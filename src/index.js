require('dotenv').config();

const logger = require('./utils/logger');
const { getDb, closeDb } = require('./db/connection');
const { runMigrations } = require('./db/migrate');
const { YouTubeClient } = require('./discovery/youtubeClient');
const { DiscoveryService } = require('./discovery/discoveryService');
const { DownloadService } = require('./downloader/downloadService');
const { TransformService } = require('./transformer/transformService');
const { IGClient } = require('./publisher/igClient');
const { PublishService } = require('./publisher/publishService');
const { PipelineCoordinator } = require('./pipeline/coordinator');
const { Scheduler } = require('./scheduler/scheduler');
const { CleanupService } = require('./cleanup/cleanupService');
const { TokenManager } = require('./tokens/tokenManager');
const { HealthMonitor } = require('./health/healthMonitor');
const { RateLimiter } = require('./utils/rateLimiter');
const config = require('../config/default');
const path = require('path');
const fs = require('fs');

let scheduler = null;
let coordinator = null;

async function main() {
  logger.info('=== Instagram Reel Bot Starting ===');
  logger.info(`Mode: ${config.dryRun ? 'DRY RUN' : 'LIVE'}`);

  // 1. Initialize database
  const db = getDb();
  runMigrations();
  logger.info('Database initialized');

  // 2. Initialize services
  const rateLimiter = new RateLimiter({
    maxTokens: config.instagram.rateLimitPerHour,
    refillRate: config.instagram.rateLimitPerHour,
  });

  const youtubeClient = new YouTubeClient(config.youtubeApiKey);
  const discoveryService = new DiscoveryService(db, youtubeClient);
  const downloadService = new DownloadService();
  const transformService = new TransformService();
  const igClient = new IGClient(rateLimiter);
  const publishService = new PublishService(db, igClient);
  const cleanupService = new CleanupService(db);
  const tokenManager = new TokenManager(db, igClient);
  const healthMonitor = new HealthMonitor(db, cleanupService);

  // 3. Initialize pipeline coordinator
  coordinator = new PipelineCoordinator(
    db, discoveryService, downloadService, transformService, publishService, cleanupService
  );

  // 4. Seed accounts from env vars (if not already in DB)
  seedAccountsFromEnv(db);

  // 4b. Sync YouTube channels from config/channels.json
  seedChannelsFromConfig(db);

  // 5. Start scheduler
  scheduler = new Scheduler(
    db, coordinator, discoveryService, tokenManager, cleanupService, healthMonitor
  );
  scheduler.start();

  // 6. Run initial discovery scan
  logger.info('Running initial discovery scan...');
  await discoveryService.scanAllChannels().catch(err => {
    logger.error('Initial discovery scan failed (non-fatal)', { error: err.message });
  });

  logger.info('=== Instagram Reel Bot Running ===');
}

/**
 * Seeds accounts from environment variables into the DB if they don't exist.
 */
function seedAccountsFromEnv(db) {
  let i = 1;
  while (process.env[`IG_ACCOUNT_${i}_USER_ID`]) {
    const igUserId = process.env[`IG_ACCOUNT_${i}_USER_ID`];
    const username = process.env[`IG_ACCOUNT_${i}_USERNAME`];
    const token = process.env[`IG_ACCOUNT_${i}_ACCESS_TOKEN`];
    const niche = process.env[`IG_ACCOUNT_${i}_NICHE`];
    const maxPosts = parseInt(process.env[`IG_ACCOUNT_${i}_MAX_POSTS_DAY`] || '3', 10);

    if (!igUserId || !username || !token || !niche) {
      logger.warn(`IG_ACCOUNT_${i} incomplete, skipping`);
      i++;
      continue;
    }

    const existing = db.prepare('SELECT id FROM accounts WHERE ig_user_id = ?').get(igUserId);
    if (!existing) {
      // Set token expiry to 60 days from now (will be refreshed)
      const expiresIn = 60 * 86400;
      const now = Math.floor(Date.now() / 1000);

      db.prepare(`
        INSERT INTO accounts (ig_user_id, ig_username, access_token, token_expires, token_refreshed, niche, max_posts_day)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(igUserId, username, token, now + expiresIn, now, niche, maxPosts);

      logger.info(`Seeded account: ${username} (niche=${niche})`);
    } else {
      // Update token if changed
      db.prepare(`
        UPDATE accounts SET access_token = ?, updated_at = unixepoch()
        WHERE ig_user_id = ? AND access_token != ?
      `).run(token, igUserId, token);
    }

    i++;
  }
}

/**
 * Syncs YouTube channels from config/channels.json into the DB.
 * Channels are grouped by niche and auto-linked to all accounts sharing that niche.
 */
function seedChannelsFromConfig(db) {
  const configPath = path.join(__dirname, '../config/channels.json');
  if (!fs.existsSync(configPath)) {
    logger.debug('No config/channels.json found, skipping channel sync');
    return;
  }

  let channelsConfig;
  try {
    channelsConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (err) {
    logger.error('Failed to parse config/channels.json', { error: err.message });
    return;
  }

  const insertChannel = db.prepare(`
    INSERT OR IGNORE INTO channels (channel_id, channel_name, niche)
    VALUES (?, ?, ?)
  `);
  const insertLink = db.prepare(`
    INSERT OR IGNORE INTO account_channels (account_id, channel_id)
    VALUES (?, ?)
  `);
  const getChannelDbId = db.prepare('SELECT id FROM channels WHERE channel_id = ?');
  const getAccountsByNiche = db.prepare('SELECT id FROM accounts WHERE niche = ? AND is_active = 1');

  let channelsAdded = 0;
  let linksAdded = 0;

  const syncAll = db.transaction(() => {
    for (const group of channelsConfig.accounts || []) {
      const niche = group.niche;
      const accounts = getAccountsByNiche.all(niche);

      for (const ch of group.channels || []) {
        const result = insertChannel.run(ch.id, ch.name, niche);
        if (result.changes > 0) channelsAdded++;

        const channelRow = getChannelDbId.get(ch.id);
        if (!channelRow) continue;

        for (const account of accounts) {
          const linkResult = insertLink.run(account.id, channelRow.id);
          if (linkResult.changes > 0) linksAdded++;
        }
      }
    }
  });

  syncAll();

  if (channelsAdded > 0 || linksAdded > 0) {
    logger.info(`Channel sync: ${channelsAdded} new channel(s), ${linksAdded} new link(s) from channels.json`);
  } else {
    logger.debug('Channel sync: all channels already up to date');
  }
}

// Graceful shutdown
let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`Received ${signal}, shutting down gracefully...`);

  // 1. Stop scheduler
  if (scheduler) scheduler.stop();

  // 2. Wait for in-flight pipelines
  if (coordinator) {
    await coordinator.waitForCompletion(60000);
  }

  // 3. Release locks
  try {
    const db = getDb();
    db.prepare(
      'UPDATE videos SET locked_by = NULL, locked_at = NULL WHERE locked_by = ?'
    ).run(String(process.pid));
  } catch {
    // DB may already be closed
  }

  // 4. Close DB
  closeDb();

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { error: String(reason) });
});

// Start
main().catch(err => {
  logger.error('Fatal startup error', { error: err.message, stack: err.stack });
  process.exit(1);
});
