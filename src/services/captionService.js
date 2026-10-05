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

  // Per-account fixed caption: fixed text + Groq search keywords + niche hashtags
  const fixed = posting.fixedCaptions?.[account?.ig_username];

  let base;
  if (fixed) {
    const t = _templateFallback({ ...video, title: '' }, account);
    let kw = '';
    if (config.groq.apiKey && groqEnabled) {
      try {
        kw = await _groqKeywords(video);
      } catch (err) {
        logger.warn(`Groq keywords failed, posting without them: ${err.message}`);
      }
    }
    const head = kw ? `${fixed}\n\n${kw}` : fixed;
    base = { instagram: `${head}\n\n${t.instagram}`, facebook: `${head}\n\n${t.facebook}` };
  } else if (config.groq.apiKey && groqEnabled) {
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

  // Apply prefix, suffix, and universal content from posting.json
  const igSettings = posting.instagram || {};
  const fbSettings = posting.facebook || {};

  return {
    instagram: capHashtags(_applyWrap(
      base.instagram,
      igSettings.captionPrefix,
      igSettings.captionSuffix,
      igSettings.universalText,
      igSettings.universalHashtags
    ), igSettings.maxHashtags || 5),
    facebook: _applyWrap(
      base.facebook,
      fbSettings.captionPrefix,
      fbSettings.captionSuffix,
      fbSettings.universalText,
      fbSettings.universalHashtags
    ),
  };
}

// Instagram caps posts at 5 hashtags (Dec 2025); drop any beyond the limit
function capHashtags(caption, max) {
  let n = 0;
  return caption.replace(/#[\p{L}\p{N}_]+/gu, tag => (++n <= max ? tag : ''))
    .replace(/[ \t]+/g, ' ').replace(/ +\n/g, '\n').trim();
}

function _applyWrap(caption, prefix, suffix, universalText, universalHashtags) {
  const parts = [];
  if (prefix && prefix.trim()) parts.push(prefix.trim());
  parts.push(caption);
  if (suffix && suffix.trim()) parts.push(suffix.trim());
  if (universalText && universalText.trim()) parts.push(universalText.trim());
  if (universalHashtags && universalHashtags.length > 0) {
    parts.push(universalHashtags.join(' '));
  }
  return parts.join('\n');
}

async function _groqGenerate(video, posting) {
  const tone = (posting.captionTone || {})[video.niche] || 'engaging, entertaining, fun';
  const igMax = (posting.instagram || {}).maxHashtags || 15;
  const fbMax = (posting.facebook || {}).maxHashtags || 5;

  const systemPrompt = `You generate short-form video captions for social media. Return valid JSON only, no markdown fences.
Required schema: {"instagram": "...", "facebook": "..."}

CRITICAL RULES — follow these strictly:
- The source title/caption is provided as CONTEXT ONLY to understand the topic and theme (it may be empty or just hashtags)
- Do NOT copy the source title/caption — write something completely original
- Do NOT mention any creator names, channel names, @handles, or any person's name from it
- Do NOT use phrases like "from [channel]", "by [creator]", or reference the video source
- Write as if this is your own original content — purely about the topic itself

Instagram rules:
- Open with a short punchy hook (1 line, under 80 chars) that captures the video's theme; work in 1-2 plain search keywords (e.g. "funny meme", "relatable") since Instagram search reads caption text
- Tone: ${tone}
- Body: 1-2 short lines expanding on the hook
- Add EXACTLY ${igMax} hashtags (Instagram rejects more) on a new line after the body: 2 broad + the rest specific, all about the "${video.niche}" niche (e.g. for memes: #memes #funny #relatablememes), NOT about the video's specific topic
- Never use #reels #viral #fyp #explore #trending — Instagram says they hurt reach
- End with a CTA that drives shares/saves, like "Send this to that one friend 😭" or "Follow for more"

Facebook rules:
- 2-3 sentences, friendly and conversational, about the topic
- Slightly less emoji than Instagram
- Add ${fbMax} hashtags at the end
- End with "Like and follow for more videos!"

Both captions are for a SHORT VIDEO (Reel). Make them feel native to each platform.`;

  const userPrompt = `Source title/caption (use for topic/theme context only — do NOT copy or mention any names from it): "${video.title || '(none)'}"
Niche: ${video.niche}
Generate original platform-specific captions about the theme of this video.`;

  const content = await _groqChat(systemPrompt, userPrompt, 0.85);
  if (!content.instagram || !content.facebook) {
    throw new Error('Groq response missing instagram/facebook fields');
  }
  return { instagram: content.instagram, facebook: content.facebook };
}

// Search keywords only (no hashtags) — Instagram search reads caption text
async function _groqKeywords(video) {
  const systemPrompt = `You write Instagram search keywords for a short video. Return valid JSON only: {"keywords": ["...", "..."]}
- 4 to 6 short lowercase search phrases (1-3 words each) people would type into Instagram search to find this video
- Mix the video's topic/theme with the "${video.niche}" niche (e.g. "funny memes", "relatable video")
- No hashtags, no emojis, no person, creator or channel names`;
  const userPrompt = `Source title/caption (context only): "${video.title || '(none)'}"\nNiche: ${video.niche}`;
  const content = await _groqChat(systemPrompt, userPrompt, 0.5);
  if (!Array.isArray(content.keywords) || !content.keywords.length) {
    throw new Error('Groq response missing keywords');
  }
  return content.keywords.map(k => String(k).replace(/#/g, '').trim()).filter(Boolean).join(', ');
}

function _groqChat(systemPrompt, userPrompt, temperature) {
  const body = JSON.stringify({
    model: config.groq.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 1500,
    // gpt-oss reasons before answering; low effort keeps the budget for the JSON
    ...(/gpt-oss/.test(config.groq.model) && { reasoning_effort: 'low' }),
    temperature,
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
          resolve(JSON.parse(parsed.choices[0].message.content));
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

  // Instagram sources: never reuse the source caption, hashtags only
  const title = video.source_url ? '' : video.title.replace(/#\w+/g, '').replace(/\s+/g, ' ').trim();

  const nicheHashtags = nicheConfig.hashtags || [`#${video.niche}`];
  const appendHashtags = defaults.appendHashtags || [];
  const allHashtags = [...nicheHashtags, ...appendHashtags];
  const maxTags = nicheConfig.hashtagCount || defaults.hashtagCount || 15;
  const selected = [...allHashtags].sort(() => Math.random() - 0.5).slice(0, maxTags);
  const hashtagString = selected.join(' ');

  const template = nicheConfig.captionTemplate || defaults.captionTemplate || '{title}\n\n{hashtags}';
  const caption = template.replace('{title}', title).replace('{hashtags}', hashtagString).trim();

  // Facebook gets fewer hashtags
  const fbSelected = [...allHashtags].sort(() => Math.random() - 0.5).slice(0, 5);
  const fbHashtagString = fbSelected.join(' ');
  const fbCaption = `${title}\n\n${fbHashtagString}`;

  return { instagram: caption, facebook: fbCaption };
}

module.exports = { generateCaptions, capHashtags };
