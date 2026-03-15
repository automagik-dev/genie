# Wish: Fix Ghost Teammates on Reset

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `fix-ghost-teammates` |
| **Date** | 2026-03-15 |

## Summary

`genie --reset` only clears one native team directory but leaves others behind. On next launch, stale team configs surface ghost teammates from dead panes. Fix: clear ALL native team directories on reset.

## Scope

### IN
- Fix `handleReset()` in `src/genie-commands/session.ts` to delete all native team directories, not just the current one
- Clean up any stale worker registry entries during reset

### OUT
- Changes to the normal (non-reset) session flow
- Changes to native team creation logic

## Decisions

| Decision | Rationale |
|----------|-----------|
| Delete all native teams on reset | Reset means start fresh. No ghost state. |

## Success Criteria

- [ ] `genie --reset` removes ALL native team directories under `~/.claude/teams/`
- [ ] No ghost teammates appear after reset + relaunch
- [ ] `bun run check` passes
- [ ] `bun run build` succeeds

## Execution Groups

### Group 1: Fix handleReset

**Goal:** Clear all native team state on reset.

**Deliverables:**
1. In `src/genie-commands/session.ts`, update `handleReset()`:
   - After killing the tmux session, delete ALL directories under `~/.claude/teams/` (not just the current window's team)
   - Also clear `~/.genie/workers.json` (reset worker registry) since all workers are dead after session kill
2. Add test verifying reset cleans up all team directories

**Acceptance criteria:**
- `handleReset()` removes all entries in `~/.claude/teams/`
- Worker registry is cleared on reset
- Normal session flow unchanged

**Validation:**
```bash
bun run typecheck
bun test src/genie-commands/__tests__/session.test.ts
```

**depends-on:** none

---

### Group 2: Validation

**Goal:** Quality gates pass.

**Validation:**
```bash
bun run check
bun run build
```

**depends-on:** Group 1
