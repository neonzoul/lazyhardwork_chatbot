// Leads export (design §9). Consumed by scripts/lead-sync.js through GET /admin/leads?since= (bearer ADMIN_TOKEN).
// Contact fields are included on purpose: the endpoint is token-protected and the sync agent is inside the trust
// boundary; the vault files decide where contact goes (never the ledger, never Discord).
// Works against the real store and tests/fakes/store.js alike (every call is awaited; fake `all()` may be sync).

const BOOKING_FIELDS = ['id', 'status', 'window_text', 'fields', 'proposed_windows', 'decided_by', 'decided_at', 'created_at'];

function pickBooking(b) {
  if (!b) return null;
  const out = {};
  for (const k of BOOKING_FIELDS) out[k] = b[k] === undefined ? null : b[k];
  return out;
}

/** Latest booking for a lead: prefer the store's forLead(); fall back to scanning all() (fake store). */
async function latestBookingFor(store, lead) {
  let rows;
  if (store.bookings && typeof store.bookings.forLead === 'function') rows = await store.bookings.forLead(lead.id);
  else if (store.bookings && typeof store.bookings.all === 'function') {
    rows = (await store.bookings.all()).filter((b) => b.lead_id === lead.id || (!b.lead_id && b.user_id === lead.user_id));
  } else rows = [];
  if (!rows.length) return null;
  return [...rows].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0];
}

async function exportLeads(store, { since } = {}) {
  const sinceIso = since ? new Date(since).toISOString() : undefined;
  if (since && Number.isNaN(Date.parse(since))) throw new RangeError(`exportLeads: invalid since "${since}"`);
  const leads = await store.leads.since(sinceIso);
  const out = [];
  for (const lead of leads) {
    const session = store.sessions && typeof store.sessions.get === 'function' ? await store.sessions.get(lead.user_id) : null;
    const booking = await latestBookingFor(store, lead);
    out.push({
      id: lead.id,
      status: lead.status || 'new',
      card_id: lead.card_id ?? null,
      symptom: lead.symptom ?? null,
      homework: lead.homework && typeof lead.homework === 'object' ? lead.homework : {},
      customer_words_th: lead.customer_words_th ?? null,
      wave_group: lead.wave_group ?? null,
      source: lead.source || 'line_oa',
      created_at: lead.created_at ?? null,
      updated_at: lead.updated_at ?? null,
      contact: {
        display_name: (session && session.display_name) || null,
        line_user_id: lead.user_id,
      },
      booking: pickBooking(booking),
    });
  }
  return out;
}

module.exports = { exportLeads };
