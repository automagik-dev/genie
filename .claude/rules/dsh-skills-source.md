---
paths:
  - plugins/dsh-genie-board/**
---

# DSH skills-source gotcha

Moved verbatim from CLAUDE.md `## Gotchas` by issue #2967; the always-on floor and
the rules index live there. This file loads when Claude reads a file matching a
`paths:` glob above; a grep-only session never loads it.

- **`~/.agents/skills` is also the DSH body's skill source — never add a `ctx.skills` provider for genie's library** — DSH's stock `skill-filesystem` discoverer (mounted per agent preset by `dsh-web-app`; the base host row is disabled on purpose) serves `~/.agents/skills` as source `user-agents`, rank 500, resource base = the skill directory, so the skills.sh channel is genie's first-party delivery to DSH with zero plugin code (verified 2026-09-15 by instantiating the registry against the installed 0.1.5-rc.2 packages: all 14 skills resolve, `wish` renders its base directory). A council rejected the `dsh-praxis`-style provider: second unrecorded delivery path invisible to doctor/uninstall, bypasses `--integrations none`, needs its own invalidation, and cordis inject is required-only so a board row that injects `skills` unmounts with the skill service. Per-checkout dogfood is a profile config row (`customSkillDirs`, rank 300), not code.
