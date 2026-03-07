const { execSync } = require('child_process');
const http = require('http');
const logger = require('../utils/logger');
const config = require('../../config/default');

class HealthMonitor {
  constructor(db, cleanupService) {
    this.db = db;
    this.cleanup = cleanupService;
  }

  /**
   * Runs all health checks. Called every 15 minutes by scheduler.
   */
  async runChecks() {
    const report = {
      timestamp: new Date().toISOString(),
      checks: {},
    };

    // 1. Database check
    report.checks.database = this._checkDatabase();

    // 2. Disk usage check
    report.checks.disk = await this._checkDiskUsage();

    // 3. Stuck video check
    report.checks.stuckVideos = this._checkStuckVideos();

    // 4. Token expiry warnings
    report.checks.tokens = this._checkTokenExpiry();

    // 5. Nginx check
    report.checks.nginx = await this._checkNginx();

    // Log summary
    const issues = Object.entries(report.checks)
      .filter(([, v]) => v.status === 'warning' || v.status === 'error')
      .map(([k, v]) => `${k}: ${v.message}`);

    if (issues.length > 0) {
      logger.warn(`Health check: ${issues.length} issue(s) found`, { issues });
    } else {
      logger.debug('Health check: all OK');
    }

    return report;
  }

  _checkDatabase() {
    try {
      this.db.prepare('SELECT 1').get();
      return { status: 'ok' };
    } catch (err) {
      return { status: 'error', message: `DB unreachable: ${err.message}` };
    }
  }

  async _checkDiskUsage() {
    try {
      const output = execSync("df -h . | tail -1 | awk '{print $5}'", {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();

      const usagePercent = parseInt(output.replace('%', ''), 10);

      if (isNaN(usagePercent)) {
        return { status: 'warning', message: `Could not parse disk usage: ${output}` };
      }

      if (usagePercent >= config.cleanup.diskUsageThreshold) {
        logger.warn(`Disk usage critical: ${usagePercent}%, triggering emergency cleanup`);
        if (this.cleanup) {
          await this.cleanup.emergencyCleanup();
        }
        return { status: 'error', message: `Disk usage: ${usagePercent}%` };
      }

      return { status: 'ok', usage: `${usagePercent}%` };
    } catch {
      return { status: 'warning', message: 'Could not check disk usage' };
    }
  }

  _checkStuckVideos() {
    const threshold = Math.floor((Date.now() - config.health.stuckVideoThresholdMs) / 1000);

    const stuck = this.db.prepare(`
      SELECT id, youtube_id, status, locked_at FROM videos
      WHERE status IN ('downloading', 'transforming', 'publishing')
        AND locked_at IS NOT NULL
        AND locked_at < ?
    `).all(threshold);

    if (stuck.length > 0) {
      // Reset stuck videos
      const resetStmt = this.db.prepare(`
        UPDATE videos SET status = 'discovered', locked_by = NULL, locked_at = NULL,
          retry_count = retry_count + 1
        WHERE id = ?
      `);

      for (const video of stuck) {
        resetStmt.run(video.id);
        logger.warn(`Unstuck video ${video.youtube_id} (was ${video.status})`);
      }

      return { status: 'warning', message: `Unstuck ${stuck.length} video(s)` };
    }

    return { status: 'ok' };
  }

  _checkTokenExpiry() {
    const nowSec = Math.floor(Date.now() / 1000);
    const warningThreshold = 7 * 86400; // 7 days

    const expiring = this.db.prepare(`
      SELECT ig_username, token_expires FROM accounts
      WHERE is_active = 1 AND (token_expires - ?) < ?
    `).all(nowSec, warningThreshold);

    if (expiring.length > 0) {
      for (const a of expiring) {
        const daysLeft = Math.floor((a.token_expires - nowSec) / 86400);
        logger.warn(`Token warning: ${a.ig_username} expires in ${daysLeft} days`);
      }
      return { status: 'warning', message: `${expiring.length} token(s) expiring soon` };
    }

    return { status: 'ok' };
  }

  async _checkNginx() {
    const url = `${config.nginxBaseUrl}/health`;

    return new Promise((resolve) => {
      const req = http.get(url, { timeout: 5000 }, (res) => {
        if (res.statusCode === 200) {
          resolve({ status: 'ok' });
        } else {
          resolve({ status: 'warning', message: `Nginx returned ${res.statusCode}` });
        }
        res.resume();
      });

      req.on('error', () => {
        resolve({ status: 'warning', message: 'Nginx unreachable' });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ status: 'warning', message: 'Nginx timeout' });
      });
    });
  }
}

module.exports = { HealthMonitor };
