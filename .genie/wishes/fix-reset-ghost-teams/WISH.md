# Wish: Fix genie --reset Ghost Teammates

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `fix-reset-ghost-teams` |
| **Date** | 2026-03-16 |

## Summary

`genie --reset` kills the tmux session but only deletes one native team directory. Other teams' configs and inboxes are left behind, causing ghost teammates on next launch. Fix: clear ALL native team directories and worker registry on reset.

## Scope

### IN

- `handleReset()` in `src/genie-commands/session.ts` clears all native team dirs under `~/.claude/teams/`
- Clear worker registry (`~/.genie/workers.json`) on reset since all workers are dead
- Close #545

### OUT

- Changes to normal session flow
- Changes to native team creation logic

## Decisions

| Decision | Rationale |
|----------|-----------|
| Delete all native teams on reset | Reset means start fresh. No ghost state. |
| Clear worker registry | All workers died with the tmux session. Registry is stale. |

## Success Criteria

- [ ] `genie --reset` removes ALL directories under `~/.claude/teams/`
- [ ] `genie --reset` clears `~/.genie/workers.json`
- [ ] No ghost teammates appear after reset + relaunch
- [ ] `bun run check` passes

## Execution Groups

### Group 1: Fix handleReset

**Goal:** Clear all native team state and worker registry on reset.

**Deliverables:**
1. In `src/genie-commands/session.ts`, update `handleReset()`:
   - After killing tmux session, delete ALL directories under `~/.claude/teams/`
   - Clear worker registry: write empty `{ workers: {}, templates: {} }` to `~/.genie/workers.json`
2. Add test verifying reset cleans up

**Acceptance criteria:**
- `handleReset()` removes all `~/.claude/teams/*`
- Worker registry is cleared
- Normal session flow unchanged

**Validation:**
```bash
bun run typecheck
bun test src/genie-commands/__tests__/session.test.ts
```

**depends-on:** none

---

### Group 2: Validation

**Validation:**
```bash
bun run check
bun run build
```

**depends-on:** Group 1
