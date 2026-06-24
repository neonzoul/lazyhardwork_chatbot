/**
 * Rich Menu setup — run once to create the 5-button menu on LINE.
 *
 * Usage:
 *   node scripts/setup-rich-menu.js
 *
 * Prerequisites:
 *   1. Set LINE_CHANNEL_ACCESS_TOKEN in .env
 *   2. Place a 2500x1686 px PNG at scripts/rich-menu.png
 *      (create in Canva or any image editor; 5 columns, 1 row layout works)
 *
 * To delete and recreate: run the script again — it replaces any existing default menu.
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (!TOKEN) {
  console.error('ERROR: LINE_CHANNEL_ACCESS_TOKEN not set in .env');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

const MENU_DEF = {
  size: { width: 2500, height: 843 },
  selected: true,
  name: 'Agent Lay Menu',
  chatBarText: '📋 เมนู',
  areas: [
    {
      bounds: { x: 0, y: 0, width: 500, height: 843 },
      action: { type: 'postback', label: '📋 บริการ', data: 'MENU_SERVICES', displayText: 'บริการของเรา' },
    },
    {
      bounds: { x: 500, y: 0, width: 500, height: 843 },
      action: { type: 'postback', label: '💼 ผลงาน', data: 'MENU_PORTFOLIO', displayText: 'ดูผลงาน' },
    },
    {
      bounds: { x: 1000, y: 0, width: 500, height: 843 },
      action: { type: 'postback', label: '💰 ราคา', data: 'MENU_PRICING', displayText: 'ราคา' },
    },
    {
      bounds: { x: 1500, y: 0, width: 500, height: 843 },
      action: { type: 'postback', label: '👤 คุยกับคนจริง', data: 'MENU_HANDOFF', displayText: 'ขอคุยกับคนจริง' },
    },
    {
      bounds: { x: 2000, y: 0, width: 500, height: 843 },
      action: { type: 'postback', label: '📞 ติดต่อ', data: 'MENU_CONTACT', displayText: 'ข้อมูลติดต่อ' },
    },
  ],
};

async function run() {
  // 1. Delete existing default rich menu if any
  try {
    const { data: existing } = await axios.get('https://api.line.me/v2/bot/user/all/richmenu', { headers });
    if (existing.richMenuId) {
      await axios.delete(`https://api.line.me/v2/bot/richmenu/${existing.richMenuId}`, { headers });
      console.log('Deleted existing default menu:', existing.richMenuId);
    }
  } catch { /* no default menu — ok */ }

  // 2. Create menu structure
  const { data: created } = await axios.post('https://api.line.me/v2/bot/richmenu', MENU_DEF, { headers });
  const richMenuId = created.richMenuId;
  console.log('Created rich menu:', richMenuId);

  // 3. Upload image (optional — skip if file not found)
  const imgPath = path.join(__dirname, 'rich-menu.png');
  if (fs.existsSync(imgPath)) {
    const img = fs.readFileSync(imgPath);
    await axios.post(
      `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`,
      img,
      { headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'image/png' } }
    );
    console.log('Image uploaded.');
  } else {
    console.warn('scripts/rich-menu.png not found — skipping image upload.');
    console.warn('Upload manually via LINE Developers console or add the file and re-run.');
  }

  // 4. Set as default
  await axios.post(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {}, { headers });
  console.log('Set as default rich menu. Done!');
}

run().catch((err) => {
  console.error('Setup failed:', err.response?.data || err.message);
  process.exit(1);
});
