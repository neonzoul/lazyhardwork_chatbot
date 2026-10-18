// Degraded replies for the "every LLM key is exhausted" case (doc/llm.md §5). Schema-valid responses built by code,
// so the turn pipeline renders them exactly like a model answer: identity, lint, quick replies, persistence.
//
//   degradedReply({ config })              — the question was forwarded to Mos (notify-before-promise: call it only
//                                            after notifier.handoff resolved); phone from config; เรียก Lay + 2 topics
//   degradedNotifyFailedReply({ config })  — the forward failed too: no promise, phone only
//   degradedFitChoiceReply({ config })     — "เหมาะกับงานผมไหม" needs no model: the five-symptom choice card
//
// Thai strings live here (conventions: next to the flow that uses them). No email, no [Agent Lay], no emoji.

const { emptyResponse } = require('../brain/schema');
const { CALL_LAY_LABEL } = require('../identity/quiet');
const fit = require('../flows/fit');

const strings = {
  degraded: (phone) => `ตอนนี้ระบบตอบอัตโนมัติขัดข้องชั่วคราวครับ ผมส่งคำถามของคุณให้มอสแล้ว เดี๋ยวมอสตอบกลับทางแชทนี้\nถ้ารีบ โทร ${phone} ได้เลย`,
  notifyFailed: (phone) => `ตอนนี้ระบบตอบอัตโนมัติขัดข้องชั่วคราวครับ\nถ้ารีบ โทร ${phone} ได้เลย เดี๋ยวมอสเข้ามาดูแชทนี้ให้นะครับ`,
  fitIntro: 'ตอนนี้ระบบตอบอัตโนมัติขัดข้องชั่วคราวครับ แต่เลือกอาการที่ใกล้เคียงได้เลย เดี๋ยวผมส่งให้มอสดูต่อให้',
  followUps: ['ราคาเท่าไหร่', 'เริ่มยังไง'],
};

function phoneOf(config) {
  return (config && config.contact && (config.contact.phoneDisplay || config.contact.phone)) || 'หามอส';
}

function textMessage(text) { return { type: 'text', text, explain: false, template: null, alt: null, data: null }; }

function mark(response, reason) {
  Object.defineProperty(response, '_meta', { value: { degraded: true, reason }, enumerable: false, writable: true, configurable: true });
  return response;
}

function degradedReply({ config } = {}) {
  return mark(emptyResponse({
    messages: [textMessage(strings.degraded(phoneOf(config)))],
    quick_replies: [CALL_LAY_LABEL, ...strings.followUps],
    topics: [], kb_refs: [], intent: 'unknown', action: null,
  }), 'llm_exhausted');
}

function degradedNotifyFailedReply({ config } = {}) {
  return mark(emptyResponse({
    messages: [textMessage(strings.notifyFailed(phoneOf(config)))],
    quick_replies: [CALL_LAY_LABEL],
    topics: [], kb_refs: [], intent: 'unknown', action: null,
  }), 'llm_exhausted_notify_failed');
}

function degradedFitChoiceReply() {
  const card = fit.fitChoiceCard();
  return mark(emptyResponse({
    messages: [
      textMessage(strings.fitIntro),
      { type: 'card', text: null, explain: false, template: card.template, alt: card.alt, data: card.data },
    ],
    quick_replies: [], topics: ['fit'], kb_refs: [], intent: 'fit', action: null,
  }), 'llm_exhausted_fit');
}

module.exports = { degradedReply, degradedNotifyFailedReply, degradedFitChoiceReply, strings };
