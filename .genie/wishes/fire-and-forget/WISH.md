# Wish: Fire-and-Forget `genie work` + Agent Auto-Exit

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `fire-and-forget` |
| **Date** | 2026-03-20 |
| **Design** | [DESIGN.md](../../brainstorms/work-fire-forget/DESIGN.md) |
| **Blocks** | `genie-scheduler` (scheduler needs non-blocking dispatch) |

## Summary

Make `genie work <slug>` non-blocking: spawn agents, print guidance, return the terminal in <5 seconds. Switch prompt delivery from `--initial-prompt` CLI args to `genie send` mailbox. Agents auto-exit their panes after calling `genie done`. Fix tmux session explosion on parallel team creation.

## Scope

### IN
- Remove `while(true)` polling loop from `autoOrchestrateCommand` in `src/term-commands/dispatch.ts`
- Replace `initialPrompt` parameter with post-spawn `genie send` mailbox delivery in all dispatch commands
- `genie done <slug>#<group>` sends "wave complete" to team-lead when all groups in wave are done
- `genie done` auto-kills the calling agent's tmux pane after notification
- Store `tmuxSessionName` in team config during `genie team create`
- Add `--session` flag to `genie spawn` and `genie team create`
- `getCurrentSessionName()` fallback chain: explicit flag > team config > `tmux list-sessions` > create new
- OTel relay liveness: detect dead pane with in_progress group → reset group to `ready`, notify team-lead

### OUT
- No changes to manual `genie work <slug>#<group> <agent>` dispatch mode
- No changes to wish state machine logic (`wish-state.ts`)
- No new CLI commands (only modifications to existing)
- No database/pgserve dependency (this wish is file-based only)
- No NATS integration
- No scheduler daemon

## Decisions

| Decision | Rationale |
|----------|-----------|
| Mailbox via `genie send` not `--initial-prompt` | CLI args visible in process list, fragile. Mailbox is durable, queued to disk |
| Team-lead `/loop` handles wave advancement | Non-deterministic watchdog gives flexibility. Team-lead reviews between waves |
| `genie done` auto-exits pane | Agents leaving orphaned sessions is the #1 resource leak today |
| `genie done` enforces git push before exit | Unpushed work is lost work. Push first, then kill pane |
| Wave detection in `genie done` | After marking group done, check if all same-wave groups are complete. If yes, message team-lead |
| Tmux session stored in team config | Single source of truth. Workers read it instead of relying on TMUX env var |
| Resume context injection on respawn | Agent doesn't need CC history — genie state tells it what to do. Inject "you were working on X" prompt on respawn |
| Genie state is source of truth, not CC memory | `--continue` is nice-to-have. Even a fresh session can resume work from wish state + registry |

## Success Criteria

- [ ] `genie work <slug>` spawns Wave 1 agents and exits in <5 seconds
- [ ] Agents receive work prompt via mailbox (visible in `genie inbox <agent>`)
- [ ] No `initialPrompt` passed via CLI args in any dispatch command
- [ ] `genie done <slug>#<group>` kills calling agent's tmux pane
- [ ] Team-lead receives "Wave N complete" message when last group finishes
- [ ] Parallel `genie team create` (5x) creates windows in same session, not 5 sessions
- [ ] `genie spawn --session <name>` places agent in specified session
- [ ] Dead pane with in_progress group resets to `ready` and notifies team-lead
- [ ] `genie done` pushes unpushed commits before killing pane
- [ ] Respawned agent receives resume context: wish slug, group, status, instructions
- [ ] Agent can resume work from fresh CC session (no `--continue` required) using injected context
- [ ] Existing test suite passes
- [ ] `bun run check` passes

## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Fire-and-forget dispatch + mailbox prompts |
| 2 | engineer | Tmux session fix (config storage + fallback chain) |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Agent auto-exit + push enforcement + wave notification |
| 4 | engineer | OTel relay liveness check |
| 5 | engineer | Session resume context injection |

### Wave 3 (after Wave 2)
| Group | Agent | Description |
|-------|-------|-------------|
| review | reviewer | Review all changes against acceptance criteria |

## Execution Groups

### Group 1: Fire-and-forget dispatch + mailbox prompts

**Goal:** Make `genie work <slug>` non-blocking and deliver prompts via native mailbox.

**Deliverables:**
1. In `src/term-commands/dispatch.ts` → `autoOrchestrateCommand`:
   - Remove the `while(true)` polling loop (lines ~377-404)
   - Remove `ORCHESTRATE_POLL_MS` and `ORCHESTRATE_TIMEOUT_MS` constants
   - After spawning wave groups, print next-step guidance and return
   - Print: "Agents dispatched for Wave N. Monitor: `genie status <slug>` | Logs: `genie read <agent>`"
2. In `src/term-commands/dispatch.ts` → `workDispatchCommand`:
   - Remove `initialPrompt` from `handleWorkerSpawn` call
   - After spawn completes, deliver work prompt via `genie send`:
     - Task description (group section from WISH.md)
     - Return instructions: "When done: run `genie done <slug>#<group>` and exit"
   - Same pattern for `brainstormCommand`, `wishCommand`, `reviewCommand`

**Acceptance Criteria:**
- [ ] `genie work <slug>` returns to terminal in <5s
- [ ] Agents receive prompt via mailbox (visible in `genie read <agent>`)
- [ ] `grep -n 'initialPrompt' src/term-commands/dispatch.ts` returns zero matches
- [ ] `grep -n 'while.*true' src/term-commands/dispatch.ts` returns zero matches in autoOrchestrate

**Validation:**
```bash
! grep -n 'ORCHESTRATE_POLL_MS\|ORCHESTRATE_TIMEOUT_MS' src/term-commands/dispatch.ts && echo "Polling removed"
bun run typecheck && bun run lint && bun test
```

**depends-on:** none

---

### Group 2: Tmux session fix

**Goal:** Prevent tmux session explosion on parallel team creation.

**Deliverables:**
1. Add `tmuxSessionName` field to `TeamConfig` interface in `src/lib/team-manager.ts`
2. In `spawnLeaderWithWish` (`src/term-commands/team.ts`), resolve current tmux session name BEFORE calling `handleWorkerSpawn` and store it in team config
3. In `resolveSpawnTeamWindow` (`src/term-commands/agents.ts`), read stored `tmuxSessionName` from team config as primary fallback when `getCurrentSessionName()` returns null
4. In `getCurrentSessionName` (`src/lib/tmux.ts`), add fallback: when `process.env.TMUX` is not set, try `tmux list-sessions -F '#{session_name}'` and return first match (or hint match)
5. Add `--session <name>` option to `genie spawn` and `genie team create` commands
6. Pass session name through `SpawnOptions` → `resolveSpawnTeamWindow`

**Acceptance Criteria:**
- [ ] Team config JSON includes `tmuxSessionName` after team creation
- [ ] `genie spawn engineer --session mytest` creates pane in "mytest" session
- [ ] `getCurrentSessionName()` returns a session name even without TMUX env (if tmux server running)
- [ ] 5 parallel `genie team create` from non-tmux context → 5 windows in one session

**Validation:**
```bash
bun run typecheck && bun run lint && bun test
```

**depends-on:** none

---

### Group 3: Agent auto-exit + push enforcement + wave completion notification

**Goal:** Agents exit cleanly after work. Work is pushed. Team-lead gets wave-complete signal.

**Deliverables:**
1. In `genie done` command handler (`src/term-commands/state.ts` or equivalent):
   - After `completeGroup()`, check if all groups in the same wave are now `done`
   - Wave detection: read WISH.md Execution Strategy, find which wave contains this group, check all wave-mates
   - If wave complete: `genie send "Wave N complete. All groups done: [list]. Run /review or advance." --to team-lead`
2. **Push enforcement** before pane exit:
   - Run `git status --porcelain` — if dirty, `git add -A && git commit -m "wip: <slug>#<group>"`
   - Run `git log @{u}..HEAD --oneline` — if unpushed commits, `git push`
   - Only proceed to pane kill after push succeeds (or no changes)
3. After push + notification, auto-kill the calling agent's pane:
   - Detect own pane ID from `TMUX_PANE` env
   - `tmux kill-pane -t <paneId>` (kills self)
   - If not in tmux: just exit process

**Acceptance Criteria:**
- [ ] `genie done <slug>#<group>` sends wave-complete message when last in wave
- [ ] `genie done` pushes unpushed commits before killing pane
- [ ] `genie done` commits dirty working tree as WIP before push
- [ ] Agent's tmux pane is killed after push + notification complete
- [ ] Team-lead inbox shows wave completion message
- [ ] Groups in different waves don't trigger premature wave-complete

**Validation:**
```bash
bun run typecheck && bun run lint && bun test
```

**depends-on:** Group 1

---

### Group 4: OTel relay liveness check

**Goal:** Detect crashed agents and reset their groups for retry.

**Deliverables:**
1. In the OTel relay pane cleanup loop (`src/term-commands/agents.ts`):
   - When a dead pane is detected AND the agent was assigned to an `in_progress` group:
   - Read wish state to find the group
   - Call `resetGroup()` to set it back to `ready`
   - Send notification: `genie send "Agent crashed on group X. Group reset to ready." --to team-lead`
2. Add helper: `findGroupByAssignee(slug, workerId)` in wish-state.ts

**Acceptance Criteria:**
- [ ] Dead pane + in_progress group → group status reset to `ready`
- [ ] Team-lead receives crash notification with group name
- [ ] Non-assigned dead panes don't trigger state changes

**Validation:**
```bash
bun run typecheck && bun run lint && bun test
```

**depends-on:** none

---

### Group 5: Session resume context injection

**Goal:** When an agent is respawned (fresh or via `--resume`), inject enough context for it to pick up where it left off — even without CC conversation history.

**Deliverables:**
1. In `protocol-router-spawn.ts` → `spawnWorkerFromTemplate()`:
   - After spawn, before delivering any messages, build a **resume context prompt**
   - Query wish state: find any `in_progress` group assigned to this worker's role+team
   - Query agent registry: get last known state, startedAt
   - Build resume prompt:
     ```
     RESUME CONTEXT: You were working on wish "<slug>", group "<N>".
     Status: in_progress. Started at: <time>.
     Wish file: .genie/wishes/<slug>/WISH.md
     Group section: <extracted group content from WISH.md>
     Last git log: <last 3 commits on branch>
     Pick up where you left off. Read the wish file for full context.
     ```
   - Deliver via `genie send` (mailbox) as the FIRST message before any task prompt
2. In `src/lib/provider-adapters.ts` → `buildClaudeCommand()`:
   - Always use `--resume <session-id>` instead of `--continue <name>` for consistent session continuity
   - Store session ID in agent registry on spawn
   - On respawn, pass stored session ID to `--resume`
   - If session ID is missing or invalid, start fresh (no `--continue` fallback)

**Acceptance Criteria:**
- [ ] Respawned agent receives resume context as first mailbox message
- [ ] Resume prompt includes: wish slug, group name, status, group section from WISH.md
- [ ] Resume prompt includes last 3 git commits on branch
- [ ] Agent can resume work from completely fresh CC session using injected context
- [ ] All spawns use `--resume <session-id>` instead of `--continue <name>`
- [ ] Session ID stored in agent registry on spawn

**Validation:**
```bash
bun run typecheck && bun run lint && bun test
! grep -n '\-\-continue' src/lib/provider-adapters.ts && echo "No --continue usage"
```

**depends-on:** Group 3, Group 4

---

## QA Criteria

- [ ] `genie work <slug>` exits immediately and agents begin working (e2e test with a simple 1-group wish)
- [ ] Agent completes work, calls `genie done`, pane disappears
- [ ] Team-lead receives wave-complete message
- [ ] Kill an agent pane mid-work → group resets to `ready`, team-lead notified
- [ ] 5 parallel team creates → single tmux session with 5 windows
- [ ] Existing `genie work <slug>#<group> <agent>` manual mode still works
- [ ] All 786+ existing tests pass

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Mailbox delivery race: agent not ready when prompt arrives | Medium | `genie send` queues to disk — agent picks up on next inbox check |
| Wave detection requires parsing WISH.md | Medium | Cache parsed waves in state file on first `genie work` |
| tmux pane self-kill race (genie done still writing) | Low | Kill pane AFTER all notifications complete, with 1s delay |
| Team-lead `/loop` not reliable | Low | Human can always run `genie status` manually |

## Files to Create/Modify

```
src/term-commands/dispatch.ts       — remove polling loop, switch to mailbox delivery
src/term-commands/state.ts          — wave detection + push enforcement + auto-exit in genie done
src/term-commands/agents.ts         — --session flag, resolveSpawnTeamWindow fallback, OTel liveness
src/term-commands/team.ts           — store tmuxSessionName, --session flag
src/lib/team-manager.ts             — tmuxSessionName field in TeamConfig
src/lib/tmux.ts                     — getCurrentSessionName fallback chain
src/lib/wish-state.ts               — findGroupByAssignee helper
src/lib/protocol-router-spawn.ts    — resume context injection on respawn
src/lib/provider-adapters.ts        — switch from --continue to --resume, store session ID
src/lib/agent-registry.ts           — store claudeSessionId reliably on spawn
```
