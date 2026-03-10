const https = require('https');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');

const API_BASE = 'https://www.googleapis.com/youtube/v3';

class YouTubeClient {
  constructor(apiKey) {
    if (!apiKey) throw new Error('YouTube API key is required');
    this.apiKey = apiKey;
  }

  /**
   * Makes a GET request to the YouTube Data API.
   */
  async _request(endpoint, params, etag = null) {
    const url = new URL(`${API_BASE}/${endpoint}`);
    params.key = this.apiKey;
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    return new Promise((resolve, reject) => {
      const headers = {};
      if (etag) headers['If-None-Match'] = etag;

      const req = https.get(url.toString(), { headers }, (res) => {
        if (res.statusCode === 304) {
          return resolve({ notModified: true, etag: etag, items: [] });
        }

        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 400) {
            return reject(new Error(`YouTube API ${res.statusCode}: ${data}`));
          }
          try {
            const parsed = JSON.parse(data);
            resolve({
              notModified: false,
              etag: res.headers.etag || parsed.etag,
              ...parsed,
            });
          } catch (e) {
            reject(new Error(`YouTube API parse error: ${e.message}`));
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => {
        req.destroy();
        reject(new Error('YouTube API request timeout'));
      });
    });
  }

  /**
   * Gets the uploads playlist ID for a channel.
   * Costs 1 quota unit.
   */
  async getUploadsPlaylistId(channelId) {
    return withRetry(async () => {
      const res = await this._request('channels', {
        part: 'contentDetails',
        id: channelId,
      });

      if (!res.items || res.items.length === 0) {
        throw new Error(`Channel not found: ${channelId}`);
      }

      return res.items[0].contentDetails.relatedPlaylists.uploads;
    }, { maxRetries: 2, label: `getUploadsPlaylist(${channelId})` });
  }

  /**
   * Lists items from a playlist with ETag caching and optional pagination.
   * ETag is only sent on the first page request (preserves 304 short-circuit).
   * Costs 1 unit per page (0 on 304 Not Modified for page 0).
   * @param {string} playlistId
   * @param {string|null} etag - cached ETag for 304 checking
   * @param {number} maxResults - items per page (max 50)
   * @param {number} maxPages - max pages to fetch (1 = no pagination)
   */
  async getPlaylistItems(playlistId, etag = null, maxResults = 10, maxPages = 1) {
    const allItems = [];
    let pageToken = null;
    let finalEtag = etag;

    for (let page = 0; page < maxPages; page++) {
      const params = {
        part: 'snippet,contentDetails',
        playlistId,
        maxResults: String(maxResults),
      };
      if (pageToken) params.pageToken = pageToken;

      const res = await this._request('playlistItems', params, page === 0 ? etag : null);

      if (res.notModified) {
        logger.debug(`Playlist ${playlistId}: not modified (ETag hit)`);
        return { items: [], etag, notModified: true };
      }

      if (page === 0) finalEtag = res.etag;

      allItems.push(...(res.items || []).map(item => ({
        videoId: item.contentDetails.videoId,
        title: item.snippet.title,
        publishedAt: item.snippet.publishedAt,
        channelId: item.snippet.channelId,
      })));

      if (!res.nextPageToken) break;
      pageToken = res.nextPageToken;
    }

    return { items: allItems, etag: finalEtag, notModified: false };
  }

  /**
   * Gets video details (duration) for filtering Shorts.
   * Costs 1 unit per 50 video IDs.
   */
  async getVideoDetails(videoIds) {
    if (videoIds.length === 0) return [];

    // Batch in groups of 50
    const results = [];
    for (let i = 0; i < videoIds.length; i += 50) {
      const batch = videoIds.slice(i, i + 50);
      const res = await this._request('videos', {
        part: 'contentDetails,snippet',
        id: batch.join(','),
      });

      for (const item of (res.items || [])) {
        results.push({
          id: item.id,
          title: item.snippet.title,
          channelId: item.snippet.channelId,
          duration: item.contentDetails.duration,
          durationSec: this._parseDuration(item.contentDetails.duration),
        });
      }
    }

    return results;
  }

  /**
   * Parses ISO 8601 duration (PT30S, PT1M15S, etc.) to seconds.
   */
  _parseDuration(iso) {
    const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return 0;
    const hours = parseInt(match[1] || '0', 10);
    const minutes = parseInt(match[2] || '0', 10);
    const seconds = parseInt(match[3] || '0', 10);
    return hours * 3600 + minutes * 60 + seconds;
  }
}

module.exports = { YouTubeClient };
