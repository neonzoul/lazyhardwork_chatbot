// Controllable clock for the quiet window / idle rules.
function createFakeClock(start = '2026-10-18T10:00:00+07:00') {
  let t = new Date(start).getTime();
  return {
    now() { return new Date(t); },
    advance(ms) { t += ms; },
    advanceMinutes(min) { t += min * 60 * 1000; },
    set(iso) { t = new Date(iso).getTime(); },
  };
}

module.exports = { createFakeClock };
