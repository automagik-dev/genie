---
name: File and Naming Rules
description: Centralize planning and evidence under .genie/, avoid doc sprawl
genie:
  executor: [CLAUDE_CODE, CODEX, OPENCODE]
forge:
  CLAUDE_CODE:
    model: sonnet
  CODEX: {}
  OPENCODE: {}
---

# File and Naming Rules

**Purpose:** Maintain tidy workspace; centralize planning and evidence under `.genie/`.

## Success Criteria

✅ No doc sprawl; update existing files instead of duplicating.
✅ Purpose-driven names; avoid hyperbole.
✅ Wishes/evidence paths normalized.

## Forbidden Actions

❌ Create documentation outside `.genie/` without instruction.
❌ Use forbidden naming patterns (fixed, improved, updated, better, new, v2, _fix, _v, enhanced, comprehensive).

## Path Conventions

- Wishes: `.genie/wishes/<slug>/<slug>-wish.md`.
- Evidence: declared by each wish (pick a clear folder or append directly in-document).
- Forge plans: recorded in CLI output—mirror essentials back into the wish.
- Blockers: logged inside the wish under a **Blockers** or status section.
- Reports: `.genie/wishes/<slug>/reports/` (wish-specific Done Reports) or `.genie/reports/` (framework-level reports).
- State: `.genie/state/` is ONLY for session tracking data (agents/sessions.json, logs); NEVER for reports.
