# 🧞 CLI Headless Execution Mode

**Status:** DRAFT
**GitHub Issue:** TBD
**Roadmap Item:** CLI – User Experience Improvements
**Mission Link:** @.genie/product/mission.md §CLI Interface

## Vision

Enable `genie run` to execute agents in headless mode for automation and scripting:
- Silent Forge startup (no interactive prompts)
- Task completion polling (wait for agent to finish)
- Structured JSON output (status, duration, executor, task IDs)
- Exit codes for CI/CD integration (0 = success, 1 = failure)
- Raw text mode for simple scripts (`--raw` flag)

## Current State

**Two Execution Modes:**
1. **Interactive** (current default): `genie run agent "prompt"` → Opens browser
2. **Headless** (new): `genie run agent "prompt" --quiet` → JSON output

**Implementation Status:**
- ✅ `genie talk <agent>` - Interactive browser session (committed: 10334ed7)
- 🟡 `genie run --raw --quiet` - Headless JSON mode (implemented, needs testing)

## Implementation Complete

**Files Modified:**
- `.genie/cli/src/genie-cli.ts` - Added `--raw`, `--quiet` flags to run command
- `.genie/cli/src/cli-core/handlers/run.ts` - Headless mode detection and execution
- `.genie/cli/src/lib/types.ts` - Added `raw?: boolean`, `quiet?: boolean` to CLIOptions
- `.genie/cli/src/genie.ts` - Fixed import path for talk command (`.js` extension)

**Files Created:**
- `.genie/cli/src/lib/headless-helpers.ts` - Core utilities:
  - `ensureForgeRunning(quiet)` - Silent Forge startup
  - `waitForTaskCompletion(attemptId, executor, maxWaitMs)` - Polling loop
  - `extractFinalOutput(logs)` - Extract agent response from logs
  - `RunResult` interface - JSON output schema

- `.genie/cli/src/commands/talk.ts` - Interactive talk command (135 lines)

**Behavior:**
```bash
# Interactive mode (default, unchanged)
genie run explore "analyze codebase"
→ Opens Forge dashboard in browser

# Headless JSON mode
genie run explore "analyze codebase" --quiet
→ {
  "agent": "explore",
  "status": "completed",
  "output": "agent's response here",
  "duration_ms": 2547,
  "executor": "opencode/DEFAULT",
  "model": "claude-sonnet-4",
  "task_id": "...",
  "attempt_id": "...",
  "forge_url": "http://localhost:8887/...",
  "timestamp": "2025-10-24T19:30:00.000Z"
}

# Raw text mode (for scripts)
genie run explore "say hello" --raw
→ Hello! How can I help you today?

# Both flags (silent + raw)
genie run explore "say hello" --raw --quiet
→ Hello! How can I help you today?
```

## Known Issues (BLOCKERS)

### 🔴 Issue 1: extractFinalOutput() Too Naive

**Problem:**
```typescript
export function extractFinalOutput(logs: string | null): string {
  const lines = logs.trim().split('\n').filter(l => l.trim());
  return lines[lines.length - 1] || '(no output)';  // ❌ Just last line!
}
```

**What's Wrong:**
- Forge executor logs contain tool calls, status updates, debugging output
- Last line might be `"[INFO] Session ended"` not actual agent response
- No parsing of structured log format

**Root Cause:**
- `ForgeExecutor.fetchLatestLogs()` returns `latest.output` from `/api/execution-processes`
- We don't know the actual format of this field
- Could be: raw stdout/stderr, JSON lines, mixed format

**Forge Log Streams Available:**
- `getRawLogsStreamUrl(processId)` - WebSocket raw stdout/stderr
- `getNormalizedLogsStreamUrl(processId)` - WebSocket parsed/structured

**Fix Options:**
1. **Test empirically** - Run actual task, inspect log format, parse correctly
2. **Use WebSocket streams** - Connect to normalized logs (more reliable but complex)
3. **Conservative parsing** - Filter log markers, look for assistant messages

**Recommendation:**
```typescript
export function extractFinalOutput(logs: string | null): string {
  if (!logs) return '(no output)';

  // Remove common log prefixes and markers
  const lines = logs.trim().split('\n')
    .filter(l => l.trim())
    .filter(l => !l.match(/^\[(INFO|DEBUG|WARN|ERROR)\]/));

  if (lines.length === 0) return '(no output)';

  // Try to find assistant/response markers
  const assistantLines = lines.filter(l =>
    l.includes('Assistant:') ||
    l.includes('Response:') ||
    !l.startsWith('[')  // Non-bracketed = usually content
  );

  return assistantLines.length > 0
    ? assistantLines.join('\n')
    : lines[lines.length - 1] || '(no output)';
}
```

**Still needs:** Real Forge log inspection to refine heuristics.

### 🟡 Issue 2: process.exit() Kills Immediately

**Problem:**
```typescript
// headless-helpers.ts:109
process.exit(result.status === 'completed' ? 0 : 1);  // ❌ Immediate kill
```

**What's Wrong:**
- Bypasses cleanup in `genie.ts` main handler
- No graceful shutdown
- Prevents error handling in parent context

**Fix:**
```typescript
// Set exit code, return to handler
process.exitCode = result.status === 'completed' ? 0 : 1;
return;  // Let genie.ts finish normally
```

**Pattern elsewhere:**
- `genie.ts:127` - `process.exitCode = 1` (correct pattern)
- Most commands set `exitCode` not `exit()`

### 🟡 Issue 3: Forge Startup Inconsistency

**Problem:**
```typescript
// Headless mode: ✅ Explicit check
if (isHeadless) {
  await ensureForgeRunning(isQuiet);
}

// Interactive mode: ❌ Assumes running
const forgeExecutor = createForgeExecutor();
await forgeExecutor.syncProfiles();  // Fails if Forge down
```

**Fix:**
```typescript
// ALWAYS ensure Forge running (both modes)
await ensureForgeRunning(parsed.options.quiet || false);

const forgeExecutor = createForgeExecutor();
await forgeExecutor.syncProfiles();  // Now safe
```

## Testing Plan

**Unit Tests:**
- `extractFinalOutput()` with various log formats
- `waitForTaskCompletion()` timeout handling
- `ensureForgeRunning()` already-running case

**Integration Tests:**
1. Start Forge, run `genie run explore "hello" --raw`
2. Check output is clean text (no log markers)
3. Check exit code = 0
4. Stop Forge, run same command
5. Check Forge auto-starts silently
6. Run with `--quiet`, check no startup messages

**Manual QA:**
```bash
# Test 1: Raw output mode
genie run explore "just say hello back" --raw
→ Expected: "hello back" (clean text)

# Test 2: JSON output mode
genie run explore "say hello" --quiet
→ Expected: Valid JSON with status="completed"

# Test 3: Failed task
genie run fix "break everything" --quiet
→ Expected: JSON with status="failed", exit code = 1

# Test 4: Forge auto-start
pkill -f forge  # Kill Forge
genie run explore "hello" --quiet
→ Expected: Forge starts silently, task executes

# Test 5: Timeout
genie run explore "sleep 1000" --quiet
→ Expected: JSON with status="timeout" after 5 minutes
```

## Completion Criteria

**Must Fix Before Merge:**
- 🔴 extractFinalOutput() parsing (test with real logs, refine heuristics)
- 🟡 Replace process.exit() with process.exitCode
- 🟡 Call ensureForgeRunning() in all cases

**Documentation:**
- Update CLI help text for run command
- Add examples to README.md
- Document JSON output schema

**Evidence Required:**
- Manual test output (all 5 scenarios above)
- Screenshot of JSON output
- CI/CD integration example (GitHub Actions)

## Future Enhancements (Out of Scope)

- WebSocket log streaming for real-time progress
- `--format` flag for custom output (YAML, CSV, etc.)
- `--timeout` flag to override 5min default
- `--follow` flag to stream logs instead of wait
- `--async` flag to start task and exit immediately (return task ID)

## References

- Forge API: `/api/execution-processes?task_attempt_id={id}`
- Log streams: `forge.js:840-858` (WebSocket URLs)
- Exit code pattern: `genie.ts:124-128`
- ForgeExecutor: `.genie/cli/src/lib/forge-executor.ts`

## Related Work

- Wish #244 - Genie Orchestration Intelligence (MCP tools for Forge)
- Commit 10334ed7 - `genie talk` command implementation
