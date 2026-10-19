// Env-based config: secrets + infrastructure only. Model selection lives in src/agents.config.js.
// v2 keys added 2026-10-17; v1 keys kept until the v1 modules are removed.

require('dotenv').config();

const env = process.env;
const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));
const publicBaseUrl = (env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

module.exports = {
    line: {
        channelSecret: env.LINE_CHANNEL_SECRET,
        channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN,
        prod: { channelSecret: env.LINE_PROD_CHANNEL_SECRET, channelAccessToken: env.LINE_PROD_CHANNEL_ACCESS_TOKEN },
        testBotBasicId: env.LINE_TEST_BOT_BASIC_ID,
        mosUserId: env.MOS_LINE_USER_ID,
    },
    llm: {
        apiKey: env.OPENAI_API_KEY,                                          // legacy (OpenAI direct) — unused by v2 since 2026-10-18
        // OpenRouter keys in rotation order (doc/llm.md §5). Spare keys are optional.
        openrouterKeys: [env.OPENROUTER_API_KEY, env.OPENROUTER_API_KEY_2, env.OPENROUTER_API_KEY_3].filter((k) => k && k.trim()),
        // LLM_MODEL_<TASK> per-task overrides (src/brain/router.js), e.g. LLM_MODEL_LAY_REPLY=openai/gpt-4.1-mini
        modelOverrides: Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('LLM_MODEL_'))),
    },
    discord: {
        leadsWebhook: env.DISCORD_LEADS_WEBHOOK,
        crmWebhook: env.DISCORD_CRM_WEBHOOK,
        botToken: env.DISCORD_BOT_TOKEN,
        guildId: env.DISCORD_GUILD_ID,
        leadsChannelId: env.DISCORD_LEADS_CHANNEL_ID,
        crmChannelId: env.DISCORD_CRM_CHANNEL_ID,
    },
    contact: {
        phone: env.CONTACT_PHONE,
        phoneDisplay: env.CONTACT_PHONE_DISPLAY || '095 569 1674 (มอส)',   // lhw-public-profile.yaml contact.phone_display
        email: env.CONTACT_EMAIL,                                            // v1 only — never shown by v2
        fastworkUrl: env.FASTWORK_URL,
        hoursStart: int(env.BUSINESS_HOURS_START, 13),
        hoursEnd: int(env.BUSINESS_HOURS_END, 22),
    },
    identity: {
        layName: 'Lay · ผู้ช่วย AI',
        mosName: 'มอส',
        layIconUrl: env.LAY_ICON_URL || (publicBaseUrl ? `${publicBaseUrl}/assets/lay-icon.png` : ''),
        mosIconUrl: env.MOS_ICON_URL || (publicBaseUrl ? `${publicBaseUrl}/assets/mos-icon.png` : ''),
    },
    publicBaseUrl,
    db: { path: env.DB_PATH || './data/lay.sqlite' },
    // examples carousels show images only when Mos has replaced the placeholders (head review 19 Oct)
    examplesImagesReady: env.EXAMPLES_IMAGES_READY === '1',
    knowledgeDir: env.KNOWLEDGE_DIR || 'knowledge',
    quiet: { windowMinutes: int(env.QUIET_WINDOW_MINUTES, 30), debounceMs: int(env.DEBOUNCE_MS, 6500) },
    port: int(env.PORT, 3000),
    adminSecret: env.ADMIN_SECRET,   // v1 dashboard
    adminToken: env.ADMIN_TOKEN,     // v2 JSON admin API
};
