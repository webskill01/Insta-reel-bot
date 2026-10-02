const logger = require('../utils/logger');
const config = require('../../config/default');

class DiscoveryService {
  constructor(db, youtubeClient, igClient) {
    this.db = db;
    this.yt = youtubeClient; // null when YOUTUBE_API_KEY is unset
    this.ig = igClient;
  }

  _isIgSource(channel) {
    return channel.channel_id.startsWith('ig:');
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
        const count = this._isIgSource(channel)
          ? await this._scanIgSource(channel, config.instagramSource.pagesPerScan)
          : await this._scanChannel(channel);
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

    logger.info(`Discovery scan complete: ${scanned} channels scanned, ${discovered} new videos found`);
    return { scanned, discovered };
  }

  /**
   * Scans an Instagram source page (channel_id "ig:<username>") via Business Discovery.
   * Upserts so a re-scan also refreshes expired media_url links. Stops early at stopAtId.
   */
  async _scanIgSource(channel, pages, stopAtId = null) {
    const reader = this.db.prepare(
      'SELECT ig_user_id, access_token FROM accounts WHERE is_active = 1 ORDER BY id LIMIT 1'
    ).get();
    if (!reader) throw new Error('No active account to read Instagram sources with');

    const username = channel.channel_id.slice(3);
    const exists = this.db.prepare('SELECT 1 FROM videos WHERE youtube_id = ?');
    const upsert = this.db.prepare(`
      INSERT INTO videos (youtube_id, channel_id, title, duration_sec, niche, status, source_url, permalink)
      VALUES (?, ?, ?, 0, ?, 'discovered', ?, ?)
      ON CONFLICT(youtube_id) DO UPDATE SET source_url = excluded.source_url
    `);

    let inserted = 0;
    let withheld = 0;
    let after = null;

    for (let page = 0; page < pages; page++) {
      const { items, next } = await this.ig.businessDiscovery(
        reader.ig_user_id, reader.access_token, username, after, config.instagramSource.pageSize
      );

      for (const m of items) {
        if (m.media_product_type !== 'REELS') continue;
        // Meta withholds media_url for reels with copyrighted audio
        if (!m.media_url) { withheld++; continue; }
        if (!exists.get(m.id)) inserted++;
        upsert.run(m.id, channel.channel_id, m.caption || '', channel.niche, m.media_url, m.permalink);
      }

      if (!next || (stopAtId && items.some(m => m.id === stopAtId))) break;
      after = next;
    }

    if (inserted > 0 || withheld > 0) {
      logger.info(`IG source @${username}: ${inserted} new reels${withheld ? `, ${withheld} skipped (no media_url)` : ''}`);
    }
    return inserted;
  }

  /**
   * Instagram CDN links expire. Re-scans the source page until the reel is
   * found again and returns its fresh link (or null if it's gone).
   */
  async refreshSourceUrl(video) {
    const channel = this.db.prepare('SELECT * FROM channels WHERE channel_id = ?').get(video.channel_id);
    if (!channel || !this._isIgSource(channel)) return null;
    await this._scanIgSource(channel, config.instagramSource.deepScanPages, video.youtube_id);
    const row = this.db.prepare('SELECT source_url FROM videos WHERE id = ?').get(video.id);
    return row?.source_url && row.source_url !== video.source_url ? row.source_url : null;
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
   * Picks a random video for a niche that this account hasn't posted yet.
   * 'published' stays eligible so every account in the niche gets each video.
   */
  pickVideoForAccount(niche, accountId) {
    return this.db.prepare(`
      SELECT v.* FROM videos v
      WHERE v.niche = ?
        AND v.status IN ('discovered', 'published')
        AND v.locked_by IS NULL
        AND v.id NOT IN (
          SELECT video_id FROM posts
          WHERE account_id = ? AND status NOT IN ('failed', 'dry_run')
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
        if (this._isIgSource(channel)) {
          totalNew += await this._scanIgSource(channel, config.instagramSource.deepScanPages);
          continue;
        }

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
