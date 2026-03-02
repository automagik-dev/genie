# Genie CLI Knowledge Base

*Consolidated knowledge about genie-cli as of 2026-02-04*

---

## 1. Overview

**Genie CLI** is a collaborative terminal toolkit for human + AI workflows. It provides three tools:

| Tool | Purpose |
|------|---------|
| `genie` | Setup wizard, prerequisites installer, hook management |
| `term` | tmux orchestration for managing terminal sessions |
| `claudio` | Claude Code launcher with custom LLM routing profiles |

**Core philosophy:** tmux is the collaboration layer. AI agents create and manage terminal sessions; humans can attach anytime.

---

## 2. Repository

- **Location:** `/home/genie/workspace/guga/code/genie-cli/`
- **GitHub:** `https://github.com/namastexlabs/genie-cli.git`
- **Branch:** `main` (up to date with origin)
- **Current version:** `0.260204.0334`
- **Language:** TypeScript (Bun)
- **Total source lines:** ~19,266 (excluding tests)

---

## 3. Key Files & Structure

```
genie-cli/
├── src/
│   ├── genie.ts              # Main genie CLI entry
│   ├── term.ts               # Main term CLI entry (623 lines)
│   ├── claudio.ts            # Claudio entry point
│   ├── term-commands/        # Term subcommands
│   │   ├── work.ts           # Worker spawning
│   │   ├── ship.ts           # Task completion
│   │   ├── push.ts           # Branch protection (NEW)
│   │   ├── events.ts         # Claude Code event streaming (564 lines)
│   │   ├── dashboard.ts      # Worker dashboard
│   │   ├── approve.ts        # Auto-approve engine
│   │   ├── spawn-parallel.ts # Parallel spawning
│   │   └── batch.ts          # Batch management
│   └── lib/
│       ├── worktree-manager.ts   # Git worktree abstraction (433 lines)
│       ├── auto-approve-engine.ts # Layered trust system
│       ├── claude-logs.ts        # Claude Code log parsing (549 lines)
│       ├── event-aggregator.ts   # Event stream aggregation
│       ├── batch-manager.ts      # Parallel spawn batches
│       └── worker-registry.ts    # Worker state tracking
├── plugins/
│   └── automagik-genie/      # Claude Code plugin with skills
├── scripts/
│   └── term.sh               # Shell wrapper
├── install.sh                # One-line installer
├── AGENTS.md                 # Agent instructions (bd workflow)
└── README.md                 # Full documentation
```

---

## 4. Configuration Files

| File | Purpose |
|------|---------|
| `~/.genie/config.json` | Hook presets, session settings, sourcePath |
| `~/.claudio/config.json` | LLM routing profiles (API URL, model mappings) |
| `~/.claude/settings.json` | Claude Code settings (hooks registered here) |
| `~/.claude/hooks/genie-bash-hook.sh` | Hook script for behavior enforcement |

---

## 5. Completed Wishes (merged to main)

| Wish | Title | Commit | Status |
|------|-------|--------|--------|
| wish-21 | Event capture (real-time Claude Code event streaming) | 4591e03 | ✅ DONE |
| wish-22 | Worktree enforcement (automatic worktree + branch per wish) | d274dba | ✅ DONE |
| wish-23 | Auto-approve engine (layered trust for safe operations) | 2d76886 | ✅ DONE |
| wish-24 | Worker dashboard (real-time CLI view of all workers) | f0d7582 | ✅ DONE |
| wish-25 | Parallel spawn (spawn multiple workers with one command) | c769a5d | ✅ DONE |

---

## 6. Key Commands

### genie
```bash
genie install          # Check/install prerequisites
genie setup            # Configure settings interactively
genie doctor           # Run diagnostics
genie hooks install    # Install hooks into Claude Code
```

### term
```bash
# Session management
term new <name>        # Create tmux session
term ls                # List sessions
term attach <name>     # Attach to session
term exec <session> <cmd>  # Execute command
term read <session>    # Read output

# Worker orchestration
term create <title>    # Create task
term work <id>         # Spawn worker for task
term workers           # List workers
term dashboard         # Live worker status
term ship <id>         # Mark done + cleanup
term close <id>        # Close + cleanup

# Advanced
term events <pane>     # Stream Claude Code events
term events --follow   # Tail mode
term approve           # Auto-approve management
term spawn-parallel    # Spawn multiple workers
term batch             # Manage batches
```

### claudio
```bash
claudio                # Launch Claude with default profile
claudio -p <profile>   # Use specific LLM profile
```

---

## 7. Skills (automagik-genie plugin)

Claude Code slash commands loaded via the plugin:

| Skill | Purpose |
|-------|---------|
| `/brainstorm` | Idea exploration |
| `/wish` | Structured planning (Wish→Do→Review step 1) |
| `/forge` | Delegated execution (step 2) |
| `/review` | Final validation (step 3) |
| `/council` | Multi-agent brainstorming |

**Location:** `~/.nvm/versions/node/v24.13.0/lib/node_modules/@automagik/genie/`

---

## 8. Parallel Work Method

### Core Principles
1. Each task gets a **dedicated git worktree**
2. Each task gets a **separate branch** (`work/<wish-id>`)
3. Each task gets a **separate PR**
4. Blockers become child wishes

### Workflow
```bash
term create "title"              # Create task
term work <wish-id> --skill forge # Spawn worker
term workers                      # Monitor
term events <pane> --follow       # Event stream
term ship <wish-id>               # Complete
```

---

## 9. Known Issues & Patterns

### ⚠️ ALWAYS START WITH /wish
When spawning Claude Code workers for non-trivial tasks:
1. First message: `/wish <task>`
2. Let worker create wish doc
3. Then `/forge` to execute
4. Then `/review` to validate

### Two Orchestration Stacks
| Stack | Tool | When to Use |
|-------|------|-------------|
| OpenClaw-native | `sessions_spawn` | Structured tasks, auto cleanup |
| Claude Code in tmux | `term` + `/forge` | Need visibility, human intervention |

### Push Protection
`term ship` and `term push` refuse to push from main/master branches.

---

## 10. OpenClaw Integration

### Shared Skills (for sessions_spawn)
Location: `/home/genie/workspace/shared/skills/`
- genie-wish, genie-do, genie-review, genie-plan-review, genie-council

### Genie-base Skill
Location: `~/.openclaw/skills/genie-base/`
Contains: MEMORY.md, SOUL.md, IDENTITY.md, TOOLS.md, AGENTS.md, HEARTBEAT.md

---

## 11. Agents with Genie-CLI Context

| Agent | Session Key | Notes |
|-------|-------------|-------|
| guga | agent:guga:main | Main orchestrator, uses genie-cli extensively |
| guga | agent:guga:genie-cli | Dedicated genie-cli work session |
| eva | agent:eva:main | Uses shared skills |
| chief-of-khal | - | Has genie-cli in workspace |

---

## 12. Open Tasks

1. **Issue 001:** Agent splits user's active window instead of target window (UX bug)
2. **QA Testing:** `term tasks` and `term panes` commands don't exist (discovered in QA)
3. **claudio status** command doesn't exist (discovered in QA)

---

## 13. Development Notes

### Installing for Development
```bash
cd ~/workspace/guga/code/genie-cli
bun install
bun run build
./install.sh --local  # Development mode
```

### Running Tests
```bash
bun test  # 39 tests, ~639ms
```

### Source Path
Configured in `~/.genie/config.json`:
```json
"sourcePath": "/home/genie/workspace/guga/code/genie-cli"
```

---

*Last updated: 2026-02-04 14:27 GMT-3*
