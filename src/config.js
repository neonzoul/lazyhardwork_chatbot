require('dotenv').config();

module.exports = {
  line: {
    channelSecret: process.env.LINE_CHANNEL_SECRET,
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  },
  llm: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.LLM_MODEL || 'claude-haiku-4-5-20251001',
  },
  discord: {
    leadsWebhook: process.env.DISCORD_LEADS_WEBHOOK,
    crmWebhook: process.env.DISCORD_CRM_WEBHOOK,
  },
  contact: {
    phone: process.env.CONTACT_PHONE,
    email: process.env.CONTACT_EMAIL,
    hoursStart: parseInt(process.env.BUSINESS_HOURS_START || '13', 10),
    hoursEnd: parseInt(process.env.BUSINESS_HOURS_END || '22', 10),
  },
  port: parseInt(process.env.PORT || '3000', 10),
};
