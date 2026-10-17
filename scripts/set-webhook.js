/**
 * Set (and test) the LINE webhook endpoint of the channel in LINE_CHANNEL_ACCESS_TOKEN.
 *
 * Usage:  node scripts/set-webhook.js https://xxxx.ngrok-free.app/webhook
 *         node scripts/set-webhook.js --show
 */
require('dotenv').config();
const axios = require('axios');

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (!TOKEN) { console.error('LINE_CHANNEL_ACCESS_TOKEN missing'); process.exit(1); }
const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const base = 'https://api.line.me/v2/bot/channel/webhook';

async function main() {
  const arg = process.argv[2];
  if (!arg) { console.error('usage: set-webhook.js <https url> | --show'); process.exit(1); }
  if (arg !== '--show') {
    if (!/^https:\/\//.test(arg)) throw new Error('webhook URL must be https');
    await axios.put(`${base}/endpoint`, { endpoint: arg }, { headers });
    console.log('endpoint set:', arg);
  }
  const { data } = await axios.get(`${base}/endpoint`, { headers });
  console.log('current:', data);
  const t = await axios.post(`${base}/test`, {}, { headers }).then((r) => r.data).catch((e) => e.response?.data || e.message);
  console.log('test:', t);
}
main().catch((e) => { console.error('failed:', e.response?.data || e.message); process.exit(1); });
