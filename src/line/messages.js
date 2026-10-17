// Builders for outgoing LINE message objects. Limits from doc/line-platform-notes.md.
const MAX_QUICK = 13;        // LINE
const OUR_MAX_QUICK = 4;     // design D-05
const LABEL_MAX = 20;        // LINE quick-reply label
const TEXT_MAX = 5000;

function cp(s) { return [...String(s)]; }
function clipLabel(label) { const c = cp(label); return c.length > LABEL_MAX ? c.slice(0, LABEL_MAX - 1).join('') + '…' : label; }

// item: string (message action, text = label) | { label, data, displayText? } (postback) | { label, uri } | { label, text }
function quickReply(items = [], { max = OUR_MAX_QUICK } = {}) {
    const list = items.filter(Boolean).slice(0, Math.min(max, MAX_QUICK)).map((it) => {
        if (typeof it === 'string') return { type: 'action', action: { type: 'message', label: clipLabel(it), text: it } };
        if (it.uri) return { type: 'action', action: { type: 'uri', label: clipLabel(it.label), uri: it.uri } };
        if (it.data) return { type: 'action', action: { type: 'postback', label: clipLabel(it.label), data: it.data, displayText: it.displayText || it.label } };
        return { type: 'action', action: { type: 'message', label: clipLabel(it.label), text: it.text || it.label } };
    });
    return list.length ? { items: list } : undefined;
}

function withExtras(msg, { sender, quickReplies } = {}) {
    if (sender && sender.name) msg.sender = { name: sender.name, ...(sender.iconUrl ? { iconUrl: sender.iconUrl } : {}) };
    const qr = quickReply(quickReplies || []);
    if (qr) msg.quickReply = qr;
    return msg;
}

function text(t, extras = {}) {
    const body = String(t ?? '').slice(0, TEXT_MAX);
    return withExtras({ type: 'text', text: body }, extras);
}

function flex(flexMessage, extras = {}) {
    // flexMessage = { type: 'flex', altText, contents }
    return withExtras({ ...flexMessage }, extras);
}

// Attach quick replies to the LAST message of a reply (LINE shows only the last message's quickReply).
function attachQuickReplies(messages, items, sender) {
    if (!messages.length) return messages;
    const last = messages[messages.length - 1];
    withExtras(last, { quickReplies: items });
    if (sender) for (const m of messages) withExtras(m, { sender });
    return messages;
}

module.exports = { text, flex, quickReply, attachQuickReplies, clipLabel, OUR_MAX_QUICK, LABEL_MAX };
