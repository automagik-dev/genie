# Wish: brain-init-skill — Intelligent Init + /brain-init Claude Code Skill

| Field | Value |
|-------|-------|
| **Status** | SHIPPED (verified 2026-04-08) |
| **Slug** | `brain-init-skill` |
| **Date** | 2026-03-27 |
| **Parent** | [brain-obsidian](../brain-obsidian/WISH.md) |
| **depends-on** | `brain-foundation` |

## Summary

Upgrade `genie brain init` from basic scaffold to intelligent context-aware initialization. Auto-detects brain type (codebase/agent/workspace/empty). Creates a `/brain-init` Claude Code skill that interviews the user and customizes SYSTEM.md, TOOLS.md, CRITERIA.md, MODEL.md via `/refine`. Generates starter entities. The brain is immediately personalized, not generic.

**After this ships:** `genie brain init` in a repo root auto-detects TypeScript/Python/Rust, reads package.json/README/CLAUDE.md, and pre-fills SYSTEM.md with project-specific context. The /brain-init skill makes the brain actually useful from minute one.

## Scope

### IN
- `src/lib/brain/detect.ts` — context auto-detection: scan cwd for package.json (codebase), SOUL.md (agent), .genie/ (workspace), empty (generic). Read project files to pre-fill config.
- Extend `init.ts` — intelligent scaffold: type-specific folders (Architecture/ for code, Intelligence/ for agents), type-specific .obsidian/ graph colors, type-specific _Templates/
- rlmx config scaffolding: SYSTEM.md, TOOLS.md, CRITERIA.md, MODEL.md — pre-tuned to detected context
- For codebase init: read package.json name/description, README.md, CLAUDE.md → auto-fill SYSTEM.md
- For agent init: read SOUL.md, AGENTS.md → auto-fill SYSTEM.md
- `skills/brain-init/SKILL.md` — Claude Code skill that:
  1. Reads scaffolded files
  2. Interviews: domain, audience, reasoning style, custom tools (one question per message)
  3. Auto-invokes /refine on SYSTEM.md + TOOLS.md
  4. Generates 2-3 starter entity files
  5. Runs `genie brain lint` to verify
- After scaffold: auto-runs `genie brain register` + `genie brain update`

### OUT
- Embedding on init (user runs `genie brain update` when ready)

## Success Criteria

- [ ] `genie brain init` in a TypeScript repo scaffolds codebase brain with Architecture/, SYSTEM.md mentioning project name
- [ ] `genie brain init` in an agent workspace scaffolds agent brain with Intelligence/, SYSTEM.md mentioning agent role
- [ ] `genie brain init` in empty dir scaffolds generic brain, prints "Run /brain-init to customize"
- [ ] TOOLS.md has domain-appropriate Python functions (find_imports for code, search_by_tag for agents)
- [ ] `/brain-init` is invocable in Claude Code
- [ ] `/brain-init` interviews (domain, audience, style, tools) one question at a time
- [ ] `/brain-init` auto-invokes `/refine` on SYSTEM.md and TOOLS.md
- [ ] After init: `genie brain lint` passes on the scaffolded brain
- [ ] `bun run check` passes

## Files to Create/Modify

```
CREATE  repos/genie-brain/src/lib/brain/detect.ts
CREATE  repos/genie/skills/brain-init/SKILL.md
MODIFY  repos/genie-brain/src/lib/brain/init.ts              (intelligent scaffold, rlmx configs)

CREATE  repos/genie-brain/src/lib/brain/detect.test.ts
CREATE  repos/genie-brain/src/lib/brain/init.test.ts         (context detection tests)
```
