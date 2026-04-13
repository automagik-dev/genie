# Wish: v4 Stability — Team/Worker Lifecycle Fixes

| Field | Value |
|-------|-------|
| **Status** | SHIPPED — PR #962 (v4 Stability Sprint, 2026-04-02) |
| **Slug** | `v4-team-lifecycle` |
| **Date** | 2026-03-31 |
| **Design** | _Design not recovered — this wish pre-dates the brainstorm-commit convention (see #1132)._ |

## Summary
Fix 3 P0 and 4 P1 bugs in team management, worktree handling, and the scheduler daemon. These cause repository corruption from unsafe worktree removal, zombie workers writing to archived teams, permanently deadlocked scheduler triggers, and orphaned wish state on team disband.

## Scope
### IN
- Fix worktree removal to use `git worktree remove` instead of `rm -rf` on shared clones (P0)
- Fix `archiveTeam()` to await member kills before updating DB (P0)
- Fix scheduler trigger claiming to add timeout + recovery for crashed daemons (P0)
- Fix wish group reset to be transactional with team disband (P1)
- Fix native team lock to handle process crash (detect stale locks by PID check) (P1)
- Fix event delivery to add retry for critical events (blocked, error, permission) (P1)
- Fix task service to use transactions for concurrent updates (P1)

### OUT
- Team member auto-scaling (feature, not stability)
- Worktree pool management (optimization)
- Scheduler cron expression validation (separate concern)
- tmux window orphan cleanup during disband (P2)

## Decisions
| Decision | Rationale |
|----------|-----------|
| `git worktree remove` over `rm -rf` | Git's native cleanup handles object store references correctly |
| PID-based stale lock detection | `kill -0 <pid>` reliably detects dead processes without race conditions |
| Trigger lease timeout of 5 minutes | Long enough for normal execution, short enough to recover from crashes |
| Retry critical events up to 3 times with backoff | Lost permission/error events can leave agents permanently stuck |

## Success Criteria
- [ ] Worktree removal never uses `rm -rf` on `--shared` clones
- [ ] Archived team members cannot write to DB after archive completes
- [ ] Crashed scheduler daemon doesn't permanently lock triggers
- [ ] Wish groups are correctly reset when team disbands
- [ ] `bun test src/lib/team-manager.test.ts` passes
- [ ] `bun test src/lib/scheduler-daemon.test.ts` passes (add lease timeout test)

## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Fix worktree removal + archiveTeam await |
| 2 | engineer | Fix scheduler trigger leasing + recovery |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Fix wish reset + native lock + event retry + task transactions |
| review | reviewer | Review all groups |

## Execution Groups

### Group 1: Safe Worktree + Archive Ordering
**Goal:** Prevent repo corruption and zombie team members.
**Deliverables:**
1. Replace `rm(worktreePath, { recursive: true, force: true })` with `git worktree remove --force` in `team-manager.ts:412-419`
2. Add fallback `rm` only if `git worktree remove` fails (non-shared clone)
3. Change `archiveTeam()` in `team-manager.ts:446-470` to `await Promise.all(killMembers)` BEFORE updating DB state
4. Add guard: if any member kill fails, log but continue (don't block archive)

**Acceptance Criteria:**
- [ ] `removeWorktree()` uses `git worktree remove` as primary path
- [ ] `archiveTeam()` awaits all member kills before DB update
- [ ] Archive completes even if individual member kills fail

**Validation:**
```bash
bun test src/lib/team-manager.test.ts
```

**depends-on:** v4-message-routing (Group 1 — spawn guard prevents new spawns during archive)

---

### Group 2: Scheduler Lease Recovery
**Goal:** Prevent permanent trigger deadlock on daemon crash.
**Deliverables:**
1. Add `lease_expires_at` column to trigger execution tracking (or use existing `updated_at` + threshold)
2. Add recovery query: `UPDATE triggers SET state = 'idle' WHERE state = 'executing' AND updated_at < now() - interval '5 minutes'`
3. Run recovery on daemon startup and every 60s during operation
4. Add test for lease expiry recovery

**Acceptance Criteria:**
- [ ] Triggers stuck in 'executing' for >5 min are automatically recovered
- [ ] Recovery runs on daemon startup
- [ ] Normal trigger execution (<5 min) is not affected

**Validation:**
```bash
bun test src/lib/scheduler-daemon.test.ts
```

**depends-on:** none

---

### Group 3: Transactional Cleanup
**Goal:** Fix wish state, lock, event, and task consistency.
**Deliverables:**
1. Wrap `resetWishGroups()` + `archiveTeam()` in a transaction in `team-manager.ts:519`
2. Add PID check to native team lock in `claude-native-teams.ts:113-131` — if lock holder PID is dead, force-acquire
3. Add retry (3x with backoff) for critical event delivery in `event-router.ts:177-226`
4. Add `sql.begin()` transaction wrapper around task state updates in `task-service.ts`

**Acceptance Criteria:**
- [ ] Wish groups are reset atomically with team disband
- [ ] Stale locks from dead processes are automatically released
- [ ] Critical events retry up to 3 times before giving up
- [ ] Concurrent task updates don't produce lost writes

**Validation:**
```bash
bun test src/lib/team-manager.test.ts && bun test src/lib/event-router.test.ts
```

**depends-on:** Group 1, Group 2

---

## Files to Create/Modify

```
src/lib/team-manager.ts
src/lib/scheduler-daemon.ts
src/lib/claude-native-teams.ts
src/lib/event-router.ts
src/lib/task-service.ts
src/lib/scheduler-daemon.test.ts (new tests)
```
