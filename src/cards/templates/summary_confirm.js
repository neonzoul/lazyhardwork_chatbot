'use strict';
/**
 * summary_confirm — {title, fields:[{k, v}] (3–6), status: pending|confirmed|declined|reproposed,
 *                    confirm_postback, edit_postback}
 * Status text is set by code (statusPill). Buttons by state:
 *   pending / reproposed → ยืนยัน (primary) + ขอแก้ไข (secondary)
 *   declined             → ขอแก้ไข (primary)   — the one emerald element
 *   confirmed            → no buttons; the pill is the emphasis
 */
const P = require('../primitives');
const { cleanTitle, list } = require('../common');

const ALT = {
  pending: 'รอมอสยืนยัน',
  reproposed: 'มอสเสนอเวลาใหม่',
  confirmed: 'ยืนยันแล้ว',
  declined: 'ยกเลิกแล้ว',
};

function buttons(data) {
  const status = data.status;
  const confirm = data.confirm_postback;
  const edit = data.edit_postback;
  if (status === 'confirmed') return [];
  if (status === 'declined') {
    if (!edit) throw new Error('summary_confirm: edit_postback missing');
    return [P.buttonPrimary('ขอแก้ไข', edit)];
  }
  if (!confirm || !edit) throw new Error('summary_confirm: confirm_postback and edit_postback required');
  return [P.buttonPrimary('ยืนยัน', confirm), P.buttonSecondary('ขอแก้ไข', edit)];
}

function build(data, ctx) {
  const title = cleanTitle(data.title, ctx, 'summary_confirm.title');
  const fields = list(data, 'fields', 1, 6, 'summary_confirm');
  const status = data.status || 'pending';
  if (!ALT[status]) throw new Error(`summary_confirm: unknown status "${status}"`);
  const body = [
    P.header(title),
    P.separator(),
    { type: 'box', layout: 'vertical', spacing: 'sm', contents: fields.map((f) => P.kvRow(f.k, f.v)) },
    P.statusPill(status, typeof data.status_label === 'string' && data.status_label.trim() ? data.status_label.trim() : undefined),
  ];
  return {
    altText: `${title} — ${ALT[status]}`,
    contents: P.bubble({ body, footer: buttons(data) }),
  };
}

function fallback(data) {
  const status = ALT[data.status] ? data.status : 'pending';
  const quick = [];
  if (status !== 'confirmed' && status !== 'declined' && data.confirm_postback) {
    quick.push({ label: 'ยืนยัน', type: 'postback', data: data.confirm_postback });
  }
  if (status !== 'confirmed' && data.edit_postback) {
    quick.push({ label: 'ขอแก้ไข', type: 'postback', data: data.edit_postback });
  }
  return {
    text: [data.title, ...(data.fields || []).map((f) => `${f.k}: ${f.v}`), ALT[status]].join('\n'),
    quick_replies: quick,
  };
}

module.exports = { build, fallback };
