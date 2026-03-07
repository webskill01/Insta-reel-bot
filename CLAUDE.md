# CLAUDE.md — Project Context for Claude Code

## What This Project Is

An autonomous Instagram Reel automation bot built with Node.js. It downloads YouTube Shorts from curated channels, applies FFmpeg transforms, and uploads them as Instagram Reels via the official Graph API. Runs 24/7 on a Linux VPS with PM2.

## Tech Stack

- **Runtime**: Node.js 20+
- **Database**: SQLite via `better-sqlite3` (WAL mode, single-writer)
- **Scheduling**: `node-cron` with randomized posting times
- **Logging**: `winston` with file rotation
- **Video download**: `yt-dlp` (spawned as child process)
- **Video processing**: `ffmpeg` (spawned as child process)
- **API**: Instagram Graph API v21.0, YouTube Data API v3
- **Process manager**: PM2
- **Static file server**: Nginx (serves processed videos for Instagram to fetch)

## Architecture

```
src/index.js (entry point)
  → boots DB, seeds accounts from env, starts scheduler

src/scheduler/scheduler.js
  → node-cron jobs: daily planner, 2-min execution tick, discovery, token refresh, cleanup, health

src/pipeline/coordinator.js
  → orchestrates per-account: pick video → download → transform → publish → cleanup

src/discovery/ → YouTube Data API v3 (quota-efficient: playlistItems + ETag caching)
src/downloader/ → yt-dlp wrapper
src/transformer/ → FFmpeg with configurable presets (config/transforms.js)
src/publisher/ → Instagram Graph API (container → poll → publish)
src/cleanup/ → deletes files immediately after publish + daily orphan scan
src/tokens/ → auto-refreshes IG tokens before 60-day expiry
src/health/ → disk, DB, Nginx, stuck video monitoring
```

## Key Files

| File | Purpose |
|------|---------|
| `config/default.js` | All configuration: paths, cron schedules, API limits, thresholds |
| `config/transforms.js` | FFmpeg preset definitions (crop, zoom, watermark) |
| `src/db/migrations/001_initial.sql` | Full database schema (8 tables) |
| `src/index.js` | Entry point, account seeding, graceful shutdown |
| `src/pipeline/coordinator.js` | Central pipeline orchestration |
| `src/publisher/igClient.js` | Instagram Graph API wrapper |
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
- **YouTube channels are added manually** via `scripts/seed-accounts.js`
- **Files are deleted immediately after publish** — no long-term video storage
- **DRY_RUN=true** skips actual Instagram publishing for testing

## Instagram Graph API Flow

1. `POST /{ig_user_id}/media` with `media_type=REELS`, `video_url` (public Nginx URL), `caption`
2. Poll `GET /{container_id}?fields=status_code` every 30s until `FINISHED`
3. `POST /{ig_user_id}/media_publish` with `creation_id`
4. Video URL must be direct, public, no redirects — served by Nginx on port 8888

## YouTube API Quota

- Uses `playlistItems.list` (1 unit) NOT `search.list` (100 units)
- ETag caching returns 304 for unchanged playlists (0 units)
- Budget: ~250 units/day for 50 channels (limit is 10,000/day)

## Common Tasks

- **Add a new niche**: Add channels via seed script, set account niche in `.env`
- **Change posting schedule**: Edit `postingWindows` in `config/default.js`
- **Add transform preset**: Add entry to `config/transforms.js`, update `presetRotation` array
- **Change daily limit**: Set `IG_ACCOUNT_N_MAX_POSTS_DAY` in `.env` or update `accounts.max_posts_day` in DB

## Testing

- Set `DRY_RUN=true` in `.env` to run the full pipeline without publishing
- Run `node scripts/seed-accounts.js stats` to check system state
- Logs are in `logs/app.log` and `logs/error.log`
