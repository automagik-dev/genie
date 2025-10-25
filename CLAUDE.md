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

---

# Session Context (2025-10-25)

## Routing Optimization & Version Unification

**GitHub Issue:** [#260 - Unify version tracking and optimize genie routing architecture](https://github.com/namastexlabs/automagik-genie/issues/260)

### Unified Backup System

**Implemented:**
- ✅ Single `backupGenieDirectory()` function in `.genie/cli/src/lib/fs-utils.ts`
- ✅ Backup only for `old_genie` installations (pre-version-tracking repos)
- ✅ `genie update` simplified to npm-only (no backups)
- ✅ Reports/wishes created blank during install (not blacklisted)

**Behavior:**
```typescript
backupGenieDirectory(workspacePath, reason: 'old_genie' | 'pre_rollback')
```
- Creates timestamped backup at `.genie/backups/<timestamp>/`
- Backs up entire .genie directory + root docs (AGENTS.md, CLAUDE.md, CORE_AGENTS.md)
- Returns backup ID for tracking
- Used by: init.ts (old genie only), rollback.ts (pre-restore safety)

**Files Modified:**
- `.genie/cli/src/lib/fs-utils.ts` - Added unified backup function
- `.genie/cli/src/commands/init.ts` - Uses unified backup, creates blank reports/wishes
- `.genie/cli/src/commands/update.ts` - Simplified to npm-only (150 lines, down from 326)
- `.genie/cli/src/commands/rollback.ts` - Uses unified backup
- `.genie/cli/src/lib/upgrade/merge-strategy.ts` - Marked deprecated

### Version Tracking Unification (Planned)

**Current State (DUAL FILES - CONFUSING):**
```
.genie/state/version.json (committed)          # Simple version tracking
.genie/.framework-version (gitignored)         # Rich metadata (underutilized)
```

**Proposed State (UNIFIED - SIMPLE):**
```typescript
// .genie/state/version.json (committed, single source of truth)
interface GenieVersion {
  version: string;              // e.g., "2.5.0-rc.58"
  installedAt: string;          // ISO timestamp
  updatedAt: string;            // ISO timestamp
  commit: string;               // Git SHA (merged from .framework-version)
  packageName: string;          // "automagik-genie"
  customizedFiles: string[];    // User modifications tracking
  deletedFiles: string[];       // User deletions tracking
  lastUpgrade: string | null;   // Last upgrade timestamp
  previousVersion: string | null;
  upgradeHistory: Array<{
    from: string;
    to: string;
    date: string;
    success: boolean;
  }>;
}
```

### Routing Architecture Issues

**Issue 1: Forge Starts Before Version Check**
- Current: `smartRouter()` → Start Forge → Check version → Maybe init
- Problem: Wastes resources starting Forge for outdated installations
- Fix: Check version FIRST, then start Forge only if needed
- Location: `.genie/cli/src/genie-cli.ts:404-450`

**Issue 2: Update Command Doesn't Check Forge Status**
- Current: `genie update` → Update npm → "Run genie to start" → Exit
- Problem: Doesn't check if Forge already running
- Fix: After update, check Forge status and prompt:
  - If running: "Forge running. Restart genie for workspace upgrade."
  - If not: "Start genie now? [Y/n]"
- Location: `.genie/cli/src/commands/update.ts`

**Issue 3: Dual Version Files (Confusion)**
- Current: Reads `.framework-version` (if exists) else `version.json`
- Problem: Two sources of truth, inconsistent state
- Fix: Merge into single `version.json` with rich metadata
- Location: `.genie/cli/src/genie-cli.ts:889-895`

**Issue 4: Terminology Inconsistency**
- Current: "update" used for both npm package AND workspace
- Problem: User confusion about what's being updated
- Fix: Clear terminology:
  - **PACKAGE UPDATE** = npm binary updated (`genie update`)
  - **WORKSPACE UPGRADE** = .genie/ templates synced (auto-detected by `genie`)

### Implementation Plan

**Phase 1: Unified Version Schema** (Next)
- Merge `.framework-version` enhancements into `version.json`
- Update init.ts to write unified schema
- Update all readers (genie-cli.ts, update.ts, migrate.ts)

**Phase 2: Smart Router Optimization**
- Reorder: Check version FIRST (before Forge startup)
- Consolidate redundant version checks
- Implement optimized flow

**Phase 3: Update Command Enhancement**
- Add Forge status detection
- Prompt "Start genie now? [Y/n]" if not running
- Show appropriate message if already running

**Phase 4: Cleanup**
- Delete deprecated upgrade/* code
- Remove unused imports
- Update tests

**Architecture Reference:**
- See `/tmp/genie-routing-analysis.md` for complete routing flow map
- See `/tmp/genie-routing-diagram.txt` for visual diagrams
- See GitHub issue #260 for full implementation details
