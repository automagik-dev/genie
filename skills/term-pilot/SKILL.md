---
name: term-pilot
description: "SINGLE SOURCE OF TRUTH for piloting tmux terminals with the 'term' CLI. Load this skill before ANY terminal orchestration. Covers: sessions, commands, workers, Claude Code control."
---

# Term Pilot - The Definitive Guide

**STOP. Read this before using ANY term command.**

This is the ONLY authoritative reference for terminal orchestration. If you're unsure, check here first.

---

## Core Mental Model

```
term = wrapper around tmux that makes it AI-friendly
```

**You are NOT running commands directly.** You are:
1. Creating/selecting a tmux session
2. Sending commands to that session
3. Reading output from that session

The human can `tmux attach -t <session>` to watch everything you do.

---

## CLI Structure Overview

The CLI is organized into namespaces:

| Namespace | Purpose | Example |
|-----------|---------|---------|
| `term session` | Low-level tmux operations | `term session exec genie 'ls'` |
| `term task` | Beads task management | `term task create "Fix bug"` |
| `term wish` | Wish document management | `term wish status my-wish` |
| (top-level) | Worker control & shortcuts | `term workers`, `term spawn` |

---

## Short Aliases

For quick terminal use:

| Alias | Expands To | Description |
|-------|------------|-------------|
| `term w` | `term work` | Spawn worker bound to task |
| `term s` | `term spawn` | Spawn Claude with skill |
| `term d` | `term dashboard` | Show worker status |
| `term a` | `term approve` | Approve pending permission |
| `term h` | `term history` | Session catch-up |

**Examples:**
```bash
term w bd-42        # Same as: term work bd-42
term d              # Same as: term dashboard
term h bd-42        # Same as: term history bd-42
```

---

## Session Namespace (`term session`)

Low-level tmux session operations. Use these for direct terminal control.

### List Sessions

```bash
term session ls              # List all tmux sessions
term session ls --json       # Machine-readable output
```

**Output example:**
```
genie (2 windows, attached)
worker-bd-001 (1 window)
```

### Execute Commands

```bash
term session exec <session> <command>
```

**This is the PRIMARY way to execute commands.** It:
- Sends the command to the session
- Waits for completion
- Returns the output to you

**Examples:**
```bash
term session exec genie 'ls -la'
term session exec genie 'npm test'
term session exec genie 'git status'
```

**Options:**
- `-q, --quiet` - Don't print output (just run)
- `-t, --timeout <ms>` - Custom timeout (default: 120000ms)

**Warning:** Commands with quotes need careful escaping:
```bash
term session exec genie 'echo "hello world"'     # Single quotes outside
term session exec genie "echo 'hello world'"     # Double quotes outside
```

### Read Output

```bash
term session read <session>              # Last 100 lines
term session read <session> -n 50        # Last 50 lines
term session read <session> --all        # Entire scrollback
term session read <session> --reverse    # Newest first
term session read <session> --search "ERROR"  # Search for pattern
term session read <session> --grep "test.*fail"  # Regex search
```

**When to use:**
- After `term session exec` if you need more context
- To see what's currently on screen
- To check command output you missed

### Send Keys (Interactive)

```bash
term session send <session> "text"              # Sends text + Enter
term session send <session> "text" --no-enter   # Sends text only (no Enter)
term session send <session> -p %42 "text"       # Send to specific pane
```

**When to use `send` vs `exec`:**
| Use `exec` | Use `send` |
|------------|------------|
| Normal shell commands | Interactive prompts |
| Scripts | Answering Y/N |
| Building/testing | Sending to Claude Code |
| Git operations | Ctrl+C to cancel |

**Special keys:**
```bash
term session send genie "C-c" --no-enter     # Ctrl+C
term session send genie "q" --no-enter       # Just 'q' (for less/vim quit)
term session send genie "" --no-enter        # Just Enter
```

### Session Lifecycle

```bash
term session new myproject                    # Create session
term session new myproject -d /path/to/dir    # With working directory
term session rm myproject                     # Kill session
term session attach myproject                 # Attach to session
```

### Session Info

```bash
term session info <session>     # Shows panes, their IDs, busy/idle state
```

### Split Panes

```bash
term session split <session> h   # Horizontal split
term session split <session> v   # Vertical split
```

---

## Task Namespace (`term task`)

Manage beads tasks/issues.

### Create Tasks

```bash
term task create "Fix the login bug"
term task create "Add feature X" --status ready
```

### List Tasks

```bash
term task ls                    # List ready tasks
term task ls --all              # List all tasks
```

### Update Tasks

```bash
term task update bd-42 --status in-progress
term task update bd-42 --title "New title"
term task update bd-42 --blocked-by bd-41
```

### Complete Tasks

```bash
term task ship bd-42            # Mark done + merge + cleanup worker
term task close bd-42           # Close + cleanup (no merge)
```

### Link Tasks to Wishes

```bash
term task link my-wish bd-42    # Link task to wish document
term task unlink my-wish bd-42  # Unlink task from wish
```

---

## Wish Namespace (`term wish`)

Manage wish documents (planning/specs).

### List Wishes

```bash
term wish ls                    # List all wishes with task status
term wish ls --json             # Machine-readable output
```

### Check Wish Status

```bash
term wish status my-wish        # Show wish with linked tasks
term wish show my-wish          # Alias for status
```

---

## Working with Claude Code (Workers)

When Claude Code is running in a pane, use these commands:

### Check Worker Status
```bash
term workers           # List all active workers
term dashboard         # Live dashboard
term d                 # Short alias
```

### Session Catch-Up with History

**This is essential for understanding what a worker has been doing:**

```bash
term history <worker>           # Compressed summary of session
term h <worker>                 # Short alias

# Options:
term history bd-42 --full       # Full conversation, no compression
term history bd-42 --since 5    # Last 5 user/assistant exchanges
term history bd-42 --json       # Output as JSON
term history bd-42 --raw        # Raw JSONL entries
```

**When to use:**
- Switching context to a worker you haven't looked at recently
- Understanding what a worker accomplished
- Debugging why a worker is stuck
- Reviewing before approving permissions

### Control Workers
```bash
term approve <worker>              # Approve permission request
term a <worker>                    # Short alias
term answer <worker> 1             # Answer question (option 1)
term answer <worker> "text:reply"  # Send text reply
term kill <worker>                 # Force kill
```

### Watch What's Happening
```bash
term watch <session>               # Real-time state changes
term events [pane-id]              # Stream Claude Code events
term events --follow               # Follow all workers
```

---

## The Worker Workflow (for beads tasks)

```bash
# 1. Create a task
term task create "Fix the bug"     # Creates bd-XXX

# 2. Start working on it
term work bd-XXX                   # Spawns Claude in new pane
term w bd-XXX                      # Short alias

# 3. Monitor
term workers                       # Check status
term dashboard                     # Live dashboard
term d                             # Short alias

# 4. Catch up on progress
term history bd-XXX                # See what worker did
term h bd-XXX                      # Short alias

# 5. Close when done
term task ship bd-XXX              # Mark done + cleanup
# or
term task close bd-XXX             # Just close + cleanup
```

---

## Session vs Pane Targeting

**Sessions** have names (e.g., `genie`, `worker-bd-001`)
**Panes** have IDs (e.g., `%42`, `%16`)

Most commands target sessions by default. To target a specific pane:

```bash
term session send genie -p %42 "message"
term session read genie -p %42
```

To find pane IDs:
```bash
term session info genie          # Shows panes and their IDs
```

---

## Common Mistakes (DON'T DO THESE)

### Wrong: Running shell commands directly
```bash
ls -la                              # This runs in YOUR context, not tmux
```

### Right: Use term session exec
```bash
term session exec genie 'ls -la'    # Runs in the tmux session
```

### Wrong: Using deprecated commands
```bash
term exec genie 'ls'                # DEPRECATED
term new myproject                  # DEPRECATED
term create "task"                  # DEPRECATED
```

### Right: Use namespaced commands
```bash
term session exec genie 'ls'        # Correct
term session new myproject          # Correct
term task create "task"             # Correct
```

### Wrong: Inventing commands that don't exist
```bash
term status genie                   # DOES NOT EXIST
term tasks                          # DOES NOT EXIST
term panes                          # DOES NOT EXIST
```

### Right: Use the actual commands
```bash
term session info genie             # Session info
term workers                        # Worker list
term session info genie             # Pane info is in here
```

---

## Quick Reference Card

| I want to... | Command |
|--------------|---------|
| **Sessions** | |
| See sessions | `term session ls` |
| Run a command | `term session exec <session> '<cmd>'` |
| See output | `term session read <session>` |
| Send text | `term session send <session> "text"` |
| Send without Enter | `term session send <session> "x" --no-enter` |
| Create session | `term session new <name>` |
| Delete session | `term session rm <name>` |
| Session info | `term session info <session>` |
| Split pane | `term session split <session> h` |
| **Workers** | |
| List workers | `term workers` |
| Live dashboard | `term dashboard` or `term d` |
| Session catch-up | `term history <worker>` or `term h <worker>` |
| Approve Claude | `term approve <worker>` or `term a <worker>` |
| Answer Claude | `term answer <worker> 1` |
| Kill worker | `term kill <worker>` |
| Watch events | `term watch <session>` |
| **Tasks** | |
| Create task | `term task create "title"` |
| List tasks | `term task ls` |
| Update task | `term task update <id> --status <status>` |
| Start work | `term work <bd-id>` or `term w <bd-id>` |
| Ship task | `term task ship <bd-id>` |
| Close task | `term task close <bd-id>` |
| Link to wish | `term task link <wish> <bd-id>` |
| **Wishes** | |
| List wishes | `term wish ls` |
| Wish status | `term wish status <slug>` |
| **Spawn** | |
| Spawn with skill | `term spawn <skill>` or `term s <skill>` |
| Interactive picker | `term spawn` |

---

## Deprecated Commands

These still work but show warnings. Use the new equivalents:

| Old (DEPRECATED) | New (USE THIS) |
|------------------|----------------|
| `term new <name>` | `term session new <name>` |
| `term rm <name>` | `term session rm <name>` |
| `term exec <sess> <cmd>` | `term session exec <sess> <cmd>` |
| `term send <sess> <keys>` | `term session send <sess> <keys>` |
| `term read <sess>` | `term session read <sess>` |
| `term split <sess>` | `term session split <sess>` |
| `term info <sess>` | `term session info <sess>` |
| `term attach <name>` | `term session attach <name>` |
| `term create <title>` | `term task create <title>` |
| `term update <id>` | `term task update <id>` |
| `term ship <id>` | `term task ship <id>` |
| `term close <id>` | `term task close <id>` |

---

## Debugging

### "Session not found"
```bash
term session ls                     # Check if session exists
term session new genie              # Create it if not
```

### "Command seems to hang"
```bash
term session read genie             # Check what's on screen
term session send genie "C-c" --no-enter   # Try Ctrl+C
term session info genie             # Check if pane is busy
```

### "I need to see the full output"
```bash
term session read genie --all       # Full scrollback
term session read genie -n 500      # Last 500 lines
```

### "Which pane is which?"
```bash
term session info genie             # Lists all panes with IDs
```

### "What did the worker do?"
```bash
term history bd-42                  # Compressed summary
term history bd-42 --full           # Full conversation
term history bd-42 --since 10       # Last 10 exchanges
```

---

## Commands That DO NOT EXIST

Do not hallucinate these:
- ~~`term status`~~ -> use `term session info` or `term workers`
- ~~`term tasks`~~ -> use `term task ls` or `term workers`
- ~~`term panes`~~ -> use `term session info`
- ~~`term run`~~ (at top level) -> use `term orc run` or `term session exec`
- ~~`term ls`~~ (without namespace) -> use `term session ls`
- ~~`claudio status`~~ -> doesn't exist

**Note:** Old commands like `term exec`, `term new` still work but are deprecated. Always use the namespaced versions.

---

*Last updated: 2026-02-05*
*This is the single source of truth. When in doubt, check here.*
