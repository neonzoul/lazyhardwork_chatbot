// Shared helpers for repositories: JSON/bool column mapping, binding, ids, time.
const crypto = require('node:crypto');

const nowIso = (clock) => (clock && typeof clock.now === 'function' ? clock.now() : new Date()).toISOString();

/** YYYY-MM-DD (UTC) from a clock — lead and booking ids are date-stamped. */
const dateStamp = (clock) => nowIso(clock).slice(0, 10);

/** `len` lower-case base36 characters from a random source. */
function shortId(len = 6) {
  let out = '';
  while (out.length < len) out += crypto.randomBytes(8).readBigUInt64BE().toString(36);
  return out.slice(0, len);
}

function fromJson(text, fallback) {
  if (text === null || text === undefined || text === '') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

const toJson = (v, fallback) => JSON.stringify(v === undefined || v === null ? fallback : v);
const fromBool = (v) => v === 1 || v === true || v === '1';

/** node:sqlite only binds null/number/bigint/string/Uint8Array — normalise everything else. Keys get the `$` prefix. */
function bind(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    let b = v;
    if (v === undefined) b = null;
    else if (typeof v === 'boolean') b = v ? 1 : 0;
    else if (v instanceof Date) b = v.toISOString();
    else if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array)) b = JSON.stringify(v);
    out[`$${k}`] = b;
  }
  return out;
}

/** Build `INSERT INTO t (a, b) VALUES ($a, $b)` for the given column list. */
const insertSql = (table, cols) => `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `$${c}`).join(', ')})`;

/** Build a repository object whose every method returns a Promise (rejections instead of throws). */
function repo(methods) {
  const out = {};
  for (const [k, fn] of Object.entries(methods)) {
    out[k] = (...args) => {
      try { return Promise.resolve(fn(...args)); } catch (err) { return Promise.reject(err); }
    };
  }
  return out;
}

module.exports = { nowIso, dateStamp, shortId, toJson, fromJson, fromBool, bind, insertSql, repo };
