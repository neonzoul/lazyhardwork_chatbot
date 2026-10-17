// Lossless burst accumulator (brief §3.10, flow §8.1): text messages from one user within `ms` are joined and
// processed once. Postbacks, follow and media bypass it. `timers` is injectable for tests.

function createDebouncer({ ms = 6500, onFlush, timers = { set: setTimeout, clear: clearTimeout } }) {
    const buffers = new Map(); // userId → { items: [], timer, first }

    function push(input) {
        const key = input.userId;
        let b = buffers.get(key);
        if (!b) { b = { items: [], timer: null, first: input }; buffers.set(key, b); }
        b.items.push(input);
        if (b.timer) timers.clear(b.timer);
        b.timer = timers.set(() => flush(key), ms);
    }

    async function flush(key) {
        const b = buffers.get(key);
        if (!b) return;
        buffers.delete(key);
        const items = b.items;
        const last = items[items.length - 1];
        const merged = {
            ...last,
            text: items.map((i) => i.text).filter((t) => t && t.trim()).join('\n'),
            replyToken: last.replyToken,                 // the newest token is the one most likely still valid
            burstCount: items.length,
            firstTimestamp: b.first.timestamp,
        };
        try { await onFlush(merged); } catch (err) { /* onFlush must handle its own errors (never-silent lives in the turn) */ console.error('debounce.onFlush threw', err?.message); }
    }

    return { push, flush, pending: (key) => (buffers.get(key)?.items.length || 0), size: () => buffers.size };
}

module.exports = { createDebouncer };
