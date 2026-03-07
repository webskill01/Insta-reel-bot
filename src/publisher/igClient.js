const https = require('https');
const logger = require('../utils/logger');
const config = require('../../config/default');

class IGClient {
  constructor(rateLimiter) {
    this.rateLimiter = rateLimiter;
    this.apiBase = config.instagram.graphApiBase;
    this.apiVersion = config.instagram.graphApiVersion;
  }

  /**
   * Makes an API request to Instagram Graph API.
   */
  async _request(method, endpoint, params = {}) {
    await this.rateLimiter.acquire();

    const url = new URL(`${this.apiBase}/${this.apiVersion}/${endpoint}`);

    return new Promise((resolve, reject) => {
      let body = null;
      const options = {
        method,
        headers: {},
      };

      if (method === 'GET') {
        for (const [k, v] of Object.entries(params)) {
          url.searchParams.set(k, v);
        }
      } else {
        body = JSON.stringify(params);
        options.headers['Content-Type'] = 'application/json';
        options.headers['Content-Length'] = Buffer.byteLength(body);
      }

      const req = https.request(url.toString(), options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);

            if (res.statusCode >= 400) {
              const errMsg = parsed.error?.message || data;
              const errCode = parsed.error?.code;
              const err = new Error(`IG API ${res.statusCode}: ${errMsg}`);
              err.statusCode = res.statusCode;
              err.igErrorCode = errCode;
              err.igErrorSubcode = parsed.error?.error_subcode;
              return reject(err);
            }

            resolve(parsed);
          } catch (e) {
            reject(new Error(`IG API parse error: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('IG API request timeout'));
      });

      if (body) req.write(body);
      req.end();
    });
  }

  /**
   * Step 1: Create a media container for a Reel.
   * POST /{ig_user_id}/media
   */
  async createContainer(igUserId, accessToken, videoUrl, caption, metadata = {}) {
    logger.debug(`Creating IG container for ${igUserId}`);

    const body = {
      media_type: 'REELS',
      video_url: videoUrl,
      caption: caption || '',
      access_token: accessToken,
    };

    // Forward optional IG metadata fields if provided
    const allowedFields = ['share_to_feed', 'cover_url', 'location_id', 'collaborators'];
    for (const field of allowedFields) {
      if (metadata[field] !== undefined && metadata[field] !== null) {
        body[field] = metadata[field];
      }
    }

    const result = await this._request('POST', `${igUserId}/media`, body);

    if (!result.id) {
      throw new Error('IG container creation returned no ID');
    }

    logger.info(`IG container created: ${result.id}`);
    return result.id;
  }

  /**
   * Step 2: Poll container status until FINISHED or ERROR.
   * GET /{container_id}?fields=status_code
   */
  async pollContainerStatus(containerId, accessToken) {
    const maxAttempts = config.instagram.containerPollMaxAttempts;
    const interval = config.instagram.containerPollIntervalMs;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await this._request('GET', containerId, {
        fields: 'status_code',
        access_token: accessToken,
      });

      const status = result.status_code;
      logger.debug(`Container ${containerId} status: ${status} (attempt ${attempt}/${maxAttempts})`);

      if (status === 'FINISHED') {
        return 'FINISHED';
      }

      if (status === 'ERROR') {
        throw new Error(`IG container processing failed: ${JSON.stringify(result)}`);
      }

      // IN_PROGRESS - wait and poll again
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, interval));
      }
    }

    throw new Error(`IG container polling timed out after ${maxAttempts} attempts`);
  }

  /**
   * Step 3: Publish the container.
   * POST /{ig_user_id}/media_publish
   */
  async publishContainer(igUserId, accessToken, containerId) {
    logger.debug(`Publishing IG container ${containerId}`);

    const result = await this._request('POST', `${igUserId}/media_publish`, {
      creation_id: containerId,
      access_token: accessToken,
    });

    if (!result.id) {
      throw new Error('IG publish returned no media ID');
    }

    logger.info(`IG reel published: ${result.id}`);
    return result.id;
  }

  /**
   * Step 4: Verify that the published media exists.
   * GET /{media_id}?fields=id,timestamp,permalink
   */
  async verifyPublication(mediaId, accessToken) {
    const result = await this._request('GET', mediaId, {
      fields: 'id,timestamp,permalink',
      access_token: accessToken,
    });

    logger.info(`IG reel verified: ${result.permalink || result.id}`);
    return result;
  }

  /**
   * Refreshes a long-lived access token.
   * GET /refresh_access_token
   */
  async refreshToken(accessToken) {
    // Token refresh uses the base URL without version
    const url = new URL(`${this.apiBase}/refresh_access_token`);
    url.searchParams.set('grant_type', 'ig_refresh_token');
    url.searchParams.set('access_token', accessToken);

    await this.rateLimiter.acquire();

    return new Promise((resolve, reject) => {
      https.get(url.toString(), (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 400) {
              return reject(new Error(`Token refresh failed: ${parsed.error?.message || data}`));
            }
            resolve({
              access_token: parsed.access_token,
              expires_in: parsed.expires_in,
            });
          } catch (e) {
            reject(new Error(`Token refresh parse error: ${e.message}`));
          }
        });
      }).on('error', reject);
    });
  }
}

module.exports = { IGClient };
