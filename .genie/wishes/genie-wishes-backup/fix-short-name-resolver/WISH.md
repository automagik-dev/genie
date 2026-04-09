# Wish: Fix genie read/answer — resolve short agent names from genie ls

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `fix-short-name-resolver` |
| **Date** | 2026-03-24 |
| **Issues** | #700 |

## Summary

`genie read <name>` and `genie answer <name>` already use `resolveTarget()` from `target-resolver.ts`, which supports role, customName, and partial ID matching. However, `genie ls` displays short names (e.g., `engineer`, `reviewer`) that don't always resolve correctly because the resolver requires an exact team context or full worker ID. Fix the resolver so that names shown by `genie ls` always resolve when passed to `genie read` or `genie answer`.

## Scope

### IN
- Fix `resolveTarget()` to match short display names from `genie ls` output
- Ensure role-based resolution works without explicit `--team` flag (infer from current context)
- Add fallback: if team-scoped lookup fails, try global worker registry match
- Add tests for short name resolution scenarios

### OUT
- No changes to `genie ls` display format
- No changes to `genie send` (uses its own resolution path)
- No new CLI flags

## Decisions

| Decision | Rationale |
|----------|-----------|
| Fix resolver, not display | The resolver should handle what `ls` shows — changing display breaks muscle memory |
| Infer team from context | `GENIE_TEAM` env var or tmux session name provides team context without `--team` |
| Global fallback after team miss | Single-agent setups don't always have team context — global search catches these |

## Success Criteria

- [ ] `genie read engineer` resolves when one engineer exists in current team
- [ ] `genie read <customName>` resolves for agents with custom names
- [ ] `genie answer engineer yes` resolves and sends input
- [ ] Resolution works without explicit `--team` flag
- [ ] `bun run check` passes

## Execution Strategy

### Wave 1
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Fix target resolver + add tests |

## Execution Groups

### Group 1: Fix target resolver short name resolution

**Goal:** Make `genie read/answer` resolve the same short names that `genie ls` displays.

**Deliverables:**
1. In `src/lib/target-resolver.ts`:
   - Ensure `resolveByRole()` infers team from `GENIE_TEAM` env var when no team context provided
   - Add fallback in main `resolveTarget()`: if team-scoped role fails, try global worker scan matching role or customName
   - Ensure partial name matching works (e.g., `eng` matches `engineer` when unambiguous)
2. In `src/lib/target-resolver.test.ts`:
   - Add test: role name resolves with `GENIE_TEAM` env set
   - Add test: customName resolves globally when no team context
   - Add test: ambiguous short name returns helpful error listing candidates

**Acceptance Criteria:**
- [ ] Short role names from `genie ls` resolve in `resolveTarget()`
- [ ] Team inferred from `GENIE_TEAM` environment variable
- [ ] Global fallback works when team context is absent
- [ ] Ambiguous names produce clear error with candidates

**Validation:**
```bash
bun test src/lib/target-resolver.test.ts && bun run typecheck
```

**depends-on:** none

---

## Files to Create/Modify

```
src/lib/target-resolver.ts       — resolution logic fixes
src/lib/target-resolver.test.ts  — new test cases
```
