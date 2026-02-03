# Co-Orchestration Guide: AI-Human Software Development

This guide explains how to use genie-cli's worker orchestration system for collaborative software development between humans and AI agents.

## Overview

The system enables multiple Claude agents to work on different tasks simultaneously, each in isolated git worktrees, while a human orchestrates and reviews their work. All state is tracked in beads for unified visibility.

```
Human (Orchestrator)
    │
    ├── term work bd-1  ──▶  Worker 1 (Claude in pane %1)
    │                              └── worktree: .worktrees/bd-1/
    │
    ├── term work bd-2  ──▶  Worker 2 (Claude in pane %2)
    │                              └── worktree: .worktrees/bd-2/
    │
    └── term workers    ──▶  Status dashboard
```

## Prerequisites

1. **tmux session**: You must be in a tmux session
2. **beads initialized**: Run `bd init` in your repo if not already done
3. **Claude CLI**: The `claude` command must be available

## Quick Start

```bash
# 1. Start the beads daemon for auto-sync
term daemon start

# 2. Create issues to work on
bd create "Implement user authentication"
bd create "Add unit tests for auth module"
bd create "Update API documentation"

# 3. Start a worker on the first issue
term work bd-1

# 4. Check worker status
term workers

# 5. When worker needs approval
term approve bd-1

# 6. When done, close the issue
term close bd-1
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
term work bd-1

# Or let the system pick the next ready issue
term work next

# Options:
#   --no-worktree    Use shared repo (no isolation)
#   --session <name> Target different tmux session
#   --prompt <msg>   Custom initial prompt
```

**What happens when you run `term work bd-1`:**
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
term workers

# Output:
# ┌─────────────────────────────────────────────────────────────────┐
# │ WORKERS                                                         │
# ├──────────┬──────────┬───────────────────────────┬──────────┬────┤
# │ Name     │ Pane     │ Task                      │ State    │Time│
# ├──────────┼──────────┼───────────────────────────┼──────────┼────┤
# │ bd-1     │ %16      │ "Add login endpoint..."   │ working  │ 5m │
# │ bd-2     │ %17      │ "Create user registra..." │ ⚠️ perm  │ 2m │
# └──────────┴──────────┴───────────────────────────┴──────────┴────┘

# JSON output for scripting
term workers --json
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
term approve bd-1        # Approve pending permission
term approve bd-1 --deny # Deny permission
```

**Answer questions:**
```bash
term answer bd-1 1              # Select option 1
term answer bd-1 "text:custom"  # Provide custom text answer
```

**Send additional instructions:**
```bash
# Focus the worker pane and type directly, or:
term send <session> "Additional instructions here" --pane %16
```

### Phase 5: Closing Issues

When a worker completes its task:

```bash
# Close issue and cleanup worker
term close bd-1

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
term kill bd-1

# Options:
#   --keep-worktree  Preserve worktree for manual inspection
#   -y, --yes        Skip confirmation
```

Note: This does NOT close the issue. The task remains `in_progress` in beads.

## Daemon Management

The beads daemon auto-commits and syncs changes:

```bash
term daemon start     # Start with auto-commit
term daemon status    # Check if running
term daemon stop      # Stop daemon
term daemon restart   # Restart with fresh config

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
term work bd-1

# When bd-1 completes, bd-2 becomes ready
term close bd-1
term work next  # Picks bd-2
```

### Pattern 2: Parallel Independent Tasks

```bash
# Create independent tasks
bd create "Add user profile page"
bd create "Add settings page"
bd create "Add notifications page"

# Spawn multiple workers
term work bd-1
term work bd-2
term work bd-3

# Monitor all
term workers
```

### Pattern 3: Review and Iterate

```bash
# Worker completes, but needs revision
# Don't close yet - send feedback
term send genie "Please also add input validation" --pane %16

# Or if already closed, reopen
bd update bd-1 --status open
term work bd-1
```

## CLI Improvement Loop

**Important:** When using this system, you may identify opportunities to improve the CLI itself. Do NOT implement these directly in your current work. Instead:

1. Create an improvement issue:
   ```bash
   bd create "CLI: <improvement description>" --label cli-improvement
   ```

2. A dedicated `genie-cli-improver` worker handles these:
   ```bash
   term work <cli-improvement-issue>
   ```

3. This separation ensures:
   - Current work stays focused
   - CLI changes are properly isolated
   - Improvements can be reviewed independently

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TERM_USE_BEADS_REGISTRY` | `true` | Set to `false` to use JSON registry fallback |

## Troubleshooting

### Worker shows as dead but pane exists
```bash
# The registry may be out of sync
term kill <worker-id>  # Clean up registry entry
term work <task-id>    # Start fresh
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

### Permission loop
If a worker keeps asking for the same permission:
```bash
# Check Claude's permission settings
# Consider using --dangerously-skip-permissions for trusted repos
```

## Best Practices

1. **Clear issue titles**: Workers use titles as context
2. **One task per worker**: Keep issues focused
3. **Use dependencies**: `--blocked-by` prevents premature work
4. **Review before closing**: Check worker output before `term close`
5. **Use worktrees**: They provide isolation and can be reviewed independently
6. **Keep daemon running**: Ensures beads state is synced to git
7. **Delegate CLI improvements**: Create issues, don't implement inline

## Command Reference

| Command | Description |
|---------|-------------|
| `term work <bd-id>` | Spawn worker for issue |
| `term work next` | Work on next ready issue |
| `term workers` | List all workers |
| `term approve <id>` | Approve permission |
| `term answer <id> <choice>` | Answer question |
| `term send <id> <msg>` | Send message (with Enter) |
| `term send <id> <keys> --no-enter` | Send raw keys |
| `term watch <id>` | Watch session events in real-time |
| `term run <id> <msg>` | Fire-and-forget with auto-approve |
| `term info <id>` | Session info (windows/panes) |
| `term close <id>` | Close issue and cleanup |
| `term kill <id>` | Force kill worker |
| `term daemon start` | Start beads daemon |
| `term daemon stop` | Stop beads daemon |
| `term daemon status` | Show daemon status |
| `term orc status <id>` | Claude state (idle/busy/permission) |
| `term orc start <id>` | Start Claude with monitoring |

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
1. Start with `term daemon start`
2. Create a few test issues with `bd create`
3. Try `term work <id>` to spawn your first worker
4. Practice the workflow with simple tasks
5. Scale up to multi-worker orchestration

Happy co-orchestrating!
