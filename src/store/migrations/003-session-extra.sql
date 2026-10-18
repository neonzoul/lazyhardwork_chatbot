-- Session fields the pipeline adds over time (quiet_acked, last_kb_refs, offer_shown, examples_shown,
-- last_customer_text, discord_thread_id, demo_state, booking_*…) live in one JSON catch-all so no field is
-- silently dropped again (found by the real-surface smoke on 2026-10-18).
ALTER TABLE sessions ADD COLUMN extra TEXT NOT NULL DEFAULT '{}';
