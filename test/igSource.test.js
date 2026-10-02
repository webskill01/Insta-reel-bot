// node --test   (needs ffmpeg + the watermark font for the last test)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reelbot-'));
process.env.DATA_DIR = tmp;
process.env.DB_PATH = path.join(tmp, 'test.db');

const { getDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const { DiscoveryService } = require('../src/discovery/discoveryService');
const { TransformService } = require('../src/transformer/transformService');

const db = getDb();
runMigrations();
db.exec(`
  INSERT INTO accounts (ig_user_id, ig_username, access_token, token_expires, token_refreshed, niche)
  VALUES ('1', 'pageA', 't', 0, 0, 'memes'), ('2', 'pageB', 't', 0, 0, 'memes');
  INSERT INTO channels (channel_id, channel_name, niche) VALUES ('ig:src', 'src', 'memes');
`);

let mediaUrl = 'https://cdn/old.mp4';
const ig = {
  businessDiscovery: async () => ({
    next: null,
    items: [
      { id: 'r1', media_product_type: 'REELS', media_url: mediaUrl, permalink: 'p1', caption: 'lol' },
      { id: 'r2', media_product_type: 'REELS', permalink: 'p2' },               // copyrighted audio: no url
      { id: 'i1', media_product_type: 'FEED', media_url: 'https://cdn/img.jpg' }, // not a reel
    ],
  }),
};
const discovery = new DiscoveryService(db, null, ig);
const channel = db.prepare("SELECT * FROM channels WHERE channel_id = 'ig:src'").get();

test('scan keeps only downloadable reels', async () => {
  assert.strictEqual(await discovery._scanIgSource(channel, 1), 1);
  assert.strictEqual(await discovery._scanIgSource(channel, 1), 0); // re-scan is not "new"
});

test('both pages get the same reel, each only once', () => {
  const v = discovery.pickVideoForAccount('memes', 1);
  assert.strictEqual(v.youtube_id, 'r1');
  db.prepare("INSERT INTO posts (video_id, account_id, status) VALUES (?, 1, 'published')").run(v.id);
  db.prepare("UPDATE videos SET status = 'published' WHERE id = ?").run(v.id);

  assert.strictEqual(discovery.pickVideoForAccount('memes', 1), null);
  assert.strictEqual(discovery.pickVideoForAccount('memes', 2).youtube_id, 'r1');

  // a dry-run post doesn't use the reel up
  db.prepare("INSERT INTO posts (video_id, account_id, status) VALUES (?, 2, 'dry_run')").run(v.id);
  assert.strictEqual(discovery.pickVideoForAccount('memes', 2).youtube_id, 'r1');
});

test('expired link is refreshed by re-scan', async () => {
  const v = db.prepare("SELECT * FROM videos WHERE youtube_id = 'r1'").get();
  mediaUrl = 'https://cdn/new.mp4';
  assert.strictEqual(await discovery.refreshSourceUrl(v), 'https://cdn/new.mp4');
});

test('each account gets its own @handle burned in', async (t) => {
  try { execFileSync('ffmpeg', ['-version']); } catch { return t.skip('no ffmpeg'); }
  const src = path.join(tmp, 'in.mp4');
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=720x1280:duration=1', '-f', 'lavfi',
    '-i', 'sine=duration=1', '-shortest', src], { stdio: 'ignore' });

  const tf = new TransformService(path.join(tmp, 'processed'));
  const args = tf.buildCommand(src, 'out.mp4', require('../config/transforms').presets.tint, { watermarkText: '@bisht.files' });
  assert.match(args[args.indexOf('-vf') + 1], /drawtext=.*text='@bisht\.files'/);

  const out = await tf.transform(src, 'r1_bisht.files', { watermarkText: '@bisht.files' });
  assert.ok(fs.statSync(out).size > 0);
});
