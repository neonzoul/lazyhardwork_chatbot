const axios = require('axios');
const config = require('./config');

async function postLead(lead) {
  if (!config.discord.leadsWebhook) return;
  const content = [
    '🟢 New Lead',
    `LINE: ${lead.lineDisplayName || '—'}`,
    `ชื่อ: ${lead.name || '—'}`,
    `ธุรกิจ: ${lead.business || '—'}`,
    `ปัญหา: ${lead.problem || '—'}`,
    `งบ: ${lead.budget || '—'}`,
    `ติดต่อ: ${lead.contact || '—'}`,
    `ช่องทาง: LINE OA`,
    `เวลา: ${new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}`,
    `สรุป: ${lead.keyRemark || '—'}`,
  ].join('\n');
  await axios.post(config.discord.leadsWebhook, { content }).catch(console.error);
}

async function postCrmHandoff({ displayName, summary }) {
  if (!config.discord.crmWebhook) return;
  const content = [
    '🔴 Human Required',
    `ลูกค้า: ${displayName || '—'}`,
    `เรื่อง: ${summary || '—'}`,
    `เวลา: ${new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}`,
    `สถานะ: WAITING_HUMAN`,
  ].join('\n');
  await axios.post(config.discord.crmWebhook, { content }).catch(console.error);
}

async function postCrmFeedback({ question }) {
  if (!config.discord.crmWebhook) return;
  const MAX = 300;
  const trimmed = question.length > MAX ? question.slice(0, MAX) + '…' : question;
  const content = [
    '❓ KB Gap — ลูกค้าถามแล้วบอทไม่รู้',
    `คำถาม: ${trimmed}`,
    `เวลา: ${new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}`,
  ].join('\n');
  await axios.post(config.discord.crmWebhook, { content }).catch(console.error);
}

module.exports = { postLead, postCrmHandoff, postCrmFeedback };
