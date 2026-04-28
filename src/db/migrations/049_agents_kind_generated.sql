-- 049_agents_kind_generated.sql
--
-- Group 3 of the invincible-genie wish.
--
-- Permanence is a structural property of identity, not a runtime fact.
-- Prior to this migration, every consumer reinvented the inference rule
-- (`id LIKE 'dir:%'`, `reports_to IS NULL`, `role = 'team-lead'`, etc.)
-- with subtle differences. The fragmentation is what produced the
-- 2026-04-25 power-outage incident: one consumer's "permanent" was
-- another consumer's "task," and the boot-pass logic could not converge.
--
-- Decision (council R2 → wish §Decisions #4): encode the rule ONCE in
-- the schema. `kind` is GENERATED ALWAYS AS ... STORED so it cannot drift
-- — every INSERT/UPDATE recomputes it from `id` and `reports_to`. No
-- consumer can author a wrong value; no consumer can read a stale one.
--
-- Inference rule (wish §Decisions #5 — identity-shape, not lifecycle):
--   - `id LIKE 'dir:%'`            → 'permanent' (directory identity row)
--   - `reports_to IS NULL`         → 'permanent' (top-of-hierarchy)
--   - everything else              → 'task' (child spawn)
--
-- Identity-shape is preferred over assignments-presence inference because
-- archived assignments would otherwise "promote" task agents to permanent
-- post-completion, breaking the boot-pass invariant.
--
-- Read-site replacement: every `id LIKE 'dir:%'` / `reports_to IS NULL`
-- ad-hoc inference in `src/` is migrated to `WHERE kind = 'permanent'`
-- (or `WHERE kind = 'task'` for the inverse). The grep
--   rg "id LIKE 'dir:%'\|reports_to IS NULL" src/
-- should return zero hits outside this migration file and the docs.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS kind TEXT
  GENERATED ALWAYS AS (
    CASE
      WHEN id LIKE 'dir:%' OR reports_to IS NULL THEN 'permanent'
      ELSE 'task'
    END
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_agents_kind ON agents (kind);
