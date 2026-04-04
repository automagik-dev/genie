# Co-Orchestration Guide: AI-Human Software Development

This guide explains how to use genie's worker orchestration system for collaborative software development between humans and AI agents.

## Overview

The system enables multiple Claude agents to work on different tasks simultaneously, each in isolated git worktrees, while a human orchestrates and reviews their work. All state is tracked through the wish pipeline for unified visibility.

```
Human (Orchestrator)
    │
    ├── genie work wish-1  ──▶  Worker 1 (Claude in pane %1)
    │                              └── worktree: .worktrees/wish-1/
    │
    ├── genie work wish-2  ──▶  Worker 2 (Claude in pane %2)
    │                              └── worktree: .worktrees/wish-2/
    │
    └── genie ls           ──▶  Status dashboard
```

## Prerequisites

1. **tmux session**: You must be in a tmux session
2. **genie installed**: Run `genie setup` in your repo if not already done
3. **Claude CLI**: The `claude` command must be available

## Quick Start

```bash
# 1. Start genie serve (manages all background services)
genie serve --daemon

# 2. Create wishes to work on (via the /wish skill in a genie session)
# /wish "Implement user authentication"
# /wish "Add unit tests for auth module"
# /wish "Update API documentation"

# 3. Start a worker on the first wish
genie work wish-1

# 4. Check worker status
genie ls

# 5. When worker needs approval
genie approve

# 6. When done, close the wish
genie close wish-1
```

## Detailed Workflow

### Phase 1: Planning & Wish Creation

Before spawning workers, create well-defined wishes using the `/wish` skill:

```bash
# Launch a genie session
genie

# Inside the session, use the /wish skill to create wishes:
# /wish "Add login endpoint with JWT tokens"
# /wish "Create user registration form"
# /wish "Write integration tests for auth flow"

# Wishes are managed through the wish state machine:
# brainstorm → wish → plan → work → review → ship
```

### Phase 2: Spawning Workers

Start workers for ready wishes:

```bash
# Work on a specific wish
genie work wish-1

# Or let the system pick the next ready wish
genie work next

# Options:
#   --no-worktree    Use shared repo (no isolation)
#   --session <name> Target different tmux session
#   --prompt <msg>   Custom initial prompt
```

**What happens when you run `genie work wish-1`:**
1. `genie serve` auto-starts if not running (pgserve + scheduler + services)
2. Wish is claimed (status → in_progress)
3. Worktree created for the wish
4. New tmux pane spawned on `tmux -L genie` socket
5. Claude Code launched with initial prompt and identity hooks
6. Agent registered in PostgreSQL with pane ID, team, and role

### Phase 3: Monitoring Workers

```bash
# Check all workers
genie ls

# JSON output for scripting
genie ls --json
```

**Worker States:**
- `spawning` - Worker being initialized
- `working` - Actively producing output
- `idle` - At prompt, waiting for input
- `⚠️ perm` - Waiting for permission approval
- `⚠️ question` - Waiting for human answer
- `✅ done` - Task completed
- `❌ error` - Encountered error
- `💀 dead` - Pane no longer exists

### Phase 4: Interacting with Workers

**Approve permissions:**
```bash
genie approve           # Approve pending permission
genie approve --start   # Start auto-approve engine
```

**Answer questions:**
```bash
genie answer wish-1 1              # Select option 1
genie answer wish-1 "text:custom"  # Provide custom text answer
```

### Phase 5: Closing Wishes

When a worker completes its task:

```bash
# Close wish and cleanup worker
genie close wish-1

# Options:
#   --merge          Merge worktree branch to main before cleanup
#   --keep-worktree  Don't delete the worktree
#   -y, --yes        Skip confirmation
```

**What happens:**
1. Wish closed (status → done)
2. State synced
3. Worktree removed (unless --keep-worktree)
4. Worker pane killed

### Phase 6: Force Killing Workers

If a worker is stuck or needs to be terminated:

```bash
genie kill wish-1
```

Note: This does NOT close the wish. The task remains `in_progress`.

## Service Management

`genie serve` is the unified infrastructure owner. It manages pgserve (database), the scheduler, event router, inbox watcher, and the TUI. The old `genie daemon` commands still work as aliases.

```bash
genie serve              # Start foreground with TUI (default)
genie serve --headless   # Services only, no TUI
genie serve --daemon     # Start in background
genie serve stop         # Stop all services gracefully
genie serve status       # Show service health

# Legacy aliases (redirect to genie serve --headless):
genie daemon start       # → genie serve --headless
genie daemon stop        # Stop genie serve
genie daemon status      # Show daemon state
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for full service topology details.

## Multi-Worker Patterns

### Pattern 1: Sequential Dependencies

```bash
# Create dependent wishes via /wish skill, then work sequentially
genie work wish-1

# When wish-1 completes, wish-2 becomes ready
genie close wish-1
genie work next  # Picks wish-2
```

### Pattern 2: Parallel Independent Tasks

```bash
# Create independent wishes, then spawn multiple workers
genie work wish-1
genie work wish-2
genie work wish-3

# Monitor all
genie ls
```

### Pattern 3: Review and Iterate

```bash
# Worker completes, but needs revision
# Reopen and reassign
genie work wish-1
```

## Troubleshooting

### Worker shows as dead but pane exists
```bash
# The registry may be out of sync
genie kill <worker-id>  # Clean up registry entry
genie work <wish-id>    # Start fresh
```

### Worktree creation fails
```bash
# Check if branch already exists
git branch -a | grep <wish-id>

# Remove orphaned worktree
git worktree remove .worktrees/<wish-id> --force
```

## Best Practices

1. **Clear wish titles**: Workers use titles as context
2. **One task per worker**: Keep wishes focused
3. **Use the wish pipeline**: `/brainstorm` → `/wish` → `/work` → `/review` → ship
4. **Review before closing**: Check worker output before `genie close`
5. **Use worktrees**: They provide isolation and can be reviewed independently
6. **Keep daemon running**: Ensures state is synced to git

## Command Reference

| Command | Description |
|---------|-------------|
| `genie work <wish-id>` | Spawn worker for wish |
| `genie work next` | Work on next ready wish |
| `genie ls` | List all workers |
| `genie approve` | Approve permission / manage auto-approve |
| `genie answer <id> <choice>` | Answer question |
| `genie history <id>` | Compressed session catch-up |
| `genie events [pane-id]` | Stream Claude Code events |
| `genie close <id>` | Close wish and cleanup |
| `genie ship <id>` | Mark done, merge, cleanup |
| `genie kill <id>` | Force kill worker |
| `genie read <id>` | Read worker pane output |
| `genie exec <id> <cmd>` | Execute command in worker pane |
| `genie serve` | Start foreground with TUI |
| `genie serve --daemon` | Start in background |
| `genie serve stop` | Stop all services |
| `genie serve status` | Show service health |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     tmux -L genie (eternal)                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │  Worker 1   │  │  Worker 2   │  │  Worker 3   │  ...        │
│  │  (Claude)   │  │  (Claude)   │  │  (Claude)   │             │
│  │  pane %16   │  │  pane %17   │  │  pane %18   │             │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘             │
│         │                │                │                     │
│         ▼                ▼                ▼                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │ .worktrees/ │  │ .worktrees/ │  │ .worktrees/ │             │
│  │   wish-1/   │  │   wish-2/   │  │   wish-3/   │             │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘             │
│         │                │                │                     │
│         └────────────────┼────────────────┘                     │
│                          ▼                                      │
│                   ┌─────────────┐                               │
│                   │   .genie/   │  ◀── Shared across worktrees │
│                   │   wishes/   │                               │
│                   └──────┬──────┘                               │
│                          │                                      │
│                          ▼                                      │
│  ┌──────────────────────────────────────────────────────┐       │
│  │              genie serve (unified)                    │       │
│  │  pgserve │ scheduler │ event-router │ inbox-watcher  │       │
│  └──────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

For detailed architecture documentation, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Next Steps

After reading this guide:
1. Start with `genie serve --daemon` (or `genie serve` for TUI mode)
2. Launch a session with `genie` and create wishes via `/wish`
3. Try `genie work <id>` to spawn your first worker
4. Practice the workflow with simple tasks
5. Scale up to multi-worker orchestration
6. Read [ARCHITECTURE.md](ARCHITECTURE.md) for internals
