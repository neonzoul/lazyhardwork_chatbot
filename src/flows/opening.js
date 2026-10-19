// Opening turn (brief §3.1, flow §3.2). Fixed text; the model is not called.
const strings = {
    opening: 'สวัสดีครับ ผม Lay ผู้ช่วย AI ของ LazyHardWork\nคนที่ทักมาส่วนใหญ่อยากรู้ 3 เรื่องนี้ครับ กดเลือกได้เลย หรือจะพิมพ์ถามอะไรก็ได้',
    quickReplies: ['ทำอะไรได้บ้าง', 'เหมาะกับงานผมไหม', 'ขอดูตัวอย่าง'],
    mediaReply: 'ตอนนี้ผมยังอ่านรูปหรือไฟล์ไม่ได้ครับ พิมพ์เล่าสั้นๆ มาได้เลย เดี๋ยวช่วยดูให้',
    stickerReply: 'รับทราบครับ มีอะไรให้ช่วยต่อบอกได้เลย',
};

function openingReply() {
    return { text: strings.opening, quickReplies: strings.quickReplies };
}

function mediaReply(mediaType) {
    return { text: mediaType === 'sticker' ? strings.stickerReply : strings.mediaReply, quickReplies: strings.quickReplies };
}

function needsOpening(session, input) {
    if (input.kind === 'follow') return true;
    return !session.opened;
}

module.exports = { openingReply, mediaReply, needsOpening, strings };
