# Wish: Team-lead exits cleanly after completing work

**Status:** SHIPPED
**Slug:** `fix-team-lead-exit`
**Created:** 2026-03-16

---

## Summary

After the team-lead completes its lifecycle (PR created, all groups done), it enters an infinite empty message loop instead of exiting. `genie team done` only updates the config file — it doesn't stop the CC session. Fix: `genie team done` should kill the team-lead's Claude Code process after marking done.

---

## Scope

### IN
- `genie team done <name>` kills all team member processes after marking status
- Team-lead AGENTS.md updated to emphasize calling `genie team done` as final action
- Verify `genie team blocked <name>` also kills members

### OUT
- Changes to how `genie team disband` works (already kills members)
- Changes to Claude Code's native team polling (external to genie)
- Changes to team-lead's heartbeat/loop logic

---

## Decisions

- **DEC-1:** `genie team done` kills all team members (including the team-lead itself) after setting status. This is safe because "done" means the lifecycle is complete — no more work needed.
- **DEC-2:** Same behavior for `genie team blocked` — blocked means human intervention needed, no point keeping agents alive.
- **DEC-3:** Reuse `killWorkersByName()` from `disbandTeam()` — same mechanism, just without deleting the worktree/config.

---

## Success Criteria

- [ ] `genie team done <name>` sets status to `done` AND kills all team members
- [ ] `genie team blocked <name>` sets status to `blocked` AND kills all team members
- [ ] Team worktree and config are preserved (NOT deleted — that's `disband`)
- [ ] `bun run check` passes

---

## Assumptions

- **ASM-1:** Killing the team-lead process via `killWorkersByName` will terminate its CC session cleanly.

## Risks

- **RISK-1:** Team-lead might be in the middle of a git push when killed — Mitigation: `genie team done` is called BY the team-lead itself as its final action, so it's done pushing by that point.

---

## Execution Groups

### Group 1: Add member kill to team done/blocked

**Goal:** Make `genie team done` and `genie team blocked` kill all team member processes.

**Deliverables:**
1. In `src/term-commands/team.ts`, update the `done` and `blocked` command handlers to kill all team members after setting status. Import and use `killWorkersByName` from `src/term-commands/agents.ts` (or the equivalent from team-manager).
2. Look at how `disbandTeam()` in `src/lib/team-manager.ts` kills members (lines 311-317) — reuse that pattern.

**Acceptance Criteria:**
- [ ] `genie team done <name>` calls `killWorkersByName()` for each member
- [ ] `genie team blocked <name>` calls `killWorkersByName()` for each member
- [ ] Team config file still exists after done/blocked (not deleted)

**Validation:**
```bash
bun run typecheck && bun run lint && bun test
```

**depends-on:** none

---

### Group 2: Validate

**Goal:** Full CI pass.

**Validation:**
```bash
bun run check
bun run build
```

**depends-on:** Group 1

---

## QA Criteria

- [ ] `genie team create test --repo . --branch dev` → hire + spawn agents → `genie team done test` → all agent processes killed
- [ ] Team config still exists with status `done` after `genie team done`
- [ ] `bun run check` passes with zero errors

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
src/term-commands/team.ts — add member kill to done/blocked handlers
```
