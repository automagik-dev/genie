# Group D: Task Monitoring & Unified `genie run` - Implementation Status

**Task Attempt ID:** `665e1f3d-9d65-419b-909f-59f610dcc8ed`
**Branch:** `forge/665e-group-d-task-mon`
**Date:** 2025-11-14
**Status:** ✅ Core Implementation Complete (Testing Pending)

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

## Pending Work

### 1. ⏳ State File Renaming
**Task:** Rename `.genie/.session` → `.genie/.tasks`

**Files to Update:**
- `src/cli/lib/service-config.ts` - Session/tasks path configuration
- `src/cli/lib/session-service.ts` - File references
- All files that read/write session state

**Command to Find References:**
```bash
grep -rn "\.session" src/cli --include="*.ts"
```

### 2. ⏳ Testing & Validation
**Required Tests:**

**A. Browser Opening Test**
```bash
# Test: Browser should open automatically
genie run master "Test browser opening"
# Expected: Browser opens to Forge task view
```

**B. WebSocket Monitoring Test**
```bash
# Test: WebSocket connection and completion detection
genie run master "Quick test task"
# Expected: Live monitoring, JSON output on completion
```

**C. Headless Task Test**
```bash
# Test: Immediate return, no browser
genie task code "Headless test"
# Expected: JSON with task_id, no browser opening
```

**D. Comparison Test**
```bash
# Test: Side-by-side behavior differences
genie run master "Test 1" > run-output.json &
genie task master "Test 2" > task-output.json
diff run-output.json task-output.json
# Expected: Different behavior (browser vs headless)
```

### 3. ⏳ Validation Evidence
**Directory:** `.genie/wishes/424-taxonomy-refactor/qa/group-d/`

**Files to Create:**
- `browser-test.log` - Manual browser opening test results
- `monitoring-test.log` - WebSocket completion detection logs
- `json-output-sample.json` - Example JSON output from `run` command
- `comparison-test.log` - Side-by-side `run` vs `task` test

## Success Criteria from Wish

- [x] `src/cli/lib/task-monitor.ts` created
- [x] `src/cli/commands/run.ts` implemented (browser + monitoring)
- [x] `src/cli/commands/task.ts` implemented (headless)
- [x] CLI commands registered (`genie run`, `genie task`)
- [x] Project builds successfully
- [ ] WebSocket streaming tested and working
- [ ] State file renamed (`.session` → `.tasks`)
- [ ] All references updated
- [ ] Live output displays correctly
- [ ] Completion detection works
- [ ] Validation evidence created

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

1. **Test Commands:** Run all validation tests to ensure functionality
2. **Rename State File:** Update `.session` → `.tasks` references
3. **Create Evidence:** Generate test logs and capture output samples
4. **Submit for Review:** Provide evidence for approval checkpoint

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
