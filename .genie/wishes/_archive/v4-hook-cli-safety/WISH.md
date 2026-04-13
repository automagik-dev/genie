# Wish: v4 Stability — Hook + CLI Safety Fixes

| Field | Value |
|-------|-------|
| **Status** | SHIPPED — PR #957 (v4 Stability Sprint, 2026-04-02) |
| **Slug** | `v4-hook-cli-safety` |
| **Date** | 2026-03-31 |
| **Design** | _Design not recovered — this wish pre-dates the brainstorm-commit convention (see #1132)._ |

## Summary
Fix 1 P0 security issue and 3 P1 reliability issues in the hook system and CLI dispatch. Hook handler errors silently return `undefined` (allow), which means a crashed `branch-guard` bypasses protection. Wish/brainstorm slugs accept path traversal. Auto-spawn handler has no error boundaries.

## Scope
### IN
- Fix hook handler error handling — blocking handlers must deny on crash, not allow (P0)
- Fix path traversal in wish/brainstorm slug validation in `dispatch.ts` (P1)
- Add error boundaries to auto-spawn handler in `auto-spawn.ts` (P1)
- Add `--hook-debug` flag to surface all hook decisions (P1)
- Fix plugin version stale after upgrade — `genie update` must update `marketplace.json` + skills symlink (P0)

### OUT
- Branch guard regex precision (P2 — partial branch name matching edge case)
- Identity injection field validation (P2)
- Unused feature flag cleanup (P2)
- Plugin cache cleanup for old versions (66 stale cache dirs — cleanup is separate chore)

## Decisions
| Decision | Rationale |
|----------|-----------|
| Blocking handlers deny on crash | Security guards that silently allow on error are worse than useless |
| Slug validation: `^[a-zA-Z0-9._-]+$` | Simple regex, blocks all path traversal, allows reasonable slug names |
| Auto-spawn returns warning context on failure | Agent still gets the message but knows spawn was attempted and failed |

## Success Criteria
- [ ] Crashing `branch-guard` handler blocks the operation (deny), not allows
- [ ] Slug `../../etc/passwd` is rejected with clear error message
- [ ] Auto-spawn handler errors are surfaced as warnings, not swallowed
- [ ] `--hook-debug` shows handler name, decision, and timing
- [ ] After `genie update`, `marketplace.json` version matches `genie --version`
- [ ] After `genie update`, skills symlink points to current cache version
- [ ] `bun test src/hooks/__tests__/dispatch.test.ts` passes
- [ ] `bun test src/hooks/handlers/` passes (add crash-deny test)

## Execution Strategy

### Wave 1 (single wave — small scope)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Fix all 4 issues |
| review | reviewer | Review group 1 |

## Execution Groups

### Group 1: Hook Safety + Slug Validation
**Goal:** Close security gaps in hooks and CLI input validation.
**Deliverables:**
1. In `hooks/index.ts`: change `runHandler()` (line ~126) — add `isBlocking: boolean` parameter. When `isBlocking && handler throws`, return `{ decision: 'deny', reason: 'handler crashed: <msg>' }`. When `!isBlocking`, keep returning `undefined` (allow). Update `executeBlockingChain()` (line ~182) to pass `isBlocking: true` when calling `runHandler()`.
2. Add `validateSlug(slug: string)` function with regex `^[a-zA-Z0-9._-]+$` — call it in `dispatch.ts` at lines 380, 441, 483, 532, 617
3. In `auto-spawn.ts:63-118`: the existing try/catch (line 79-117) already wraps the body but returns nothing on error. Change the catch block to return `{ hookSpecificOutput: { additionalContext: 'auto-spawn warning: <msg>' } }` instead of returning undefined
4. Add env var `GENIE_HOOK_DEBUG=1` support in `hooks/index.ts` — when set, log handler name + decision + elapsed ms to stderr for every handler invocation
5. Fix `genie update` plugin sync in `src/genie-commands/update.ts`: after copying to cache dir, also update `~/.claude/plugins/marketplaces/automagik/.claude-plugin/marketplace.json` version field AND update `~/.claude/plugins/marketplaces/automagik/plugins/genie/package.json` version AND repoint the skills symlink at `~/.claude/plugins/marketplaces/automagik/plugins/genie/skills` to `../../cache/automagik/genie/<version>/skills`

**Acceptance Criteria:**
- [ ] Blocking handler crash → deny (test: mock handler that throws → verify deny result)
- [ ] Non-blocking handler crash → allow with log (existing behavior, now explicit)
- [ ] Slug with `/`, `..`, or `\` → rejected with error
- [ ] Auto-spawn failure → warning in context, not silence
- [ ] GENIE_HOOK_DEBUG=1 → visible handler trace in stderr

**Validation:**
```bash
bun test src/hooks/__tests__/dispatch.test.ts && bun test src/hooks/handlers/__tests__/auto-spawn.test.ts
```

**depends-on:** none

---

## Files to Create/Modify

```
src/hooks/index.ts
src/hooks/handlers/auto-spawn.ts
src/term-commands/dispatch.ts
src/hooks/__tests__/dispatch.test.ts (add crash-deny test)
src/hooks/handlers/__tests__/auto-spawn.test.ts (new — error boundary test)
src/term-commands/__tests__/dispatch-slug.test.ts (new — path traversal rejection test)
src/genie-commands/update.ts
```
