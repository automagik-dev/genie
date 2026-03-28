# Wish: Make `genie work` fire-and-forget with mailbox prompts

| Field | Value |
|-------|-------|
| **Status** | SHIPPED (superseded by `fire-and-forget`) |
| **Slug** | `work-fire-forget` |
| **Date** | 2026-03-19 |

## Summary

`genie work <slug>` currently blocks the terminal with a 30-second polling loop for up to 30 minutes per wave. This wish converts it to fire-and-forget: spawn agents, inject prompts via native mailbox (not CLI args), print next-step guidance, and exit. Agents must also die when their team-lead dies.

## Scope

### IN
- Remove polling loop from `autoOrchestrateCommand` — spawn and exit
- Switch prompt delivery from `--initial-prompt` CLI arg to `genie send` (native mailbox)
- Inject return instructions in each agent's prompt: how to report back via `genie send` before exiting
- Add agent lifecycle binding: agents die when team-lead dies
- Print next-step guidance after spawning (status command, how to check progress)

### OUT
- No changes to manual `genie work <slug>#<group> <agent>` mode
- No changes to wish state machine logic
- No changes to wave parsing or group extraction
- No new CLI commands

## Decisions

| Decision | Rationale |
|----------|-----------|
| Mailbox via `genie send` not `--initial-prompt` | CLI arg injection is fragile and visible in process list. Mailbox is the native Claude Code messaging channel — more reliable, arrives as a proper message |
| Fire-and-forget exits after Wave 1 spawn | Sequential waves can be triggered by re-running `genie work <slug>` (skips completed groups) or by a team-lead orchestrating |
| Agent cleanup via tmux session binding | When team-lead's tmux session/pane dies, child agent panes in the same window should be killed. Use tmux `set-option remain-on-exit off` + window kill propagation |

## Success Criteria

- [ ] `genie work <slug>` spawns agents and returns to terminal in <5 seconds
- [ ] Agents receive their work prompt via mailbox, not CLI `--initial-prompt`
- [ ] Each agent's prompt includes instructions to `genie send` results back and `genie done` before exit
- [ ] Agents terminate when their team-lead process exits
- [ ] `genie status <slug>` still works to check progress
- [ ] Existing tests pass

## Execution Strategy

### Wave 1
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Fire-and-forget + mailbox prompt delivery |
| 2 | engineer | Agent lifecycle binding to team-lead |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| review | reviewer | Review all changes |

## Execution Groups

### Group 1: Fire-and-forget with mailbox prompts

**Goal:** Make `genie work` non-blocking and deliver prompts via native mailbox.

**Deliverables:**

1. **`src/term-commands/dispatch.ts`** — `autoOrchestrateCommand`:
   - Remove the `while(true)` polling loop (lines 377-404)
   - After spawning wave groups, print next-step guidance and return
   - Print: "Agents dispatched. Each will report when done."
   - Print: "Monitor: `genie status <slug>` | Logs: `genie read <agent>`"

2. **`src/term-commands/dispatch.ts`** — `workDispatchCommand`:
   - Remove `initialPrompt` from `handleWorkerSpawn` call
   - After spawn completes, use `genie send` (exec) to deliver the work prompt via mailbox
   - The prompt must include:
     - The task description (group section from WISH.md)
     - Return instructions: "When done: run `genie done <slug>#<group>` then `genie send '<summary>' --to team-lead`"
     - Exit instruction: "After reporting, your session will end."

3. **Same pattern for `brainstormCommand`, `wishCommand`, `reviewCommand`** — switch from `initialPrompt` to mailbox delivery

**Acceptance Criteria:**
- [ ] `genie work <slug>` returns immediately after spawning
- [ ] Agents receive prompt via mailbox (visible in `genie read <agent>`)
- [ ] No `initialPrompt` passed via CLI args in any dispatch command

**Validation:**
```bash
# Verify no initialPrompt in dispatch commands
! grep -n 'initialPrompt' src/term-commands/dispatch.ts
```

**depends-on:** none

---

### Group 2: Agent lifecycle binding

**Goal:** Agents terminate when their team-lead exits.

**Deliverables:**

1. **`src/term-commands/agents.ts`** — In `handleWorkerSpawn`:
   - When spawning an agent with a `--team`, record the team-lead's pane ID
   - Set tmux `remain-on-exit off` on agent panes so they don't linger as dead panes

2. **`src/term-commands/team.ts`** or new cleanup hook:
   - When `genie team done` or `genie team disband` runs, kill all agent panes in the team
   - When team-lead pane exits (tmux hook or monitor), kill child agent panes
   - Use `tmux kill-pane -t <paneId>` for each registered agent

3. **Agent spawn** — bind agent to team-lead session:
   - Option A: Use tmux `set-hook pane-exited` on the team-lead pane to kill agents
   - Option B: Agent heartbeat checks if team-lead pane is alive, exits if not

**Acceptance Criteria:**
- [ ] Killing team-lead pane also kills spawned agent panes
- [ ] `genie team disband` cleans up all agents
- [ ] No orphaned agent panes after team-lead exits

**Validation:**
```bash
# Verify team cleanup kills agents (manual test)
genie spawn engineer --team test-team
genie team disband test-team
# Engineer pane should be gone
```

**depends-on:** none

---

## QA Criteria

- [ ] `genie work <slug>` exits in <5 seconds
- [ ] Agent receives mailbox prompt and begins working
- [ ] Agent reports completion via `genie send`
- [ ] Team-lead exit kills all agents in team
- [ ] `genie status <slug>` reflects agent progress
- [ ] Existing test suite passes (786+ tests)

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Mailbox delivery race: agent not ready when prompt arrives | Medium | `genie send` queues to disk — agent picks up on next inbox check |
| Sequential waves lost without polling | Low | User re-runs `genie work` to advance; or team-lead orchestrates |
| tmux hook reliability varies across versions | Medium | Fallback: agent-side heartbeat polling team-lead pane |

---

## Files to Create/Modify

```
src/term-commands/dispatch.ts
src/term-commands/agents.ts
src/term-commands/team.ts
```
