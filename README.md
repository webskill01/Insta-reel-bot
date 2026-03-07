# Instagram Reel Bot

An autonomous bot that downloads YouTube Shorts from curated channels and reposts them as Instagram Reels on multiple business accounts using the official Instagram Graph API.

## How It Works

```
YouTube Shorts ──► Download ──► Transform ──► Upload ──► Instagram Reels
   (yt-dlp)         (FFmpeg)      (Graph API)
```

### Pipeline Flow

1. **Discovery** — The bot scans your configured YouTube channels every 4 hours using the YouTube Data API v3. It finds new Shorts (videos ≤ 60 seconds) and stores them in a local SQLite database.

2. **Scheduling** — At midnight each day, the bot generates randomized posting times for each Instagram account across three time windows:
   - Morning: 7:00 AM – 9:30 AM
   - Afternoon: 12:00 PM – 2:30 PM
   - Evening: 6:00 PM – 9:00 PM

3. **Download** — When a posting time arrives, the bot picks a random un-posted Short matching the account's niche and downloads it via `yt-dlp`.

4. **Transform** — The video is processed through FFmpeg with slight modifications (crop, zoom, or watermark) to differentiate it from the original. Presets rotate automatically.

5. **Upload** — The processed video is served via Nginx as a public URL, then uploaded to Instagram using the Graph API's two-step container flow (create container → poll until ready → publish).

6. **Cleanup** — Both raw and processed video files are deleted from disk immediately after a successful upload to save space.

### Multi-Account Support

Each Instagram account is configured with:
- A **niche** (e.g., motivation, finance, tech) that determines which YouTube channels it pulls from
- A **daily post limit** (default: 3 per day)
- Its own **randomized schedule** — no two accounts post at the same time

### Reliability Features

- **Retry with exponential backoff** on all API calls and downloads
- **Rate limiter** — stays under Instagram's 200 requests/hour limit
- **Token auto-refresh** — refreshes Instagram tokens 10 days before expiry
- **Health monitor** — checks disk usage, stuck videos, DB health, and Nginx every 15 minutes
- **Graceful shutdown** — waits for in-flight uploads to finish before stopping
- **Duplicate prevention** — 4-layer system ensures the same video is never posted twice to the same account

---

## Prerequisites

You need the following on your VPS (Linux server):

| Tool | Purpose |
|------|---------|
| **Node.js 20+** | Runtime |
| **FFmpeg** | Video processing |
| **yt-dlp** | YouTube downloading |
| **Nginx** | Serving video files as public URLs |
| **PM2** | Process management |

You also need:
- A **YouTube Data API v3** key ([get one here](https://console.cloud.google.com/apis/credentials))
- One or more **Instagram Business/Creator accounts** with Graph API access
- **Long-lived access tokens** for each Instagram account ([Meta developer docs](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/get-started))

---

## Setup Guide

### Step 1: Clone and Install

```bash
# Clone the project to your VPS
git clone <your-repo-url> /opt/reel-bot
cd /opt/reel-bot

# Or use the automated setup script (installs all system deps too)
bash scripts/setup.sh
```

If setting up manually:

```bash
# Install system dependencies
sudo apt update && sudo apt install -y nginx ffmpeg python3-pip
pip3 install --user yt-dlp

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2 globally
sudo npm install -g pm2

# Install project dependencies
cd /opt/reel-bot
npm install --production
```

### Step 2: Configure Environment Variables

```bash
cp .env.example .env
nano .env
```

Fill in your actual values:

```env
# YouTube Data API v3 key
YOUTUBE_API_KEY=AIzaSy...your_key

# Instagram Account 1
IG_ACCOUNT_1_USER_ID=17841400000000000
IG_ACCOUNT_1_USERNAME=motivation_daily
IG_ACCOUNT_1_ACCESS_TOKEN=IGQVJ...your_token
IG_ACCOUNT_1_NICHE=motivation
IG_ACCOUNT_1_MAX_POSTS_DAY=3

# Instagram Account 2 (add as many as needed)
IG_ACCOUNT_2_USER_ID=17841400000000001
IG_ACCOUNT_2_USERNAME=finance_tips
IG_ACCOUNT_2_ACCESS_TOKEN=IGQVJ...your_token
IG_ACCOUNT_2_NICHE=finance
IG_ACCOUNT_2_MAX_POSTS_DAY=3

# Your VPS public URL (used by Instagram to fetch videos)
NGINX_BASE_URL=http://your-server-ip:8888

# Paths (defaults work for most setups)
DATA_DIR=./data
DB_PATH=./data/reel-bot.db

# Set to true to test without actually publishing to Instagram
DRY_RUN=false
LOG_LEVEL=info
```

### Step 3: Configure Nginx

```bash
# Copy the provided Nginx config
sudo cp nginx/reel-bot.conf /etc/nginx/sites-available/reel-bot
sudo ln -sf /etc/nginx/sites-available/reel-bot /etc/nginx/sites-enabled/

# Update the alias path in the config if your data dir is different
# Default expects: /opt/reel-bot/data/processed/
sudo nano /etc/nginx/sites-available/reel-bot

# Test and reload
sudo nginx -t && sudo systemctl reload nginx

# Open the port in firewall
sudo ufw allow 8888/tcp
```

Verify Nginx is working:
```bash
curl http://localhost:8888/health
# Should return: ok
```

### Step 4: Add YouTube Channels

```bash
# Add channels for each niche
node scripts/seed-accounts.js add-channel \
  --id UCxxxxxxxxxxxxxxxxxxxxxx \
  --name "Motivation Channel" \
  --niche motivation

node scripts/seed-accounts.js add-channel \
  --id UCyyyyyyyyyyyyyyyyyyyyyy \
  --name "Finance Channel" \
  --niche finance

# Link channels to accounts (use IDs from list commands)
node scripts/seed-accounts.js link-channel --account-id 1 --channel-id 1
node scripts/seed-accounts.js link-channel --account-id 2 --channel-id 2

# Verify setup
node scripts/seed-accounts.js list-accounts
node scripts/seed-accounts.js list-channels
```

### Step 5: Test with Dry Run

```bash
# Set DRY_RUN=true in .env first, then:
node src/index.js
```

Check the logs to verify:
- Accounts are seeded from env vars
- YouTube channels are scanned
- Shorts are discovered
- Schedule is generated

### Step 6: Go Live

```bash
# Set DRY_RUN=false in .env, then start with PM2:
pm2 start ecosystem.config.js
pm2 save

# Enable auto-start on server reboot
pm2 startup
# Follow the printed command
```

---

## Managing the Bot

### Useful Commands

```bash
# View live logs
pm2 logs reel-bot

# Check process status
pm2 status

# Restart the bot
pm2 restart reel-bot

# Stop the bot
pm2 stop reel-bot

# View system stats
node scripts/seed-accounts.js stats

# List accounts and channels
node scripts/seed-accounts.js list-accounts
node scripts/seed-accounts.js list-channels
```

### Log Files

| File | Contents |
|------|----------|
| `logs/app.log` | All application logs |
| `logs/error.log` | Errors only |
| `logs/pm2-out.log` | PM2 stdout |
| `logs/pm2-error.log` | PM2 stderr |

### Adding a Watermark

Place your watermark image at `data/watermarks/logo.png`. The bot will automatically overlay it on videos when the `watermark` transform preset is selected during rotation.

---

## Project Structure

```
insta-reel-bot/
├── config/
│   ├── default.js              # All config (schedules, limits, API settings)
│   └── transforms.js           # FFmpeg transform presets
├── src/
│   ├── index.js                # Entry point — boots everything
│   ├── db/                     # SQLite database (better-sqlite3)
│   ├── scheduler/              # Cron jobs + randomized time windows
│   ├── discovery/              # YouTube API scanning
│   ├── downloader/             # yt-dlp wrapper
│   ├── transformer/            # FFmpeg processing
│   ├── publisher/              # Instagram Graph API
│   ├── pipeline/               # Orchestrates the full flow
│   ├── cleanup/                # File deletion after upload
│   ├── tokens/                 # Auto-refresh Instagram tokens
│   ├── health/                 # System health monitoring
│   └── utils/                  # Logger, retry, rate limiter
├── data/                       # Runtime (raw/, processed/, watermarks/)
├── logs/                       # Application logs
├── nginx/                      # Nginx config
├── scripts/                    # Setup and management scripts
├── ecosystem.config.js         # PM2 configuration
└── .env                        # Secrets (not committed)
```

---

## Database

SQLite database at `data/reel-bot.db` with these tables:

| Table | Purpose |
|-------|---------|
| `accounts` | Instagram accounts, tokens, niche, limits |
| `channels` | YouTube channels to monitor |
| `account_channels` | Links accounts to channels (many-to-many) |
| `videos` | Discovered YouTube Shorts with status tracking |
| `posts` | Upload records (video + account + IG media ID) |
| `daily_stats` | Per-account daily post/failure counts |
| `token_refreshes` | Token refresh audit log |
| `etag_cache` | YouTube API ETag cache for quota savings |

---

## Scheduled Jobs

| Schedule | Job | Description |
|----------|-----|-------------|
| Midnight | Daily Planner | Generates randomized posting times |
| Every 2 min | Execution Tick | Checks for due posts and triggers pipeline |
| Every 4 hours | Discovery Scan | Scans YouTube channels for new Shorts |
| 3:00 AM | Token Refresh | Refreshes tokens expiring within 10 days |
| 4:00 AM | Orphan Cleanup | Deletes stale files older than 24 hours |
| Every 15 min | Health Check | Monitors disk, DB, Nginx, stuck videos |

---

## Troubleshooting

### Bot not posting?
1. Check `pm2 logs reel-bot` for errors
2. Verify `DRY_RUN=false` in `.env`
3. Run `node scripts/seed-accounts.js list-accounts` — check `is_active` is 1
4. Ensure YouTube channels are linked to accounts with matching niches

### Instagram token expired?
The bot auto-refreshes tokens 10 days before expiry. If a token expires, the account is deactivated. To fix:
1. Get a new long-lived token from Meta
2. Update `IG_ACCOUNT_N_ACCESS_TOKEN` in `.env`
3. Restart: `pm2 restart reel-bot`

### Videos not uploading?
1. Test Nginx: `curl http://your-ip:8888/health`
2. Check a video URL is accessible: `curl -I http://your-ip:8888/processed/somefile.mp4`
3. Ensure your VPS IP is publicly reachable on port 8888

### Disk filling up?
The bot deletes files after upload and runs cleanup at 4 AM. If disk still fills:
- Check `logs/` directory size — old logs may accumulate
- The health monitor triggers emergency cleanup at 90% disk usage automatically

---

## License

Private project. Not for redistribution.
