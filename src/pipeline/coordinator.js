const logger = require('../utils/logger');
const config = require('../../config/default');

class PipelineCoordinator {
  constructor(db, discoveryService, downloadService, transformService, publishService, cleanupService) {
    this.db = db;
    this.discovery = discoveryService;
    this.downloader = downloadService;
    this.transformer = transformService;
    this.publisher = publishService;
    this.cleanup = cleanupService;
    this._inFlight = new Set();
  }

  /**
   * Runs one complete pipeline cycle for an account:
   * pick video → download → transform → publish → cleanup
   */
  async executeForAccount(account) {
    if (this._inFlight.has(account.id)) {
      logger.debug(`Pipeline already in-flight for ${account.ig_username}, skipping`);
      return { success: false, error: 'already_in_flight' };
    }

    // Check daily limit
    if (!this._canPostToday(account)) {
      logger.debug(`${account.ig_username} has reached daily post limit`);
      return { success: false, error: 'daily_limit_reached' };
    }

    this._inFlight.add(account.id);
    let video = null;

    try {
      // Step 1: Pick a video
      video = this.discovery.pickVideoForAccount(account.niche, account.id);

      if (!video) {
        logger.info(`No available videos for ${account.ig_username} (niche=${account.niche}), running discovery...`);
        await this.discovery.scanAllChannels();
        video = this.discovery.pickVideoForAccount(account.niche, account.id);
      }

      if (!video) {
        logger.info(`No fresh content for ${account.ig_username} — running deep channel scan...`);
        await this.discovery.deepScanAllChannels();
        video = this.discovery.pickVideoForAccount(account.niche, account.id);
      }

      if (!video) {
        logger.warn(`No videos available for ${account.ig_username} even after deep scan`);
        return { success: false, error: 'no_videos_available' };
      }

      // Acquire lock
      if (!this._acquireLock(video.id)) {
        logger.warn(`Could not acquire lock on video ${video.youtube_id}`);
        return { success: false, error: 'lock_failed' };
      }

      logger.info(`Pipeline started: ${video.youtube_id} → ${account.ig_username}`);

      // Step 2: Download
      this._updateVideoStatus(video.id, 'downloading');
      const rawPath = await this.downloader.download(video.youtube_id);
      this._updateVideoStatus(video.id, 'downloaded', { raw_path: rawPath });

      // Step 3: Transform
      this._updateVideoStatus(video.id, 'transforming');
      const processedPath = await this.transformer.transform(rawPath, video.youtube_id);
      this._updateVideoStatus(video.id, 'transformed', { processed_path: processedPath });

      // Step 4: Publish
      this._updateVideoStatus(video.id, 'publishing');
      const result = await this.publisher.publishReel(video, account);

      if (result.success) {
        this._updateVideoStatus(video.id, 'published');

        // Step 5: Cleanup files
        await this.cleanup.cleanupVideo(video.id);

        logger.info(`Pipeline complete: ${video.youtube_id} → ${account.ig_username} (media=${result.mediaId})`);
        return { success: true, videoId: video.youtube_id, mediaId: result.mediaId };
      } else {
        this._handleVideoFailure(video.id, result.error);
        return { success: false, videoId: video.youtube_id, error: result.error };
      }

    } catch (err) {
      logger.error(`Pipeline error for ${account.ig_username}`, {
        videoId: video?.youtube_id,
        error: err.message,
        stack: err.stack,
      });

      if (video) {
        this._handleVideoFailure(video.id, err.message);
      }

      return { success: false, videoId: video?.youtube_id, error: err.message };

    } finally {
      if (video) this._releaseLock(video.id);
      this._inFlight.delete(account.id);
    }
  }

  _canPostToday(account) {
    const today = new Date().toISOString().split('T')[0];
    const stats = this.db.prepare(
      'SELECT posts_count FROM daily_stats WHERE account_id = ? AND date = ?'
    ).get(account.id, today);

    return !stats || stats.posts_count < account.max_posts_day;
  }

  _acquireLock(videoId) {
    const result = this.db.prepare(`
      UPDATE videos SET locked_by = ?, locked_at = unixepoch()
      WHERE id = ? AND locked_by IS NULL
    `).run(String(process.pid), videoId);

    return result.changes > 0;
  }

  _releaseLock(videoId) {
    this.db.prepare(
      'UPDATE videos SET locked_by = NULL, locked_at = NULL WHERE id = ?'
    ).run(videoId);
  }

  _updateVideoStatus(videoId, status, extra = {}) {
    const sets = ['status = ?'];
    const values = [status];

    for (const [key, val] of Object.entries(extra)) {
      sets.push(`${key} = ?`);
      values.push(val);
    }

    values.push(videoId);
    this.db.prepare(`UPDATE videos SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  _handleVideoFailure(videoId, errorMsg) {
    const video = this.db.prepare('SELECT retry_count FROM videos WHERE id = ?').get(videoId);
    const retries = (video?.retry_count || 0) + 1;

    if (retries >= config.defaults.maxRetriesPerVideo) {
      this._updateVideoStatus(videoId, 'failed', {
        error_message: errorMsg,
        retry_count: retries,
      });
      // Clean up files on permanent failure
      this.cleanup.cleanupVideo(videoId).catch(() => {});
      logger.error(`Video ${videoId} permanently failed after ${retries} retries`);
    } else {
      // Reset to discovered so it can be retried
      this._updateVideoStatus(videoId, 'discovered', {
        error_message: errorMsg,
        retry_count: retries,
      });
      logger.warn(`Video ${videoId} failed (retry ${retries}/${config.defaults.maxRetriesPerVideo})`);
    }
  }

  /**
   * Returns a promise that resolves when all in-flight pipelines finish.
   * Used for graceful shutdown.
   */
  async waitForCompletion(timeoutMs = 60000) {
    const start = Date.now();
    while (this._inFlight.size > 0 && Date.now() - start < timeoutMs) {
      logger.info(`Waiting for ${this._inFlight.size} in-flight pipeline(s) to complete...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    if (this._inFlight.size > 0) {
      logger.warn(`Shutdown timeout: ${this._inFlight.size} pipeline(s) still in-flight`);
    }
  }
}

module.exports = { PipelineCoordinator };
