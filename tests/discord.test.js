// Proves the fix for "the bot can promise a handoff that nobody hears"
// (doc/spec/v2/codearea-fix-handoff-silent-failure.md).
const test = require('node:test');
const assert = require('node:assert/strict');

function freshRequire(modPath) {
  const resolved = require.resolve(modPath);
  delete require.cache[resolved];
  return require(resolved);
}

test('postCrmHandoff rejects when the notify transport throws', async (t) => {
  process.env.DISCORD_CRM_WEBHOOK = 'https://discord.com/api/webhooks/test/token';
  delete require.cache[require.resolve('../src/config')];

  const axios = require('axios');
  t.mock.method(axios, 'post', () => Promise.reject(new Error('network down')));

  const discord = freshRequire('../src/discord');
  await assert.rejects(
    () => discord.postCrmHandoff({ userId: 'U1', displayName: 'Test', summary: 'hi' })
  );
});

test('postCrmHandoff rejects when DISCORD_CRM_WEBHOOK is unset', async () => {
  // Empty string, not delete: dotenv only fills keys absent from process.env, so a real
  // value from a local .env would silently reappear and defeat this test.
  process.env.DISCORD_CRM_WEBHOOK = '';
  delete require.cache[require.resolve('../src/config')];

  const discord = freshRequire('../src/discord');
  await assert.rejects(
    () => discord.postCrmHandoff({ userId: 'U1', displayName: 'Test', summary: 'hi' })
  );
});

test('postCrmHandoff includes userId in the payload so Mos can identify the customer', async (t) => {
  process.env.DISCORD_CRM_WEBHOOK = 'https://discord.com/api/webhooks/test/token';
  delete require.cache[require.resolve('../src/config')];

  const axios = require('axios');
  let sentBody;
  t.mock.method(axios, 'post', (url, body) => {
    sentBody = body;
    return Promise.resolve({ status: 204 });
  });

  const discord = freshRequire('../src/discord');
  await discord.postCrmHandoff({ userId: 'Utest123', displayName: 'Test', summary: 'hi' });

  assert.match(sentBody.content, /Utest123/);
});

test('postLead and postCrmFeedback stay fire-and-forget (never throw)', async (t) => {
  process.env.DISCORD_LEADS_WEBHOOK = 'https://discord.com/api/webhooks/test/token';
  process.env.DISCORD_CRM_WEBHOOK = 'https://discord.com/api/webhooks/test/token';
  delete require.cache[require.resolve('../src/config')];

  const axios = require('axios');
  t.mock.method(axios, 'post', () => Promise.reject(new Error('network down')));

  const discord = freshRequire('../src/discord');
  await assert.doesNotReject(() => discord.postLead({ name: 'x' }));
  await assert.doesNotReject(() => discord.postCrmFeedback({ question: 'x' }));
});
