const https = require('https');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const config = require('../../config/default');

const CAPTIONS_PATH = path.join(__dirname, '../../config/captions.json');
const POSTING_PATH = path.join(__dirname, '../../config/posting.json');

/**
 * Loads posting.json fresh on each call (so edits take effect without restart).
 */
function loadPostingConfig() {
  try {
    return JSON.parse(fs.readFileSync(POSTING_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Generates captions for both Instagram and Facebook.
 * Uses Groq API if configured and enabled in posting.json, otherwise falls
 * back to the captions.json template system.
 *
 * @param {object} video   - { title, niche }
 * @param {object} account - { niche } (used for template fallback)
 * @returns {Promise<{instagram: string, facebook: string}>}
 */
async function generateCaptions(video, account) {
  const posting = loadPostingConfig();
  const groqEnabled = posting.groq?.enabled !== false;

  let base;
  if (config.groq.apiKey && groqEnabled) {
    try {
      base = await _groqGenerate(video, posting);
      logger.debug(`Generated Groq caption for: ${video.title.slice(0, 50)}`);
    } catch (err) {
      logger.warn(`Groq caption failed, using template fallback: ${err.message}`);
      base = _templateFallback(video, account);
    }
  } else {
    if (!config.groq.apiKey) {
      logger.debug('Groq not configured, using template fallback');
    }
    base = _templateFallback(video, account);
  }

  // Apply prefix and suffix from posting.json
  const igSettings = posting.instagram || {};
  const fbSettings = posting.facebook || {};

  return {
    instagram: _applyWrap(base.instagram, igSettings.captionPrefix, igSettings.captionSuffix),
    facebook:  _applyWrap(base.facebook,  fbSettings.captionPrefix, fbSettings.captionSuffix),
  };
}

function _applyWrap(caption, prefix, suffix) {
  const parts = [prefix, caption, suffix].filter(s => s && s.trim());
  return parts.join('\n');
}

async function _groqGenerate(video, posting) {
  const tone = (posting.captionTone || {})[video.niche] || 'engaging, entertaining, fun';
  const igMax = (posting.instagram || {}).maxHashtags || 15;
  const fbMax = (posting.facebook || {}).maxHashtags || 5;

  const systemPrompt = `You generate short-form video captions for social media. Return valid JSON only, no markdown fences.
Required schema: {"instagram": "...", "facebook": "..."}

Instagram rules:
- Hook in first line (attention-grabbing, platform-native)
- Tone: ${tone}
- Max 150 chars before hashtags
- Add ${igMax} relevant hashtags on a new line starting with newlines
- End with a CTA like "Follow for more 🔥" or "Save this 📌"

Facebook rules:
- 2-3 sentences, friendly and conversational
- Slightly less emoji than Instagram
- Add ${fbMax} hashtags inline or at the end
- End with "Like & follow for more videos!"

Both captions are for a SHORT VIDEO (Reel/Short). Make them feel native to each platform.`;

  const userPrompt = `Video title: "${video.title}"
Niche: ${video.niche}
Generate platform-specific captions for this short video.`;

  const body = JSON.stringify({
    model: config.groq.model || 'llama-3.1-8b-instant',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 500,
    temperature: 0.85,
    response_format: { type: 'json_object' },
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.groq.apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          const content = JSON.parse(parsed.choices[0].message.content);
          if (!content.instagram || !content.facebook) {
            return reject(new Error('Groq response missing instagram/facebook fields'));
          }
          resolve({ instagram: content.instagram, facebook: content.facebook });
        } catch (e) {
          reject(new Error(`Groq parse error: ${e.message} | raw: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Groq timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * Template fallback — uses captions.json (same logic as publishService.generateCaption).
 */
function _templateFallback(video, account) {
  let captionConfig;
  try {
    captionConfig = JSON.parse(fs.readFileSync(CAPTIONS_PATH, 'utf-8'));
  } catch {
    return { instagram: video.title, facebook: video.title };
  }

  const defaults = captionConfig.defaults || {};
  const nicheConfig = captionConfig.niches?.[account?.niche || video.niche] || {};

  const title = video.title.replace(/#\w+/g, '').replace(/\s+/g, ' ').trim();

  const nicheHashtags = nicheConfig.hashtags || [`#${video.niche}`];
  const appendHashtags = defaults.appendHashtags || [];
  const allHashtags = [...nicheHashtags, ...appendHashtags];
  const maxTags = nicheConfig.hashtagCount || defaults.hashtagCount || 15;
  const selected = [...allHashtags].sort(() => Math.random() - 0.5).slice(0, maxTags);
  const hashtagString = selected.join(' ');

  const template = nicheConfig.captionTemplate || defaults.captionTemplate || '{title}\n\n{hashtags}';
  const caption = template.replace('{title}', title).replace('{hashtags}', hashtagString);

  // Facebook gets fewer hashtags
  const fbSelected = [...allHashtags].sort(() => Math.random() - 0.5).slice(0, 5);
  const fbHashtagString = fbSelected.join(' ');
  const fbCaption = `${title}\n\n${fbHashtagString}`;

  return { instagram: caption, facebook: fbCaption };
}

module.exports = { generateCaptions };
