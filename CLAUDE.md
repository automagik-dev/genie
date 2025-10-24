@AGENTS.md

# ⚠️ User Context (Project-Specific Session Continuity)
# Load project-local user context from: .genie/USERCONTEXT.md (gitignored, per-user, per-project)
# This file enables session memory, user preferences, decision tracking, and parallel work for THIS project.
# Each team member has their own context file (not shared in git).
# If missing, install/update agent will create it from template.
# TODO: Create USERCONTEXT.md template and uncomment @ reference

# Claude Code Entry Point

This file loads all Genie agent knowledge and project state via @ references above.

**Architecture:**
- **AGENTS.md**: Complete Genie agent knowledge base (universal patterns, behavioral rules, workflows)
- **CLAUDE.md**: Meta-loader (this file) - auto-loads knowledge on every session
- **USERCONTEXT.md**: Per-user preferences and session continuity (gitignored)
- **.genie/.session**: Live Forge state, auto-generated (gitignored, load explicitly with `!cat .genie/.session`)

All agent instructions, patterns, and behavioral rules are in AGENTS.md for single source of truth.

**Historical:** MASTER-PLAN.md archived to `.genie/reports/architectural-evolution-may-oct-2025.md` (served its purpose, reached RC92)

---

# Session Context (2025-10-24)

## CLI UX Improvements - Interactive vs Headless Modes

**Implemented:**
- ✅ **`genie talk <agent>`** - Interactive browser session (NEW)
  - Location: `.genie/cli/src/commands/talk.ts`
  - Behavior:
    - Starts Forge if not running (silent startup with timing)
    - Shows "Genie is ready" message
    - 5s countdown or Enter to proceed
    - Opens dashboard in browser
    - Exits, leaving Forge running in background
  - Use case: Interactive work with agents via Forge UI

**In Progress:**
- 🚧 **`genie run <agent> <prompt>`** - Headless JSON execution (PLANNED)
  - Current: Starts task → Shows URL → Opens browser (interactive mode)
  - Target: Starts Forge → Executes → Waits for completion → Prints JSON → Exits
  - Flags planned:
    - Default: JSON output with full metadata (status, duration, executor, task IDs, forge_url)
    - `--raw`: Plain text output only (for simple scripts)
    - `--quiet`: Suppress startup messages
  - Architecture changes needed:
    - Silent Forge startup helper
    - Task completion polling (wait for Forge task to finish)
    - Output extraction from executor logs
    - Structured JSON response format

**Architecture Notes:**
- Forge backend dependency: Both modes require Forge running (`localhost:8887`)
- Forge lifecycle: Auto-starts if down (2s typical), stays running between commands
- Current `genie run` opens browser (interactive) - new mode will be headless by default
- Serverless feasibility: LOW (Forge manages local git worktrees, executor processes, requires filesystem access)
