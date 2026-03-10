const logger = require('../utils/logger');
const config = require('../../config/default');

class DiscoveryService {
  constructor(db, youtubeClient) {
    this.db = db;
    this.yt = youtubeClient;
  }

  /**
   * Scans all active channels for new Shorts. Inserts into videos table.
   * Returns { scanned, discovered } counts.
   */
  async scanAllChannels() {
    const channels = this.db.prepare(
      'SELECT * FROM channels WHERE is_active = 1'
    ).all();

    let scanned = 0;
    let discovered = 0;

    for (const channel of channels) {
      try {
        const count = await this._scanChannel(channel);
        discovered += count;
        scanned++;

        // Update last_scanned
        this.db.prepare(
          'UPDATE channels SET last_scanned = unixepoch() WHERE id = ?'
        ).run(channel.id);
      } catch (err) {
        logger.error(`Discovery: failed to scan channel ${channel.channel_name}`, {
          channelId: channel.channel_id,
          error: err.message,
        });
      }
    }

    logger.info(`Discovery scan complete: ${scanned} channels scanned, ${discovered} new Shorts found`);
    return { scanned, discovered };
  }

  /**
   * Scans a single channel for new Shorts.
   */
  async _scanChannel(channel) {
    // Step 1: Get uploads playlist ID (cached in DB)
    let playlistId = channel.uploads_playlist;
    if (!playlistId) {
      playlistId = await this.yt.getUploadsPlaylistId(channel.channel_id);
      this.db.prepare(
        'UPDATE channels SET uploads_playlist = ? WHERE id = ?'
      ).run(playlistId, channel.id);
      logger.debug(`Cached uploads playlist for ${channel.channel_name}: ${playlistId}`);
    }

    // Step 2: Fetch recent playlist items with ETag
    const cachedEtag = this._getCachedEtag(`playlist:${playlistId}`);
    const playlistResult = await this.yt.getPlaylistItems(
      playlistId,
      cachedEtag,
      config.youtube.maxResultsPerChannel
    );

    if (playlistResult.notModified) {
      logger.debug(`Channel ${channel.channel_name}: no new uploads (ETag cache hit)`);
      return 0;
    }

    // Update ETag cache
    this._setCachedEtag(`playlist:${playlistId}`, playlistResult.etag, playlistResult.items);

    // Step 3: Filter out already-known videos
    const videoIds = playlistResult.items.map(i => i.videoId);
    const known = new Set(
      this.db.prepare(
        `SELECT youtube_id FROM videos WHERE youtube_id IN (${videoIds.map(() => '?').join(',')})`
      ).all(...videoIds).map(r => r.youtube_id)
    );

    const newVideoIds = videoIds.filter(id => !known.has(id));
    if (newVideoIds.length === 0) {
      logger.debug(`Channel ${channel.channel_name}: no new videos after filtering known`);
      return 0;
    }

    // Step 4: Get video details (duration) for new videos
    const details = await this.yt.getVideoDetails(newVideoIds);

    // Step 5: Filter for Shorts (duration <= 60s)
    const shorts = details.filter(
      v => v.durationSec > 0 && v.durationSec <= config.youtube.shortsMaxDurationSec
    );

    // Step 6: Insert new Shorts into DB
    const insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO videos (youtube_id, channel_id, title, duration_sec, niche, status)
      VALUES (?, ?, ?, ?, ?, 'discovered')
    `);

    let inserted = 0;
    const insertMany = this.db.transaction((videos) => {
      for (const video of videos) {
        const result = insertStmt.run(
          video.id,
          channel.channel_id,
          video.title,
          video.durationSec,
          channel.niche
        );
        if (result.changes > 0) inserted++;
      }
    });

    insertMany(shorts);

    if (inserted > 0) {
      logger.info(`Channel ${channel.channel_name}: discovered ${inserted} new Shorts`);
    }

    return inserted;
  }

  /**
   * Picks a random undiscovered video for a given niche that hasn't been
   * posted to the specified account.
   */
  pickVideoForAccount(niche, accountId) {
    return this.db.prepare(`
      SELECT v.* FROM videos v
      WHERE v.niche = ?
        AND v.status = 'discovered'
        AND v.locked_by IS NULL
        AND v.id NOT IN (
          SELECT video_id FROM posts
          WHERE account_id = ? AND status != 'failed'
        )
      ORDER BY RANDOM()
      LIMIT 1
    `).get(niche, accountId) || null;
  }

  /**
   * Deep-scans all active channels, paginating back through upload history
   * to find older Shorts not yet in the DB. Called when regular scan + fresh
   * discovery both yield no content for an account.
   */
  async deepScanAllChannels() {
    logger.info('Running deep channel scan for older content...');
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - config.youtube.maxContentAgeDays);

    let totalNew = 0;
    const channels = this.db.prepare('SELECT * FROM channels WHERE is_active = 1').all();

    for (const channel of channels) {
      try {
        let playlistId = channel.uploads_playlist;
        if (!playlistId) {
          playlistId = await this.yt.getUploadsPlaylistId(channel.channel_id);
          this.db.prepare('UPDATE channels SET uploads_playlist = ? WHERE id = ?')
            .run(playlistId, channel.id);
        }

        // Fetch without ETag so we paginate deeper (ignores cache)
        const result = await this.yt.getPlaylistItems(
          playlistId, null, 50, config.youtube.deepScanPages
        );

        // Filter to content within the age limit
        const recentItems = result.items.filter(i => new Date(i.publishedAt) >= cutoff);
        if (recentItems.length === 0) continue;

        const videoIds = recentItems.map(i => i.videoId);
        const details = await this.yt.getVideoDetails(videoIds);
        const shorts = details.filter(
          v => v.durationSec > 0 && v.durationSec <= config.youtube.shortsMaxDurationSec
        );

        const insertStmt = this.db.prepare(`
          INSERT OR IGNORE INTO videos (youtube_id, channel_id, title, duration_sec, niche, status)
          VALUES (?, ?, ?, ?, ?, 'discovered')
        `);

        let inserted = 0;
        const insertMany = this.db.transaction((videos) => {
          for (const v of videos) {
            const r = insertStmt.run(v.id, channel.channel_id, v.title, v.durationSec, channel.niche);
            if (r.changes > 0) inserted++;
          }
        });
        insertMany(shorts);

        if (inserted > 0) {
          logger.info(`Deep scan — Channel ${channel.channel_name}: found ${inserted} older Shorts`);
          totalNew += inserted;
        }
      } catch (err) {
        logger.error(`Deep scan: failed for channel ${channel.channel_name}`, { error: err.message });
      }
    }

    logger.info(`Deep scan complete: ${totalNew} new older Shorts added`);
    return totalNew;
  }

  _getCachedEtag(key) {
    const row = this.db.prepare(
      'SELECT etag FROM etag_cache WHERE cache_key = ?'
    ).get(key);
    return row ? row.etag : null;
  }

  _setCachedEtag(key, etag, items) {
    this.db.prepare(`
      INSERT OR REPLACE INTO etag_cache (cache_key, etag, response_json, cached_at)
      VALUES (?, ?, ?, unixepoch())
    `).run(key, etag, JSON.stringify(items));
  }
}

module.exports = { DiscoveryService };
