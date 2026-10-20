// Session helpers — pure functions over the session row (shape: tests/fakes/store.js defaultSession).
// human = Mos took the chat (Human Mode, 20 Oct): Lay silent, no timeout, released only by Mos (▶️Lay / /lay)
const MODES = ['lay', 'quiet', 'mos_active', 'demo', 'human'];
const HOMEWORK_FIELDS = ['business', 'problem_verbatim', 'where_work_lives', 'team_size', 'maintainer', 'urgency', 'budget_frame', 'preferred_contact', 'came_from'];
const DRAFT_FIELDS = ['symptom', 'card', 'tier', 'name'];

function unionTopics(session, topics = []) {
    const set = new Set([...(session.topics_covered || []), ...topics.filter((t) => t && t !== 'offtopic' && t !== 'banter' && t !== 'policy')]);
    session.topics_covered = [...set];
    return session.topics_covered;
}

// Merge lead_updates: nulls never overwrite; homework fields → session.homework, draft fields → session.draft.
function mergeLeadUpdates(session, updates = {}) {
    session.homework = session.homework || {};
    session.draft = session.draft || {};
    const changed = [];
    for (const [k, v] of Object.entries(updates || {})) {
        if (v === null || v === undefined || v === '') continue;
        const target = HOMEWORK_FIELDS.includes(k) ? session.homework : DRAFT_FIELDS.includes(k) ? session.draft : null;
        if (!target) continue;
        if (target[k] !== v) { target[k] = v; changed.push(k); }
    }
    return changed;
}

function missingHomework(session) {
    const h = session.homework || {};
    return HOMEWORK_FIELDS.filter((f) => !h[f]);
}

// Reset context (Mos, 20 Oct: /reset): Lay starts fresh with this user. What Lay knew (draft, homework, topics, flags) is
// cleared and the model history starts at context_since; the transcript and the lead stay for the record.
const RESET_KEEP = ['user_id', 'display_name', 'created_at', 'opened', 'discord_thread_id', 'last_customer_at', 'last_bot_at', 'unfollowed_at'];
function resetContext(session, now) {
    const kept = Object.fromEntries(RESET_KEEP.filter((k) => session[k] !== undefined).map((k) => [k, session[k]]));
    for (const k of Object.keys(session)) delete session[k];
    Object.assign(session, {
        mode: 'lay', mode_since: now.toISOString(), demo_shop: null, demo_state: null, topics_covered: [], draft: {}, homework: {},
        questions_asked: 0, loose_ends_fired: false, booking_step: null, ...kept, context_since: now.toISOString(),
    });
    return session;
}

function setMode(session, mode, now) {
    if (!MODES.includes(mode)) throw new Error(`bad mode ${mode}`);
    if (session.mode !== mode) { session.mode = mode; session.mode_since = now.toISOString(); session.quiet_acked = false; }
    return session;
}

function minutesSince(iso, now) {
    if (!iso) return Infinity;
    return (now.getTime() - new Date(iso).getTime()) / 60000;
}

module.exports = { resetContext, MODES, HOMEWORK_FIELDS, DRAFT_FIELDS, unionTopics, mergeLeadUpdates, missingHomework, setMode, minutesSince };
