import cron from 'node-cron'
import { Notification } from './notification.model'
import { NotificationServices } from './notification.service'
import {
  NotificationStatus,
  NotificationType,
  NotificationChannel,
  NotificationPriority,
} from './notification.interface'
import { User } from '../user/user.model'

export class NotificationScheduler {
  private static instance: NotificationScheduler

  private constructor() {
    this.initializeSchedulers()
  }

  static getInstance(): NotificationScheduler {
    if (!NotificationScheduler.instance) {
      NotificationScheduler.instance = new NotificationScheduler()
    }
    return NotificationScheduler.instance
  }

  private initializeSchedulers(): void {
    console.log('🕒 Initializing notification schedulers...')

    // Schedule 1: Process pending notifications every minute
    cron.schedule('* * * * *', async () => {
      await this.processPendingNotifications()
    })

    // Schedule 3: Clean up old archived notifications daily at 2 AM
    cron.schedule('0 2 * * *', async () => {
      await this.cleanupArchivedNotifications()
    })

    // Schedule 4: Send welcome emails to new users (within last hour)
    cron.schedule('*/15 * * * *', async () => {
      await this.sendWelcomeEmails()
    })

    // Schedule 5: Check for period start notifications daily at 8 AM
    cron.schedule('0 8 * * *', async () => {
      await this.schedulePeriodNotifications()
    })

    console.log('✅ Notification schedulers initialized')
  }

  private async schedulePeriodNotifications(): Promise<void> {
    try {
      const users = await User.find({
        lastPeriodStartDate: { $exists: true },
        'settings.pushNotification': true,
      })

      const today = new Date()
      today.setHours(0, 0, 0, 0)

      for (const user of users) {
        if (!user.lastPeriodStartDate || !user.cycleLength) continue

        // Calculate next period start date
        const nextStart = new Date(user.lastPeriodStartDate)
        nextStart.setDate(nextStart.getDate() + user.cycleLength)
        
        // Difference in days
        const diffInDays = Math.ceil((nextStart.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))

        // Notify 3 days before estimated start
        if (diffInDays === 3) {
          await NotificationServices.createNotification(
            {
              userId: user._id,
              title: 'Period Estimated to Start Soon',
              content: 'Your period is estimated to start in 3 days. Please update your profile if it has already started.',
              type: NotificationType.SYSTEM_ALERT,
              channel: NotificationChannel.BOTH,
              priority: NotificationPriority.HIGH,
              actionUrl: `/profile`,
              actionText: 'Update Profile',
            },
            true,
          )
        }
      }
    } catch (error) {
      console.error('Error scheduling period notifications:', error)
    }
  }

  private async processPendingNotifications(): Promise<void> {
    try {
      const pendingNotifications = await Notification.find({
        status: NotificationStatus.PENDING,
        scheduledAt: { $lte: new Date() },
        channel: { $ne: 'IN_APP' },
      }).limit(50)

      console.log(
        `📧 Processing ${pendingNotifications.length} pending notifications...`,
      )

      for (const notification of pendingNotifications) {
        try {
          await NotificationServices.sendNotificationEmail(notification)
        } catch (error: any) {
          console.error(
            `Failed to process notification ${notification._id}:`,
            error,
          )

          // Update status to failed after max retries
          const retryCount = (notification.metadata?.retryCount || 0) + 1
          if (retryCount >= 3) {
            await Notification.findByIdAndUpdate(notification._id, {
              status: NotificationStatus.FAILED,
              metadata: {
                ...notification.metadata,
                retryCount,
                lastError: error.message,
              },
            })
          } else {
            // Update retry count and reschedule for later
            await Notification.findByIdAndUpdate(notification._id, {
              scheduledAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes later
              metadata: {
                ...notification.metadata,
                retryCount,
              },
            })
          }
        }
      }
    } catch (error) {
      console.error('Error processing pending notifications:', error)
    }
  }

  private async sendWelcomeEmails(): Promise<void> {
    try {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)

      // Find users created in the last hour who haven't received welcome email
      const newUsers = await User.find({
        createdAt: { $gte: oneHourAgo },
        'metadata.welcomeEmailSent': { $ne: true },
      })

      console.log(`👋 Found ${newUsers.length} new users to welcome`)

      for (const user of newUsers) {
        try {
          await NotificationServices.createNotification(
            {
              userId: user._id,
              title: 'Welcome to Chaserxhype Bean Fien!',
              content: `Welcome aboard, ${user.name}! We're excited to have you join our community.`,
              type: NotificationType.WELCOME,
              channel: NotificationChannel.BOTH,
              priority: NotificationPriority.MEDIUM,
              metadata: {
                welcomeEmailSent: true,
              },
              actionUrl: `${process.env.CLIENT_URL}/dashboard`,
              actionText: 'Get Started',
            },
            true,
          )

          // Mark welcome email as sent in user metadata
          await User.findByIdAndUpdate(user._id, {
            $set: {
              'metadata.welcomeEmailSent': true,
              'metadata.welcomeEmailSentAt': new Date(),
            },
          })

          console.log(`Sent welcome email to: ${user.email}`)
        } catch (error) {
          console.error(`Failed to send welcome email to ${user.email}:`, error)
        }
      }
    } catch (error) {
      console.error('Error sending welcome emails:', error)
    }
  }

  private async cleanupArchivedNotifications(): Promise<void> {
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

      const result = await Notification.deleteMany({
        isArchived: true,
        updatedAt: { $lte: thirtyDaysAgo },
      })

      console.log(
        `🧹 Cleaned up ${result.deletedCount} archived notifications older than 30 days`,
      )
    } catch (error) {
      console.error('Error cleaning up archived notifications:', error)
    }
  }

  // Public method to manually trigger schedulers (for testing)
  async triggerManualSchedule(
    type: 'welcome' | 'cleanup',
  ): Promise<void> {
    console.log(`🔧 Manually triggering scheduler: ${type}`)

    switch (type) {
      case 'welcome':
        await this.sendWelcomeEmails()
        break
      case 'cleanup':
        await this.cleanupArchivedNotifications()
        break
    }

    console.log(`✅ Manual scheduler completed: ${type}`)
  }
}

// Export singleton instance
export const notificationScheduler = NotificationScheduler.getInstance()
