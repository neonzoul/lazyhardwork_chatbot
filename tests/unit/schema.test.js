const test = require('node:test');
const assert = require('node:assert/strict');
const { responseSchema, validateResponse, emptyResponse, LEAD_FIELDS } = require('../../src/brain/schema');

test('strict schema shape: every property required, no additional properties', () => {
  const s = responseSchema.schema;
  assert.equal(responseSchema.strict, true);
  assert.deepEqual(Object.keys(s.properties).sort(), [...s.required].sort());
  assert.equal(s.additionalProperties, false);
  const lu = s.properties.lead_updates;
  assert.deepEqual(Object.keys(lu.properties).sort(), [...LEAD_FIELDS].sort());
  const m = s.properties.messages.items;
  assert.deepEqual(Object.keys(m.properties).sort(), [...m.required].sort());
});

test('validateResponse accepts a good response and rejects bad ones', () => {
  assert.equal(validateResponse(emptyResponse({ messages: [{ type: 'text', text: 'ครับ', explain: false, template: null, alt: null, data: null }], intent: 'pricing' })).ok, true);
  assert.equal(validateResponse(emptyResponse()).ok, false); // empty text
  const twoCards = emptyResponse({ messages: [
    { type: 'card', text: null, explain: false, template: 'offer', alt: 'a', data: {} },
    { type: 'card', text: null, explain: false, template: 'info', alt: 'b', data: {} },
  ] });
  assert.ok(validateResponse(twoCards).errors.includes('at most one card per reply'));
  assert.equal(validateResponse(emptyResponse({ quick_replies: ['a', 'b', 'c', 'd', 'e'] })).ok, false);
  assert.equal(validateResponse(emptyResponse({ action: 'fly' })).ok, false);
  assert.equal(validateResponse({ not: 'valid' }).ok, false);
});
