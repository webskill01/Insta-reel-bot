const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');
const config = require('../../config/default');

class DownloadService {
  constructor(outputDir) {
    this.outputDir = outputDir || config.rawDir;
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Downloads a YouTube Short via yt-dlp.
   * @param {string} youtubeId - YouTube video ID
   * @returns {Promise<string>} absolute path to downloaded file
   */
  async download(youtubeId) {
    const outputPath = path.resolve(this.outputDir, `${youtubeId}.mp4`);

    // Skip if already downloaded
    if (fs.existsSync(outputPath) && this.validateFile(outputPath)) {
      logger.debug(`Video already downloaded: ${youtubeId}`);
      return outputPath;
    }

    return withRetry(async () => {
      await this._runYtDlp(youtubeId, outputPath);

      if (!this.validateFile(outputPath)) {
        // Clean up bad file
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        throw new Error(`Downloaded file failed validation: ${youtubeId}`);
      }

      logger.info(`Downloaded: ${youtubeId} → ${outputPath}`);
      return outputPath;
    }, {
      maxRetries: 2,
      baseDelay: 5000,
      label: `download(${youtubeId})`,
    });
  }

  /**
   * Runs yt-dlp as a child process.
   */
  _runYtDlp(youtubeId, outputPath) {
    const url = `https://www.youtube.com/shorts/${youtubeId}`;

    const args = [
      '--no-playlist',
      '-f', 'bestvideo[height<=1920]+bestaudio/best',
      '--merge-output-format', 'mp4',
      '--no-warnings',
      '--no-progress',
      '-o', outputPath,
      url,
    ];

    return new Promise((resolve, reject) => {
      const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`yt-dlp timeout after ${config.download.timeoutMs}ms`));
      }, config.download.timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`yt-dlp exited with code ${code}: ${stderr.slice(0, 500)}`));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`yt-dlp spawn error: ${err.message}`));
      });
    });
  }

  /**
   * Validates a downloaded file by checking existence and size.
   */
  validateFile(filePath) {
    if (!fs.existsSync(filePath)) return false;

    const stats = fs.statSync(filePath);
    if (stats.size < config.download.minFileSizeBytes) {
      logger.warn(`File too small: ${filePath} (${stats.size} bytes)`);
      return false;
    }
    if (stats.size > config.download.maxFileSizeBytes) {
      logger.warn(`File too large: ${filePath} (${stats.size} bytes)`);
      return false;
    }

    return true;
  }
}

module.exports = { DownloadService };
