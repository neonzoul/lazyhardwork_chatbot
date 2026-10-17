// Who is speaking (design §6.1). Every outgoing message carries a `sender`; the OA default is never ours.
function createSenders(config) {
    const lay = { name: config.identity.layName, iconUrl: config.identity.layIconUrl || undefined };
    const mos = { name: config.identity.mosName, iconUrl: config.identity.mosIconUrl || undefined };
    return {
        lay,
        mos,
        demo(shop) {
            // shop: { name_th, icon_key } from the examples pack; name must stay ≤ 20 chars
            const base = `${shop.short_name_th || shop.name_th} · ผู้ช่วย AI`;
            const name = [...base].length <= 20 ? base : `${(shop.short_name_th || shop.name_th).slice(0, 8)} · ผู้ช่วย AI`;
            const iconUrl = shop.icon_url || (config.publicBaseUrl && shop.icon_key ? `${config.publicBaseUrl}/assets/${shop.icon_key}.png` : undefined);
            return { name, iconUrl };
        },
        forSession(session, shops = {}) {
            if (session?.mode === 'demo' && session.demo_shop && shops[session.demo_shop]) return this.demo(shops[session.demo_shop]);
            return lay;
        },
    };
}

module.exports = { createSenders };
