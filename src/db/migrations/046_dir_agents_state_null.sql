-- Backfill: clear 'spawning'/'error' from directory-agent identity rows.
--
-- Directory rows (id prefix `dir:`) are identity records, not runtime spawns.
-- They never have a pane or executor of their own — state is tracked via
-- their runtime/executor children. Prior to this fix, directory.add()
-- INSERTed without a `state` value and the column DEFAULT ('spawning')
-- applied, causing reconcileStaleSpawns() to flip every dir row to
-- 'error' ~60s after every `genie serve` boot.
--
-- The INSERT is now corrected in agent-directory.ts to pass NULL explicitly,
-- and reconcileStaleSpawns() skips `dir:%` ids as belt-and-suspenders.
-- This migration repairs rows already poisoned by the old behavior.
UPDATE agents
   SET state = NULL,
       last_state_change = now()
 WHERE id LIKE 'dir:%'
   AND state IN ('spawning', 'error')
   AND (pane_id IS NULL OR pane_id = '')
   AND current_executor_id IS NULL;
