const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');
const config = require('../../config/default');

// Load caption templates (cached at module level)
let captionConfig = null;
function loadCaptionConfig() {
  if (captionConfig) return captionConfig;
  const configPath = path.join(__dirname, '../../config/captions.json');
  captionConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return captionConfig;
}

class PublishService {
  constructor(db, igClient) {
    this.db = db;
    this.ig = igClient;
  }

  /**
   * Full publish flow for one video to one account.
   * Creates container → polls → publishes → verifies.
   */
  async publishReel(video, account) {
    const { caption, metadata } = this.generateCaption(video, account);
    const videoUrl = `${config.nginxBaseUrl}/processed/${video.youtube_id}.mp4`;

    // Create or get post record
    let post = this.db.prepare(
      'SELECT * FROM posts WHERE video_id = ? AND account_id = ?'
    ).get(video.id, account.id);

    if (!post) {
      this.db.prepare(`
        INSERT INTO posts (video_id, account_id, caption, status, scheduled_at)
        VALUES (?, ?, ?, 'pending', unixepoch())
      `).run(video.id, account.id, caption);

      post = this.db.prepare(
        'SELECT * FROM posts WHERE video_id = ? AND account_id = ?'
      ).get(video.id, account.id);
    }

    if (post.status === 'published') {
      logger.warn(`Post already published: video=${video.youtube_id} account=${account.ig_username}`);
      return { success: true, mediaId: post.ig_media_id };
    }

    try {
      // Step 1: Create container
      if (config.dryRun) {
        logger.info(`[DRY RUN] Would publish ${video.youtube_id} to ${account.ig_username}`);
        this._updatePostStatus(post.id, 'published', { ig_media_id: 'dry_run' });
        return { success: true, mediaId: 'dry_run' };
      }

      const containerId = await withRetry(
        () => this.ig.createContainer(account.ig_user_id, account.access_token, videoUrl, caption, metadata),
        { maxRetries: 3, baseDelay: 2000, label: `createContainer(${account.ig_username})` }
      );

      this._updatePostStatus(post.id, 'container_created', { ig_container_id: containerId });

      // Step 2: Poll until container is ready
      this._updatePostStatus(post.id, 'polling');
      await this.ig.pollContainerStatus(containerId, account.access_token);

      // Step 3: Publish
      const mediaId = await withRetry(
        () => this.ig.publishContainer(account.ig_user_id, account.access_token, containerId),
        { maxRetries: 2, baseDelay: 3000, label: `publishContainer(${account.ig_username})` }
      );

      this._updatePostStatus(post.id, 'published', {
        ig_media_id: mediaId,
        published_at: Math.floor(Date.now() / 1000),
      });

      // Step 4: Verify (non-critical, don't fail if this errors)
      try {
        await this.ig.verifyPublication(mediaId, account.access_token);
      } catch (verifyErr) {
        logger.warn(`Verification failed (non-critical): ${verifyErr.message}`);
      }

      // Update daily stats
      this._incrementDailyStats(account.id);

      logger.info(`Published reel: ${video.youtube_id} → ${account.ig_username} (media=${mediaId})`);
      return { success: true, mediaId };

    } catch (err) {
      const isRateLimit = err.igErrorCode === 4;
      const isTokenExpired = err.igErrorCode === 190;

      this._updatePostStatus(post.id, 'failed', { error_message: err.message });

      // Increment failure count
      this.db.prepare(
        'UPDATE posts SET retry_count = retry_count + 1 WHERE id = ?'
      ).run(post.id);

      this._incrementDailyFailures(account.id);

      if (isTokenExpired) {
        logger.error(`Token expired for ${account.ig_username} — pausing account`);
        this.db.prepare('UPDATE accounts SET is_active = 0 WHERE id = ?').run(account.id);
      }

      if (isRateLimit) {
        logger.warn(`Rate limit hit for ${account.ig_username} — will retry later`);
      }

      logger.error(`Publish failed: ${video.youtube_id} → ${account.ig_username}`, {
        error: err.message,
      });

      return { success: false, error: err.message };
    }
  }

  /**
   * Generates caption and IG metadata from config/captions.json templates.
   * Returns { caption: string, metadata: object }
   */
  generateCaption(video, account) {
    const cfg = loadCaptionConfig();
    const defaults = cfg.defaults || {};
    const nicheConfig = cfg.niches?.[account.niche] || {};

    // Clean video title
    const title = video.title
      .replace(/#\w+/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Build hashtag pool: niche-specific + default appended ones
    const nicheHashtags = nicheConfig.hashtags || [`#${account.niche}`];
    const appendHashtags = defaults.appendHashtags || [];
    const allHashtags = [...nicheHashtags, ...appendHashtags];

    // Shuffle and cap at hashtagCount
    const maxTags = nicheConfig.hashtagCount || defaults.hashtagCount || 15;
    const shuffled = allHashtags.sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, maxTags);
    const hashtagString = selected.join(' ');

    // Apply template
    const template = nicheConfig.captionTemplate || defaults.captionTemplate || '{title}\n\n{hashtags}';
    const caption = template
      .replace('{title}', title)
      .replace('{hashtags}', hashtagString);

    // Build IG metadata (optional fields for createContainer)
    const metadata = {};
    const shareToFeed = nicheConfig.share_to_feed ?? defaults.share_to_feed;
    if (shareToFeed !== undefined) metadata.share_to_feed = shareToFeed;
    if (nicheConfig.cover_url) metadata.cover_url = nicheConfig.cover_url;
    if (nicheConfig.location_id) metadata.location_id = nicheConfig.location_id;
    if (nicheConfig.collaborators) metadata.collaborators = nicheConfig.collaborators;

    return { caption, metadata };
  }

  _updatePostStatus(postId, status, extra = {}) {
    const sets = ['status = ?'];
    const values = [status];

    for (const [key, val] of Object.entries(extra)) {
      sets.push(`${key} = ?`);
      values.push(val);
    }

    values.push(postId);
    this.db.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  _incrementDailyStats(accountId) {
    const today = new Date().toISOString().split('T')[0];
    this.db.prepare(`
      INSERT INTO daily_stats (account_id, date, posts_count)
      VALUES (?, ?, 1)
      ON CONFLICT(account_id, date) DO UPDATE SET posts_count = posts_count + 1
    `).run(accountId, today);
  }

  _incrementDailyFailures(accountId) {
    const today = new Date().toISOString().split('T')[0];
    this.db.prepare(`
      INSERT INTO daily_stats (account_id, date, failures)
      VALUES (?, ?, 1)
      ON CONFLICT(account_id, date) DO UPDATE SET failures = failures + 1
    `).run(accountId, today);
  }
}

module.exports = { PublishService };
