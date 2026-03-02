# Brainstorm: Forge Resilience
**Status:** VALIDATED
**Author:** Sofia 🎯 (PM)
**Date:** 2026-02-10
**Source:** Field report from real incident — Omni agent (Opus 4.6) attempting `/forge` on openclaw-provider-integration wish

---

## Problem

When an AI agent runs `/forge` → `term work` in a repo where beads infrastructure is broken or uninitialized, it enters a 5-minute debugging loop that requires human intervention. This was observed live on 2026-02-10.

### Root Cause Chain

1. `term work <id>` requires `.genie/tasks.json` to exist — fails silently if missing
2. `bd create` succeeds but `bd show` fails with "LEGACY DATABASE DETECTED" — inconsistent behavior confuses agent
3. `/forge` skill recommends spawn mode (depends on beads + term work) with no fallback when those fail
4. Error messages say WHAT failed but not WHY or HOW TO FIX — agent can't self-diagnose

### Evidence

- Field report: `/home/genie/workspace/sofia/memory/genie-cli-field-report.md`
- Council review (5 members): `/home/genie/workspace/sofia/memory/council-pr30-review.md`
- PR #30 exists (code-first, no wish) — needs retroactive governance

## Solution

Three targeted fixes + two council-recommended improvements:

1. **Graceful init** — `term work` auto-creates `.genie/tasks.json` if missing
2. **Beads fallback** — `getBeadsIssue()` tries `bd list` when `bd show` fails
3. **Inline mode** — `--inline` flag + auto-fallback when beads claim fails
4. **Degraded mode logging** — emit `⚠️ [DEGRADED]` when auto-fallback activates (council: Operator + Questioner)
5. **Error message TIPs** — every beads failure message ends with actionable TIP (council: Ergonomist + Questioner)

## Scope

### IN
- `src/lib/local-tasks.ts` — `ensureTasksFile()`, `claimTask()` guards
- `src/term-commands/work.ts` — `getBeadsIssue()` fallback, `--inline` flag, auto-fallback, error messages
- `src/term.ts` — wire `--inline` flag
- Tests for all new behavior

### OUT
- Fixing beads legacy DB migration itself (that's a beads issue, not genie-cli)
- Changes to `/forge` skill SKILL.md (separate wish if needed)
- Changes to `ship` command for inline-mode workers (future wish)
- Dashboard or UI changes

## Key Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Auto-create tasks.json (not just warn) | Agent can't create files with correct schema. Zero-config is essential for agentic UX. |
| D2 | Fallback chain: bd show → bd list → inline | Graceful degradation. Each step is less functional but keeps work moving. |
| D3 | Auto-fallback (mutate options.inline) | Agents can't answer interactive prompts. Silent recovery > blocking. (Council: Ergonomist) |
| D4 | `[DEGRADED]` log on fallback | Prevents hiding broken infrastructure. Radar/monitoring can detect. (Council: Operator) |
| D5 | TIP in error messages | Agentic UX: LLMs follow explicit suggestions. Discovery via error context. (Council: Ergonomist) |

## Risks

| Risk | Mitigation |
|------|-----------|
| Inline mode loses beads tracking | `[DEGRADED]` log makes it visible. Synthetic issue preserves task identity. |
| Auto-created tasks.json hides CI/CD issues | Only creates if `.genie/` dir can be written to. Permission check included. |
| `bd list` fallback returns wrong issue | Match by exact ID. Fail if ambiguous. |

## Success Definition

The exact scenario from the field report (steps 4-10) should resolve automatically without human intervention. An AI agent running `term work <id>` in a fresh or broken-beads repo should either succeed or fail with an actionable error message within 5 seconds.

---

## Council Review Summary

5 members consulted (Flash, $0.044 total):
- **3 APPROVE** (Simplifier, Architect, Operator)
- **1 APPROVE w/ modifications** (Ergonomist) — wants `[DEGRADED]` log + optimized recovery pipeline
- **1 MODIFY** (Questioner) — wants `--inline` justified or split to separate PR, verbose fallback logging

All 5 agree the bugs are resolved. Disagreement is on process (scope creep of `--inline` in a hotfix PR).

**PM Decision:** Accept `--inline` in scope (it's the auto-fallback mechanism, not a luxury feature). Add `[DEGRADED]` logging and TIP messages as required by council.
