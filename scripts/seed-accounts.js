#!/usr/bin/env node

/**
 * CLI tool to add YouTube channels to the database.
 *
 * Usage:
 *   node scripts/seed-accounts.js add-channel --id UCxxxxxx --name "Channel Name" --niche motivation
 *   node scripts/seed-accounts.js link-channel --account-id 1 --channel-id 1
 *   node scripts/seed-accounts.js list-accounts
 *   node scripts/seed-accounts.js list-channels
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');

const db = getDb();
runMigrations();

const command = process.argv[2];
const args = parseArgs(process.argv.slice(3));

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (key && value) result[key] = value;
  }
  return result;
}

switch (command) {
  case 'add-channel': {
    const { id, name, niche } = args;
    if (!id || !name || !niche) {
      console.error('Usage: add-channel --id UCxxxxxx --name "Channel Name" --niche motivation');
      process.exit(1);
    }
    try {
      db.prepare(
        'INSERT INTO channels (channel_id, channel_name, niche) VALUES (?, ?, ?)'
      ).run(id, name, niche);
      console.log(`Added channel: ${name} (${id}) [niche=${niche}]`);
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        console.log(`Channel already exists: ${id}`);
      } else {
        throw err;
      }
    }
    break;
  }

  case 'link-channel': {
    const accountId = parseInt(args['account-id'], 10);
    const channelId = parseInt(args['channel-id'], 10);
    if (!accountId || !channelId) {
      console.error('Usage: link-channel --account-id 1 --channel-id 1');
      process.exit(1);
    }
    try {
      db.prepare(
        'INSERT INTO account_channels (account_id, channel_id) VALUES (?, ?)'
      ).run(accountId, channelId);
      console.log(`Linked account ${accountId} to channel ${channelId}`);
    } catch (err) {
      if (err.message.includes('UNIQUE') || err.message.includes('PRIMARY')) {
        console.log('Link already exists');
      } else {
        throw err;
      }
    }
    break;
  }

  case 'list-accounts': {
    const accounts = db.prepare('SELECT id, ig_username, niche, is_active, max_posts_day FROM accounts').all();
    if (accounts.length === 0) {
      console.log('No accounts found. Set IG_ACCOUNT_* env vars and start the bot to auto-seed.');
    } else {
      console.log('\nAccounts:');
      console.table(accounts);
    }
    break;
  }

  case 'list-channels': {
    const channels = db.prepare('SELECT id, channel_id, channel_name, niche, is_active FROM channels').all();
    if (channels.length === 0) {
      console.log('No channels found. Use: add-channel --id UCxxxxx --name "Name" --niche niche');
    } else {
      console.log('\nChannels:');
      console.table(channels);
    }
    break;
  }

  case 'stats': {
    const videoCount = db.prepare('SELECT COUNT(*) as count FROM videos').get().count;
    const postCount = db.prepare("SELECT COUNT(*) as count FROM posts WHERE status = 'published'").get().count;
    const accountCount = db.prepare('SELECT COUNT(*) as count FROM accounts WHERE is_active = 1').get().count;
    const channelCount = db.prepare('SELECT COUNT(*) as count FROM channels WHERE is_active = 1').get().count;

    console.log('\nSystem Stats:');
    console.log(`  Active accounts: ${accountCount}`);
    console.log(`  Active channels: ${channelCount}`);
    console.log(`  Discovered videos: ${videoCount}`);
    console.log(`  Published reels: ${postCount}`);
    break;
  }

  case 'sync': {
    const configPath = path.join(__dirname, '../config/channels.json');
    if (!fs.existsSync(configPath)) {
      console.error('config/channels.json not found. Create it first.');
      process.exit(1);
    }

    const channelsConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const insertChannel = db.prepare(
      'INSERT OR IGNORE INTO channels (channel_id, channel_name, niche) VALUES (?, ?, ?)'
    );
    const insertLink = db.prepare(
      'INSERT OR IGNORE INTO account_channels (account_id, channel_id) VALUES (?, ?)'
    );
    const getChannelDbId = db.prepare('SELECT id FROM channels WHERE channel_id = ?');
    const getAccountsByNiche = db.prepare('SELECT id, ig_username FROM accounts WHERE niche = ? AND is_active = 1');

    let channelsAdded = 0;
    let linksAdded = 0;

    const syncAll = db.transaction(() => {
      for (const group of channelsConfig.accounts || []) {
        const niche = group.niche;
        const accounts = getAccountsByNiche.all(niche);

        for (const ch of group.channels || []) {
          const result = insertChannel.run(ch.id, ch.name, niche);
          if (result.changes > 0) {
            channelsAdded++;
            console.log(`  + Channel: ${ch.name} (${ch.id}) [${niche}]`);
          }

          const channelRow = getChannelDbId.get(ch.id);
          if (!channelRow) continue;

          for (const account of accounts) {
            const linkResult = insertLink.run(account.id, channelRow.id);
            if (linkResult.changes > 0) {
              linksAdded++;
              console.log(`    → Linked to ${account.ig_username}`);
            }
          }
        }
      }
    });

    syncAll();
    console.log(`\nSync complete: ${channelsAdded} new channel(s), ${linksAdded} new link(s)`);
    break;
  }

  default:
    console.log('Instagram Reel Bot - Account & Channel Manager\n');
    console.log('Commands:');
    console.log('  add-channel     --id UCxxxxxx --name "Name" --niche motivation');
    console.log('  link-channel    --account-id 1 --channel-id 1');
    console.log('  list-accounts   List all Instagram accounts');
    console.log('  list-channels   List all YouTube channels');
    console.log('  sync            Sync channels from config/channels.json');
    console.log('  stats           Show system statistics');
}

closeDb();
