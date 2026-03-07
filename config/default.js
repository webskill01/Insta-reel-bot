const path = require('path');

require('dotenv').config();

const DATA_DIR = process.env.DATA_DIR || './data';

module.exports = {
  // Paths
  dataDir: DATA_DIR,
  rawDir: path.join(DATA_DIR, 'raw'),
  processedDir: path.join(DATA_DIR, 'processed'),
  watermarksDir: path.join(DATA_DIR, 'watermarks'),
  dbPath: process.env.DB_PATH || path.join(DATA_DIR, 'reel-bot.db'),

  // YouTube
  youtubeApiKey: process.env.YOUTUBE_API_KEY,

  // Server
  nginxBaseUrl: process.env.NGINX_BASE_URL || 'http://localhost:8888',

  // Scheduling - time windows for randomized posting (HH:MM in server timezone)
  postingWindows: {
    morning:   { start: '07:00', end: '09:30' },
    afternoon: { start: '12:00', end: '14:30' },
    evening:   { start: '18:00', end: '21:00' },
  },

  // Cron schedules
  cron: {
    dailyPlanner:    '0 0 * * *',    // Midnight: plan today's posts
    executionTick:   '*/2 * * * *',  // Every 2 min: check for due posts
    discoveryScan:   '0 */4 * * *',  // Every 4 hours: scan YouTube
    tokenRefresh:    '0 3 * * *',    // 3 AM: check token expiry
    orphanCleanup:   '0 4 * * *',    // 4 AM: clean orphan files
    healthCheck:     '*/15 * * * *', // Every 15 min: health check
  },

  // Limits
  defaults: {
    maxPostsPerDay: 3,
    maxRetriesPerVideo: 3,
    maxRetriesPerPost: 3,
  },

  // Instagram API
  instagram: {
    graphApiVersion: 'v21.0',
    graphApiBase: 'https://graph.instagram.com',
    containerPollIntervalMs: 30_000,  // 30 seconds
    containerPollMaxAttempts: 20,     // 10 minutes total
    rateLimitPerHour: 180,            // 200 limit with 20 buffer
  },

  // YouTube API
  youtube: {
    maxResultsPerChannel: 10,
    shortsMaxDurationSec: 60,
  },

  // Download
  download: {
    minFileSizeBytes: 100 * 1024,     // 100 KB
    maxFileSizeBytes: 100 * 1024 * 1024, // 100 MB
    timeoutMs: 120_000,               // 2 minutes
  },

  // Transform
  transform: {
    timeoutMs: 300_000,               // 5 minutes
  },

  // Cleanup
  cleanup: {
    orphanMaxAgeMs: 24 * 60 * 60 * 1000, // 24 hours
    diskUsageThreshold: 90,              // percent
  },

  // Token refresh
  tokens: {
    refreshDaysBeforeExpiry: 10,
  },

  // Health
  health: {
    stuckVideoThresholdMs: 30 * 60 * 1000, // 30 minutes
  },

  // Operational
  dryRun: process.env.DRY_RUN === 'true',
  timezone: process.env.TIMEZONE || 'UTC',
  logLevel: process.env.LOG_LEVEL || 'info',
};
