// Fake Discord notifier. `fail` names which calls throw: { handoff: true, booking: true, kbGap: true, lead: true }.
function createFakeNotifier({ fail = {} } = {}) {
  const calls = [];
  let n = 0;
  const make = (name, promiseBacked) => async (payload) => {
    calls.push({ name, payload });
    if (fail[name]) throw new Error(`fake notifier: ${name} failed`);
    return promiseBacked ? { threadId: `T${++n}` } : undefined;
  };
  return {
    calls,
    fail,
    handoff: make('handoff', true),
    booking: make('booking', true),
    kbGap: make('kbGap', false),
    lead: make('lead', false),
    relayToMos: make('relayToMos', false),
    named(name) { return calls.filter((c) => c.name === name); },
    reset() { calls.length = 0; },
  };
}

module.exports = { createFakeNotifier };
