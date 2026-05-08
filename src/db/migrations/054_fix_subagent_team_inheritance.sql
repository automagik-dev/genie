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

DO $$
DECLARE
  builtin_names text[] := ARRAY[
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
  ];
  has_name_column boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'agent_templates'
      AND column_name = 'name'
  ) INTO has_name_column;

  IF has_name_column THEN
    -- Post-061 schema: agent_templates.id is a UUID PK; name is the text
    -- template key used by roles, built-ins, and parent/child hierarchy.
    EXECUTE $sql$
      UPDATE agent_templates AS child
      SET team = parent.team,
          updated_at = now()
      FROM agent_templates AS parent
      WHERE child.name LIKE parent.name || '/%'
        AND parent.name NOT LIKE '%/%'
        AND child.team IS DISTINCT FROM parent.team
    $sql$;

    EXECUTE 'DELETE FROM agent_templates WHERE name = ANY ($1)' USING builtin_names;
  ELSE
    -- Pre-061 / fresh-install ordering: id is still the text template key.
    EXECUTE $sql$
      UPDATE agent_templates AS child
      SET team = parent.team,
          updated_at = now()
      FROM agent_templates AS parent
      WHERE child.id LIKE parent.id || '/%'
        AND parent.id NOT LIKE '%/%'
        AND child.team IS DISTINCT FROM parent.team
    $sql$;

    EXECUTE 'DELETE FROM agent_templates WHERE id = ANY ($1)' USING builtin_names;
  END IF;
END $$;

COMMIT;
