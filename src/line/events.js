// Normalise a raw LINE webhook event into the pipeline's input shape (see core/turn.js).
// Returns null for events we ignore.

function normalise(event) {
    if (!event || !event.source) return null;
    const src = event.source;
    const base = {
        userId: src.userId || null,
        chatType: src.type,                        // user | group | room
        chatId: src.groupId || src.roomId || src.userId || null,
        replyToken: event.replyToken || null,
        timestamp: event.timestamp || Date.now(),
        webhookEventId: event.webhookEventId || null,
        isRedelivery: !!event.deliveryContext?.isRedelivery,
    };
    switch (event.type) {
        case 'message': {
            const m = event.message || {};
            if (m.type === 'text') return { ...base, kind: 'text', text: m.text || '', messageId: m.id };
            return { ...base, kind: 'media', mediaType: m.type, messageId: m.id };
        }
        case 'postback':
            return { ...base, kind: 'postback', data: event.postback?.data || '', params: event.postback?.params || null };
        case 'follow':
            return { ...base, kind: 'follow', isUnblocked: !!event.follow?.isUnblocked };
        case 'unfollow':
            return { ...base, kind: 'unfollow' };
        case 'join':
        case 'leave':
        case 'memberJoined':
        case 'memberLeft':
            return { ...base, kind: event.type };
        default:
            return null;
    }
}

module.exports = { normalise };
