// Proves the scenario runner's plumbing with a stub turn, before the real pipeline exists.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runScenario } = require('../run-scenarios');

const stubTurn = {
  async runTurn(input, deps) {
    const s = await deps.store.sessions.getOrCreate(input.userId);
    if (input.kind === 'follow') {
      await deps.line.push(input.userId, [{ type: 'text', text: 'สวัสดีครับ ผม Lay ผู้ช่วย AI ของมอส คนที่ทักมาส่วนใหญ่อยากรู้ 3 เรื่องนี้', sender: { name: 'Lay · ผู้ช่วย AI' },
        quickReply: { items: ['ทำอะไรได้บ้าง', 'เหมาะกับงานผมไหม', 'ขอดูตัวอย่าง'].map((l) => ({ type: 'action', action: { type: 'message', label: l, text: l } })) } }]);
      return { action: null, session: s, sent: [] };
    }
    let r;
    try { r = await deps.model.respond({}); } catch {
      await deps.line.push(input.userId, [{ type: 'text', text: 'ตอนนี้ระบบขัดข้องชั่วคราวครับ ถ้ารีบ โทร 095 569 1674 (มอส) ได้เลย', sender: { name: 'Lay · ผู้ช่วย AI' },
        quickReply: { items: [{ type: 'action', action: { type: 'message', label: 'เรียก Lay', text: 'เรียก Lay' } }] } }]);
      return { action: null, session: s, sent: [] };
    }
    s.topics_covered = [...new Set([...(s.topics_covered || []), ...r.topics])];
    await deps.store.sessions.save(s);
    await deps.line.push(input.userId, [{ type: 'text', text: r.messages[0].text, sender: { name: 'Lay · ผู้ช่วย AI' },
      quickReply: { items: r.quick_replies.map((l) => ({ type: 'action', action: { type: 'message', label: l, text: l } })) } }]);
    return { action: r.action, session: s, sent: [] };
  },
};

test('smoke scenario passes against the stub turn', async () => {
  const path = require('path');
  const yaml = require('js-yaml');
  const fs = require('fs');
  const sc = { file: '00-smoke-pricing.yaml', ...yaml.load(fs.readFileSync(path.join(__dirname, '..', 'scenarios', '00-smoke-pricing.yaml'), 'utf8')) };
  const r = await runScenario(sc, { turn: stubTurn, modelMode: 'scripted' });
  assert.equal(r.ok, true, JSON.stringify(r.steps.filter((s) => !s.ok), null, 2));
});

test('runner flags a silent turn and a banned reply', async () => {
  const silentTurn = { async runTurn() { return { action: null }; } };
  const r = await runScenario({ file: 'x', name: 'x', steps: [{ user: 'hi', model: 'ok', expect: {} }] }, { turn: silentTurn, modelMode: 'scripted' });
  assert.equal(r.ok, false);
  assert.ok(r.steps[0].fails.some((f) => f.startsWith('SILENT')));

  const bannedTurn = { async runTurn(input, deps) { await deps.line.push(input.userId, [{ type: 'text', text: '[Agent Lay] Sprint 1 ฿15,000 + ดูแล' }]); return { action: null }; } };
  const r2 = await runScenario({ file: 'y', name: 'y', steps: [{ user: 'ราคา', expect: { banned_clean: true, sender: 'lay' } }] }, { turn: bannedTurn, modelMode: 'scripted' });
  assert.equal(r2.ok, false);
  assert.ok(r2.steps[0].fails.some((f) => f.startsWith('banned')));
  assert.ok(r2.steps[0].fails.some((f) => f.startsWith('sender')));
});
