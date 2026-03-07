const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const config = require('../../config/default');

class CleanupService {
  constructor(db) {
    this.db = db;
    this.rawDir = config.rawDir;
    this.processedDir = config.processedDir;
  }

  /**
   * Deletes raw and processed files for a video after successful publish.
   * Updates DB paths to NULL.
   */
  async cleanupVideo(videoId) {
    const video = this.db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
    if (!video) return;

    let cleaned = 0;

    if (video.raw_path) {
      try {
        if (fs.existsSync(video.raw_path)) {
          fs.unlinkSync(video.raw_path);
          cleaned++;
        }
      } catch (err) {
        logger.warn(`Failed to delete raw file: ${video.raw_path}`, { error: err.message });
      }
    }

    if (video.processed_path) {
      try {
        if (fs.existsSync(video.processed_path)) {
          fs.unlinkSync(video.processed_path);
          cleaned++;
        }
      } catch (err) {
        logger.warn(`Failed to delete processed file: ${video.processed_path}`, { error: err.message });
      }
    }

    // Clear paths in DB
    this.db.prepare(
      'UPDATE videos SET raw_path = NULL, processed_path = NULL WHERE id = ?'
    ).run(videoId);

    if (cleaned > 0) {
      logger.info(`Cleaned up ${cleaned} file(s) for video ${video.youtube_id}`);
    }
  }

  /**
   * Orphan cleanup: delete files older than 24h that are not actively needed.
   */
  async cleanupOrphans() {
    const maxAge = Date.now() - config.cleanup.orphanMaxAgeMs;
    let deleted = 0;

    for (const dir of [this.rawDir, this.processedDir]) {
      if (!fs.existsSync(dir)) continue;

      const files = fs.readdirSync(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        try {
          const stats = fs.statSync(filePath);
          if (stats.mtimeMs > maxAge) continue; // Too new

          // Check if any video in active state references this file
          const youtubeId = path.parse(file).name;
          const video = this.db.prepare(
            "SELECT status FROM videos WHERE youtube_id = ?"
          ).get(youtubeId);

          // Delete if: no DB record, or status is terminal (published/failed/skipped)
          const isTerminal = !video || ['published', 'failed', 'skipped'].includes(video?.status);
          if (isTerminal) {
            fs.unlinkSync(filePath);
            deleted++;
            logger.debug(`Orphan cleanup: deleted ${filePath}`);
          }
        } catch (err) {
          logger.warn(`Orphan cleanup error for ${filePath}`, { error: err.message });
        }
      }
    }

    if (deleted > 0) {
      logger.info(`Orphan cleanup: deleted ${deleted} files`);
    }
  }

  /**
   * Emergency cleanup when disk usage exceeds threshold.
   * Aggressively deletes all files for published/failed videos.
   */
  async emergencyCleanup() {
    logger.warn('Emergency cleanup triggered!');
    let deleted = 0;

    for (const dir of [this.processedDir, this.rawDir]) {
      if (!fs.existsSync(dir)) continue;

      const files = fs.readdirSync(dir);
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(dir, file));
          deleted++;
        } catch (err) {
          // ignore
        }
      }
    }

    // Clear all file paths in DB
    this.db.prepare(
      "UPDATE videos SET raw_path = NULL, processed_path = NULL WHERE status IN ('published', 'failed', 'skipped')"
    ).run();

    logger.warn(`Emergency cleanup: deleted ${deleted} files`);
  }
}

module.exports = { CleanupService };
