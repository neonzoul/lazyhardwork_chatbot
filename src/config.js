// Env-based config: secrets + infrastructure only.
// Model selection lives in src/agents.config.js, not here.

require('dotenv').config();

module.exports = {
    line: {
        channelSecret: process.env.LINE_CHANNEL_SECRET,
        channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    },
    llm: {
        apiKey: process.env.OPENAI_API_KEY,
    },
    discord: {
        leadsWebhook: process.env.DISCORD_LEADS_WEBHOOK,
        crmWebhook: process.env.DISCORD_CRM_WEBHOOK,
    },
    contact: {
        phone: process.env.CONTACT_PHONE,
        email: process.env.CONTACT_EMAIL,
        fastworkUrl: process.env.FASTWORK_URL,
        hoursStart: parseInt(process.env.BUSINESS_HOURS_START || '13', 10),
        hoursEnd: parseInt(process.env.BUSINESS_HOURS_END || '22', 10),
    },
    port: parseInt(process.env.PORT || '3000', 10),
    adminSecret: process.env.ADMIN_SECRET,
};
