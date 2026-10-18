// Which KB sections go into this turn's prompt (design §1.2 step 5). pack = output of brain/kb.loadPack.
const ALWAYS_FILES = ['about', 'policies', 'offer', 'process'];
const BY_INTENT = {
    fit: ['fit-map'], capability: ['fit-map'], proof: ['examples'], demo: ['examples'],
    benefits: ['benefits'], faq: ['faq'], pricing: ['faq'], timeline: ['faq'], howtostart: ['faq'],
    tell_me_more: ['faq'], unknown: ['faq', 'fit-map'], homework_answer: ['faq'], booking: [],
};

function selectSections(pack, { intentHint = 'unknown', draft = {}, previousRefs = [] } = {}) {
    if (!pack || !pack.sections) return [];
    const files = new Set([...ALWAYS_FILES, ...(BY_INTENT[intentHint] || ['faq'])]);
    const out = [];
    const seen = new Set();
    const fullOffer = new Set(['pricing', 'tell_me_more', 'faq'].includes(intentHint) ? ['*'] : []);
    for (const [id, sec] of pack.sections) {
        const file = String(sec.file || '').replace(/\.md$/, '');
        if (!files.has(file) || seen.has(id)) continue;
        if (file === 'offer' && !offerWanted(id, { intentHint, draft, fullOffer })) continue;
        out.push({ id, text: sec.text, title: sec.title }); seen.add(id);
    }
    // anchors for "tell me more": the previous answer's refs, whatever file they live in
    for (const ref of previousRefs || []) {
        const sec = pack.sections.get(ref);
        if (sec && !seen.has(ref)) { out.push({ id: ref, text: sec.text, title: sec.title, anchor: true }); seen.add(ref); }
    }
    // the chosen card's offer sections first if a symptom/card is known
    if (draft.card) out.sort((a, b) => (b.id.startsWith(`offer.${draft.card}`) ? 1 : 0) - (a.id.startsWith(`offer.${draft.card}`) ? 1 : 0));
    return out;
}

// offer.md is the largest file: keep every card's headline + T1 door, the T4 paragraph and care; the deeper tiers only
// for the card in the draft or when the customer is on price; the B symptom cards only for fit.
function offerWanted(id, { intentHint, draft, fullOffer }) {
    if (id === 'offer.overview' || id === 'offer.T4') return true;
    const m = /^offer\.([A-C]\d)(?:\.(.+))?$/.exec(id);
    if (!m) return intentHint === 'fit' || intentHint === 'capability'; // offer.symptom-cards, offer.B*
    const [, card, sub] = m;
    if (!sub || sub === 'T1' || sub === 'care') return true;
    if (draft && draft.card === card) return true;
    return fullOffer.has('*');
}

module.exports = { selectSections, offerWanted, ALWAYS_FILES, BY_INTENT };
