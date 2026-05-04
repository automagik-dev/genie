-- 062_drop_fk_mailbox_from_worker_temp.sql
--
-- Wish: retire-session-names-id-only, G7 kill-switch.
--
-- TEMPORARY MIGRATION — DROPS fk_mailbox_from_worker (added by migration 061)
-- so the dispatcher unblocks while groups G3-G7 of the bundle PR are still
-- landing in parallel. The dispatcher's `cliSender` path currently writes
-- mailbox rows with non-UUID strings (e.g. `cli:<name>`), which fails the FK
-- introduced in 061 and aborts every dispatch follow-up with a PostgresError.
--
-- ⚠️  THIS MIGRATION IS A KILL-SWITCH, NOT A REVERT. ⚠️
--   - It is the FIRST half of a bundle: 062 drops the FK; 063 re-adds it.
--   - Both files ship in the same PR.
--   - 062 is applied locally NOW (2026-05-04) to unblock dispatch.
--   - 063 MUST run AFTER all G4-G7 callers (msg.ts, agent/send.ts, hooks,
--     dispatch-client) are reviewed-green and confirmed to write UUIDs into
--     mailbox.from_worker. The reviewer gates 063's application explicitly
--     ("all G4-G7 callers clean").
--
-- Idempotent: drops only when the constraint exists. A re-run after 063 has
-- re-added the FK is a no-op iff someone re-applies 062 by mistake — the
-- IF-EXISTS guard means it WILL re-drop the FK. Operators must coordinate
-- 062/063 ordering in the migration log.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_mailbox_from_worker'
  ) THEN
    ALTER TABLE mailbox DROP CONSTRAINT fk_mailbox_from_worker;
    RAISE NOTICE '[062] dropped fk_mailbox_from_worker (kill-switch active until 063 runs)';
  ELSE
    RAISE NOTICE '[062] fk_mailbox_from_worker not present — no-op';
  END IF;
END $$;
