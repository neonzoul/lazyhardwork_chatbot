// Fake LINE client: records every send so scenarios can assert on messages, sender, quick replies and Flex JSON.
// fail: { push: Error|null, reply: Error|null } to inject LINE failures.
function createFakeLine({ fail = {}, profiles = {} } = {}) {
  const sent = []; // { via: 'reply'|'push', to, messages }
  return {
    sent,
    async reply(replyToken, messages) {
      if (fail.reply) throw fail.reply;
      sent.push({ via: 'reply', to: replyToken, messages });
    },
    async push(to, messages) {
      if (fail.push) throw fail.push;
      sent.push({ via: 'push', to, messages });
    },
    async showLoading() {},
    async getProfile(userId) { return { displayName: profiles[userId] || 'ลูกค้าทดสอบ' }; },
    // helpers
    lastMessages() { return sent.length ? sent[sent.length - 1].messages : []; },
    allMessages() { return sent.flatMap((s) => s.messages); },
    texts() { return this.allMessages().filter((m) => m.type === 'text').map((m) => m.text); },
    cards() { return this.allMessages().filter((m) => m.type === 'flex'); },
    quickReplies() {
      const last = this.allMessages().at(-1);
      return last?.quickReply?.items?.map((i) => i.action.label) || [];
    },
    senders() { return this.allMessages().map((m) => m.sender?.name || null); },
    reset() { sent.length = 0; },
  };
}

module.exports = { createFakeLine };
