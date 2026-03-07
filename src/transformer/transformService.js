const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');
const config = require('../../config/default');
const transformConfig = require('../../config/transforms');

class TransformService {
  constructor(outputDir) {
    this.outputDir = outputDir || config.processedDir;
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
    this._rotationIndex = 0;
  }

  /**
   * Applies FFmpeg transforms to a video.
   * @param {string} inputPath - path to raw video
   * @param {string} videoId - used for output filename
   * @param {Object} options - { presetName, watermarkPath }
   * @returns {Promise<string>} path to processed video
   */
  async transform(inputPath, videoId, options = {}) {
    const outputPath = path.resolve(this.outputDir, `${videoId}.mp4`);
    const presetName = options.presetName || this._getNextPreset();
    const preset = transformConfig.presets[presetName];

    if (!preset) {
      throw new Error(`Unknown transform preset: ${presetName}`);
    }

    return withRetry(async () => {
      const args = this.buildCommand(inputPath, outputPath, preset, options);
      await this._runFfmpeg(args);

      if (!fs.existsSync(outputPath)) {
        throw new Error(`FFmpeg produced no output: ${outputPath}`);
      }

      const stats = fs.statSync(outputPath);
      logger.info(`Transformed: ${videoId} (preset=${presetName}, size=${(stats.size / 1024 / 1024).toFixed(1)}MB)`);
      return outputPath;
    }, {
      maxRetries: 1,
      baseDelay: 3000,
      label: `transform(${videoId})`,
    });
  }

  /**
   * Builds the FFmpeg command arguments.
   */
  buildCommand(inputPath, outputPath, preset, options = {}) {
    const args = ['-y', '-i', inputPath];

    // Add watermark input if using watermark preset
    const watermarkPath = options.watermarkPath ||
      (preset.useFilterComplex && fs.existsSync(path.join(config.watermarksDir, 'logo.png'))
        ? path.join(config.watermarksDir, 'logo.png')
        : null);

    if (preset.useFilterComplex && watermarkPath) {
      args.push('-i', watermarkPath);
      args.push('-filter_complex', preset.filterComplex);
      args.push('-map', '[bg]', '-map', '0:a?');
    } else {
      args.push('-vf', preset.videoFilters.join(','));
    }

    args.push(
      '-c:v', preset.videoCodec,
      '-preset', preset.preset,
      '-crf', String(preset.crf),
      '-b:v', preset.videoBitrate,
      '-maxrate', preset.videoBitrate,
      '-bufsize', '8M',
      '-c:a', preset.audioCodec,
      '-b:a', preset.audioBitrate,
      '-ar', String(preset.audioSampleRate),
      '-movflags', '+faststart',
      '-t', '90',
      outputPath
    );

    return args;
  }

  /**
   * Runs FFmpeg as a child process.
   */
  _runFfmpeg(args) {
    return new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`FFmpeg timeout after ${config.transform.timeoutMs}ms`));
      }, config.transform.timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`FFmpeg spawn error: ${err.message}`));
      });
    });
  }

  /**
   * Rotates through transform presets for variety.
   */
  _getNextPreset() {
    const rotation = transformConfig.presetRotation;
    const preset = rotation[this._rotationIndex % rotation.length];
    this._rotationIndex++;
    return preset;
  }
}

module.exports = { TransformService };
