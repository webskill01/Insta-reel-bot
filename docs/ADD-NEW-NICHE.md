# Adding a New Niche — Step-by-Step Guide

This guide walks through everything needed to add a brand-new niche (e.g., `fitness`, `cooking`, `tech`) with a new Instagram account and optional Facebook Page to the **same running bot**. No new bot instance is needed.

---

## Overview

You will:
1. Set up the new Instagram account in Meta's Facebook Developer portal
2. Get a long-lived Instagram access token
3. (Optional) Get a Facebook Page access token for cross-posting
4. Add the account to `.env`
5. Add YouTube channels to `config/channels.json`
6. Configure caption tone in `config/posting.json`
7. Restart the bot

---

## Part 1: Facebook Developer Portal Setup

### 1.1 — Use Your Existing App

You do **not** need to create a new Facebook App. Your existing app (the one already connected to your first Instagram account) can handle multiple IG accounts. Just add the new account to the same app.

Go to: [developers.facebook.com/apps](https://developers.facebook.com/apps) → open your existing app.

### 1.2 — Add the New Instagram Account to Your App

Your app must be connected to a **Facebook Page that is linked to the Instagram Business account**.

#### If the Instagram account is already a Business/Creator account:

1. Go to your Facebook Page linked to the new Instagram account
2. Settings → Linked Accounts → connect the Instagram account (if not already linked)
3. In the Developer portal → your app → **Instagram** product → **API Setup**
4. Under "Add an Instagram account", enter the Instagram handle or log in — this connects the IG account to your app

#### If the Instagram account is Personal (needs converting):

1. Open Instagram → Profile → Settings → Account → Switch to Professional Account
2. Choose **Creator** or **Business** (Business gives more API access)
3. Connect it to a Facebook Page when prompted (create one if needed — a Page can be minimal, just needs to exist)
4. Come back to the Developer portal and add it per the steps above

### 1.3 — Required App Permissions

Your app needs these permissions (already granted if you set up the first account). Check under App Review:

| Permission | Purpose |
|-----------|---------|
| `instagram_basic` | Read account info |
| `instagram_content_publish` | Post Reels |
| `pages_show_list` | List your Pages |
| `pages_read_engagement` | Read Page info (needed for FB token) |
| `pages_manage_posts` | Post videos to Facebook Page |

If any are missing: App Dashboard → App Review → Permissions and Features → Request each one.

> **Note**: For apps in Development mode, you can only use accounts that are added as Testers or Admins. For production (multiple unrelated accounts), you need App Review approval. For your own personal accounts, Development mode is fine.

### 1.4 — Add Yourself (or the Account Owner) as a Tester

If the new Instagram account is owned by someone else or a different login:

1. App Dashboard → Roles → Roles
2. Click **Add Testers** → enter the Facebook account linked to the new IG account
3. That person accepts the tester invite from their Facebook notifications

---

## Part 2: Get a Long-Lived Instagram Access Token

### 2.1 — Get a Short-Lived Token First

Go to: [developers.facebook.com/tools/explorer](https://developers.facebook.com/tools/explorer)

1. Top right: select your app from the dropdown
2. Click **Generate Access Token** → log in as the account connected to the new Instagram account
3. Grant all requested permissions
4. Copy the token shown — this is a short-lived token (valid ~1-2 hours)

### 2.2 — Get the Instagram User ID

In Graph API Explorer, run:

```
GET /me/accounts?fields=id,name,instagram_business_account
```

Find the Page linked to your new Instagram account. Note the `instagram_business_account.id` — this is your **IG User ID** (starts with `178414...`).

Alternatively, directly:
```
GET /me?fields=instagram_business_account{id,username}
```

### 2.3 — Exchange for Long-Lived Token (valid 60 days)

Replace `{app-id}`, `{app-secret}`, and `{short-lived-token}` with your values:

```
GET https://graph.facebook.com/oauth/access_token
  ?grant_type=fb_exchange_token
  &client_id={app-id}
  &client_secret={app-secret}
  &fb_exchange_token={short-lived-token}
```

You can run this in Graph API Explorer or in your browser. Copy the `access_token` from the response — this is your **long-lived Instagram token** (60 days). The bot will auto-refresh it 10 days before it expires.

> **App ID and Secret**: Found at App Dashboard → Settings → Basic.

---

## Part 3: (Optional) Get a Facebook Page Access Token

Only needed if you want to cross-post this niche's videos to a Facebook Page.

### 3.1 — Get the Page Token

In Graph API Explorer (using the long-lived token from Part 2):

```
GET /me/accounts
```

Find your Page in the response. Each Page entry has its own `access_token` — that's your **Page access token**.

### 3.2 — Get a Long-Lived Page Token

Page tokens from `/me/accounts` are already long-lived (they don't expire as long as the user token is valid). However, to be safe, exchange it:

```
GET https://graph.facebook.com/oauth/access_token
  ?grant_type=fb_exchange_token
  &client_id={app-id}
  &client_secret={app-secret}
  &fb_exchange_token={page-access-token}
```

Note your **Page ID** as well — it's the `id` field next to your page in the `/me/accounts` response.

---

## Part 4: Add the Account to the Bot

### 4.1 — Update `.env`

SSH into your VPS and open `.env`:

```bash
nano /opt/reel-bot/.env
```

Add the new account block. Increment the number (`_3_`, `_4_`, etc.):

```env
# Instagram Account 3 — new niche
IG_ACCOUNT_3_USER_ID=17841400000000002
IG_ACCOUNT_3_USERNAME=your_new_handle
IG_ACCOUNT_3_ACCESS_TOKEN=IGQVJ...your_new_token
IG_ACCOUNT_3_NICHE=fitness
IG_ACCOUNT_3_MAX_POSTS_DAY=3
```

If enabling Facebook cross-posting for this account as well (the bot currently uses one FB page globally):

```env
FB_POST_ENABLED=true
FB_PAGE_ID=123456789012345
FB_PAGE_ACCESS_TOKEN=EAAxxxxxxxxxx...
```

> **Note**: The bot currently has one global FB page config. If you need per-account FB pages (different page per niche), that would require a code change.

### 4.2 — Verify the Account Numbers are Sequential

The bot reads `IG_ACCOUNT_1_*`, `IG_ACCOUNT_2_*`, `IG_ACCOUNT_3_*`... and stops at the first gap. So if you have accounts 1 and 3 but no 2, only account 1 will load. Keep numbers consecutive.

---

## Part 5: Add YouTube Channels

### 5.1 — Find Channel IDs for the New Niche

For each YouTube channel you want to pull from:

1. Go to the channel on YouTube
2. Click their page → About (or More → About)
3. Share → Copy channel ID — it starts with `UC`

Or: open the channel page, look at the URL — `youtube.com/channel/UCxxxxxxxxxx` — that's the ID.

### 5.2 — Update `config/channels.json`

```bash
nano /opt/reel-bot/config/channels.json
```

Add a new group for your niche. The niche name **must match** the `IG_ACCOUNT_N_NICHE` value exactly.

```json
{
  "accounts": [
    {
      "niche": "motivation",
      "channels": [
        { "id": "UCxxxxxxxxxxxxxxxxxxxxxx", "name": "Existing Motivation Channel" }
      ]
    },
    {
      "niche": "fitness",
      "channels": [
        { "id": "UCaaaaaaaaaaaaaaaaaaaaa", "name": "Fitness Channel 1" },
        { "id": "UCbbbbbbbbbbbbbbbbbbbbb", "name": "Fitness Channel 2" },
        { "id": "UCccccccccccccccccccccc", "name": "Workout Videos" }
      ]
    }
  ]
}
```

The bot syncs this file to the database at every startup. New channels and links are added automatically. Existing ones are not duplicated.

---

## Part 6: Configure Caption Tone

Edit `config/posting.json` to add the new niche's caption style. This file is read fresh for every post — no restart needed.

```bash
nano /opt/reel-bot/config/posting.json
```

Add your niche to `captionTone`:

```json
{
  "captionTone": {
    "motivation": "inspirational, uplifting, empowering, hustle culture",
    "finance": "value-focused, smart, practical, money-savvy",
    "fitness": "energetic, motivating, gym culture, transformation journey, push your limits"
  }
}
```

You can also set platform-specific caption suffixes (e.g., to promote a new handle):

```json
{
  "instagram": {
    "captionSuffix": "\n\nFollow @your_fitness_handle for daily workouts! 🔥"
  }
}
```

---

## Part 7: Restart the Bot

```bash
pm2 restart reel-bot --update-env
```

The `--update-env` flag is required whenever you change `.env` — without it, the old env vars stay loaded.

Watch the startup logs to confirm:

```bash
pm2 logs reel-bot --lines 50
```

You should see:
```
Seeded account: your_new_handle (niche=fitness)
Channel sync: 3 new channel(s), 3 new link(s) from channels.json
Running initial discovery scan...
```

---

## Part 8: Verify Everything Works

### Check account is active

```bash
cd /opt/reel-bot
node -e "
const db = require('better-sqlite3')('./data/reel-bot.db');
console.log(db.prepare('SELECT id, ig_username, niche, is_active, max_posts_day FROM accounts').all());
"
```

All your accounts should appear with `is_active: 1`.

### Check channels are linked

```bash
node -e "
const db = require('better-sqlite3')('./data/reel-bot.db');
console.log(db.prepare(\`
  SELECT a.ig_username, c.channel_name, c.niche
  FROM account_channels ac
  JOIN accounts a ON a.id = ac.account_id
  JOIN channels c ON c.id = ac.channel_id
\`).all());
"
```

You should see your new account linked to the new channels.

### Check videos are being discovered

After a few minutes, check if shorts are being found:

```bash
node -e "
const db = require('better-sqlite3')('./data/reel-bot.db');
const rows = db.prepare(\"SELECT status, COUNT(*) as count FROM videos GROUP BY status\").all();
console.log(rows);
"
```

If you see `discovered` count going up, the new channels are being scanned.

### Check the daily plan

Posting times are generated at 00:01. To check if today's plan exists:

```bash
node -e "
const db = require('better-sqlite3')('./data/reel-bot.db');
const today = new Date().toISOString().split('T')[0];
console.log(db.prepare('SELECT * FROM posts WHERE status=? AND DATE(scheduled_at, \"unixepoch\") = ?').all('pending', today));
"
```

If it's after midnight and the list is empty, wait 2 minutes — the self-healing tick will run `planDay()` automatically.

---

## Troubleshooting

### "Seeded account" not appearing in logs
- Check `IG_ACCOUNT_N_USER_ID` is set (the number must be consecutive with no gaps)
- Check all 4 required fields are set: `USER_ID`, `USERNAME`, `ACCESS_TOKEN`, `NICHE`
- Run `pm2 restart reel-bot --update-env` again

### Account shows `is_active: 0`
A previous token error deactivated it. Fix:
```bash
sqlite3 /opt/reel-bot/data/reel-bot.db "UPDATE accounts SET is_active=1 WHERE ig_username='your_handle';"
pm2 restart reel-bot --update-env
```

### Duplicate accounts in DB (account appears twice)
This can happen if the bot was restarted with a different `IG_USER_ID` for the same handle. Fix:
```bash
# Find the correct row (check the ig_user_id matches what Meta gives you)
sqlite3 /opt/reel-bot/data/reel-bot.db "SELECT id, ig_user_id, ig_username FROM accounts;"
# Delete the wrong duplicate
sqlite3 /opt/reel-bot/data/reel-bot.db "DELETE FROM accounts WHERE id = WRONG_ID;"
```

### No videos found for new niche
- Verify channel IDs are correct (copy from YouTube URL, not handle)
- Channel IDs always start with `UC` and are 24 characters
- Try a manual scan: `pm2 restart reel-bot --update-env` (triggers initial scan at startup)
- Check the channel actually has Shorts (videos ≤ 60 seconds)

### Facebook cross-posting not working
1. Confirm `FB_POST_ENABLED=true` in `.env`
2. Confirm `FB_PAGE_ID` and `FB_PAGE_ACCESS_TOKEN` are set
3. Check logs: `pm2 logs reel-bot | grep -i facebook`
4. The Page token must have `pages_manage_posts` permission
5. Run in Graph API Explorer: `GET /{page-id}?fields=id,name&access_token={token}` — should return page info

### Token rejected (error code 190)
The access token is invalid or expired. Get a new one from Part 2 above and update `.env`, then `pm2 restart reel-bot --update-env`.

---

## Quick Reference

| What to change | Where |
|---------------|-------|
| Add/remove Instagram account | `.env` — `IG_ACCOUNT_N_*` variables |
| Add YouTube channels | `config/channels.json` — add to the right niche group |
| Change caption tone/style | `config/posting.json` → `captionTone` (live reload) |
| Change caption prefix/suffix | `config/posting.json` → `instagram.captionSuffix` (live reload) |
| Enable Facebook cross-posting | `.env` — `FB_POST_ENABLED=true` + `FB_PAGE_ID` + `FB_PAGE_ACCESS_TOKEN` |
| Change daily post limit | `.env` — `IG_ACCOUNT_N_MAX_POSTS_DAY` |
| Change posting time windows | `config/default.js` → `postingWindows` (requires restart) |
