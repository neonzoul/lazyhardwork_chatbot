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

function setMode(session, mode, now) {
    if (!MODES.includes(mode)) throw new Error(`bad mode ${mode}`);
    if (session.mode !== mode) { session.mode = mode; session.mode_since = now.toISOString(); session.quiet_acked = false; }
    return session;
}

function minutesSince(iso, now) {
    if (!iso) return Infinity;
    return (now.getTime() - new Date(iso).getTime()) / 60000;
}

module.exports = { MODES, HOMEWORK_FIELDS, DRAFT_FIELDS, unionTopics, mergeLeadUpdates, missingHomework, setMode, minutesSince };
