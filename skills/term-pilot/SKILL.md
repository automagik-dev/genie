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

## The 5 Commands You Actually Need

### 1. `term ls` - See What Exists

```bash
term ls              # List all tmux sessions
term ls --json       # Machine-readable
```

**Output example:**
```
genie (2 windows, attached)
worker-bd-001 (1 window)
```

### 2. `term exec` - Run a Command

```bash
term exec <session> <command>
```

**This is the PRIMARY way to execute commands.** It:
- Sends the command to the session
- Waits for completion
- Returns the output to you

**Examples:**
```bash
term exec genie 'ls -la'
term exec genie 'npm test'
term exec genie 'git status'
```

**Options:**
- `-q, --quiet` - Don't print output (just run)
- `-t, --timeout <ms>` - Custom timeout (default: 120000ms)

**Warning:** Commands with quotes need careful escaping:
```bash
term exec genie 'echo "hello world"'     # Single quotes outside
term exec genie "echo 'hello world'"     # Double quotes outside
```

### 3. `term read` - See What Happened

```bash
term read <session>              # Last 100 lines
term read <session> -n 50        # Last 50 lines
term read <session> --all        # Entire scrollback
term read <session> --reverse    # Newest first
```

**When to use:**
- After `term exec` if you need more context
- To see what's currently on screen
- To check command output you missed

### 4. `term send` - Send Keys (Interactive)

```bash
term send <session> "text"           # Sends text + Enter
term send <session> "text" --no-enter  # Sends text only (no Enter)
term send <session> -p %42 "text"    # Send to specific pane
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
term send genie "C-c" --no-enter     # Ctrl+C
term send genie "q" --no-enter       # Just 'q' (for less/vim quit)
term send genie "" --no-enter        # Just Enter
```

### 5. `term new` / `term rm` - Session Lifecycle

```bash
term new myproject                    # Create session
term new myproject -d /path/to/dir    # With working directory
term rm myproject                     # Kill session
```

---

## Working with Claude Code (Workers)

When Claude Code is running in a pane, use these commands:

### Check Worker Status
```bash
term workers           # List all active workers
term dashboard         # Live dashboard (use -w for auto-refresh)
```

### Control Workers
```bash
term approve <worker>              # Approve permission request
term answer <worker> 1             # Answer question (option 1)
term answer <worker> "text:reply"  # Send text reply
term kill <worker>                 # Force kill
```

### Watch What's Happening
```bash
term watch <session>               # Real-time state changes
term events <pane> --follow        # Stream Claude Code events
```

---

## Session vs Pane Targeting

**Sessions** have names (e.g., `genie`, `worker-bd-001`)
**Panes** have IDs (e.g., `%42`, `%16`)

Most commands target sessions by default. To target a specific pane:

```bash
term send genie -p %42 "message"
term read genie -p %42
```

To find pane IDs:
```bash
term info genie          # Shows panes and their IDs
```

---

## The Worker Workflow (for beads tasks)

```bash
# 1. Create a task
term create "Fix the bug"           # Creates bd-XXX

# 2. Start working on it
term work bd-XXX                    # Spawns Claude in new pane

# 3. Monitor
term workers                        # Check status
term dashboard -w                   # Live dashboard

# 4. Close when done
term ship bd-XXX                    # Mark done + cleanup
# or
term close bd-XXX                   # Just close + cleanup
```

---

## Common Mistakes (DON'T DO THESE)

### Wrong: Running shell commands directly
```bash
ls -la                              # This runs in YOUR context, not tmux
```

### Right: Use term exec
```bash
term exec genie 'ls -la'            # Runs in the tmux session
```

### Wrong: Inventing commands that don't exist
```bash
term status genie                   # DOES NOT EXIST
term tasks                          # DOES NOT EXIST
term panes                          # DOES NOT EXIST
```

### Right: Use the actual commands
```bash
term info genie                     # Session info
term workers                        # Task/worker list
term info genie                     # Pane info is in here
```

### Wrong: Using `term orc` for simple operations
```bash
term orc status genie               # Overcomplicated
term orc send genie "msg"           # Just use term send
```

### Right: `orc` is only for advanced Claude Code control
```bash
# Only use orc for specific Claude Code operations:
term orc status genie               # Only if you need Claude's internal state
term orc run genie "task" -a        # Fire-and-forget with auto-approve
```

---

## Quick Reference Card

| I want to... | Command |
|--------------|---------|
| See sessions | `term ls` |
| Run a command | `term exec <session> '<cmd>'` |
| See output | `term read <session>` |
| Send text | `term send <session> "text"` |
| Send without Enter | `term send <session> "x" --no-enter` |
| Create session | `term new <name>` |
| Delete session | `term rm <name>` |
| Session info | `term info <session>` |
| List workers | `term workers` |
| Live dashboard | `term dashboard -w` |
| Approve Claude | `term approve <worker>` |
| Answer Claude | `term answer <worker> 1` |
| Start task work | `term work <bd-id>` |
| Close task | `term close <bd-id>` |
| Watch events | `term watch <session>` |
| Split pane | `term split <session> h` |

---

## Debugging

### "Session not found"
```bash
term ls                             # Check if session exists
term new genie                      # Create it if not
```

### "Command seems to hang"
```bash
term read genie                     # Check what's on screen
term send genie "C-c" --no-enter   # Try Ctrl+C
term info genie                     # Check if pane is busy
```

### "I need to see the full output"
```bash
term read genie --all              # Full scrollback
term read genie -n 500             # Last 500 lines
```

### "Which pane is which?"
```bash
term info genie                    # Lists all panes with IDs
```

---

## Commands That DO NOT EXIST

Do not hallucinate these:
- ~~`term status`~~ -> use `term info`
- ~~`term tasks`~~ -> use `term workers` or `bd ls`
- ~~`term panes`~~ -> use `term info`
- ~~`term run`~~ (at top level) -> use `term orc run` or `term exec`
- ~~`claudio status`~~ -> doesn't exist

---

*Last updated: 2026-02-04*
*This is the single source of truth. When in doubt, check here.*
