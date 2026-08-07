// Proves the fix for "the bot can promise a handoff that nobody hears"
// (doc/spec/v2/codearea-fix-handoff-silent-failure.md).
//
// Forces the notify transport (Discord webhook) to throw and asserts:
//   1. handleHandoff's catch block runs
//   2. the message sent to the customer is the failure message, with real contact details
//   3. "ส่งเรื่องให้คุณมอสแล้ว" (or any success claim) appears nowhere in what the customer receives
//   4. the session is NOT left in WAITING_HUMAN — the bot keeps answering
const test = require('node:test');
const assert = require('node:assert/strict');

function freshRequire(modPath) {
  const resolved = require.resolve(modPath);
  delete require.cache[resolved];
  return require(resolved);
}

function setEnv() {
  process.env.DISCORD_CRM_WEBHOOK = 'https://discord.com/api/webhooks/test/token';
  process.env.CONTACT_PHONE = '0900000000';
  process.env.CONTACT_EMAIL = 'mos@example.com';
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-token';
  process.env.LINE_CHANNEL_SECRET = 'test-secret';
  delete require.cache[require.resolve('../src/config')];
}

test('handleHandoff: notify failure tells the customer the truth and keeps the bot answering', async (t) => {
  setEnv();

  const axios = require('axios');
  t.mock.method(axios, 'post', () => Promise.reject(new Error('discord unreachable')));

  const line = require('@line/bot-sdk');
  const sent = [];
  t.mock.method(line.messagingApi.MessagingApiClient.prototype, 'pushMessage', async ({ messages }) => {
    sent.push(messages[0].text);
    return {};
  });

  const state = freshRequire('../src/state');
  const bot = freshRequire('../src/bot');

  const userId = 'Utest-handoff-fail';
  await bot.handleHandoff(userId, 'Test User', []);

  assert.equal(sent.length, 1, 'exactly one message reached the customer');
  assert.match(sent[0], /ขออภัยครับ/, 'customer is told something went wrong');
  assert.match(sent[0], /0900000000|mos@example\.com/, 'a real contact route is included');
  assert.doesNotMatch(
    sent[0],
    /ส่งเรื่องให้คุณมอสแล้ว/,
    'no success claim leaks to the customer on the failure path'
  );
  assert.notEqual(
    state.getStatus(userId),
    state.WAITING_HUMAN,
    'session must not be left waiting for a human nobody was told about'
  );
});

test('handleHandoff: successful notify flips to WAITING_HUMAN and confirms to the customer', async (t) => {
  setEnv();

  const axios = require('axios');
  t.mock.method(axios, 'post', () => Promise.resolve({ status: 204 }));

  const line = require('@line/bot-sdk');
  const sent = [];
  t.mock.method(line.messagingApi.MessagingApiClient.prototype, 'pushMessage', async ({ messages }) => {
    sent.push(messages[0].text);
    return {};
  });

  const state = freshRequire('../src/state');
  const bot = freshRequire('../src/bot');

  const userId = 'Utest-handoff-ok';
  await bot.handleHandoff(userId, 'Test User', []);

  assert.equal(sent.length, 1);
  assert.match(sent[0], /ส่งเรื่องให้คุณมอสแล้ว/);
  assert.equal(state.getStatus(userId), state.WAITING_HUMAN);
});

test('processMessage: a promised escalation that fails to notify is not sent to the customer as-is', async (t) => {
  setEnv();

  const axios = require('axios');
  t.mock.method(axios, 'post', () => Promise.reject(new Error('discord unreachable')));

  const line = require('@line/bot-sdk');
  const sent = [];
  t.mock.method(line.messagingApi.MessagingApiClient.prototype, 'pushMessage', async ({ messages }) => {
    sent.push(messages[0].text);
    return {};
  });

  // Stub the LLM call so this test doesn't hit OpenAI, and returns a reply that trips the
  // "promised escalation" regex in processMessage.
  const llm = freshRequire('../src/llm');
  t.mock.method(llm, 'chat', async () => ({
    reply: 'ได้เลยครับ เดี๋ยวส่งเรื่องให้คุณ Mos ดูแลต่อนะครับ',
    kbGap: false,
  }));

  const state = freshRequire('../src/state');
  const bot = freshRequire('../src/bot');

  const userId = 'Utest-promised-escalation';
  await bot.processMessage(userId, 'Test User', 'ขอคุยเรื่องบิลที่ผิดพลาด');

  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], /ส่งเรื่องให้คุณ Mos ดูแลต่อ/, 'the broken promise is not forwarded as-is');
  assert.match(sent[0], /ขออภัยครับ/);
  assert.notEqual(state.getStatus(userId), state.WAITING_HUMAN);
});
