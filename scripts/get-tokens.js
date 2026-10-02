// Turns a short-lived user token (Graph API Explorer, app "Reel Publisher") into
// never-expiring page tokens and prints IG_ACCOUNT_* lines for .env.
//
//   node scripts/get-tokens.js <short-lived user token>
//
// Needs META_APP_ID + META_APP_SECRET of the same app in .env (App Dashboard → Settings → Basic).
// Without them, pass a token you already extended in the Access Token Debugger.
require('dotenv').config();
const https = require('https');

const get = (endpoint, params) => new Promise((resolve, reject) => {
  const url = `https://graph.facebook.com/v21.0/${endpoint}?${new URLSearchParams(params)}`;
  https.get(url, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => {
      const json = JSON.parse(data);
      json.error ? reject(new Error(json.error.message)) : resolve(json);
    });
  }).on('error', reject);
});

async function main() {
  const shortToken = process.argv[2];
  if (!shortToken) throw new Error('Usage: node scripts/get-tokens.js <short-lived user token>');

  const { META_APP_ID, META_APP_SECRET } = process.env;
  const userToken = META_APP_ID && META_APP_SECRET
    ? (await get('oauth/access_token', {
      grant_type: 'fb_exchange_token',
      client_id: META_APP_ID,
      client_secret: META_APP_SECRET,
      fb_exchange_token: shortToken,
    })).access_token
    : shortToken;

  const { data: pages } = await get('me/accounts', {
    access_token: userToken,
    fields: 'name,access_token,instagram_business_account{id,username}',
  });

  let n = 0;
  for (const page of pages) {
    const ig = page.instagram_business_account;
    if (!ig) {
      console.log(`# FB page "${page.name}" has no linked Instagram account — skipped`);
      continue;
    }
    n++;
    console.log([
      '',
      `# ${ig.username} (FB page: ${page.name})`,
      `IG_ACCOUNT_${n}_USER_ID=${ig.id}`,
      `IG_ACCOUNT_${n}_USERNAME=${ig.username}`,
      `IG_ACCOUNT_${n}_ACCESS_TOKEN=${page.access_token}`,
      `IG_ACCOUNT_${n}_NICHE=memes`,
      `IG_ACCOUNT_${n}_MAX_POSTS_DAY=3`,
    ].join('\n'));
  }

  // Page tokens from a long-lived user token never expire; confirm before using them
  const check = await get('debug_token', { input_token: pages[0]?.access_token || userToken, access_token: userToken });
  console.log(`\n# token expires: ${check.data.expires_at ? new Date(check.data.expires_at * 1000).toISOString() : 'never'}`);
  console.log(`# scopes: ${check.data.scopes.join(', ')}`);
  if (!check.data.scopes.includes('instagram_manage_insights')) {
    console.log('# WARNING: instagram_manage_insights missing — reading the source page will fail');
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
