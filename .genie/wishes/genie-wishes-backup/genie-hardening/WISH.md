# Wish: Genie Hardening — Session Lifecycle + Coverage Gate

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `genie-hardening` |
| **Date** | 2026-03-17 |
| **Design** | [DESIGN.md](../../brainstorms/issue-triage-march17/DESIGN.md) |
| **Issues** | #531, #574 (Phase 1-2), #526 |

## Summary

Team-lead sessions have no process liveness checks — `isTeamActive()` only verifies a tmux window exists, not that Claude Code is alive inside it. External inbox messages for offline teams are silently lost because no daemon watches for them. CI doesn't enforce the 70% coverage floor we already meet. This wish fixes all three.

## Scope

### IN
- Fix `isTeamActive()` to verify process liveness via `isPaneAlive()`
- Store team-lead pane ID in agent-registry for tracking and respawn
- Dead team-lead auto-respawns on next `ensureTeamLead()` call
- New `inbox-watcher.ts` daemon that polls native inboxes and auto-spawns offline team-leads
- CI coverage gate at 68% threshold in `.github/workflows/ci.yml`

### OUT
- #574 Phase 3 (idle timeout / session resume for team-leads) — future wish
- #574 Phase 4 (simplify omni integration) — future wish
- Writing new tests to increase coverage (already at 70.57%)
- Changes to CC's native SendMessage or permission system (#599 — upstream CC bug)
- Inbox watcher message routing/parsing (external systems write correctly formatted messages)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Wire `isPaneAlive()` into `isTeamActive()` | Already proven for workers in `idle-timeout.ts:115`. 3-line addition. |
| Store team-lead pane ID via `ensureTeamWindow().paneId` in agent-registry | `ensureTeamWindow` already returns `paneId` — just save it. Enables liveness tracking. |
| New `inbox-watcher.ts` following `idle-timeout.ts` dependency-injection pattern | Proven polling pattern with testable deps. Same conventions the codebase uses. |
| 30s poll interval for inbox watcher | Message delivery is latency-sensitive. 60s (idle-timeout) too slow for user-facing messages. |
| CI threshold at 68% not 70% | 2.5% safety margin below current 70.57% — prevents legitimate PRs from blocking on unrelated minor shifts. |
| Backoff: 3 spawn attempts with exponential delay | Prevents crash loops if team-lead has persistent startup failure. |
| 30s grace period after spawn before liveness check | `isPaneAlive()` can false-negative during slow Claude Code startup. |

## Success Criteria

- [ ] `isTeamActive()` returns `false` when tmux window exists but Claude Code process is dead
- [ ] Team-lead pane ID stored in agent-registry on spawn via `ensureTeamLead()`
- [ ] Dead team-lead auto-respawns on next `ensureTeamLead()` call (stale window cleaned up)
- [ ] New `inbox-watcher.ts` polls `~/.claude/teams/*/inboxes/team-lead.json` every 30s
- [ ] Unread message for offline team triggers `ensureTeamLead()`
- [ ] Backoff after 3 failed spawn attempts (no crash loops)
- [ ] Watcher starts lazily (on first team creation) and exits when no teams are active
- [ ] CI fails if line coverage drops below 68%
- [ ] `bun run check` still passes (no regressions)

## Execution Groups

### Group 1: Team-lead liveness check and registry tracking

**Goal:** Make `isTeamActive()` verify process liveness, not just window existence. Store team-lead pane ID for tracking.

**Deliverables:**
1. In `src/lib/team-auto-spawn.ts`, modify `isTeamActive()`:
   - After confirming the window exists (line 73), get the window's pane ID via `tmux.listPanes()`
   - Call `tmux.isPaneAlive(paneId)` — if false, return false (stale window)
   - Add 30s grace period: read team-lead's `startedAt` from registry, skip liveness check if < 30s old
2. In `src/lib/team-auto-spawn.ts`, modify `ensureTeamLead()`:
   - After `ensureTeamWindow()` returns (line 109), save `teamWindow.paneId` to agent-registry using a new `registerTeamLead()` helper
   - Before spawning: if stale window detected, kill it via `tmux.executeTmux('kill-window ...')` and re-create
3. In `src/lib/agent-registry.ts`:
   - Add `saveTeamLeadEntry(teamName, paneId, session, windowName, repoPath)` — stores an `Agent` entry with `role: 'team-lead'` and `team: teamName`
   - Add `getTeamLeadEntry(teamName)` — finds agent where `role === 'team-lead' && team === teamName`
4. In `src/lib/team-auto-spawn.test.ts`:
   - Test: window exists + pane alive → `isTeamActive()` returns true
   - Test: window exists + pane dead → `isTeamActive()` returns false
   - Test: window exists + pane spawned < 30s ago → `isTeamActive()` returns true (grace period)
   - Test: `ensureTeamLead()` stores pane ID in registry
   - Test: `ensureTeamLead()` cleans up stale window and re-creates

**Acceptance criteria:**
- `isTeamActive()` checks `isPaneAlive()` after window match
- Team-lead pane ID appears in `~/.genie/workers.json` after spawn
- Grace period prevents false negatives during startup

**Validation:**
```bash
grep "isPaneAlive" src/lib/team-auto-spawn.ts && echo "liveness OK"
grep "saveTeamLeadEntry\|registerTeamLead" src/lib/agent-registry.ts && echo "registry OK"
bun test src/lib/team-auto-spawn.test.ts && echo "tests OK"
bun run typecheck && bun run lint
```

**depends-on:** none

---

### Group 2: Inbox watcher daemon

**Goal:** Poll native inboxes for unread messages and auto-spawn offline team-leads.

**Deliverables:**
1. New file `src/lib/inbox-watcher.ts`:
   - Follow `idle-timeout.ts` dependency-injection pattern with `InboxWatcherDeps` interface
   - Export `INBOX_POLL_INTERVAL_MS = 30_000` (configurable via `GENIE_INBOX_POLL_MS` env, 0 = disabled)
   - Export `checkInboxes(deps): Promise<string[]>` — main polling function:
     a. List all team directories under `~/.claude/teams/`
     b. For each team, read `inboxes/team-lead.json`
     c. If unread messages exist (`read: false`), call `isTeamActive(teamName)`
     d. If not active, call `ensureTeamLead(teamName, workingDir)` — get `workingDir` from team config's lead member `cwd` field
     e. Track spawn attempts per team in memory (not persisted). After 3 consecutive failures, skip that team until next daemon restart (log warning).
     f. Return list of team names where spawn was triggered
   - Export `startInboxWatcher(): NodeJS.Timeout` — starts the polling interval
   - Export `stopInboxWatcher(handle): void` — clears the interval
2. In `src/lib/claude-native-teams.ts`:
   - Add `listTeamsWithUnreadInbox(): Promise<Array<{ teamName: string; unreadCount: number; workingDir: string | null }>>`:
     a. Read `~/.claude/teams/` directory
     b. For each team, load `inboxes/team-lead.json` and count `read: false` messages
     c. Get `workingDir` from config.json → members → team-lead → cwd
     d. Return teams with unreadCount > 0
3. New file `src/lib/inbox-watcher.test.ts`:
   - Test: no teams → returns empty
   - Test: team with unread messages + active team-lead → no spawn triggered
   - Test: team with unread messages + inactive team-lead → spawn triggered
   - Test: 3 consecutive spawn failures → team skipped with warning
   - Test: disabled via `GENIE_INBOX_POLL_MS=0` → returns empty

**Acceptance criteria:**
- Polling function scans all teams and detects unread messages
- Inactive teams with unread messages trigger `ensureTeamLead()`
- Backoff prevents crash loops (3 strikes)
- Dependency injection makes all logic unit-testable without tmux

**Validation:**
```bash
bun test src/lib/inbox-watcher.test.ts && echo "watcher tests OK"
grep "listTeamsWithUnreadInbox" src/lib/claude-native-teams.ts && echo "helper OK"
bun run typecheck && bun run lint
```

**depends-on:** Group 1 (uses improved `isTeamActive()`)

---

### Group 3: CI coverage gate

**Goal:** Enforce 68% minimum line coverage in CI so coverage can never silently regress.

**Deliverables:**
1. In `.github/workflows/ci.yml`, replace the Test step (line 68-69):
   ```yaml
   - name: Test with coverage
     run: |
       COVERAGE_OUTPUT=$(bun test --coverage 2>&1)
       echo "$COVERAGE_OUTPUT"
       LINE_COV=$(echo "$COVERAGE_OUTPUT" | grep "All files" | awk -F'|' '{print $2}' | tr -d ' ')
       echo "Line coverage: ${LINE_COV}%"
       if [ -z "$LINE_COV" ]; then
         echo "WARNING: Could not parse coverage — skipping threshold check"
         exit 0
       fi
       THRESHOLD=68
       if [ "$(echo "$LINE_COV < $THRESHOLD" | bc -l)" = "1" ]; then
         echo "FAILED: Coverage ${LINE_COV}% is below ${THRESHOLD}% minimum"
         exit 1
       fi
       echo "PASSED: Coverage ${LINE_COV}% meets ${THRESHOLD}% minimum"
   ```

**Acceptance criteria:**
- CI runs `bun test --coverage` instead of bare `bun test`
- Coverage below 68% fails the quality-gate job
- Unparseable coverage output warns but does not block (graceful degradation)

**Validation:**
```bash
grep "coverage" .github/workflows/ci.yml && echo "coverage step OK"
grep "68" .github/workflows/ci.yml && echo "threshold OK"
bun test --coverage 2>&1 | grep "All files" && echo "coverage output OK"
```

**depends-on:** none

---

### Group 4: Integration validation

**Goal:** Full CI pass + end-to-end verification that all three streams work together.

**Validation:**
```bash
bun run check
bun run build
bun test --coverage 2>&1 | grep "All files"
```

**depends-on:** Group 1, Group 2, Group 3

---

## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Team-lead liveness check + registry |
| 3 | engineer | CI coverage gate |

### Wave 2 (after Group 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | Inbox watcher daemon |

### Wave 3 (after all)
| Group | Agent | Description |
|-------|-------|-------------|
| 4 | reviewer | Integration validation |

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Inbox watcher adds persistent background process | Medium | Lazy start on first team creation, clean shutdown, same conventions as idle-timeout |
| Team-lead respawn loops on persistent crash | Medium | 3-attempt exponential backoff, then skip team until daemon restart |
| Coverage gate blocks unrelated PRs | Low | 68% threshold = 2.5% buffer below current 70.57%; adjustable |
| Race between watcher and `genie send` delivery | Low | Both call idempotent `ensureTeamLead()` — duplicate attempt is a no-op |
| `isPaneAlive()` false negative during slow startup | Low | 30s grace period skips liveness check for freshly spawned team-leads |

---

## Files to Create/Modify

```
src/lib/team-auto-spawn.ts          — Add isPaneAlive() check, store pane ID
src/lib/agent-registry.ts           — Add saveTeamLeadEntry/getTeamLeadEntry
src/lib/team-auto-spawn.test.ts     — Liveness + registry tests
src/lib/inbox-watcher.ts            — NEW: inbox polling daemon
src/lib/inbox-watcher.test.ts       — NEW: watcher unit tests
src/lib/claude-native-teams.ts      — Add listTeamsWithUnreadInbox()
.github/workflows/ci.yml            — Add coverage threshold enforcement
```
