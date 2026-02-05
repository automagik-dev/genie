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

For full CLI command reference, see the **term-pilot** skill.

## Start Working NOW

### 1. Check Current State

```bash
term session ls            # What sessions exist?
term workers               # Any active workers?
term task ls               # What tasks are ready? (replaces bd ready)
term task ls --all         # All tasks including done/blocked
```

### 2. Pick or Create Work

```bash
# Work on existing task
term work <bd-id>

# Or create new task and work it
term task create "Fix the thing" && term work next
```

### 3. Execute

The worker spawns Claude in a pane. You can:
- Watch: `tmux attach -t genie` or `term watch genie`
- Approve: `term approve <worker>` or `term a <worker>`
- Answer: `term answer <worker> <choice>`
- Check: `term orc status genie` (Claude state)
- Send: `term session send genie "msg"` (sends with Enter)

### 4. Catching Up on Worker Context

When switching between workers or checking what a worker has done, use `term history`:

```bash
term history <worker>           # Compressed summary of session
term h <worker>                 # Short alias

# Options:
term history bd-42 --full       # Full conversation, no compression
term history bd-42 --since 5    # Last 5 user/assistant exchanges
term history bd-42 --json       # Output as JSON
```

**When to use:**
- Switching context to a worker you haven't looked at recently
- Understanding what a worker accomplished
- Debugging why a worker is stuck
- Reviewing before approving permissions

### 5. Close When Done

```bash
term task ship <bd-id>         # Mark done, merge, cleanup worktree
term task close <bd-id>        # Close + cleanup (no merge)
```

---

## Parallel Work Pattern

Split work across multiple panes/workers:

```bash
# In session "genie"
term session split genie h     # New pane (uses ACTIVE pane)
term spawn forge               # Spawn Claude with skill
```

Or use workers for tracked work:

```bash
term work bd-001           # Worker 1
term work bd-002           # Worker 2 (parallel)
term workers               # See both
term dashboard             # Live dashboard (or term d)
```

---

## Wish Management

Track larger initiatives with wishes:

```bash
term wish ls                   # List all wishes with task status
term wish status <slug>        # Show wish with linked tasks
term task link <wish> <bd-id>  # Link a task to a wish
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
| See sessions | `term session ls` |
| See workers | `term workers` |
| Live dashboard | `term dashboard` or `term d` |
| See tasks | `term task ls` |
| See wishes | `term wish ls` |
| Wish status | `term wish status <slug>` |
| Start work | `term work <id>` or `term w <id>` |
| Split pane | `term session split genie h` |
| Catch up | `term history <worker>` or `term h <worker>` |
| Approve | `term approve <worker>` or `term a <worker>` |
| Answer | `term answer <worker> 1` |
| Send message | `term session send genie "msg"` |
| Send raw keys | `term session send genie "q" --no-enter` |
| Watch events | `term watch genie` |
| Fire-and-forget | `term orc run genie "task"` |
| Session info | `term session info genie` |
| Claude state | `term orc status genie` |
| Ship task | `term task ship <id>` |
| Close task | `term task close <id>` |

---

## Stop Planning, Start Doing

1. What needs to be done? (one thing)
2. Is there a task? Create one if not: `term task create "..."`
3. `term work <id>` or just start coding
4. Ship it

No more circles.
