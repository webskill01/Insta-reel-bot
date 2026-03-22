# Instagram Reel Bot

An autonomous bot that downloads YouTube Shorts from curated channels, generates AI captions, and reposts them as Instagram Reels (and optionally Facebook videos) on multiple business accounts using the official Meta Graph API.

## How It Works

```
YouTube Shorts ──► Download ──► Transform ──► AI Caption ──► Instagram Reels
   (yt-dlp)         (FFmpeg)      (Groq AI)     (Graph API)       + Facebook Page
```

### Pipeline Flow

1. **Discovery** — The bot scans your configured YouTube channels every 4 hours using the YouTube Data API v3. It finds new Shorts (videos ≤ 60 seconds) and stores them in a local SQLite database. Channels are configured in `config/channels.json` and auto-linked to accounts by niche at startup.

2. **Scheduling** — At 00:01 each day, the bot generates randomized posting times for each Instagram account across three time windows:
   - Morning: 8:00 AM – 9:00 AM
   - Afternoon: 2:00 PM – 3:00 PM
   - Evening: 8:00 PM – 10:00 PM

   The scheduler is self-healing: if the midnight cron misses (rare edge case), the 2-minute execution tick detects the new day and replans automatically within 2 minutes.

3. **Download** — When a posting time arrives, the bot picks a random un-posted Short matching the account's niche and downloads it via `yt-dlp`.

4. **Transform** — The video is processed through FFmpeg with slight modifications (crop, zoom, or watermark) to differentiate it from the original. Presets rotate automatically.

5. **AI Caption Generation** — Before uploading, the bot generates platform-aware captions using the Groq API (free tier). Instagram captions are emoji-rich with hooks and hashtags; Facebook captions are conversational with fewer hashtags. Falls back to `config/captions.json` templates if Groq is unavailable. Caption tone per niche is configurable in `config/posting.json`.

6. **Upload** — The processed video is served via Nginx (behind a Cloudflare Tunnel for HTTPS) as a public URL, then uploaded to Instagram using the Graph API's two-step container flow (create container → poll until ready → publish).

7. **Facebook Cross-posting** — After a successful Instagram upload, the same video is optionally posted to a Facebook Page with its own caption. This is non-blocking — if Facebook fails, the Instagram post is already done.

8. **Cleanup** — Both raw and processed video files are deleted from disk immediately after a successful upload.

### Multi-Account Support

Each Instagram account is configured with:
- A **niche** (e.g., motivation, finance, tech) that determines which YouTube channels it pulls from
- A **daily post limit** (default: 3 per day)
- Its own **randomized schedule** — no two accounts post at the same time
- An optional **linked Facebook Page** for cross-posting

### Reliability Features

- **Self-healing scheduler** — detects missed midnight cron, replans within 2 minutes
- **Daily failed video reset** — videos that failed the previous day are reset to retry automatically
- **Retry with exponential backoff** on all API calls and downloads
- **Rate limiter** — stays under Instagram's 200 requests/hour limit
- **Token auto-refresh** — refreshes Instagram tokens 10 days before expiry
- **Health monitor** — checks disk usage, stuck videos, DB health, and Nginx every 15 minutes
- **Graceful shutdown** — waits for in-flight uploads to finish before stopping
- **Duplicate prevention** — 4-layer system ensures the same video is never posted twice to the same account
- **Deep content scanning** — fetches up to 5 pages per channel (250 videos), 5-month content window

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
| **cloudflared** | Cloudflare Tunnel for HTTPS (required by Meta) |

You also need:
- A **YouTube Data API v3** key ([get one here](https://console.cloud.google.com/apis/credentials))
- One or more **Instagram Business/Creator accounts** with Graph API access
- **Long-lived Instagram access tokens** for each account
- A **Cloudflare Tunnel** with a domain pointing to your Nginx port (Meta's servers require HTTPS to fetch videos — plain HTTP will fail)
- *(Optional)* A **Groq API key** (free at console.groq.com — no credit card needed) for AI captions
- *(Optional)* A **Facebook Page** and Page access token for cross-posting

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

### Step 2: Set Up Cloudflare Tunnel (Required)

Meta's servers require HTTPS to fetch your videos. A plain `http://your-ip:8888` URL will always fail with a container error. You must use a Cloudflare Tunnel.

```bash
# Install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared

# Authenticate (opens browser — run on a machine with browser, then copy cert)
cloudflared tunnel login

# Create a tunnel
cloudflared tunnel create reel-bot

# Create config (replace with your tunnel ID and domain)
mkdir -p ~/.cloudflared
cat > ~/.cloudflared/config.yml << EOF
tunnel: YOUR-TUNNEL-ID
credentials-file: /home/botuser/.cloudflared/YOUR-TUNNEL-ID.json
ingress:
  - hostname: cdn.yourdomain.com
    service: http://localhost:8888
  - service: http_status:404
EOF

# Add DNS record (routes cdn.yourdomain.com → tunnel)
cloudflared tunnel route dns reel-bot cdn.yourdomain.com

# Start tunnel with PM2
pm2 start "cloudflared tunnel run reel-bot" --name cf-tunnel
pm2 save
```

Then set `NGINX_BASE_URL=https://cdn.yourdomain.com` in your `.env`.

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
```

Verify Nginx is working:
```bash
curl http://localhost:8888/health
# Should return: ok
```

### Step 4: Configure Environment Variables

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

# Your HTTPS CDN URL (Cloudflare Tunnel — Instagram fetches videos from this)
NGINX_BASE_URL=https://cdn.yourdomain.com

# Paths (defaults work for most setups)
DATA_DIR=./data
DB_PATH=./data/reel-bot.db

# Set to true to test without actually publishing to Instagram
DRY_RUN=false
LOG_LEVEL=info

# Groq AI captions — free at console.groq.com (no credit card needed)
# Leave blank to use captions.json templates instead
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxx
GROQ_MODEL=llama-3.1-8b-instant

# Facebook Page cross-posting (optional)
FB_POST_ENABLED=false
FB_PAGE_ID=
FB_PAGE_ACCESS_TOKEN=
```

### Step 5: Configure YouTube Channels

Edit `config/channels.json` to add your channels grouped by niche. The bot auto-links channels to all accounts sharing that niche at startup — no script needed.

```json
{
  "accounts": [
    {
      "niche": "motivation",
      "channels": [
        { "id": "UCxxxxxxxxxxxxxxxxxxxxxx", "name": "Motivation Channel" },
        { "id": "UCyyyyyyyyyyyyyyyyyyyyyy", "name": "Success Mindset" }
      ]
    },
    {
      "niche": "finance",
      "channels": [
        { "id": "UCzzzzzzzzzzzzzzzzzzzzzz", "name": "Finance Tips" }
      ]
    }
  ]
}
```

### Step 6: Configure Caption Settings

Edit `config/posting.json` to tweak caption behavior. This file is read per-post — changes take effect immediately without restarting the bot.

```json
{
  "groq": {
    "enabled": true,
    "model": "llama-3.1-8b-instant",
    "fallbackToTemplates": true
  },
  "instagram": {
    "captionPrefix": "",
    "captionSuffix": "\n\nFollow @yourhandle for more! 🔥",
    "maxHashtags": 15
  },
  "facebook": {
    "enabled": false,
    "captionPrefix": "",
    "captionSuffix": "\n\nLike & follow for daily videos! 👍",
    "maxHashtags": 5
  },
  "captionTone": {
    "motivation": "inspirational, uplifting, empowering, hustle culture",
    "finance": "value-focused, smart, practical, money-savvy"
  }
}
```

### Step 7: Test with Dry Run

```bash
# Set DRY_RUN=true in .env first, then:
node src/index.js
```

Check the logs to verify:
- Accounts are seeded from env vars
- YouTube channels are scanned and linked
- Shorts are discovered
- Schedule is generated
- Captions are generated (Groq or template fallback)

### Step 8: Go Live

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

# Restart the bot (required after .env changes)
pm2 restart reel-bot --update-env

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
│   ├── transforms.js           # FFmpeg transform presets
│   ├── channels.json           # YouTube channels by niche (auto-seeded at startup)
│   ├── captions.json           # Caption templates (fallback when Groq not set)
│   └── posting.json            # Tweakable caption/posting settings (live reload)
├── src/
│   ├── index.js                # Entry point — boots everything
│   ├── db/                     # SQLite database (better-sqlite3)
│   ├── scheduler/              # Cron jobs + randomized time windows
│   ├── discovery/              # YouTube API scanning
│   ├── downloader/             # yt-dlp wrapper
│   ├── transformer/            # FFmpeg processing
│   ├── publisher/
│   │   ├── igClient.js         # Instagram Graph API wrapper
│   │   ├── publishService.js   # Instagram publish flow
│   │   └── facebookClient.js   # Facebook Page video posting
│   ├── services/
│   │   └── captionService.js   # Groq AI captions + template fallback
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
| 00:01 daily | Daily Planner | Generates randomized posting times + resets failed videos |
| Every 2 min | Execution Tick | Checks for due posts, self-heals if planner missed |
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
4. Ensure YouTube channels are in `config/channels.json` with the correct niche

### Container always returns ERROR?
Meta's servers **must** be able to fetch videos via HTTPS. A plain `http://ip:port` URL will always fail.
1. Confirm `NGINX_BASE_URL` starts with `https://`
2. Verify your Cloudflare Tunnel is running: `pm2 status cf-tunnel`
3. Test: `curl https://cdn.yourdomain.com/health` should return `ok`

### Instagram token expired?
The bot auto-refreshes tokens 10 days before expiry. If a token expires, the account is deactivated. To fix:
1. Get a new long-lived token from Meta
2. Update `IG_ACCOUNT_N_ACCESS_TOKEN` in `.env`
3. Restart: `pm2 restart reel-bot --update-env`

### No posts planned for today?
If today shows 0 posting times in logs:
- Check the account is active: `SELECT is_active FROM accounts WHERE ig_username='yourhandle';` in SQLite
- If is_active=0, run: `UPDATE accounts SET is_active=1 WHERE ig_username='yourhandle';`
- The self-healing tick will replan within 2 minutes

### Disk filling up?
The bot deletes files after upload and runs cleanup at 4 AM. If disk still fills:
- Check `logs/` directory size — old logs may accumulate
- The health monitor triggers emergency cleanup at 90% disk usage automatically

### Captions look wrong?
- Edit `config/posting.json` — changes take effect on the next post (no restart needed)
- To disable Groq and use templates: set `GROQ_API_KEY=` (empty) in `.env`
- To change caption tone per niche: edit the `captionTone` object in `posting.json`

---

## Adding a New Niche / Account

See [docs/ADD-NEW-NICHE.md](docs/ADD-NEW-NICHE.md) for a complete step-by-step guide covering:
- Setting up Facebook Developer app permissions for new accounts
- Getting Instagram long-lived tokens
- Getting Facebook Page access tokens
- Adding channels and configuring the bot

---

## License

Private project. Not for redistribution.
