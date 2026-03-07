const logger = require('../utils/logger');
const config = require('../../config/default');

class TokenManager {
  constructor(db, igClient) {
    this.db = db;
    this.ig = igClient;
  }

  /**
   * Checks all active accounts and refreshes tokens expiring within threshold.
   */
  async checkAndRefreshAll() {
    const accounts = this.db.prepare(
      'SELECT * FROM accounts WHERE is_active = 1'
    ).all();

    let refreshed = 0;
    let failed = 0;

    for (const account of accounts) {
      const daysLeft = this.daysUntilExpiry(account);

      if (daysLeft <= config.tokens.refreshDaysBeforeExpiry) {
        logger.info(`Token for ${account.ig_username} expires in ${daysLeft} days, refreshing...`);

        try {
          const result = await this.ig.refreshToken(account.access_token);

          const newExpires = Math.floor(Date.now() / 1000) + result.expires_in;

          // Update account
          this.db.prepare(`
            UPDATE accounts SET
              access_token = ?,
              token_expires = ?,
              token_refreshed = unixepoch(),
              updated_at = unixepoch()
            WHERE id = ?
          `).run(result.access_token, newExpires, account.id);

          // Log refresh
          this.db.prepare(`
            INSERT INTO token_refreshes (account_id, old_expires, new_expires, success)
            VALUES (?, ?, ?, 1)
          `).run(account.id, account.token_expires, newExpires);

          refreshed++;
          logger.info(`Token refreshed for ${account.ig_username}, new expiry: ${new Date(newExpires * 1000).toISOString()}`);

        } catch (err) {
          failed++;
          logger.error(`Token refresh failed for ${account.ig_username}`, { error: err.message });

          // Log failed attempt
          this.db.prepare(`
            INSERT INTO token_refreshes (account_id, old_expires, new_expires, success, error_message)
            VALUES (?, ?, 0, 0, ?)
          `).run(account.id, account.token_expires, err.message);

          // If token is actually expired (0 days left), deactivate account
          if (daysLeft <= 0) {
            this.db.prepare('UPDATE accounts SET is_active = 0 WHERE id = ?').run(account.id);
            logger.error(`Account ${account.ig_username} deactivated due to expired token`);
          }
        }
      } else {
        logger.debug(`Token for ${account.ig_username} OK (${daysLeft} days remaining)`);
      }
    }

    logger.info(`Token refresh check complete: ${refreshed} refreshed, ${failed} failed`);
    return { refreshed, failed };
  }

  /**
   * Returns days until token expiry.
   */
  daysUntilExpiry(account) {
    const nowSec = Math.floor(Date.now() / 1000);
    const remainingSec = account.token_expires - nowSec;
    return Math.floor(remainingSec / 86400);
  }
}

module.exports = { TokenManager };
