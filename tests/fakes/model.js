// Scripted model. Each call pops the next response from the queue (or uses `fallback`).
// Queue items may be: a full response object, a partial merged over emptyResponse(), the string 'throw'
// (model error), or the string 'garbage' (unparseable output) — for fault injection.
const { emptyResponse } = require('../../src/brain/schema');

function text(t, extra = {}) {
  return emptyResponse({ messages: [{ type: 'text', text: t, explain: false, template: null, alt: null, data: null }], ...extra });
}

function createFakeModel({ queue = [], fallback = null } = {}) {
  const calls = [];
  return {
    calls,
    queue,
    async respond(req) {
      calls.push(req);
      const next = queue.length ? queue.shift() : fallback;
      if (next === null || next === undefined) throw new Error('fake model: no scripted response left');
      if (next === 'throw') throw new Error('fake model: provider error');
      if (next === 'garbage') return { not: 'a', valid: 'response' };
      if (typeof next === 'string') return text(next);
      if (next.messages) return next;
      return emptyResponse(next);
    },
    push(...items) { queue.push(...items); },
    reset() { calls.length = 0; queue.length = 0; },
  };
}

module.exports = { createFakeModel, text };
