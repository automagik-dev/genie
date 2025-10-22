# Forge vs Genie Executor: Comprehensive Analysis
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Date:** 2025-10-18
**Objective:** Validate ForgeClient API as replacement for Genie's background executor
**Status:** Investigation Complete - Ready for Implementation

---

## Executive Summary

**Recommendation:** ✅ **Replace Genie's background-launcher.ts with Forge's ForgeClient API**

**Impact:**
- 🔥 **Code Deletion:** ~400-500 lines eliminated (background-launcher.ts, background-manager.ts, polling logic)
- ⚡ **Performance:** Polling (500ms-5s) → Real-time WebSocket streaming (milliseconds)
- 🛡️ **Reliability:** Timeout race conditions → Guaranteed execution model
- 🎯 **Simplification:** Dual state tracking → Single source of truth (Forge backend)

---

## Current Genie Architecture (Problems)

### 1. Background Launcher Pattern (background-launcher.ts)

```typescript
// PROBLEM: Polling race condition (lines 65-118)
const pollTimeout = 60000; // 60 seconds (was 20s)
while (Date.now() - pollStart < pollTimeout) {
  await sleep(pollInterval);
  const liveStore = loadSessions(...);
  const liveEntry = liveStore.sessions?.[entry.sessionId];

  if (liveEntry?.sessionId) {
    // SUCCESS - session ID appeared
    return true;
  }

  pollInterval = Math.min(pollInterval * 1.5, 5000); // Exponential backoff
}

// TIMEOUT - session might appear milliseconds later
process.stdout.write(`\n▸ Timeout waiting for session ID\n`);
```

**Pain Points:**
- ❌ **Race condition:** If session ID appears 1ms after timeout, failure
- ❌ **Unreliable:** Timeout increased from 20s → 60s (band-aid fix)
- ❌ **Inefficient:** Polling every 500ms-5s instead of real-time notification
- ❌ **No guarantees:** Session creation may succeed but polling times out

### 2. Background Manager (background-manager.ts)

```typescript
// PROBLEM: Fork/exec pattern with manual process management
launch(options): number {
  const child = spawn(this.execPath, [scriptPath, ...rawArgs], spawnOptions);

  if (!child.pid) {
    throw new Error('Failed to spawn background process.');
  }

  this.children.set(child.pid, metadata);

  child.on('exit', (code, signal) => {
    // Manual cleanup
    this.children.delete(child.pid!);
  });

  return child.pid;
}
```

**Pain Points:**
- ❌ **Manual process management:** Track PIDs, handle exit codes, cleanup
- ❌ **No recovery:** If process crashes, no automatic restart
- ❌ **Limited visibility:** No structured logs, just PID tracking

### 3. Session Store (session-store.ts)

```typescript
// PROBLEM: Dual state tracking
export interface SessionStore {
  version: number;
  sessions: Record<string, SessionEntry>; // sessions.json
}

// ALSO: SESSION-STATE.md (human-readable)
// Synchronization issues possible
```

**Pain Points:**
- ❌ **Dual tracking:** `sessions.json` + `SESSION-STATE.md` (sync issues)
- ❌ **Migration complexity:** V1 (agent-keyed) → V2 (sessionId-keyed)
- ❌ **No history:** Overwritten on each save

### 4. Overall Architecture

```
┌─────────────────┐
│ Genie CLI       │
└────────┬────────┘
         │
         ├─ background-launcher.ts (spawn + poll)
         │   └─ backgroundManager.launch()
         │       └─ spawn(genie.js, args)
         │           └─ Background process starts
         │
         ├─ Polling loop (60s timeout, 500ms-5s intervals)
         │   └─ loadSessions() every poll
         │       └─ Check if sessionId appeared
         │
         └─ session-store.ts (sessions.json + SESSION-STATE.md)
             └─ Dual state tracking
```

**Overall Problems:**
- ❌ **3 failure modes:** Fork fail, polling timeout, session corruption
- ❌ **No real-time feedback:** Progress updates every 5 seconds only
- ❌ **Complex state management:** Multiple files, manual sync
- ❌ **Limited scalability:** Each session = new process to poll

---

## Forge Architecture (Solutions)

### 1. Unified Execution Model

```typescript
// SOLUTION: Guaranteed execution, no polling
const attempt = await forge.createTaskAttempt({
  task_id: taskId,
  executor_profile_id: 'CLAUDE_CODE',
  base_branch: 'main',
  target_branch: 'main'
});

// attempt.id is GUARANTEED to exist or API throws error
// No timeout race - synchronous confirmation
```

**Benefits:**
- ✅ **No race conditions:** Synchronous API confirmation
- ✅ **Guaranteed execution:** Either succeeds or fails immediately
- ✅ **No polling:** Request-response model, not timeout-based

### 2. Worktree Isolation

```typescript
// SOLUTION: Filesystem-level isolation (git worktrees)
// Each task attempt gets:
// - Unique worktree: /var/tmp/automagik-forge/worktrees/XXXX-YYYY/
// - Unique branch: forge/XXXX-YYYY
// - Zero collision (filesystem primitives guarantee uniqueness)
```

**Benefits:**
- ✅ **Parallel execution:** 10+ tasks run simultaneously, zero collisions
- ✅ **Clean state:** Each attempt starts with fresh worktree
- ✅ **Safe cleanup:** Delete worktree = complete cleanup

### 3. Real-Time Streaming

```typescript
// SOLUTION: WebSocket streaming (not polling)

// Raw logs (stdout/stderr)
const logsUrl = forge.getRawLogsStreamUrl(processId);
const ws = new WebSocket(logsUrl);
ws.onmessage = (event) => {
  console.log(event.data); // Real-time, milliseconds latency
};

// Normalized logs (structured)
const normalizedUrl = forge.getNormalizedLogsStreamUrl(processId);

// Live diffs
const diffUrl = forge.getTaskDiffStreamUrl(attemptId);

// Server-sent events (all updates)
const events = forge.subscribeToEvents();
```

**Benefits:**
- ✅ **Real-time feedback:** Milliseconds latency, not seconds
- ✅ **Structured logs:** Normalized format for parsing
- ✅ **Live diffs:** See file changes as they happen
- ✅ **Event-driven:** No polling overhead

### 4. Single Source of Truth

```typescript
// SOLUTION: Forge backend = single source of truth

// Projects
await forge.listProjects()
await forge.getProject(projectId)

// Tasks
await forge.listTasks(projectId)
await forge.getTask(projectId, taskId)

// Task Attempts (execution state)
await forge.listTaskAttempts(taskId)
await forge.getTaskAttempt(attemptId)

// Execution Processes (running state)
await forge.listExecutionProcesses(attemptId)
await forge.getExecutionProcess(processId)
```

**Benefits:**
- ✅ **No dual tracking:** Forge backend = canonical state
- ✅ **History preserved:** All attempts/processes stored
- ✅ **No migration complexity:** Backend handles versioning

### 5. Follow-Up Support

```typescript
// SOLUTION: Built-in conversation continuation

// Resume with new prompt
await forge.followUpTaskAttempt(attemptId, "continue with tests");

// Replace executor entirely
await forge.replaceTaskAttemptProcess(attemptId, {
  executor_profile_id: 'CLAUDE_CODE',
  prompt: "different approach"
});
```

**Benefits:**
- ✅ **Session continuity:** Resume conversations seamlessly
- ✅ **Executor switching:** Change executors mid-task
- ✅ **No session corruption:** Backend manages state

### 6. Overall Architecture

```
┌─────────────────┐
│ Genie CLI       │
└────────┬────────┘
         │
         ├─ ForgeClient API (type-safe, 80+ endpoints)
         │   └─ POST /api/task-attempts (create execution)
         │       └─ Returns attempt.id (guaranteed)
         │
         ├─ WebSocket streaming (real-time)
         │   ├─ Raw logs (stdout/stderr)
         │   ├─ Normalized logs (structured)
         │   └─ Live diffs (file changes)
         │
         └─ Forge Backend (single source of truth)
             ├─ Worktrees (isolation)
             ├─ Git branches (version control)
             └─ Task/Attempt/Process hierarchy (state management)
```

**Overall Benefits:**
- ✅ **1 failure mode:** API request fails (clear error message)
- ✅ **Real-time feedback:** WebSocket streaming (milliseconds)
- ✅ **Simple state:** Forge backend = canonical source
- ✅ **Infinite scalability:** Backend handles concurrency

---

## API Coverage Analysis

### Core Abstractions

**1. Projects** (Container for tasks)
- `listProjects()` - GET /api/projects
- `createProject()` - POST /api/projects
- `getProject(id)` - GET /api/projects/{id}
- `updateProject(id, updates)` - PUT /api/projects/{id}
- `deleteProject(id)` - DELETE /api/projects/{id}
- `listProjectBranches(id)` - GET /api/projects/{id}/branches
- `searchProjectFiles(id, query, mode)` - GET /api/projects/{id}/search
- `openProjectInEditor(id, request)` - POST /api/projects/{id}/open-editor

**2. Tasks** (Units of work)
- `listTasks(projectId)` - GET /api/projects/{projectId}/tasks
- `createTask(projectId, task)` - POST /api/projects/{projectId}/tasks
- `createAndStartTask(projectId, request)` - POST /api/projects/{projectId}/tasks/create-and-start ⭐
- `getTask(projectId, taskId)` - GET /api/projects/{projectId}/tasks/{taskId}
- `updateTask(projectId, taskId, updates)` - PUT /api/projects/{projectId}/tasks/{taskId}
- `deleteTask(projectId, taskId)` - DELETE /api/projects/{projectId}/tasks/{taskId}

**3. Task Attempts** (Execution instances)
- `listTaskAttempts(taskId)` - GET /api/task-attempts
- `createTaskAttempt(request)` - POST /api/task-attempts ⭐
- `getTaskAttempt(id)` - GET /api/task-attempts/{id}
- `followUpTaskAttempt(id, prompt)` - POST /api/task-attempts/{id}/follow-up ⭐
- `replaceTaskAttemptProcess(id, request)` - POST /api/task-attempts/{id}/replace-process
- `getTaskAttemptBranchStatus(id)` - GET /api/task-attempts/{id}/branch-status
- `rebaseTaskAttempt(id, baseBranch)` - POST /api/task-attempts/{id}/rebase
- `mergeTaskAttempt(id)` - POST /api/task-attempts/{id}/merge
- `pushTaskAttemptBranch(id)` - POST /api/task-attempts/{id}/push
- `createTaskAttemptPullRequest(id, request)` - POST /api/task-attempts/{id}/pr
- `stopTaskAttemptExecution(id)` - POST /api/task-attempts/{id}/stop

**4. Execution Processes** (Running agents)
- `listExecutionProcesses(attemptId)` - GET /api/execution-processes
- `getExecutionProcess(id)` - GET /api/execution-processes/{id}
- `stopExecutionProcess(id)` - POST /api/execution-processes/{id}/stop

**5. Real-Time Streaming** (WebSocket)
- `getTasksStreamUrl(projectId)` - WS /api/projects/{projectId}/tasks/stream/ws
- `getExecutionProcessesStreamUrl(attemptId)` - WS /api/execution-processes/stream/ws
- `getRawLogsStreamUrl(processId)` - WS /api/execution-processes/{processId}/raw-logs/ws ⭐
- `getNormalizedLogsStreamUrl(processId)` - WS /api/execution-processes/{processId}/normalized-logs/ws ⭐
- `getTaskDiffStreamUrl(attemptId, statsOnly)` - WS /api/task-attempts/{attemptId}/diff/ws
- `subscribeToEvents()` - EventSource /api/events

**6. Images** (Task screenshots/attachments)
- `uploadImage(file)` - POST /api/images/upload
- `uploadTaskImage(taskId, file)` - POST /api/images/task/{taskId}/upload
- `getImageFile(id)` - GET /api/images/{id}/file
- `getTaskImages(taskId)` - GET /api/images/task/{taskId}
- `deleteImage(id)` - DELETE /api/images/{id}

⭐ = **Critical for Genie integration**

---

## Side-by-Side Comparison

| Feature | Genie (Current) | Forge (Proposed) | Winner |
|---------|----------------|------------------|--------|
| **Execution Model** | Fork/exec + polling | API request + response | ✅ Forge |
| **Timeout Handling** | 60s polling timeout | No timeout (synchronous) | ✅ Forge |
| **Real-Time Feedback** | 5s progress updates | WebSocket (milliseconds) | ✅ Forge |
| **State Management** | sessions.json + SESSION-STATE.md | Forge backend (single source) | ✅ Forge |
| **Isolation** | Process isolation only | Worktree + branch isolation | ✅ Forge |
| **Parallel Execution** | Manual management | Built-in (proven 10+ tasks) | ✅ Forge |
| **Session Resume** | Manual session ID tracking | Built-in followUpTaskAttempt | ✅ Forge |
| **Error Recovery** | None (manual restart) | Process replacement | ✅ Forge |
| **Logs** | File-based, polling | WebSocket streaming | ✅ Forge |
| **Code Complexity** | ~500 lines (launcher + manager) | ~50 lines (ForgeClient calls) | ✅ Forge |
| **Type Safety** | Partial | Full (TypeScript) | ✅ Forge |
| **Testing** | Complex (process mocking) | Simple (API mocking) | ✅ Forge |

**Winner:** Forge wins 12/12 categories

---

## Code Deletion Opportunities

### Files to DELETE ✂️ (~400-500 lines)

1. **background-launcher.ts** (~125 lines) - **ENTIRE FILE**
   - Polling loop replaced by synchronous API calls
   - Timeout logic replaced by request-response model

2. **background-manager.ts** (~153 lines) - **ENTIRE FILE**
   - Process forking replaced by Forge backend execution
   - PID tracking replaced by attempt.id tracking

3. **Session polling logic** (~40 lines in genie.ts)
   - Replaced by real-time WebSocket streaming

4. **Dual state tracking** (~80 lines in session-store.ts)
   - SESSION-STATE.md can be simplified (Forge = source of truth)
   - sessions.json can be thin cache or removed entirely

### Files to REFACTOR ✨

1. **genie.ts** (simplified)
   - Replace CLI executor invocation with ForgeClient API calls
   - Example:

   ```typescript
   // OLD (background-launcher.ts):
   const runnerPid = backgroundManager.launch({...});
   while (Date.now() - pollStart < pollTimeout) {
     await sleep(pollInterval);
     const liveEntry = loadSessions(...).sessions[entry.sessionId];
     if (liveEntry?.sessionId) return true;
   }

   // NEW (ForgeClient):
   const attempt = await forge.createAndStartTask(projectId, {
     title: agentName,
     description: prompt,
     executor_profile_id: executorKey,
     base_branch: 'main'
   });
   console.log(`Session ID: ${attempt.id}`);
   console.log(`View: npx automagik-genie view ${attempt.id}`);
   ```

2. **MCP tools** (refactored)
   - `mcp__genie__run` → calls `forge.createAndStartTask()`
   - `mcp__genie__resume` → calls `forge.followUpTaskAttempt()`
   - `mcp__genie__view` → calls `forge.getExecutionProcess()` + WebSocket streaming
   - `mcp__genie__stop` → calls `forge.stopTaskAttemptExecution()`
   - Direct pass-through to Forge API

3. **session-store.ts** (simplified)
   - Remove dual tracking (sessions.json + SESSION-STATE.md)
   - Map Forge task attempts to Genie sessions (thin cache)
   - Or remove entirely and use Forge API directly

### Files to KEEP (Unchanged)

- Agent definitions (`.genie/agents/`)
- Workflow system
- Frontend CLI interfaces
- User authentication

**Estimated Reduction:** 40-50% of Genie executor code (400-500 lines) → 50-100 lines

---

## Automation Opportunities

### 1. Automatic Task Creation from GitHub Issues

**Current:** Manual task creation in Forge UI
**Proposed:** Genie CLI automatically creates Forge tasks from GitHub issues

```typescript
// When user runs: npx automagik-genie run implementor --issue 120
async function createFromIssue(issueNumber: number) {
  const issue = await gh.getIssue(issueNumber);

  const task = await forge.createAndStartTask(projectId, {
    title: `[ISSUE] #${issueNumber}-${slugify(issue.title)}`,
    description: issue.body,
    executor_profile_id: 'CLAUDE_CODE',
    base_branch: 'main'
  });

  // Update GitHub issue with task link
  await gh.commentOnIssue(issueNumber, `Forge task: ${task.id}`);

  return task;
}
```

### 2. Automatic PR Creation from Task Attempts

**Current:** Manual PR creation
**Proposed:** Genie CLI auto-creates PRs when task completes

```typescript
// When task attempt completes
async function autoCreatePR(attemptId: string) {
  const attempt = await forge.getTaskAttempt(attemptId);

  if (attempt.status === 'completed') {
    const pr = await forge.createTaskAttemptPullRequest(attemptId, {
      title: attempt.task.title,
      description: attempt.task.description,
      target_branch: 'main'
    });

    console.log(`PR created: ${pr.pr_url}`);
  }
}
```

### 3. Real-Time Log Streaming in CLI

**Current:** Polling log files
**Proposed:** WebSocket streaming directly in CLI

```typescript
// Live logs in terminal
async function streamLogs(processId: string) {
  const url = forge.getRawLogsStreamUrl(processId);
  const ws = new WebSocket(url);

  ws.onmessage = (event) => {
    process.stdout.write(event.data);
  };

  ws.onerror = (error) => {
    console.error('Stream error:', error);
  };
}
```

### 4. Session Resume with Context

**Current:** Manual session ID lookup
**Proposed:** Automatic context restoration

```typescript
// Resume last session for agent
async function resumeAgent(agentName: string, prompt: string) {
  // Find last attempt for this agent
  const tasks = await forge.listTasks(projectId);
  const lastTask = tasks.find(t => t.title.includes(agentName));

  if (lastTask) {
    const attempts = await forge.listTaskAttempts(lastTask.id);
    const lastAttempt = attempts[0];

    // Resume with new prompt
    await forge.followUpTaskAttempt(lastAttempt.id, prompt);
  }
}
```

### 5. Parallel Session Management

**Current:** Manual tracking of multiple sessions
**Proposed:** Forge automatically manages parallel executions

```typescript
// Launch 10 parallel tasks (like current SESSION-STATE.md example)
async function launchParallel(tasks: Array<{title: string, description: string}>) {
  const attempts = await Promise.all(
    tasks.map(task => forge.createAndStartTask(projectId, {
      ...task,
      executor_profile_id: 'CLAUDE_CODE',
      base_branch: 'main'
    }))
  );

  // Forge backend handles isolation via worktrees
  // No collision risk - proven with 10+ parallel tasks

  return attempts;
}
```

---

## Implementation Roadmap

### Phase 1: Foundation (Week 1)

**Goal:** Replace background-launcher.ts with ForgeClient API

**Tasks:**
1. Create `ForgeExecutor` class (wraps ForgeClient)
2. Implement `createSession()` → `forge.createAndStartTask()`
3. Implement `resumeSession()` → `forge.followUpTaskAttempt()`
4. Implement `stopSession()` → `forge.stopTaskAttemptExecution()`
5. Unit tests for ForgeExecutor

**Success Criteria:**
- `npx automagik-genie run implementor "task"` creates Forge task
- Session ID = Forge attempt.id
- No polling timeouts

**Estimated Effort:** 8-12 hours

### Phase 2: Real-Time Streaming (Week 2)

**Goal:** Replace polling with WebSocket streaming

**Tasks:**
1. Implement WebSocket log streaming in CLI
2. Replace file-based log polling with `getRawLogsStreamUrl()`
3. Add live diff streaming with `getTaskDiffStreamUrl()`
4. Update `view` command to use WebSocket

**Success Criteria:**
- `npx automagik-genie view <session>` streams logs in real-time
- Latency < 100ms
- Clean disconnect on Ctrl+C

**Estimated Effort:** 6-8 hours

### Phase 3: State Consolidation (Week 2-3)

**Goal:** Simplify session state management

**Tasks:**
1. Remove dual tracking (sessions.json + SESSION-STATE.md)
2. Use Forge API as single source of truth
3. Migrate existing sessions (if any)
4. Update MCP tools to use Forge API directly

**Success Criteria:**
- No sessions.json file (or thin cache only)
- SESSION-STATE.md optional (for human readability)
- All session queries go through Forge API

**Estimated Effort:** 4-6 hours

### Phase 4: Automation (Week 3)

**Goal:** Add automation opportunities

**Tasks:**
1. Auto-create tasks from GitHub issues
2. Auto-create PRs when tasks complete
3. Auto-resume sessions by agent name
4. Parallel session management

**Success Criteria:**
- `--issue 120` flag creates Forge task + links to issue
- `--auto-pr` flag creates PR on completion
- 10+ parallel sessions work without collision

**Estimated Effort:** 8-10 hours

### Phase 5: Cleanup & Documentation (Week 4)

**Goal:** Remove old code, document new architecture

**Tasks:**
1. Delete background-launcher.ts
2. Delete background-manager.ts
3. Simplify session-store.ts
4. Update documentation
5. Migration guide for users

**Success Criteria:**
- 400-500 lines deleted
- Documentation complete
- Migration guide tested

**Estimated Effort:** 4-6 hours

### Total Estimated Effort: 30-42 hours (~1 week focused work)

---

## Risk Analysis

### Low Risk ✅

1. **API Stability:** Forge API is stable (80+ endpoints, proven in production)
2. **Type Safety:** ForgeClient is fully typed (TypeScript)
3. **Backward Compatibility:** Can keep old executor as fallback during migration
4. **Testing:** ForgeClient is easier to mock/test than process spawning

### Medium Risk ⚠️

1. **Forge Backend Availability:** Depends on Forge backend being up
   - **Mitigation:** Health check before session creation, clear error messages

2. **Migration Complexity:** Existing sessions need migration
   - **Mitigation:** Auto-migration on first load, fallback to old format

3. **WebSocket Reliability:** Network issues may interrupt streams
   - **Mitigation:** Auto-reconnect, fallback to polling if WebSocket fails

### High Risk 🔴

**None identified** - Forge architecture is proven (10+ parallel tasks, zero collisions)

---

## Performance Expectations

### Current (Genie)
- Session creation: 500ms-60s (polling timeout)
- Log updates: 5-second intervals
- State queries: File I/O (sessions.json)

### Proposed (Forge)
- Session creation: < 500ms (synchronous API call)
- Log updates: Real-time WebSocket (< 100ms latency)
- State queries: HTTP API (< 100ms)

**Expected Improvement:** 10-100x faster in most scenarios

---

## Testing Strategy

### Unit Tests
- `ForgeExecutor.createSession()` → mocks `forge.createAndStartTask()`
- `ForgeExecutor.resumeSession()` → mocks `forge.followUpTaskAttempt()`
- `ForgeExecutor.stopSession()` → mocks `forge.stopTaskAttemptExecution()`

### Integration Tests
- Create real Forge task → verify attempt.id returned
- Resume real Forge session → verify followUp works
- Stream real logs → verify WebSocket connection
- Stop real execution → verify process stops

### End-to-End Tests
- Full workflow: create → resume → view logs → stop
- Parallel execution: 10 tasks simultaneously
- Error scenarios: network failure, backend down

### Performance Tests
- Session creation latency (should be < 500ms)
- WebSocket streaming latency (should be < 100ms)
- Parallel task creation (should handle 100+ tasks)

---

## Migration Plan for Existing Users

### Automatic Migration
1. On first run with new version, detect old sessions.json
2. Migrate sessions to Forge backend (create corresponding tasks)
3. Update SESSION-STATE.md with new attempt IDs
4. Backup old sessions.json as sessions.json.backup

### Manual Migration (if automatic fails)
1. Export sessions: `npx automagik-genie export-sessions`
2. Import to Forge: `npx automagik-genie import-sessions`
3. Verify: `npx automagik-genie list`

### Rollback Plan
1. Keep old executor as `--executor=legacy` flag
2. If issues, users can run: `npx automagik-genie run --executor=legacy implementor "task"`
3. Remove legacy executor after 2-3 releases (deprecation period)

---

## Conclusion

**Verdict:** ✅ **PROCEED WITH FORGE INTEGRATION**

**Key Reasons:**
1. **Eliminates race conditions:** No more polling timeouts
2. **Real-time streaming:** WebSocket latency < 100ms
3. **Code simplification:** 400-500 lines deleted
4. **Better reliability:** Proven with 10+ parallel tasks
5. **Easier testing:** API mocking vs process mocking
6. **Future-proof:** Leverage Forge's 80+ endpoints for automation

**Next Steps:**
1. Review this analysis with team
2. Approve implementation roadmap
3. Start Phase 1: Foundation (Week 1)
4. Iterate based on feedback

**Estimated Timeline:** 4 weeks to full production deployment

---

**Document Version:** 1.0
**Author:** Claude (Genie investigator)
**Review Status:** Awaiting Felipe approval
