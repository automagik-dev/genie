-- 054_fix_subagent_team_inheritance.sql — Backfill agent_templates.team for
-- subagents and wipe sticky team pins on built-in roles + council members.
--
-- Why
-- ---
-- Two pre-fix defects let the team column drift away from its semantic owner:
--
--   1. Subagent rows (id = 'parent/child') were saved with whatever team the
--      operator's session happened to be in (often 'felipe' or 'genie'),
--      not the parent agent's team. Downstream `genie send`, mailbox
--      routing, and inbox visibility used the wrong team.
--
--   2. Built-in roles (engineer, trace, qa, fix, reviewer, etc.) and council
--      members (council, council--*) are SHARED across teams — they were
--      never meant to carry a sticky team. The first spawn pinned the team
--      forever via `lookupTemplateTeam`, contaminating every later spawn.
--
-- The runtime fix in this PR (skip-saveTemplate for built-ins, parent
-- override for subagents) prevents the regression going forward; this
-- migration heals the rows already poisoned in production databases.
--
-- Idempotent: re-running this migration is a no-op once the rows are clean.

BEGIN;

-- 1. Backfill: subagent rows inherit their parent's team.
--    `child.id LIKE parent.id || '/%'` matches `parent/anything` whose parent
--    name has no slash itself (avoids matching grandparent/parent/child).
--    Skip when child.team already equals parent.team.
UPDATE agent_templates AS child
SET team = parent.team,
    updated_at = now()
FROM agent_templates AS parent
WHERE child.id LIKE parent.id || '/%'
  AND parent.id NOT LIKE '%/%'
  AND child.team IS DISTINCT FROM parent.team;

-- 2. Wipe sticky pins for built-in roles + council members.
--    Built-ins are SHARED — runtime resolution (GENIE_TEAM env, tmux
--    discovery) decides the team per-spawn now. Keeping the rows would let
--    `lookupTemplateTeam` keep returning a stale team for the first caller
--    of every spawn until the rows are overwritten with a fresh team —
--    which the runtime fix now refuses to do.
DELETE FROM agent_templates
WHERE id IN (
  -- BUILTIN_ROLES (plugins/genie/agents/*/AGENTS.md, category=role)
  'docs',
  'engineer',
  'fix',
  'pm',
  'qa',
  'refactor',
  'reviewer',
  'team-lead',
  'trace',
  -- BUILTIN_COUNCIL_MEMBERS (plugins/genie/agents/council*, category=council)
  'council',
  'council--architect',
  'council--benchmarker',
  'council--deployer',
  'council--ergonomist',
  'council--measurer',
  'council--operator',
  'council--questioner',
  'council--sentinel',
  'council--simplifier',
  'council--tracer'
);

COMMIT;
