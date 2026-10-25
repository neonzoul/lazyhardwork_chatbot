#!/usr/bin/env node
// Scenario runner (design §12). Drives src/core/turn.runTurn with fakes and asserts the brief §9 properties.
//
//   node tests/run-scenarios.js [--dir tests/scenarios] [--only <substring>] [--model scripted|real] [--json out.json]
//
// Scenario YAML:
//   name: ราคาแล้วถามต่อ
//   user: { id: Utest1, displayName: "พี่เอ" }          # optional
//   session: { mode: lay, topics_covered: [], ... }       # optional initial session fields
//   steps:
//     - user: "ราคาเท่าไหร่"                               # customer text (one burst)
//       model: { messages: [...], topics: [pricing], ... }  # scripted model response for THIS step (scripted mode);
//                                                          # a list = the reply, then the regenerated one(s)
//       expect: { ... }                                    # see assert() below
//     - postback: FIT_chat_overload
//     - media: image
//     - follow: true
//     - fault: { notifier: handoff }     # next call of notifier.handoff throws (also: notifier: booking|kbGap, model: throw|garbage|exhausted, line: push|reply)
//                                        # model: exhausted = every OpenRouter key out of credit for the next model call (doc/llm.md §5)
//     - clock: { advance_minutes: 31 }
//     - mos: { threadId: T1, text: "..." }   # a relayed Mos message (relay side) — pushed as "มอส", mode → mos_active
//     - decision: { decision: approve|propose|decline, windows: [..] }   # Mos's booking decision (flows/endings.applyMosDecision)
//     - allow: [booking_confirmed]         # lint ids the following steps may legitimately contain
//   fault.line: reply | push | [reply, push, push] — each named call of the fake LINE client throws once, in order
//
// expect keys: replies (int) · replies_min · text_contains [..] · text_not_contains [..] · quick_replies [..] (exact)
//   · quick_replies_includes [..] · quick_replies_max (int) · card (template|null) · sender (lay|mos|demo|null)
//   · banned_clean (bool) · emoji_max (int) · no_prose_list (bool) · action (string|null) · notified [names]
//   · not_notified [names] · silent (bool: the step may send nothing)
//   · alerts { critical: n, recovered: n, warn: n } (cumulative Discord operator alerts posted so far — real discord/alerts with a recording transport)
//   · session { mode, topics_covered_includes [..], questions_asked_max, draft_has [..], homework_has [..] }

// Deterministic test config: the scenarios must not depend on a developer's .env (the first CI run on 18 Oct failed
// because offer cards need a Fastwork URL and the examples carousel needs an https base URL). Real values win when set.
process.env.FASTWORK_URL = process.env.FASTWORK_URL || 'https://fastwork.co/test-profile';
process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://lay.example.test';
process.env.EXAMPLES_IMAGES_READY = process.env.EXAMPLES_IMAGES_READY || '1'; // the carousel scenarios test the image path

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { createFakeLine } = require('./fakes/line');
const { createFakeNotifier } = require('./fakes/notifier');
const { createFakeModel } = require('./fakes/model');
const { createFakeClock } = require('./fakes/clock');
const { createFakeStore } = require('./fakes/store');
const { createAlerts } = require('../src/discord/alerts');
const lint = require('../src/core/lint');
let PACK = null;
try { const { loadPack } = require('../src/brain/kb'); PACK = loadPack(path.join(__dirname, '..', 'knowledge')); } catch { PACK = null; }

const SENDER_NAMES = { lay: 'Agent Lay · AI', mos: 'มอส' };
// Vocabulary — tests/unit/scenarios.test.js checks every YAML against these so a typo fails `npm test`.
const EXPECT_KEYS = ['replies', 'replies_min', 'text_contains', 'text_not_contains', 'quick_replies', 'quick_replies_includes', 'quick_replies_max',
  'card', 'sender', 'banned_clean', 'emoji_max', 'no_prose_list', 'action', 'notified', 'not_notified', 'silent', 'session', 'alerts'];
const SESSION_EXPECT_KEYS = ['mode', 'topics_covered_includes', 'questions_asked_max', 'draft_has', 'homework_has'];
// `expect_scripted` checks only hold when the scripted model said exactly what the step scripts (e.g. a repaired link);
// with --model real only `expect` applies
const stepExpect = (step, mode) => ({ ...(step.expect || {}), ...(mode !== 'real' ? step.expect_scripted || {} : {}) });
const STEP_KEYS = ['user', 'postback', 'media', 'follow', 'mos', 'decision', 'fault', 'clock', 'allow', 'model', 'expect', 'expect_scripted', 'note'];
const INPUT_STEP_KEYS = ['user', 'postback', 'media', 'follow', 'mos', 'decision'];

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : def; }

function loadScenarios(dir, only) {
  return fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()
    .map((f) => ({ file: f, ...yaml.load(fs.readFileSync(path.join(dir, f), 'utf8')) }))
    .filter((s) => !only || (s.name || s.file).includes(only));
}

function flexTemplate(msg) { return msg?.contents?._template || msg?.altText || 'flex'; }

function assertStep(expect, ctx) {
  const fails = [];
  const { line, notifier, result, session, sentBefore } = ctx;
  const sends = line.sent.slice(sentBefore);
  const msgs = sends.flatMap((s) => s.messages);
  const texts = msgs.filter((m) => m.type === 'text').map((m) => m.text);
  const joined = texts.join('\n');
  const card = msgs.find((m) => m.type === 'flex');
  const last = msgs.at(-1);
  const qr = last?.quickReply?.items?.map((i) => i.action.label) || [];
  const check = (cond, msg) => { if (!cond) fails.push(msg); };

  if (expect.replies !== undefined) check(msgs.length === expect.replies, `replies ${msgs.length} ≠ ${expect.replies}`);
  if (expect.replies_min !== undefined) check(msgs.length >= expect.replies_min, `replies ${msgs.length} < ${expect.replies_min}`);
  for (const t of expect.text_contains || []) check(joined.includes(t), `text missing "${t}"`);
  for (const t of expect.text_not_contains || []) check(!joined.includes(t), `text must not contain "${t}"`);
  if (expect.quick_replies) check(JSON.stringify(qr) === JSON.stringify(expect.quick_replies), `quick replies ${JSON.stringify(qr)} ≠ ${JSON.stringify(expect.quick_replies)}`);
  for (const q of expect.quick_replies_includes || []) check(qr.includes(q), `quick replies missing "${q}"`);
  if (expect.quick_replies_max !== undefined) check(qr.length <= expect.quick_replies_max, `quick replies ${qr.length} > ${expect.quick_replies_max}`);
  if ('card' in expect) {
    if (expect.card === null) check(!card, `unexpected card ${card && flexTemplate(card)}`);
    else check(card && flexTemplate(card) === expect.card, `card ${card ? flexTemplate(card) : 'none'} ≠ ${expect.card}`);
  }
  if ('sender' in expect) {
    const want = expect.sender === null ? null : expect.sender === 'demo' ? 'demo' : SENDER_NAMES[expect.sender];
    for (const m of msgs) {
      const got = m.sender?.name || null;
      if (want === 'demo') check(got && got.includes('ผู้ช่วย AI') && got !== SENDER_NAMES.lay, `sender "${got}" is not a demo shop`);
      else check(got === want, `sender "${got}" ≠ "${want}"`);
    }
  }
  if (expect.banned_clean) for (const t of texts) { const b = lint.findBanned(t, ctx.allow); check(b.length === 0, `banned ${b.map((x) => x.id).join(',')} in "${t.slice(0, 40)}"`); }
  if (expect.emoji_max !== undefined) { const n = texts.reduce((a, t) => a + lint.countEmoji(t), 0); check(n <= expect.emoji_max, `emoji ${n} > ${expect.emoji_max}`); }
  if (expect.no_prose_list) for (const t of texts) check(!lint.hasProseList(t), `prose list in "${t.slice(0, 40)}"`);
  if ('action' in expect) check((result?.action ?? null) === expect.action, `action ${result?.action ?? null} ≠ ${expect.action}`);
  for (const n of expect.notified || []) check(notifier.named(n).length > 0, `notifier.${n} not called`);
  for (const n of expect.not_notified || []) check(notifier.named(n).length === 0, `notifier.${n} was called`);
  if (expect.alerts) for (const [name, n] of Object.entries(expect.alerts)) check((ctx.alerts?.named(name) || []).length === n, `alerts.${name} posted ${(ctx.alerts?.named(name) || []).length} ≠ ${n}`);
  if (expect.session) {
    const s = session || {};
    const e = expect.session;
    if (e.mode) check(s.mode === e.mode, `mode ${s.mode} ≠ ${e.mode}`);
    for (const t of e.topics_covered_includes || []) check((s.topics_covered || []).includes(t), `topics_covered missing ${t}`);
    if (e.questions_asked_max !== undefined) check((s.questions_asked || 0) <= e.questions_asked_max, `questions_asked ${s.questions_asked} > ${e.questions_asked_max}`);
    for (const k of e.draft_has || []) check(s.draft && s.draft[k] != null, `draft.${k} missing`);
    for (const k of e.homework_has || []) check(s.homework && s.homework[k] != null, `homework.${k} missing`);
  }
  return fails;
}

// `line.failNext` — the fake reads a static `fail` map; the runner adds one-shot failures on top without touching the fake.
// failNext: 'reply' | 'push' | ['reply', 'push', ...] — each entry makes the next call of that method throw once, in order.
function withFailNext(line) {
  const wrap = (name) => {
    const orig = line[name].bind(line);
    line[name] = async (...args) => {
      const list = Array.isArray(line.failNext) ? line.failNext : line.failNext ? [line.failNext] : [];
      const i = list.indexOf(name);
      if (i > -1) { list.splice(i, 1); line.failNext = list.length ? list : null; throw Object.assign(new Error(`fake line: ${name} failed (fault.line)`), { statusCode: 500 }); }
      return orig(...args);
    };
  };
  wrap('reply'); wrap('push');
  line.failNext = null;
  return line;
}

// Compact view of what the customer saw this step (for --json / scripts/scenario-report.js).
function bubblesOf(sends) {
  return sends.flatMap((s) => s.messages.map((m) => ({
    via: s.via, type: m.type === 'flex' ? 'card' : m.type, text: m.type === 'text' ? m.text : null,
    template: m.type === 'flex' ? flexTemplate(m) : null, alt: m.type === 'flex' ? m.altText || null : null,
    sender: m.sender?.name || null, quick_replies: m.quickReply?.items?.map((i) => i.action.label) || [],
  })));
}

// Operator alerts: the real src/discord/alerts (so the 15-min throttle is exercised) over a recording transport.
function createAlertsRecorder(clock) {
  const posts = [];
  const transport = {
    botConfigured: true,
    async postMessage({ channelId, content, allowedMentions }) { posts.push({ channelId, content, allowedMentions }); },
    async postWebhook() { throw new Error('no webhook in scenarios'); },
    async createThread() { throw new Error('no threads in scenarios'); },
  };
  const alerts = createAlerts({ transport, crmChannelId: 'crm', clock, statusLine: () => 'keys: scenario' });
  const RE = { critical: /CRITICAL/, recovered: /recovered/, warn: /warning/ };
  alerts.posts = posts;
  alerts.named = (name) => posts.filter((p) => RE[name] && RE[name].test(p.content));
  return alerts;
}

function runnerConfig() { try { return { ...require('../src/config'), examplesImagesReady: true }; } catch { return { contact: { phoneDisplay: '095 569 1674 (มอส)', hoursStart: 13, hoursEnd: 22 }, identity: { layName: 'Lay · ผู้ช่วย AI', mosName: 'มอส' }, quiet: { windowMinutes: 30, debounceMs: 6500 }, publicBaseUrl: '' }; } }

async function runScenario(sc, { turn, modelMode }) {
  const line = withFailNext(createFakeLine({ profiles: sc.user?.displayName ? { [sc.user?.id || 'Utest']: sc.user.displayName } : {} }));
  const notifier = createFakeNotifier();
  const model = modelMode === 'real' ? require('../src/brain/respond').createModel() : createFakeModel();
  const clock = createFakeClock(sc.start || undefined);
  const store = createFakeStore();
  const alerts = createAlertsRecorder(clock);
  const deps = { line, notifier, model, clock, store, alerts, pack: sc.pack || PACK, log: { info() {}, warn() {}, error() {} } };
  const userId = sc.user?.id || 'Utest';
  if (sc.session) { const s = await store.sessions.getOrCreate(userId); Object.assign(s, sc.session); await store.sessions.save(s); }

  const stepResults = [];
  let allow = new Set();
  let pendingNotifierFault = null;
  let pendingModelFault = null;
  for (const [i, step] of (sc.steps || []).entries()) {
    if (step.fault) {
      if (step.fault.notifier) { notifier.fail[step.fault.notifier] = true; pendingNotifierFault = step.fault.notifier; }
      if (step.fault.model && typeof model.push === 'function') { model.push(step.fault.model); pendingModelFault = step.fault.model; } // real model: faults cannot be injected
      if (step.fault.line) line.failNext = step.fault.line;
      stepResults.push({ i, kind: 'fault', ok: true });
      continue;
    }
    if (step.clock) { if (step.clock.advance_minutes) clock.advanceMinutes(step.clock.advance_minutes); stepResults.push({ i, kind: 'clock', ok: true }); continue; }
    if (step.allow) { allow = new Set(step.allow); continue; }
    // `model:` may be a list: the first reply, then the regenerated one(s) for the same step (repeat / policy regenerate)
    const scriptedList = step.model && modelMode !== 'real' ? (Array.isArray(step.model) ? step.model : [step.model]) : [];
    if (scriptedList.length) model.push(...scriptedList);
    // a scripted reply the turn did not use (code answered it: price range, out of scope, details) must not leak into the
    // next step's model call (19 Oct: the price answer moved from the model to the approved FAQ)

    if (step.decision) {
      // Mos's booking decision from Discord: not a turn — flows/endings.applyMosDecision pushes to the customer as Lay.
      const sentBefore = line.sent.length;
      let fails = [];
      try {
        const endings = require('../src/flows/endings');
        const { createSenders } = require('../src/identity/sender');
        const config = runnerConfig();
        const sess = await store.sessions.getOrCreate(userId);
        const booking = (sess.booking_id && await store.bookings.get(sess.booking_id)) || await store.bookings.pendingFor(userId);
        if (!booking) throw new Error('decision: no booking for this user');
        await endings.applyMosDecision({ decision: step.decision.decision, windows: step.decision.windows || [], booking, session: sess, deps, config, senders: createSenders(config) });
        const session = await store.sessions.get(userId);
        fails = assertStep(stepExpect(step, modelMode), { line, notifier, alerts, result: { action: null }, session, sentBefore, allow });
      } catch (e) { fails = [`decision threw: ${e.message}`]; }
      stepResults.push({ i, kind: 'decision', input: step.decision, ok: fails.length === 0, fails, sent: line.sent.slice(sentBefore), bubbles: bubblesOf(line.sent.slice(sentBefore)) });
      continue;
    }

    const input = step.user !== undefined ? { kind: 'text', text: String(step.user) }
      : step.postback !== undefined ? { kind: 'postback', data: String(step.postback) }
      : step.media ? { kind: 'media', mediaType: step.media }
      : step.follow ? { kind: 'follow' }
      : step.mos ? { kind: 'mos_relay', threadId: step.mos.threadId, text: step.mos.text }
      : null;
    if (!input) { stepResults.push({ i, kind: 'unknown', ok: false, fails: ['step has no user/postback/media/follow/mos/decision/fault/clock'] }); continue; }
    input.userId = userId; input.replyToken = `rt${i}`; input.timestamp = clock.now().getTime(); input.displayName = sc.user?.displayName;

    const sentBefore = line.sent.length;
    let result = null; let err = null;
    try { result = await turn.runTurn(input, deps); } catch (e) { err = e; }
    for (const sc1 of scriptedList) { const k = model.queue.indexOf(sc1); if (k >= 0) model.queue.splice(k, 1); }
    if (pendingModelFault !== null) { const k = model.queue.indexOf(pendingModelFault); if (k >= 0) model.queue.splice(k, 1); pendingModelFault = null; }
    const session = await store.sessions.get(userId);
    const fails = err ? [`runTurn threw: ${err.message}`] : assertStep(stepExpect(step, modelMode), { line, notifier, alerts, result, session, sentBefore, allow });
    // never-silent: every customer-originated step must produce at least one outgoing message unless the scenario says silent
    if (!err && !stepExpect(step, modelMode).silent && line.sent.length === sentBefore && input.kind !== 'mos_relay') fails.push('SILENT: no message sent');
    stepResults.push({ i, kind: input.kind, input: step.user ?? step.postback ?? step.media ?? (step.mos ? step.mos.text : 'follow'), ok: fails.length === 0, fails, sent: line.sent.slice(sentBefore), bubbles: bubblesOf(line.sent.slice(sentBefore)), errors: (result?.errors || []).map((e) => e.message) });
    // a notifier fault lasts for exactly one input step (the header promises "next call"); it used to stick for the whole scenario
    if (pendingNotifierFault) { delete notifier.fail[pendingNotifierFault]; pendingNotifierFault = null; }
  }
  const ok = stepResults.every((s) => s.ok);
  return { name: sc.name || sc.file, file: sc.file, ok, covers: sc.covers || [], pending_transcript: !!sc.pending_transcript, steps: stepResults, transcript: line.sent, store: store._dump() };
}

async function main() {
  const dir = arg('dir', path.join(__dirname, 'scenarios'));
  const only = arg('only', null);
  const modelMode = arg('model', 'scripted');
  const jsonOut = arg('json', null);
  const turn = require('../src/core/turn');
  const scenarios = loadScenarios(dir, only);
  if (!scenarios.length) { console.log('no scenarios'); return; }
  const results = [];
  for (const sc of scenarios) {
    const r = await runScenario(sc, { turn, modelMode });
    results.push(r);
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.file})`);
    for (const s of r.steps) if (!s.ok) console.log(`      step ${s.i} [${s.kind}] ${JSON.stringify(s.input)}\n        - ${s.fails.join('\n        - ')}`);
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} scenarios passed`);
  if (jsonOut) { fs.mkdirSync(path.dirname(jsonOut), { recursive: true }); fs.writeFileSync(jsonOut, JSON.stringify({ ran_at: new Date().toISOString(), model: modelMode, passed, total: results.length, results }, null, 2)); }
  process.exitCode = passed === results.length ? 0 : 1;
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(2); });
module.exports = { runScenario, assertStep, loadScenarios, EXPECT_KEYS, SESSION_EXPECT_KEYS, STEP_KEYS, INPUT_STEP_KEYS };
