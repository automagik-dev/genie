# Co-Orchestration Guide: AI-Human Software Development

This guide explains how to use genie-cli's worker orchestration system for collaborative software development between humans and AI agents.

## Overview

The system enables multiple Claude agents to work on different tasks simultaneously, each in isolated git worktrees, while a human orchestrates and reviews their work. All state is tracked in beads for unified visibility.

```
Human (Orchestrator)
    │
    ├── genie work bd-1  ──▶  Worker 1 (Claude in pane %1)
    │                              └── worktree: .worktrees/bd-1/
    │
    ├── genie work bd-2  ──▶  Worker 2 (Claude in pane %2)
    │                              └── worktree: .worktrees/bd-2/
    │
    └── genie agent list ──▶  Status dashboard
```

## Prerequisites

1. **tmux session**: You must be in a tmux session
2. **beads initialized**: Run `bd init` in your repo if not already done
3. **Claude CLI**: The `claude` command must be available

## Quick Start

```bash
# 1. Start the beads daemon for auto-sync
genie daemon start

# 2. Create issues to work on
bd create "Implement user authentication"
bd create "Add unit tests for auth module"
bd create "Update API documentation"

# 3. Start a worker on the first issue
genie work bd-1

# 4. Check worker status
genie agent list

# 5. When worker needs approval
genie agent approve

# 6. When done, close the issue
genie agent close bd-1
```

## Detailed Workflow

### Phase 1: Planning & Issue Creation

Before spawning workers, create well-defined issues in beads:

```bash
# Create issues with clear titles
bd create "Add login endpoint with JWT tokens"
bd create "Create user registration form"
bd create "Write integration tests for auth flow"

# Set dependencies if needed
bd update bd-2 --blocked-by bd-1
bd update bd-3 --blocked-by bd-1,bd-2

# View the queue
bd ready      # Shows issues ready to work on
bd list       # Shows all issues with status
```

### Phase 2: Spawning Workers

Start workers for ready issues:

```bash
# Work on a specific issue
genie work bd-1

# Or let the system pick the next ready issue
genie work next

# Options:
#   --no-worktree    Use shared repo (no isolation)
#   --session <name> Target different tmux session
#   --prompt <msg>   Custom initial prompt
```

**What happens when you run `genie work bd-1`:**
1. Daemon starts (if not running) for auto-sync
2. Issue is claimed (status → in_progress)
3. Worktree created via `bd worktree create bd-1`
4. New tmux pane spawned in the worktree directory
5. Claude CLI launched with initial prompt
6. Agent bead created to track the worker
7. Work bound to agent via slot system

### Phase 3: Monitoring Workers

```bash
# Check all workers
genie agent list

# JSON output for scripting
genie agent list --json
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
genie agent approve           # Approve pending permission
genie agent approve --start   # Start auto-approve engine
```

**Answer questions:**
```bash
genie agent answer bd-1 1              # Select option 1
genie agent answer bd-1 "text:custom"  # Provide custom text answer
```

### Phase 5: Closing Issues

When a worker completes its task:

```bash
# Close issue and cleanup worker
genie agent close bd-1

# Options:
#   --merge          Merge worktree branch to main before cleanup
#   --keep-worktree  Don't delete the worktree
#   --no-sync        Skip bd sync
#   -y, --yes        Skip confirmation
```

**What happens:**
1. Issue closed in beads (status → done)
2. Beads synced to git
3. Worktree removed (unless --keep-worktree)
4. Worker pane killed
5. Agent bead deleted

### Phase 6: Force Killing Workers

If a worker is stuck or needs to be terminated:

```bash
genie agent kill bd-1
```

Note: This does NOT close the issue. The task remains `in_progress` in beads.

## Daemon Management

The beads daemon auto-commits and syncs changes:

```bash
genie daemon start     # Start with auto-commit
genie daemon status    # Check if running
genie daemon stop      # Stop daemon
genie daemon restart   # Restart with fresh config

# Options for start/restart:
#   --no-auto-commit  Disable auto-commit
#   --auto-push       Enable auto-push to remote
```

## Multi-Worker Patterns

### Pattern 1: Sequential Dependencies

```bash
# Create dependent tasks
bd create "Design database schema"           # bd-1
bd create "Implement models"                 # bd-2
bd update bd-2 --blocked-by bd-1

# Start first task
genie work bd-1

# When bd-1 completes, bd-2 becomes ready
genie agent close bd-1
genie work next  # Picks bd-2
```

### Pattern 2: Parallel Independent Tasks

```bash
# Create independent tasks
bd create "Add user profile page"
bd create "Add settings page"
bd create "Add notifications page"

# Spawn multiple workers
genie work bd-1
genie work bd-2
genie work bd-3

# Monitor all
genie agent list
```

### Pattern 3: Review and Iterate

```bash
# Worker completes, but needs revision
# Don't close yet — reopen and reassign
bd update bd-1 --status open
genie work bd-1
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TERM_USE_BEADS_REGISTRY` | `true` | Set to `false` to use JSON registry fallback |

## Troubleshooting

### Worker shows as dead but pane exists
```bash
# The registry may be out of sync
genie agent kill <worker-id>  # Clean up registry entry
genie work <task-id>           # Start fresh
```

### Worktree creation fails
```bash
# Check if branch already exists
git branch -a | grep <task-id>

# Remove orphaned worktree
git worktree remove .worktrees/<task-id> --force
```

### Daemon won't start
```bash
# Check bd daemon directly
bd daemon status
bd daemon start --auto-commit
```

## Best Practices

1. **Clear issue titles**: Workers use titles as context
2. **One task per worker**: Keep issues focused
3. **Use dependencies**: `--blocked-by` prevents premature work
4. **Review before closing**: Check worker output before `genie agent close`
5. **Use worktrees**: They provide isolation and can be reviewed independently
6. **Keep daemon running**: Ensures beads state is synced to git

## Command Reference

| Command | Description |
|---------|-------------|
| `genie work <bd-id>` | Spawn worker for issue |
| `genie work next` | Work on next ready issue |
| `genie agent list` | List all workers |
| `genie agent approve` | Approve permission / manage auto-approve |
| `genie agent answer <id> <choice>` | Answer question |
| `genie agent history <id>` | Compressed session catch-up |
| `genie agent events [pane-id]` | Stream Claude Code events |
| `genie agent close <id>` | Close issue and cleanup |
| `genie agent ship <id>` | Mark done, merge, cleanup |
| `genie agent kill <id>` | Force kill worker |
| `genie agent read <id>` | Read worker pane output |
| `genie agent exec <id> <cmd>` | Execute command in worker pane |
| `genie daemon start` | Start beads daemon |
| `genie daemon stop` | Stop beads daemon |
| `genie daemon status` | Show daemon status |
| `genie council` | Spawn dual-model deliberation |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Human Terminal                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │  Worker 1   │  │  Worker 2   │  │  Worker 3   │  ...        │
│  │  (Claude)   │  │  (Claude)   │  │  (Claude)   │             │
│  │  pane %16   │  │  pane %17   │  │  pane %18   │             │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘             │
│         │                │                │                     │
│         ▼                ▼                ▼                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │ .worktrees/ │  │ .worktrees/ │  │ .worktrees/ │             │
│  │   bd-1/     │  │   bd-2/     │  │   bd-3/     │             │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘             │
│         │                │                │                     │
│         └────────────────┼────────────────┘                     │
│                          ▼                                      │
│                   ┌─────────────┐                               │
│                   │   .genie/   │  ◀── Shared via redirect     │
│                   │ issues.jsonl│                               │
│                   └──────┬──────┘                               │
│                          │                                      │
│                          ▼                                      │
│                   ┌─────────────┐                               │
│                   │ bd daemon   │  ◀── Auto-commit & sync      │
│                   └─────────────┘                               │
└─────────────────────────────────────────────────────────────────┘
```

## Next Steps

After reading this guide:
1. Start with `genie daemon start`
2. Create a few test issues with `bd create`
3. Try `genie work <id>` to spawn your first worker
4. Practice the workflow with simple tasks
5. Scale up to multi-worker orchestration
