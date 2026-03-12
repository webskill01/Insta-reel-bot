const cron = require('node-cron');
const logger = require('../utils/logger');
const config = require('../../config/default');
const { generateDailyTimes } = require('./timeWindows');

class Scheduler {
  constructor(db, pipelineCoordinator, discoveryService, tokenManager, cleanupService, healthMonitor) {
    this.db = db;
    this.pipeline = pipelineCoordinator;
    this.discovery = discoveryService;
    this.tokenManager = tokenManager;
    this.cleanup = cleanupService;
    this.health = healthMonitor;

    // Map<accountId, { times: Date[], executed: Set<index> }>
    this.dailySchedule = new Map();
    this._lastPlanDate = null;
    this._jobs = [];
    this._running = false;
  }

  /**
   * Boots the scheduler. Registers all cron jobs.
   */
  start() {
    this._running = true;

    // 1. Daily planner: midnight
    this._registerJob(config.cron.dailyPlanner, () => this.planDay(), 'daily-planner');

    // 2. Execution tick: every 2 minutes
    this._registerJob(config.cron.executionTick, () => this.executePendingPosts(), 'execution-tick');

    // 3. Discovery scan: every 4 hours
    this._registerJob(config.cron.discoveryScan, () => this.runDiscovery(), 'discovery-scan');

    // 4. Token refresh: daily at 3 AM
    this._registerJob(config.cron.tokenRefresh, () => this.checkTokenRefresh(), 'token-refresh');

    // 5. Orphan cleanup: daily at 4 AM
    this._registerJob(config.cron.orphanCleanup, () => this.runOrphanCleanup(), 'orphan-cleanup');

    // 6. Health check: every 15 minutes
    this._registerJob(config.cron.healthCheck, () => this.runHealthCheck(), 'health-check');

    // Plan today immediately on startup
    this.planDay();

    logger.info('Scheduler started with all cron jobs registered');
  }

  stop() {
    this._running = false;
    for (const job of this._jobs) {
      job.task.stop();
    }
    this._jobs = [];
    logger.info('Scheduler stopped');
  }

  _registerJob(schedule, handler, name) {
    const task = cron.schedule(schedule, async () => {
      if (!this._running) return;
      try {
        await handler();
      } catch (err) {
        logger.error(`Cron job [${name}] failed`, { error: err.message, stack: err.stack });
      }
    });
    this._jobs.push({ task, name });
  }

  /**
   * Plans posting times for all active accounts for today.
   */
  planDay() {
    this._lastPlanDate = new Date().toISOString().split('T')[0];

    // Reset videos that failed due to transient errors so they can be retried today
    const reset = this.db.prepare(
      "UPDATE videos SET status='discovered', retry_count=0, error_message=NULL, locked_by=NULL WHERE status='failed'"
    ).run();
    if (reset.changes > 0) {
      logger.info(`Reset ${reset.changes} failed video(s) to discovered for retry`);
    }

    const accounts = this.db.prepare(
      'SELECT * FROM accounts WHERE is_active = 1'
    ).all();

    this.dailySchedule.clear();

    for (const account of accounts) {
      const times = generateDailyTimes(account.max_posts_day);
      this.dailySchedule.set(account.id, {
        times,
        executed: new Set(),
        account,
      });

      const timeStrs = times.map(t =>
        `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
      );
      logger.info(`Planned ${account.ig_username}: ${timeStrs.join(', ')}`);
    }

    logger.info(`Daily plan created for ${accounts.length} accounts`);
  }

  /**
   * Checks the schedule map, fires pipeline for posts whose time has arrived.
   */
  async executePendingPosts() {
    // Self-healing: replan if midnight cron was missed (node-cron reliability issue)
    const today = new Date().toISOString().split('T')[0];
    if (this._lastPlanDate !== today) {
      logger.info(`New day detected in execution tick, replanning for ${today}...`);
      this.planDay();
    }

    const now = Date.now();

    for (const [accountId, schedule] of this.dailySchedule.entries()) {
      for (let i = 0; i < schedule.times.length; i++) {
        if (schedule.executed.has(i)) continue;

        const scheduledTime = schedule.times[i].getTime();
        if (now >= scheduledTime) {
          schedule.executed.add(i);

          logger.info(`Executing scheduled post ${i + 1} for ${schedule.account.ig_username}`);

          // Re-fetch account to get latest token
          const account = this.db.prepare(
            'SELECT * FROM accounts WHERE id = ? AND is_active = 1'
          ).get(accountId);

          if (!account) {
            logger.warn(`Account ${accountId} no longer active, skipping`);
            continue;
          }

          // Fire and forget (don't block other accounts)
          this.pipeline.executeForAccount(account).catch(err => {
            logger.error(`Scheduled post failed for ${account.ig_username}`, {
              error: err.message,
            });
          });
        }
      }
    }
  }

  async runDiscovery() {
    logger.info('Running scheduled discovery scan...');
    await this.discovery.scanAllChannels();
  }

  async checkTokenRefresh() {
    if (this.tokenManager) {
      logger.info('Running token refresh check...');
      await this.tokenManager.checkAndRefreshAll();
    }
  }

  async runOrphanCleanup() {
    if (this.cleanup) {
      logger.info('Running orphan cleanup...');
      await this.cleanup.cleanupOrphans();
    }
  }

  async runHealthCheck() {
    if (this.health) {
      await this.health.runChecks();
    }
  }
}

module.exports = { Scheduler };
