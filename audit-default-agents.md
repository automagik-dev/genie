# Default Agents Audit — `plugins/genie/agents/`

**Wish:** `agent-yaml-permissions-wireup` — Group 4
**Date:** 2026-05-03
**Auditor:** engineer-4

## Methodology

Every subdirectory under `plugins/genie/agents/` was checked for references in `src/`, `skills/`, and `plugins/` (excluding self-references inside its own agent directory). Reference categories considered "live use":

- **Discovery / registry** — `src/lib/builtin-agents.ts` scans the directory; `BUILTIN_ROLES.length === 9` and `BUILTIN_COUNCIL_MEMBERS.length === 11` are asserted by `src/lib/builtin-agents.test.ts`. Removing any directory breaks the 20-agent contract.
- **Spawn / addressability** — `genie spawn <name>`, native team registration (`src/lib/team-manager.ts`, `src/lib/claude-native-teams.ts`), agent directory resolution (`src/lib/agent-directory.ts`), council deliberation flow.
- **Skill workflows** — `skills/pm/SKILL.md`, `skills/work/...`, etc. dispatch by name (`refactor`, `docs`, `trace`, ...).
- **Documentation pointers** — `plugins/genie/agents/team-lead/AGENTS.md` routes to roles by name.

## Audit Table

| # | Role | src/ refs | skills/ refs | plugins/ refs | Decision | Rationale |
|---|------|-----------|--------------|---------------|----------|-----------|
| 1 | `council` | 143 | 27 | 39 | **KEEP** | Council deliberation entry point; asserted in `builtin-agents.test.ts:86`; spawned by `/council` skill. |
| 2 | `council--architect` | 11 | 1 | 0 | **KEEP** | Council member; asserted in `builtin-agents.test.ts:92`; addressable via `Agent` subagent_type and `genie spawn`. |
| 3 | `council--benchmarker` | 1 | 0 | 0 | **KEEP** | Council member; asserted in `builtin-agents.test.ts:88`. |
| 4 | `council--deployer` | 1 | 0 | 0 | **KEEP** | Council member; asserted in `builtin-agents.test.ts:94`. |
| 5 | `council--ergonomist` | 1 | 0 | 0 | **KEEP** | Council member; asserted in `builtin-agents.test.ts:91`. |
| 6 | `council--measurer` | 3 | 0 | 0 | **KEEP** | Council member; asserted in `builtin-agents.test.ts:95`; used in `send.test.ts` topology. |
| 7 | `council--operator` | 1 | 0 | 0 | **KEEP** | Council member; asserted in `builtin-agents.test.ts:93`. |
| 8 | `council--questioner` | 8 | 0 | 0 | **KEEP** | Council member; asserted in `builtin-agents.test.ts:87`; documented in `genie spawn` help (`src/genie.ts:475`). |
| 9 | `council--sentinel` | 3 | 0 | 0 | **KEEP** | Council member; asserted in `builtin-agents.test.ts:90`; used in `claude-native-teams.test.ts:823`. |
| 10 | `council--simplifier` | 3 | 0 | 0 | **KEEP** | Council member; asserted in `builtin-agents.test.ts:89`. |
| 11 | `council--tracer` | 1 | 0 | 0 | **KEEP** | Council member; asserted in `builtin-agents.test.ts:96`. |
| 12 | `docs` | 47 | 46 | 7 | **KEEP** | Standard role; asserted in `builtin-agents.test.ts:45`; close-verb skill; spawned by PM. |
| 13 | `engineer` | 599 | 45 | 18 | **KEEP** | Standard role; asserted in `builtin-agents.test.ts:40`; primary work executor; documented in `genie spawn` help. |
| 14 | `fix` | 398 | 83 | 36 | **KEEP** | Standard role; asserted in `builtin-agents.test.ts:43`; FIX-FIRST loop dispatch. |
| 15 | `pm` | 11 | 3 | 4 | **KEEP** | Standard role; asserted in `builtin-agents.test.ts:48`; project management entry point. |
| 16 | `qa` | 240 | 12 | 7 | **KEEP** | Standard role; asserted in `builtin-agents.test.ts:42`; QA workflow + board column gate. |
| 17 | `refactor` | 13 | 9 | 5 | **KEEP** | Standard role; asserted in `builtin-agents.test.ts:46`; PM dispatches when wish scope mentions "refactor". |
| 18 | `reviewer` | 174 | 28 | 9 | **KEEP** | Standard role; asserted in `builtin-agents.test.ts:41`; review/fix loop. |
| 19 | `team-lead` | 335 | 6 | 19 | **KEEP** | Standard role; asserted in `builtin-agents.test.ts:47,51-56`; system-prompt mode; team orchestration. |
| 20 | `trace` | 75 | 45 | 7 | **KEEP** | Standard role; asserted in `builtin-agents.test.ts:44`; investigation handoff target for `/fix`. |

## Summary

- **Total directories audited:** 20 (matches wish inventory)
- **Kept:** 20
- **Deleted:** 0

## Why nothing was deleted

The `BUILTIN_ROLES.length === 9` and `BUILTIN_COUNCIL_MEMBERS.length === 11` invariants in `src/lib/builtin-agents.test.ts:20,60` lock the directory contents. Each role and each council member is also explicitly asserted by name. Beyond the test contract, every council member is addressable via the `council` deliberation flow and spawn surface; every standard role is dispatched by skills, PM routing, or board column gates.

Result: the audit confirms the 20-agent set is the minimum surface area. No deletions in this wish — Group 6 will migrate frontmatter → `agent.yaml` for all 20 survivors.

## Validation

```bash
# All 20 directories still present, all referenced
$ ls plugins/genie/agents/ | wc -l
20

# Test contract still satisfied
$ bun test src/lib/builtin-agents.test.ts
```
