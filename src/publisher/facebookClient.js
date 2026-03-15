const https = require('https');
const logger = require('../utils/logger');
const config = require('../../config/default');

class FacebookClient {
  /**
   * Publishes a video to a Facebook Page.
   * Skips silently if facebook.enabled is false or credentials are missing.
   *
   * @param {string} videoUrl - Public HTTPS URL of the video (CDN URL)
   * @param {string} caption  - Facebook-specific caption/description
   * @returns {Promise<string|null>} - Facebook video ID, or null if skipped
   */
  async publishVideo(videoUrl, caption) {
    const { enabled, pageId, pageToken, graphApiVersion } = config.facebook;

    if (!enabled) return null;
    if (!pageId || !pageToken) {
      logger.warn('Facebook publishing enabled but FB_PAGE_ID or FB_PAGE_ACCESS_TOKEN is missing');
      return null;
    }

    const body = JSON.stringify({
      file_url: videoUrl,
      description: caption,
      access_token: pageToken,
    });

    logger.debug(`Posting to Facebook Page ${pageId}`);

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'graph.facebook.com',
        path: `/${graphApiVersion}/${pageId}/videos`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              return reject(new Error(`FB API: ${parsed.error.message} (code ${parsed.error.code})`));
            }
            logger.info(`Facebook video published: ${parsed.id}`);
            resolve(parsed.id);
          } catch (e) {
            reject(new Error(`FB parse error: ${e.message}`));
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(60000, () => { req.destroy(); reject(new Error('Facebook publish timeout')); });
      req.write(body);
      req.end();
    });
  }
}

module.exports = { FacebookClient };
