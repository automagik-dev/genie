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

**Implemented (Needs Testing):**
- 🟡 **`genie run <agent> <prompt>`** - Headless JSON execution
  - Location: `.genie/cli/src/cli-core/handlers/run.ts` (modified)
  - Helpers: `.genie/cli/src/lib/headless-helpers.ts` (new)
  - Types: `.genie/cli/src/lib/types.ts` (added `raw`, `quiet` to CLIOptions)
  - Behavior:
    - Detects `--raw` or `--quiet` flags → switches to headless mode
    - Ensures Forge running (silent if `--quiet`)
    - Creates session, waits for completion (polling every 1s, 5min timeout)
    - Outputs JSON (default) or raw text (`--raw`)
    - Sets exit code 0 (success) or 1 (failure)
  - Flags:
    - Default: JSON output with metadata (status, duration, executor, model, task_id, attempt_id, forge_url, timestamp)
    - `--raw`: Plain text output only
    - `--quiet`: Suppress Forge startup messages
  - **Known Issues (BLOCKER for production use):**
    1. 🔴 **extractFinalOutput() too naive** - Just returns last line of logs
       - Problem: Forge logs contain tool calls, status markers, debugging output
       - Last line might be `"[INFO] Session ended"` not agent response
       - Need to inspect actual Forge log format and parse correctly
    2. 🟡 **process.exit() kills immediately** - Should set `process.exitCode` and return
    3. 🟡 **Forge startup inconsistency** - Interactive mode doesn't call `ensureForgeRunning()`

**Architecture Notes:**
- Forge backend dependency: Both modes require Forge running (`localhost:8887`)
- Forge executor logs: `listExecutionProcesses(attemptId)` returns array with `.output` field (format unknown)
- Two log streams available: raw (stdout/stderr) and normalized (parsed) via WebSocket
- Polling pattern: Check `getTaskAttempt(id).status` every 1s until `completed|success|failed|error`
- Exit code pattern: Use `process.exitCode = N` not `process.exit(N)` (matches genie.ts main handler)
- Serverless feasibility: LOW (Forge manages local git worktrees, executor processes, requires filesystem access)
