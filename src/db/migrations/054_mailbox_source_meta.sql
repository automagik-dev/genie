-- 054_mailbox_source_meta.sql
--
-- Foundation for the channel-shaped envelope (PR A in the channels-pivot
-- roadmap). The mailbox row gains two optional, idempotent columns so the
-- delivery layer can carry source attribution and arbitrary metadata
-- (whatsapp phone, telegram chat id, system nudge kind, …) end-to-end:
--
--   - `source TEXT NOT NULL DEFAULT 'agent'` — origin of the message. The
--     default keeps every pre-existing row (and every legacy `mailbox.send`
--     caller that doesn't pass an opts arg) reading as `'agent'`, which is
--     the back-compat behaviour the renderer expects (plain body, no
--     `<channel …>` wrap).
--   - `meta JSONB NOT NULL DEFAULT '{}'::jsonb` — free-form k/v map.
--     Persisted verbatim and re-hydrated by the inbox/outbox readers so
--     channel-aware UIs round-trip the data.
--
-- Indexes are deliberately omitted — every existing inbox/outbox query
-- already filters on `to_worker` / `from_worker`, so no extra index is
-- needed for the foundation. PR C+ may add a `(to_worker, source)` index
-- once it's clear which sources warrant their own hot path.
--
-- Re-runnable: both ALTER COLUMN clauses use `IF NOT EXISTS`.

ALTER TABLE mailbox
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'agent';

ALTER TABLE mailbox
  ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb;
