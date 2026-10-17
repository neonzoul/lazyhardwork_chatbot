// The structured response contract (design §2). One object per turn, produced by the model through
// OpenAI structured outputs (strict). Strict mode needs: every property listed in `required`,
// `additionalProperties: false`, and nullable fields expressed as type arrays.

const TOPICS = ['capability', 'fit', 'pricing', 'timeline', 'proof', 'howtostart', 'benefits', 'process', 'offtopic', 'banter', 'policy'];

const INTENTS = [
  'greeting', 'capability', 'fit', 'pricing', 'timeline', 'proof', 'howtostart', 'tell_me_more',
  'homework_answer', 'booking', 'faq', 'benefits', 'out_of_scope', 'special_price', 'ask_human',
  'ai_disclosure', 'banter', 'abuse', 'closing', 'unknown', 'demo',
];

const ACTIONS = [null, 'handoff_unknown', 'handoff_scope', 'handoff_human', 'booking_start', 'booking_confirm', 'demo_enter', 'demo_exit'];

const TEMPLATES = ['choice', 'compare', 'steps', 'offer', 'summary_confirm', 'examples', 'info'];

const LEAD_FIELDS = [
  'business', 'problem_verbatim', 'where_work_lives', 'team_size', 'maintainer', 'urgency',
  'budget_frame', 'preferred_contact', 'came_from', 'symptom', 'card', 'name',
];

const nullableString = { type: ['string', 'null'] };

const leadUpdatesSchema = {
  type: 'object',
  properties: Object.fromEntries(LEAD_FIELDS.map((f) => [f, nullableString])),
  required: LEAD_FIELDS,
  additionalProperties: false,
};

const messageSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['text', 'card'] },
    text: nullableString,                                  // text messages: ≤ ~3 short lines, plain text
    explain: { type: 'boolean' },                          // true = an explanatory bubble where structural emoji are allowed
    template: { type: ['string', 'null'], enum: [...TEMPLATES, null] },
    alt: nullableString,                                   // card altText
    data: { type: ['object', 'null'], additionalProperties: true }, // template-specific; validated by cards/validate
  },
  required: ['type', 'text', 'explain', 'template', 'alt', 'data'],
  additionalProperties: false,
};

const responseSchema = {
  name: 'lay_turn',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      messages: { type: 'array', minItems: 1, maxItems: 3, items: messageSchema },
      quick_replies: { type: 'array', maxItems: 4, items: { type: 'string' } },
      topics: { type: 'array', items: { type: 'string', enum: TOPICS } },
      kb_refs: { type: 'array', items: { type: 'string' } },
      intent: { type: 'string', enum: INTENTS },
      lead_updates: leadUpdatesSchema,
      action: { type: ['string', 'null'], enum: ACTIONS },
    },
    required: ['messages', 'quick_replies', 'topics', 'kb_refs', 'intent', 'lead_updates', 'action'],
    additionalProperties: false,
  },
};

// Light runtime validation for responses that did not come through strict mode (fakes, repairs, tests).
function validateResponse(r) {
  const errors = [];
  if (!r || typeof r !== 'object') return { ok: false, errors: ['not an object'] };
  if (!Array.isArray(r.messages) || r.messages.length < 1 || r.messages.length > 3) errors.push('messages: 1-3 required');
  else {
    let cards = 0;
    r.messages.forEach((m, i) => {
      if (m.type === 'text') { if (!m.text || !m.text.trim()) errors.push(`messages[${i}]: empty text`); }
      else if (m.type === 'card') { cards++; if (!TEMPLATES.includes(m.template)) errors.push(`messages[${i}]: unknown template ${m.template}`); if (!m.alt) errors.push(`messages[${i}]: card needs alt`); }
      else errors.push(`messages[${i}]: bad type ${m.type}`);
    });
    if (cards > 1) errors.push('at most one card per reply');
  }
  if (!Array.isArray(r.quick_replies) || r.quick_replies.length > 4) errors.push('quick_replies: array ≤ 4');
  else r.quick_replies.forEach((q, i) => { if (typeof q !== 'string' || !q.trim() || [...q].length > 20) errors.push(`quick_replies[${i}]: label 1-20 chars`); });
  if (!Array.isArray(r.topics) || r.topics.some((t) => !TOPICS.includes(t))) errors.push('topics: unknown topic');
  if (!INTENTS.includes(r.intent)) errors.push(`intent: unknown ${r.intent}`);
  if (!ACTIONS.includes(r.action === undefined ? null : r.action)) errors.push(`action: unknown ${r.action}`);
  if (!r.lead_updates || typeof r.lead_updates !== 'object') errors.push('lead_updates: object required');
  if (!Array.isArray(r.kb_refs)) errors.push('kb_refs: array required');
  return { ok: errors.length === 0, errors };
}

// A complete, schema-valid empty response to build fakes and fallbacks from.
function emptyResponse(overrides = {}) {
  return {
    messages: [{ type: 'text', text: '', explain: false, template: null, alt: null, data: null }],
    quick_replies: [],
    topics: [],
    kb_refs: [],
    intent: 'unknown',
    lead_updates: Object.fromEntries(LEAD_FIELDS.map((f) => [f, null])),
    action: null,
    ...overrides,
  };
}

module.exports = { responseSchema, validateResponse, emptyResponse, TOPICS, INTENTS, ACTIONS, TEMPLATES, LEAD_FIELDS };
