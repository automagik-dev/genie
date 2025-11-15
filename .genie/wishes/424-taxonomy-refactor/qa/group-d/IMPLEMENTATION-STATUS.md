# Group D: Task Monitoring & Unified `genie run` - Implementation Status

**Task Attempt ID:** `665e1f3d-9d65-419b-909f-59f610dcc8ed`
**Branch:** `forge/665e-group-d-task-mon`
**Date:** 2025-11-14
**Status:** ✅ Implementation + Validation Complete (ready for final review)

## Completed Work

### 1. ✅ Task Monitor Library (`src/cli/lib/task-monitor.ts`)
**Implementation:** WebSocket-based task monitoring using Forge's normalized-logs endpoint

**Features:**
- Event-driven completion detection (no polling)
- Real-time log streaming with callbacks
- Timeout handling (default 5 minutes)
- Connection cleanup and error recovery
- JSON output formatting

**API:**
```typescript
export async function monitorTaskCompletion(
  options: TaskMonitorOptions
): Promise<TaskResult>
```

**WebSocket Endpoint:** `ws://localhost:{port}/api/tasks/{attemptId}/normalized-logs/ws`

### 2. ✅ Unified `genie run` Command (`src/cli/commands/run.ts`)
**Implementation:** Browser opening + WebSocket monitoring + JSON output

**Behavior:**
1. Creates Forge task with agent
2. Opens browser in fullscreen task view (cross-platform: macOS, Windows, Linux, WSL)
3. Attaches WebSocket monitor
4. Waits for completion (event-driven)
5. Outputs JSON with results

**Command:**
```bash
genie run <agent> "<prompt>"
```

**Output Format:**
```json
{
  "task_url": "http://localhost:3000/tasks/...",
  "result": "...",
  "status": "completed|failed|timeout",
  "duration_ms": 45230,
  "attempt_id": "..."
}
```

### 3. ✅ Headless `genie task` Command (`src/cli/commands/task.ts`)
**Implementation:** Pure headless execution (fire and forget)

**Behavior:**
1. Creates Forge task with agent
2. Returns immediately with task ID (no monitoring)
3. No browser opening
4. JSON output with task details

**Command:**
```bash
genie task <agent> "<prompt>"
```

**Output:**
```json
{
  "task_id": "...",
  "task_url": "...",
  "agent": "...",
  "executor": "...",
  "status": "started",
  "message": "Task running in background"
}
```

### 4. ✅ CLI Integration
**Files Updated:**
- `src/cli/genie.ts` - Added `task` command case (line 145-148)
- `src/cli/genie-cli.ts` - Updated command registration:
  - Simplified `run` command (removed options, focused on browser + monitoring)
  - Added `task` command (headless execution)
  - Deprecated `talk` command (redirects to `run`)
  - Added `task` to `nonBlockingCommands` list (line 233)

### 5. ✅ Build Success
Project builds successfully with new commands:
- `pnpm install` completed
- `pnpm run build` passed
- All TypeScript compilation successful

## Validation & Evidence

### 1. ✅ State File Renaming
- `.genie/.session` → `.genie/.tasks` (documented in AGENTS.md + CHANGELOG)
- `.gitignore` updated so the new file remains ephemeral
- Sample state file rewritten with task terminology for future captures

### 2. ✅ Automated Test Passes
- `pnpm test:genie` (rebuild CLI + genie smoke suite)
- `pnpm test:session-service` (TaskService concurrency + locking)
- `pnpm run build:mcp` (TypeScript compile of the MCP/WebSocket stack)

### 3. ✅ MCP Regression Suite Refreshed
- All MCP harness tests now exercise `task`, `continue_task`, and `view_task`
- `tests/mcp-live-sessions.test.js` + `tests/mcp-real-user-test.js` cover the new command flow end-to-end
- Documentation (`AGENTS.md`, `AGENTS-VOICE.md`) now instructs operators to use the updated tool names

## Success Criteria from Wish

- [x] `src/cli/lib/task-monitor.ts` created
- [x] `src/cli/commands/run.ts` implemented (browser + monitoring)
- [x] `src/cli/commands/task.ts` implemented (headless)
- [x] CLI commands registered (`genie run`, `genie task`)
- [x] Project builds successfully
- [x] WebSocket streaming tested and working (CLI monitor waits for execution, view uses normalized logs)
- [x] State file renamed (`.session` → `.tasks`)
- [x] All references updated
- [x] Live output displays correctly (JSON output validated through updated MCP tests)
- [x] Completion detection works
- [x] Validation evidence created

## Technical Notes

### WebSocket Implementation
The `task-monitor.ts` library uses the `ws` package and connects to Forge's normalized-logs WebSocket endpoint. Key features:
- Auto-cleanup on completion/timeout/error
- Message parsing (JSON and plain text)
- Status detection (completed, failed, success, error)
- Output buffering for final result

### Browser Opening
Reuses cross-platform logic from `talk.ts`:
- macOS: `open` command
- Windows: `cmd /c start`
- Linux: `xdg-open`
- WSL: `cmd.exe /c start` (detects WSL via `/proc/version`)

### Command Routing
Both commands use the existing CLI infrastructure:
- `genie-cli.ts` → `genie.ts` → command handlers
- Dynamic import for command modules
- Consistent error handling and config loading

## Next Steps

1. Hand off to the Review neuron once MCP tooling is live again (`/review @.genie/wishes/424-taxonomy-refactor/...`)
2. Monitor Forge telemetry for any regressions in Interactive `genie run` / MCP task orchestration

## Known Limitations

1. **WebSocket URL:** Currently assumes standard Forge port pattern
2. **Timeout:** Fixed 5-minute default (configurable but not exposed in CLI)
3. **Error Messages:** Could be more user-friendly
4. **Progress Indication:** No live progress bar (only status updates via callback)

## Future Enhancements

1. **Progress UI:** Add terminal progress bar for long-running tasks
2. **Task Cancellation:** Support Ctrl+C to cancel monitoring (task continues in background)
3. **Output Streaming:** Real-time log output to terminal (not just final result)
4. **Multiple Task Monitoring:** Monitor multiple tasks simultaneously
5. **Task History:** Track completed tasks and their results
