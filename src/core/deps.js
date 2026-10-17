// Dependency container (design §1, conventions "everything external is injected").
// Production wiring lives in src/app.js (to come); tests and the scenario runner pass fakes from tests/fakes.
//
// Interfaces (duck-typed; keep them this small):
//   line: {
//     reply(replyToken, messages) → Promise<void>
//     push(to, messages) → Promise<void>
//     showLoading(userId) → Promise<void>            best effort
//     getProfile(userId) → Promise<{displayName}>
//   }
//   notifier: {
//     handoff({lead, session, kind, draft}) → Promise<{threadId}>   MUST throw on failure (promise-backed)
//     booking({lead, booking}) → Promise<{threadId}>                 MUST throw on failure
//     kbGap({question, userId}) → Promise<void>                      best effort
//     lead({lead}) → Promise<void>                                   best effort
//     relayToMos({threadId, text}) → Promise<void>                   best effort
//   }
//   store: repositories (see src/store) — sessions.get/upsert, messages.append, leads.*, bookings.*, kbGaps.*, events.append
//   model: { respond({system, messages, schema}) → Promise<object> }  returns the parsed structured response or throws
//   clock: { now() → Date }
//   log:   { info(event, fields), warn(event, fields), error(event, fields) }

function consoleLog() {
  const line = (level) => (event, fields = {}) => {
    const safe = { ...fields };
    for (const k of Object.keys(safe)) if (typeof safe[k] === 'string' && safe[k].length > 80) safe[k] = safe[k].slice(0, 80) + '…';
    // eslint-disable-next-line no-console
    console[level === 'error' ? 'error' : 'log'](JSON.stringify({ t: new Date().toISOString(), level, event, ...safe }));
  };
  return { info: line('info'), warn: line('warn'), error: line('error') };
}

function createDeps(overrides = {}) {
  const required = ['line', 'notifier', 'store', 'model'];
  for (const k of required) if (!overrides[k]) throw new Error(`deps.${k} is required`);
  return {
    clock: { now: () => new Date() },
    log: consoleLog(),
    ...overrides,
  };
}

module.exports = { createDeps, consoleLog };
