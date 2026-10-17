// LINE Messaging API wrapper — the only place the LINE SDK is called for sending (conventions: injected deps.line).
const line = require('@line/bot-sdk');

function describeError(err) {
    const body = err?.body || err?.originalError?.response?.data;
    let parsed = body;
    if (typeof body === 'string') { try { parsed = JSON.parse(body); } catch { /* keep string */ } }
    return { status: err?.status || err?.statusCode || err?.originalError?.response?.status, body: parsed, message: err?.message };
}

function createLineClient({ channelAccessToken, log = console } = {}) {
    if (!channelAccessToken) throw new Error('createLineClient: channelAccessToken missing');
    const api = new line.messagingApi.MessagingApiClient({ channelAccessToken });
    return {
        async reply(replyToken, messages) {
            await api.replyMessage({ replyToken, messages });
        },
        async push(to, messages, retryKey) {
            await api.pushMessage({ to, messages }, retryKey);
        },
        async showLoading(chatId, seconds = 5) {
            try { await api.showLoadingAnimation({ chatId, loadingSeconds: seconds }); } catch { /* best effort */ }
        },
        async getProfile(userId) {
            const p = await api.getProfile(userId);
            return { displayName: p.displayName, pictureUrl: p.pictureUrl };
        },
        describeError,
        _api: api,
    };
}

module.exports = { createLineClient, describeError };
