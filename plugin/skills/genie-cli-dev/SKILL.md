---
name: genie-cli-dev
description: "Development guide for genie-cli - the AI-friendly terminal orchestration tool built on tmux. Use when modifying term commands, tmux library, or adding new CLI features."
---

# Genie-CLI Development Guide

## Overview

Genie-CLI (`tools/genie-cli/`) is an AI-friendly terminal orchestration system built on tmux. It provides two main entry points:

- **`genie`** - Setup and utilities (install, setup, doctor, shortcuts)
- **`term`** - Terminal orchestration (session/window/pane management, command execution)

**Stack:** TypeScript, Bun, Commander.js, tmux

---

## Architecture

```
tools/genie-cli/
├── src/
│   ├── genie.ts          # genie CLI entry point
│   ├── term.ts           # term CLI entry point
│   ├── lib/
│   │   ├── tmux.ts       # Core tmux wrapper (CRITICAL)
│   │   ├── tmux-wrapper.ts
│   │   ├── config.ts
│   │   ├── worktree.ts   # Git worktree management
│   │   ├── worker-registry.ts
│   │   └── orchestrator/ # Claude Code automation
│   ├── term-commands/    # term subcommands
│   │   ├── split.ts
│   │   ├── new.ts
│   │   ├── ls.ts
│   │   ├── exec.ts
│   │   ├── read.ts
│   │   ├── window.ts
│   │   ├── pane.ts
│   │   ├── spawn.ts      # Skill-based Claude spawning
│   │   ├── work.ts       # Worker orchestration
│   │   └── orchestrate.ts
│   └── genie-commands/   # genie subcommands
│       ├── install.ts
│       ├── setup.ts
│       └── doctor.ts
└── plugin/               # Claude Code plugin
```

---

## Core tmux Library (`src/lib/tmux.ts`)

### Key Interfaces

```typescript
interface TmuxSession {
  id: string;       // e.g., "$0"
  name: string;     // User-friendly name
  attached: boolean;
  windows: number;
}

interface TmuxWindow {
  id: string;       // e.g., "@0"
  name: string;
  active: boolean;  // Is this the active window?
  sessionId: string;
}

interface TmuxPane {
  id: string;       // e.g., "%0"
  windowId: string;
  active: boolean;  // Is this the active pane?
  title: string;
}
```

### Critical Functions

| Function | Purpose | Returns |
|----------|---------|---------|
| `listSessions()` | Get all tmux sessions | `TmuxSession[]` |
| `findSessionByName(name)` | Find session by name | `TmuxSession \| null` |
| `listWindows(sessionId)` | Get windows in session | `TmuxWindow[]` |
| `listPanes(windowId)` | Get panes in window | `TmuxPane[]` |
| `splitPane(paneId, direction, size?, workingDir?)` | Split a pane | `TmuxPane \| null` |
| `executeCommand(paneId, command)` | Run command in pane | `commandId` |
| `runCommandSync(paneId, command, timeout?)` | Run command and wait | `{output, exitCode}` |
| `capturePaneContent(paneId, lines?)` | Read pane output | `string` |

### Finding Active Window/Pane

Both `TmuxWindow` and `TmuxPane` have an `active: boolean` property parsed from tmux format strings:

```typescript
// From listWindows - uses #{?window_active,1,0}
const activeWindow = windows.find(w => w.active) || windows[0];

// From listPanes - uses #{?pane_active,1,0}
const activePane = panes.find(p => p.active) || panes[0];
```

**Common bug pattern:** Using `windows[0]` or `panes[0]` instead of finding the active one.

---

## Term Commands Pattern

Each command in `src/term-commands/` follows this pattern:

```typescript
// Example: split.ts
import * as tmux from '../lib/tmux.js';

export interface SplitOptions {
  workspace?: string;
  worktree?: string;
}

export async function splitSessionPane(
  sessionName: string,
  direction?: string,
  options: SplitOptions = {}
): Promise<void> {
  // 1. Find session
  const session = await tmux.findSessionByName(sessionName);
  if (!session) { /* error handling */ }

  // 2. Get windows/panes
  const windows = await tmux.listWindows(session.id);
  // ...

  // 3. Perform operation
  // ...
}
```

### Registering Commands

Commands are registered in `src/term.ts` using Commander.js:

```typescript
program
  .command('split <session> [direction]')
  .description('Split pane in a tmux session (h=horizontal, v=vertical)')
  .option('-d, --workspace <path>', 'Working directory for the new pane')
  .action(async (session, direction, options) => {
    await splitCmd.splitSessionPane(session, direction, options);
  });
```

---

## Common Patterns

### Session → Window → Pane Navigation

```typescript
// Get session by name
const session = await tmux.findSessionByName(sessionName);

// Get windows in session
const windows = await tmux.listWindows(session.id);

// Find ACTIVE window (not just first!)
const activeWindow = windows.find(w => w.active) || windows[0];

// Get panes in window
const panes = await tmux.listPanes(activeWindow.id);

// Find ACTIVE pane (not just first!)
const activePane = panes.find(p => p.active) || panes[0];
```

### Getting Pane Working Directory

```typescript
const currentPath = await tmux.executeTmux(
  `display-message -p -t '${paneId}' '#{pane_current_path}'`
);
```

### Splitting Panes

```typescript
const newPane = await tmux.splitPane(
  targetPaneId,
  'horizontal' | 'vertical',  // direction
  undefined,                   // size (percentage)
  workingDir                   // optional working directory
);
```

---

## Known Issues & Fixes

### Issue: Commands target first pane instead of active pane

**Symptom:** `term split genie h` splits the first pane of first window, not the user's current pane.

**Root cause:** Using `windows[0]` and `panes[0]` instead of finding active.

**Fix pattern:**
```typescript
// Before (wrong)
const panes = await tmux.listPanes(windows[0].id);
const paneId = panes[0].id;

// After (correct)
const activeWindow = windows.find(w => w.active) || windows[0];
const panes = await tmux.listPanes(activeWindow.id);
const activePane = panes.find(p => p.active) || panes[0];
const paneId = activePane.id;
```

---

## Testing Commands

```bash
# Build
cd tools/genie-cli && bun run build

# Test term commands
term ls                    # List sessions
term new test-session      # Create session
term window ls test-session # List windows
term pane ls test-session  # List panes
term split test-session h  # Split horizontally
term info test-session     # Session info (windows/panes)
term rm test-session       # Cleanup
```

---

## Worker Orchestration

Workers bind Claude Code sessions to beads issues:

```bash
term work <bd-id>      # Spawn worker for issue
term work next         # Work on next ready issue
term workers           # List workers
term close <bd-id>     # Close issue and cleanup
term kill <worker>     # Force kill worker
```

Worker state tracked in `src/lib/worker-registry.ts`.

---

## Orchestrator (Claude Automation)

The `src/lib/orchestrator/` module automates Claude Code:

- **Completion detection** - Detect when Claude finishes
- **State detection** - Parse Claude's current state from terminal output
- **Event monitoring** - Watch for permissions, questions, errors

```bash
term orc start genie       # Start Claude with monitoring
term orc status genie      # Check Claude state (detailed)
term send genie "msg"      # Send message with Enter
term send genie "q" --no-enter  # Send raw key
term watch genie           # Watch session events
term run genie "task"      # Fire-and-forget with auto-approve
term approve <worker>      # Approve permission (for workers)
term answer <worker> 1     # Answer question (for workers)
```

---

## Development Workflow

1. Edit source in `src/`
2. Build: `bun run build`
3. Test: `term <command>`
4. The CLI is symlinked, so rebuilt files are immediately available

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `src/lib/tmux.ts` | All tmux operations |
| `src/term.ts` | Command registration |
| `src/term-commands/split.ts` | Pane splitting |
| `src/term-commands/spawn.ts` | Skill-based Claude spawning |
| `src/term-commands/orchestrate.ts` | Claude automation |
| `src/lib/orchestrator/state-detector.ts` | Claude state parsing |
| `src/lib/worker-registry.ts` | Worker state tracking |
