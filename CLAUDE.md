# CLAUDE.md — Project Context for Claude Code

## What This Project Is

An autonomous Instagram Reel automation bot built with Node.js. It downloads YouTube Shorts from curated channels, generates AI captions via Groq, applies FFmpeg transforms, and uploads them as Instagram Reels (plus optional Facebook Page cross-posts) via the official Meta Graph API. Runs 24/7 on a Linux VPS with PM2.

## Tech Stack

- **Runtime**: Node.js 20+
- **Database**: SQLite via `better-sqlite3` (WAL mode, single-writer)
- **Scheduling**: `node-cron` with randomized posting times
- **Logging**: `winston` with file rotation
- **Video download**: `yt-dlp` (spawned as child process)
- **Video processing**: `ffmpeg` (spawned as child process)
- **API**: Instagram Graph API v21.0, YouTube Data API v3, Groq API (AI captions)
- **Process manager**: PM2
- **Static file server**: Nginx (serves processed videos) behind Cloudflare Tunnel (HTTPS required by Meta)

## Architecture

```
src/index.js (entry point)
  → boots DB, seeds accounts from env, syncs channels.json, starts scheduler

src/scheduler/scheduler.js
  → node-cron jobs: daily planner (00:01), 2-min execution tick (self-healing), discovery, token refresh, cleanup, health
  → _lastPlanDate tracks last plan date; executePendingPosts() replans if midnight cron missed

src/pipeline/coordinator.js
  → pick video → download → transform → generate captions → publish IG → cross-post FB → cleanup

src/services/captionService.js  [NEW]
  → Groq API (llama-3.1-8b-instant) for platform-aware captions
  → Falls back to captions.json templates if Groq fails or key not set
  → Reads config/posting.json per-call for prefix/suffix/tone (live reload)

src/discovery/ → YouTube Data API v3 (quota-efficient: playlistItems + ETag caching)
src/downloader/ → yt-dlp wrapper
src/transformer/ → FFmpeg with configurable presets (config/transforms.js)
src/publisher/igClient.js → Instagram Graph API (container → poll → publish)
src/publisher/facebookClient.js  [NEW] → Facebook Page video posting via Graph API
src/cleanup/ → deletes files immediately after publish + daily orphan scan
src/tokens/ → auto-refreshes IG tokens before 60-day expiry
src/health/ → disk, DB, Nginx, stuck video monitoring
```

## Key Files

| File | Purpose |
|------|---------|
| `config/default.js` | All configuration: paths, cron schedules, API limits, groq/facebook settings |
| `config/transforms.js` | FFmpeg preset definitions (crop, zoom, watermark) |
| `config/channels.json` | YouTube channels by niche — auto-synced to DB at startup |
| `config/captions.json` | Caption templates (fallback when Groq not configured) |
| `config/posting.json` | Tweakable caption/posting settings — read per-post, no restart needed |
| `src/db/migrations/001_initial.sql` | Full database schema (8 tables) |
| `src/index.js` | Entry point, account seeding, channel sync, graceful shutdown |
| `src/pipeline/coordinator.js` | Central pipeline orchestration |
| `src/services/captionService.js` | Groq AI caption generation + template fallback |
| `src/publisher/igClient.js` | Instagram Graph API wrapper |
| `src/publisher/facebookClient.js` | Facebook Page video publishing |
| `src/discovery/youtubeClient.js` | YouTube Data API wrapper |
| `.env.example` | All required environment variables |
| `ecosystem.config.js` | PM2 process configuration |
| `nginx/reel-bot.conf` | Nginx config for serving video files |

## Database Tables

`accounts`, `channels`, `account_channels`, `videos`, `posts`, `daily_stats`, `token_refreshes`, `etag_cache`

- Videos track status: `discovered → downloading → downloaded → transforming → transformed → publishing → published`
- Posts track status: `pending → container_created → polling → published`
- Row locking via `videos.locked_by` prevents concurrent processing

## Important Patterns

- **No external HTTP libraries** — all API calls use native `https` module
- **Retry with exponential backoff** — `src/utils/retry.js` wraps all external calls
- **Rate limiter** — token bucket in `src/utils/rateLimiter.js` (180 req/hr for IG API)
- **Accounts are seeded from env vars** at startup (`IG_ACCOUNT_N_*` pattern)
- **YouTube channels are configured in `config/channels.json`** — auto-linked to accounts by niche at startup; no seed script needed
- **`config/posting.json` is read per-post** — caption prefix/suffix/tone changes take effect immediately without restart
- **Files are deleted immediately after publish** — no long-term video storage
- **DRY_RUN=true** skips actual Instagram publishing for testing
- **Self-healing scheduler** — `executePendingPosts()` tracks `_lastPlanDate` and calls `planDay()` if the midnight cron missed
- **Daily failed video reset** — `planDay()` resets all `status='failed'` videos to `status='discovered'` each morning

## Instagram Graph API Flow

1. `POST /{ig_user_id}/media` with `media_type=REELS`, `video_url` (HTTPS public URL), `caption`
2. Poll `GET /{container_id}?fields=status_code` every 30s until `FINISHED`
3. `POST /{ig_user_id}/media_publish` with `creation_id`
4. Video URL **must be HTTPS** — Meta's servers reject plain HTTP. Use Cloudflare Tunnel.
5. API base is `graph.facebook.com` (NOT `graph.instagram.com`) — Facebook Login flow requires this

## Facebook Cross-posting Flow

1. Enabled via `FB_POST_ENABLED=true` + `FB_PAGE_ID` + `FB_PAGE_ACCESS_TOKEN` in `.env`
2. After successful IG publish: `POST /{version}/{pageId}/videos` with `file_url` + `description`
3. Non-blocking — FB failure does not affect Instagram post
4. Separate caption from Groq (shorter, conversational, fewer hashtags)

## Groq AI Caption Generation

- Free tier at console.groq.com — no credit card, ~30 req/min, 6000 req/day
- Model: `llama-3.1-8b-instant` (fast, free)
- Returns `{instagram: string, facebook: string}` — platform-aware
- Reads `captionTone` from `config/posting.json` to tune style per niche
- Applies `captionPrefix`/`captionSuffix` from `posting.json` after generation
- Falls back to `config/captions.json` templates if Groq fails or key not configured

## YouTube API Quota

- Uses `playlistItems.list` (1 unit) NOT `search.list` (100 units)
- ETag caching returns 304 for unchanged playlists (0 units)
- Budget: ~250 units/day for 50 channels (limit is 10,000/day)
- `deepScanPages: 5` fetches up to 250 videos per channel
- `maxContentAgeDays: 150` keeps a 5-month content buffer

## Common Tasks

- **Add a new niche/account**: See `docs/ADD-NEW-NICHE.md` for full walkthrough
- **Change posting schedule**: Edit `postingWindows` in `config/default.js`
- **Change caption tone**: Edit `captionTone` in `config/posting.json` (live, no restart)
- **Add caption prefix/suffix**: Edit `instagram.captionSuffix` in `config/posting.json` (live, no restart)
- **Add transform preset**: Add entry to `config/transforms.js`, update `presetRotation` array
- **Change daily limit**: Set `IG_ACCOUNT_N_MAX_POSTS_DAY` in `.env` or update `accounts.max_posts_day` in DB
- **Fix duplicate accounts in DB**: `DELETE FROM accounts WHERE ig_user_id != 'correct_id'`
- **Fix deactivated account**: `UPDATE accounts SET is_active=1 WHERE ig_username='handle'`
- **Reset stuck videos**: `UPDATE videos SET status='discovered', locked_by=NULL WHERE status='failed'`

## Testing

- Set `DRY_RUN=true` in `.env` to run the full pipeline without publishing
- Run `node scripts/seed-accounts.js stats` to check system state
- Logs are in `logs/app.log` and `logs/error.log`
- Restart after `.env` changes: `pm2 restart reel-bot --update-env`
