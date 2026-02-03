# Genie CLI

Collaborative terminal toolkit for human + AI workflows.

## Overview

Genie CLI provides three tools for human/AI collaboration:

- **genie** - Setup wizard, prerequisites installer, and hook management
- **term** - tmux orchestration for managing terminal sessions
- **claudio** - Claude Code launcher with custom LLM routing profiles

The core idea: **tmux is the collaboration layer**. AI agents create and manage terminal sessions; humans can attach at any time to watch, assist, or take over. Both work in the same shared workspace.

---

## Quick Start

```bash
# One-line install (auto-detects best method)
curl -fsSL https://raw.githubusercontent.com/namastexlabs/genie-cli/main/install.sh | bash

# Or install with bun/npm directly
bun install -g @automagik/genie

# Then configure
genie setup              # Configure hook presets interactively
genie hooks install      # Install hooks into Claude Code

# Launch Claude Code with your router profile
claudio

# Watch the AI work (from another terminal)
tmux attach -t genie
```

---

## Configuration Files

Genie uses several configuration files:

| File | Purpose |
|------|---------|
| `~/.genie/config.json` | Hook presets and session settings |
| `~/.claudio/config.json` | LLM routing profiles (API URL, model mappings) |
| `~/.claude/settings.json` | Claude Code settings (hooks registered here) |
| `~/.claude/hooks/genie-bash-hook.sh` | Hook script that enforces configured behaviors |

---

## genie Reference

### Prerequisites Check & Install

```bash
genie install              # Interactive prerequisite check & install
genie install --check      # Only check, don't offer to install
genie install --yes        # Auto-approve all installations
```

#### What It Checks

| Prerequisite | Required | Installation Method |
|--------------|----------|---------------------|
| tmux | Yes | brew > apt/dnf/pacman > manual |
| bun | Yes | Official installer (curl) |
| claude | No (recommended) | npm global install |

---

### Hook Configuration (genie setup)

Interactive wizard for configuring which hooks to enable:

```bash
genie setup          # Interactive wizard
genie setup --quick  # Use recommended defaults (collaborative + audited)
```

The wizard explains each hook preset and lets you choose which to enable. Configuration is saved to `~/.genie/config.json`.

---

### Hook Management (genie hooks)

```bash
genie hooks show                 # Show current hook configuration
genie hooks install              # Install hooks into Claude Code
genie hooks install --force      # Overwrite existing hooks
genie hooks uninstall            # Remove hooks from Claude Code
genie hooks uninstall --keep-script  # Remove but keep the script file
genie hooks test                 # Test the hook script
```

#### How Hooks Work

1. `genie setup` saves your preferences to `~/.genie/config.json`
2. `genie hooks install` creates `~/.claude/hooks/genie-bash-hook.sh` and registers it in `~/.claude/settings.json`
3. When Claude Code runs, it invokes the hook script for relevant tool calls
4. The hook script enforces your configured behaviors

---

### Hook Presets

#### Collaborative (Recommended)

**What:** All terminal commands run through tmux
**Why:** You can watch AI work in real-time
**How:** Bash commands are rewritten to `term exec genie:shell '<command>'`

When enabled, any Bash tool call the AI makes gets automatically proxied through your tmux session. You can attach and watch:

```bash
tmux attach -t genie
```

Configuration options:
```json
{
  "hooks": {
    "enabled": ["collaborative"],
    "collaborative": {
      "sessionName": "genie",
      "windowName": "shell"
    }
  }
}
```

#### Supervised

**What:** File changes require your approval
**Why:** Prevents accidental overwrites
**How:** Write/Edit tools always ask permission

When enabled, the AI must get your explicit approval before writing or editing files. The default tools that require approval are `Write` and `Edit`.

Configuration options:
```json
{
  "hooks": {
    "enabled": ["supervised"],
    "supervised": {
      "alwaysAsk": ["Write", "Edit"]
    }
  }
}
```

#### Sandboxed

**What:** Restrict file access to specific directories
**Why:** Protects sensitive areas of your system
**How:** Operations outside the sandbox are blocked

When enabled, the AI can only read, write, or search files within the allowed paths. Attempts to access files outside these directories are denied.

Configuration options:
```json
{
  "hooks": {
    "enabled": ["sandboxed"],
    "sandboxed": {
      "allowedPaths": ["~/projects", "/tmp"]
    }
  }
}
```

#### Audited

**What:** Log all AI tool usage to a file
**Why:** Review what the AI did after a session
**How:** Every tool call is logged to `~/.genie/audit.log`

When enabled, all tool executions are recorded in JSONL format with timestamps, inputs, outputs, and duration.

Configuration options:
```json
{
  "hooks": {
    "enabled": ["audited"],
    "audited": {
      "logPath": "~/.genie/audit.log"
    }
  }
}
```

#### Combining Presets

You can enable multiple presets together:

```json
{
  "hooks": {
    "enabled": ["collaborative", "audited"]
  }
}
```

This gives you real-time observation (collaborative) plus a complete audit trail (audited).

---

## term Reference

### Command Tree

```
term
├── new <name>              Create session (-d workspace, -w worktree)
├── ls                      List sessions (--json)
├── attach <name>           Attach interactively
├── rm <name>               Remove session (--keep-worktree)
├── read <session>          Read output (-n, --grep, --json, -f)
├── exec <session> <cmd>    Run command (async)
├── send <session> <keys>   Send keys with Enter (--no-enter for raw)
├── split <session> <h|v>   Split pane (-d, -w)
├── info <session>          Session info (--json)
├── watch <session>         Watch events in real-time
├── run <session> <msg>     Fire-and-forget with auto-approve
├── window
│   ├── new <session> <name>
│   ├── ls <session> (--json)
│   └── rm <window-id>
├── pane
│   ├── ls <session> (--json)
│   └── rm <pane-id>
├── orc
│   ├── start <session>     Start Claude with monitoring
│   └── status <session>    Claude state (idle/busy/permission)
└── hook
    ├── set <event> <cmd>
    ├── list
    └── rm <event>
```

### Common Options

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON (essential for agents) |
| `-n <lines>` | Number of lines to read |
| `-f` | Follow mode (live tail) |
| `-d <path>` | Working directory |
| `-w` | Create git worktree |
| `--grep <pattern>` | Filter output by pattern |

---

## claudio Reference

### What It Does

claudio launches Claude Code with custom LLM routing profiles. It configures Claude's model mappings so requests for "opus", "sonnet", or "haiku" route to specific models via your configured router.

**Key principle**: `claude` = vanilla Anthropic, `claudio` = your custom router setup.

### Command Reference

```
claudio                     Launch with default profile
claudio <profile>           Launch with named profile

claudio setup               First-time setup wizard
claudio profiles            List all profiles (* = default)
claudio profiles add        Add new profile (interactive picker)
claudio profiles rm <name>  Delete profile
claudio profiles default <name>  Set default profile
claudio profiles show <name>     Show profile details

claudio models              List available models from router
claudio config              Show current config (URL, default profile)
```

### Hook Override Flags

```bash
claudio --hooks collaborative,audited  # Override with specific presets
claudio --no-hooks                     # Disable all hooks for this session
```

These flags let you temporarily override your `~/.genie/config.json` settings without changing the configuration file.

### Setup Wizard

Run `claudio setup` for first-time configuration:

```
$ claudio setup

🔧 Claudio Setup

? API URL: http://localhost:8317
? API Key: ********

Testing connection... ✓ Connected (47 models available)

Create your first profile:

? Profile name: main
? Select OPUS model: gemini-2.5-pro
? Select SONNET model: gemini-2.5-flash
? Select HAIKU model: gemini-2.5-flash

✓ Profile "main" created and set as default

Run `claudio` to launch, or `claudio profiles add` to create more.
```

### Profile Management

```bash
# List all profiles
claudio profiles
#   main *
#     opus:   gemini-2.5-pro
#     sonnet: gemini-2.5-flash
#     haiku:  gemini-2.5-flash
#   (* = default)

# Add a new profile
claudio profiles add

# Set default profile
claudio profiles default main

# Show profile details
claudio profiles show main

# Delete a profile
claudio profiles rm old-profile
```

### Configuration

Config lives in `~/.claudio/config.json`:

```json
{
  "apiUrl": "http://localhost:8317",
  "apiKey": "sk-...",
  "defaultProfile": "main",
  "profiles": {
    "main": {
      "opus": "gemini-2.5-pro",
      "sonnet": "gemini-2.5-flash",
      "haiku": "gemini-2.5-flash"
    }
  }
}
```

---

## For Humans

### Watching Agent Work

See what sessions exist:
```bash
term ls
```

Attach to watch an agent's session:
```bash
term attach genie
# or directly with tmux
tmux attach -t genie
```

Read recent output without attaching:
```bash
term read genie -n 200
```

### Taking Control

Once attached, you're in a normal tmux session:
- Type commands directly
- Use `Ctrl+B d` to detach
- The agent can continue working after you detach

### Quick Reference

| Task | Command |
|------|---------|
| List sessions | `term ls` |
| Attach to session | `term attach <name>` |
| Read output | `term read <name> -n 100` |
| Follow live | `term read <name> -f` |
| Kill session | `term rm <name>` |

---

## For AI Agents

### Standard Workflow

```bash
# 1. Create a session
term new khal-tests -d /path/to/project

# 2. Execute commands
term exec khal-tests "npm test"

# 3. Read output (always use --json for parsing)
term read khal-tests -n 100 --json

# 4. Clean up when done
term rm khal-tests
```

### JSON Output

Always use `--json` for reliable parsing:

```bash
# List sessions
term ls --json
# → [{"name":"khal-tests","windows":1,"created":"2025-01-30T10:00:00Z"}]

# Read output
term read khal-tests --json
# → {"session":"khal-tests","lines":["$ npm test","PASS src/app.test.ts"]}

# Check session info
term info khal-tests --json
# → {"exists":true,"windows":1,"panes":1}
```

### Session Naming Convention

Use descriptive names: `<project>-<task>`
- `khal-tests` - running Khal test suite
- `khal-deploy` - deployment process
- `api-build` - building API server

### Parallel Execution

Run multiple tasks in separate windows:
```bash
term new project-work -d /path/to/project
term window new project-work tests
term window new project-work build

term exec project-work:tests "npm test"
term exec project-work:build "npm run build"
```

Or use panes within a window:
```bash
term split project-work h  # horizontal split
term exec project-work "npm test"  # runs in active pane
```

### Detecting Completion

Check if a command finished:
```bash
term info my-session --json
```

Look for shell prompt in output to detect completion:
```bash
term read my-session -n 10 --json
```

---

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/namastexlabs/genie-cli/main/install.sh | bash
```

To update: `genie update`

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Claude Code                             │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ ~/.claude/settings.json                                 ││
│  │   hooks: [{ matcher: "Bash", command: "genie-bash-..." }]││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ PreToolUse / PostToolUse
┌─────────────────────────────────────────────────────────────┐
│              ~/.claude/hooks/genie-bash-hook.sh              │
│                                                              │
│  Reads: ~/.genie/config.json                                 │
│  Applies: collaborative, supervised, sandboxed, audited      │
└─────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
   │ Collaborative │   │   Audited    │   │  Sandboxed   │
   │               │   │              │   │              │
   │ Bash → term   │   │ Log to file  │   │ Block paths  │
   │ exec session  │   │              │   │ outside list │
   └──────────────┘   └──────────────┘   └──────────────┘
```

**Components:**

- **Bun** - TypeScript runtime and bundler
- **Commander.js** - CLI framework
- **tmux** - Session orchestration backend
- **Inquirer** - Interactive prompts for setup wizard

## License

MIT
