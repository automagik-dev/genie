# Wish: Fix Genie Team Orchestration — Make Teams Work

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `genie-orchestration-fix` |
| **Date** | 2026-03-23 |
| **Repo** | `automagik-dev/genie` at `/home/genie/agents/namastexlabs/genie/repos/genie` |
| **Issues** | #708 (polling loop), #712 (spawn delay), #713 (messaging) |

## Summary
Genie teams don't work. 0/3 team deployments completed autonomously in today's session. Three bugs in the orchestration chain: (1) team-lead gets stuck polling instead of dispatching work, (2) agents take 60s to become ready after spawn, (3) `genie send` writes to PG but Claude Code agents receive via native IPC — two disconnected messaging systems. Fix all three so `genie team create --wish <slug>` works end-to-end without human intervention.

## Scope

### IN
- **#708 — Team-lead polling loop:** Fix the team-lead agent prompt and/or `genie work` command so team-lead dispatches work instead of polling forever
- **#713 — Messaging bridge:** Make `genie send` deliver messages to Claude Code agent sessions (detect CC sessions, pipe via tmux)
- **#712 — Spawn readiness:** Add mechanism for spawn to signal when agent is ready (or `genie work` waits for agent readiness before dispatching)
- **Stale worktree state:** `genie team create` must clean `.genie/state/` in worktrees to prevent "already dispatched" false positives
- **Stale shutdown requests:** Prevent old shutdown requests from killing re-spawned agents

### OUT
- New team-lead features (multi-wish, priority ordering) — fix what exists first
- NATS-based event-driven orchestration (long-term — fix polling approach for now)
- UI for team management (genie-os concern, not CLI)
- Changes to Claude Code native IPC protocol

## Decisions

| Decision | Rationale |
|----------|-----------|
| Fix messaging in genie CLI, not in CC | `genie send` already knows the recipient's pane ID from workers registry. It can pipe the message via tmux `send-keys`. The bridge lives in genie, not CC. |
| Clean worktree state on team create | Old `.genie/state/*.json` from previous teams causes "already dispatched" false positives. Nuclear clean on create is safe — it's a fresh team. |
| Team-lead prompt fix + `genie work` defense | Two layers: (1) team-lead AGENTS.md gets clearer "dispatch first, poll after" instructions, (2) `genie work` returns distinct exit codes so team-lead knows what happened. |
| Spawn readiness via lockfile or health check | After `genie spawn`, write a ready marker. `genie work` waits for it before dispatching. Timeout after 120s. |

## Success Criteria

- [ ] `genie team create <name> --repo <path> --wish <slug>` completes full lifecycle without human intervention
- [ ] Team-lead reads WISH.md, dispatches `genie work`, monitors progress, runs review
- [ ] Engineer receives work assignment and starts coding within 60s of spawn
- [ ] `genie send 'message' --to <agent>` delivers to Claude Code agent sessions in real-time
- [ ] Re-spawned agents don't auto-approve stale shutdown requests
- [ ] Clean worktree: no stale `.genie/state/` from previous teams
- [ ] End-to-end: team creates PR within 30 minutes for a simple wish (1 group)

## Execution Strategy

### Wave 1 (parallel — independent fixes)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Fix `genie send` to bridge PG messages to CC native IPC via tmux |
| 2 | engineer | Fix worktree state cleanup + stale shutdown handling |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Fix team-lead prompt + `genie work` exit codes + spawn readiness |
| 4 | engineer | End-to-end integration test: `genie team create` with a test wish |

### Wave 3
| Group | Agent | Description |
|-------|-------|-------------|
| review | reviewer | Review all groups |

## Execution Groups

### Group 1: Message Bridge — genie send → CC Native IPC

**Goal:** When `genie send` targets a Claude Code agent session, deliver the message via tmux pipe in addition to PG storage.

**Deliverables:**

1. **`src/term-commands/msg.ts`** — After writing message to PG (line ~401), call `writeNativeInbox` from `claude-native-teams.ts` to also deliver to the CC agent's native inbox file. The bridge mechanism ALREADY EXISTS in `protocol-router.ts:203-237` (`deliverViaNativeInbox`), but `msg.ts::send` does NOT use it. The fix is ~5 lines: after PG write, resolve worker → call `writeNativeInbox`.

2. **`writeNativeInbox`** (claude-native-teams.ts:254-278) — already handles lockfile contention and writes to `~/.claude/teams/<team>/inboxes/<agent>.json`. This is how CC SendMessage receives messages. No new mechanism needed.

**Key files (verified against codebase):**
- `src/term-commands/msg.ts:370-409` — current send (PG only, no native inbox delivery)
- `src/lib/protocol-router.ts:203-237` — existing `deliverViaNativeInbox` bridge (WORKS but not called by msg.ts)
- `src/lib/claude-native-teams.ts:254-278` — `writeNativeInbox` (the actual file write)

**Acceptance Criteria:**
- [ ] `genie send 'test' --to engineer` delivers to CC agent within 5s
- [ ] Message also persists in PG (backward compatible)
- [ ] Works for same-team and cross-team agents

**Validation:**
```bash
# Spawn an agent, send a message, verify it receives it
genie spawn engineer && sleep 30 && genie send 'echo received' --to engineer && sleep 10 && genie read engineer | grep -c 'echo received'
```

**depends-on:** none

---

### Group 2: Worktree State + Stale Shutdown Cleanup

**Goal:** Prevent stale state from previous teams from corrupting new team operations.

**Deliverables:**

1. **Clean PG wish state on `genie team create`** — Wish state is stored in PostgreSQL via `wish-state.ts` (NOT `.genie/state/` files — that directory doesn't exist). When `createTeam` runs with a slug that has existing state from a previous team, the old state must be purged. Check `wish-state.ts:188-192` — `createState` may already handle this, but verify it works when the wish slug is reused across team disbands.

2. **Stale shutdown request handling** — When an agent re-spawns (resume), it should NOT auto-approve shutdown requests issued before the respawn. Add a timestamp check: if shutdown request timestamp < agent spawn timestamp, ignore it.

**Key files (verified):**
- `src/lib/team-manager.ts:213-256` — team create logic (worktree creation)
- `src/lib/wish-state.ts:181-241` — PG-backed wish state (createState, getState)
- `src/lib/spawn-command.ts` — spawn lifecycle

**Acceptance Criteria:**
- [ ] After `genie team create` with a previously-used slug, `genie status <slug>` returns fresh "no state" (not stale "already dispatched")
- [ ] Re-spawned agent ignores old shutdown requests
- [ ] `wish-state.ts::createState` properly overwrites existing state for the same slug

**Validation:**
```bash
# Create team, check wish state is fresh
genie team create test-clean --repo . --wish test-slug && genie status test-slug 2>&1 | grep -c "No state found"
```

**depends-on:** none

---

### Group 3: Team-Lead Prompt + genie work Exit Codes + Spawn Readiness

**Goal:** Make team-lead dispatch work correctly and wait for agents to be ready.

**Deliverables:**

1. **Team-lead AGENTS.md** — The prompt at `plugins/genie/agents/team-lead/AGENTS.md` ALREADY says "dispatch first, poll after" (lines 1-72). The problem is NOT the prompt. The problem is that `genie work` (which is actually dispatch logic in `src/term-commands/dispatch.ts`) doesn't return clear exit codes, so team-lead can't distinguish "dispatched successfully" from "already dispatched" from "wish not found."

   **Minimal prompt update:** Add explicit instruction to check `genie work` exit code and act accordingly. Add max-poll limit (20 cycles) and escalation behavior.

2. **`genie work` exit codes** — The work dispatch logic lives in `src/term-commands/dispatch.ts` (NOT a standalone `genie work` command file). Add distinct exit codes:
   - 0: work dispatched successfully
   - 1: wish not found
   - 2: already dispatched (all groups have state)
   - 3: partial dispatch (some groups dispatched, others queued)

3. **Spawn readiness** — `protocol-router.ts::waitForWorkerReady` (lines 42-55) already exists with 15s timeout and idle-state detection. It's used internally but NOT exposed as a CLI flag. Add `genie spawn --wait` that calls this mechanism.

**Key files (verified):**
- `plugins/genie/agents/team-lead/AGENTS.md` — already clear, needs minor exit-code handling
- `src/term-commands/dispatch.ts:300+` — contains `genie work` logic (detectWorkMode, auto-dispatch)
- `src/lib/protocol-router.ts:42-55` — `waitForWorkerReady` (exists, needs CLI exposure)
- `src/lib/spawn-command.ts` — spawn command builder

**Acceptance Criteria:**
- [ ] Team-lead checks `genie work` exit code before polling
- [ ] Team-lead stops polling after 20 cycles with no progress
- [ ] `dispatch.ts` returns exit code 2 when all groups already dispatched
- [ ] `genie spawn --wait` blocks until agent is ready (uses existing `waitForWorkerReady`, timeout 120s)

**Validation:**
```bash
# Check exit codes
genie work nonexistent-wish 2>&1; echo "exit: $?"  # should be 1
```

**depends-on:** Group 1 (messaging must work for dispatched work to reach agents), Group 2 (state must be clean)

---

### Group 4: End-to-End Integration Test

**Goal:** Verify the full cycle works: create team → dispatch work → engineer executes → review → PR.

**Deliverables:**

1. **Test wish** — Create a minimal wish (1 group: "add a comment to a file") in a test repo
2. **Run `genie team create test-e2e --repo <test-repo> --wish <slug>`**
3. **Monitor** — team-lead dispatches, engineer works, reviewer reviews
4. **Verify** — PR is created within 30 minutes, no human intervention needed

**Acceptance Criteria:**
- [ ] Team completes the wish autonomously
- [ ] PR is created targeting dev
- [ ] No manual `genie send` or intervention required
- [ ] Total time < 30 minutes for a 1-group wish

**depends-on:** Groups 1, 2, 3

---

## QA Criteria

- [ ] `genie team create` with a real wish produces a PR without human intervention
- [ ] `genie send` delivers to CC agents in real-time
- [ ] No stale state pollution between teams
- [ ] Team-lead doesn't enter infinite polling loop
- [ ] Re-spawned agents function correctly (no stale shutdown)

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| CC native IPC protocol is undocumented | High | Investigate `.claude/teams/*/inboxes/*.json` pattern. If file-based, write there. If not, fall back to tmux send-keys with special escape sequence. |
| Team-lead prompt changes don't take effect for running agents | Low | Kill existing team-leads before testing. New spawns pick up updated AGENTS.md. |
| Spawn readiness detection is unreliable | Medium | Use multiple signals: pane exists + CC session file exists + initial output detected. Timeout at 120s with clear error. |
| `genie work` already has complex state machine | Medium | Don't refactor — only add exit code differentiation. Keep existing behavior. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
# Messaging bridge (Group 1)
src/term-commands/msg.ts                              (MODIFY — after PG write, call writeNativeInbox)
src/lib/protocol-router.ts                            (READ — deliverViaNativeInbox at lines 203-237, reference only)
src/lib/claude-native-teams.ts                        (READ — writeNativeInbox at lines 254-278, may need import in msg.ts)

# State cleanup (Group 2)
src/lib/team-manager.ts                               (MODIFY — clean PG wish state on team create)
src/lib/wish-state.ts                                 (READ/MODIFY — verify createState handles slug reuse)
src/lib/spawn-command.ts                              (MODIFY — stale shutdown timestamp check)

# Team-lead + dispatch + spawn (Group 3)
plugins/genie/agents/team-lead/AGENTS.md              (MODIFY — add exit code handling + max-poll)
src/term-commands/dispatch.ts                         (MODIFY — add distinct exit codes to work dispatch)
src/lib/protocol-router.ts                            (MODIFY — expose waitForWorkerReady for CLI)
src/lib/spawn-command.ts                              (MODIFY — add --wait flag using waitForWorkerReady)

# Tests (Group 4)
.genie/wishes/test-e2e/WISH.md                        (CREATE — test wish)
```
