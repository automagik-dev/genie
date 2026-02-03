---
name: work-orchestration
description: "How to orchestrate real work with the human using term, claudio, and beads. Stop planning, start doing."
---

# Work Orchestration

## The Stack

- **term** - Terminal/tmux orchestration
- **claudio** - Claude Code API automation
- **beads** - Task/issue tracking (bd CLI)
- **worktrees** - Isolated git branches for parallel work

## Start Working NOW

### 1. Check Current State

```bash
term ls                    # What sessions exist?
term workers               # Any active workers?
bd ls                      # What issues are ready?
```

### 2. Pick or Create Work

```bash
# Work on existing issue
term work <bd-id>

# Or create new issue and work it
term create "Fix the thing" && term work next
```

### 3. Execute

The worker spawns Claude in a pane. You can:
- Watch: `tmux attach -t genie` or `term watch genie`
- Approve: `term approve <worker>`
- Answer: `term answer <worker> <choice>`
- Check: `term orc status genie` (Claude state)
- Send: `term send genie "msg"` (sends with Enter)

### 4. Close When Done

```bash
term close <bd-id>         # Closes issue, cleans worktree
```

---

## Parallel Work Pattern

Split work across multiple panes/workers:

```bash
# In session "genie"
term split genie h         # New pane (uses ACTIVE pane)
term spawn forge           # Spawn Claude with skill
```

Or use workers for tracked work:

```bash
term work bd-001           # Worker 1
term work bd-002           # Worker 2 (parallel)
term workers               # See both
```

---

## Human-AI Handoff

**Human does:**
- Approves permissions
- Answers questions
- Provides context when stuck
- Reviews before merge

**AI does:**
- Implements tasks
- Runs tests
- Creates commits (when asked)
- Reports blockers

---

## Quick Commands

| Action | Command |
|--------|---------|
| See sessions | `term ls` |
| See workers | `term workers` |
| See issues | `bd ls` |
| Start work | `term work <id>` |
| Split pane | `term split genie h` |
| Approve | `term approve <worker>` |
| Answer | `term answer <worker> 1` |
| Send message | `term send genie "msg"` |
| Send raw keys | `term send genie "q" --no-enter` |
| Watch events | `term watch genie` |
| Fire-and-forget | `term run genie "task"` |
| Session info | `term info genie` |
| Claude state | `term orc status genie` |
| Close work | `term close <id>` |

---

## Stop Planning, Start Doing

1. What needs to be done? (one thing)
2. Is there an issue? Create one if not
3. `term work <id>` or just start coding
4. Ship it

No more circles.
