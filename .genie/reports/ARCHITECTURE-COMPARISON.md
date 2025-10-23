# Genie vs Forge Executor Architecture Comparison
## Current Architecture (Genie - BUGGY)

```
┌─────────────────────────────────────────────────────────────────┐
│  USER: npx automagik-genie run implementor "build feature X"    │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  GENIE CLI (genie.ts)                                           │
│  - Parse command                                                │
│  - Create session entry (sessionId = UUID)                      │
│  - Save to sessions.json                                        │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  BACKGROUND LAUNCHER (background-launcher.ts)                   │
│  - backgroundManager.launch() → spawn(genie.js, args)           │
│  - Background process starts                                    │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  POLLING LOOP (60s timeout, 500ms-5s intervals)                 │
│                                                                  │
│  const pollStart = Date.now();                                  │
│  while (Date.now() - pollStart < 60000) {                       │
│    await sleep(pollInterval);                                   │
│    const liveStore = loadSessions(...);                         │
│    const liveEntry = liveStore.sessions[sessionId];             │
│                                                                  │
│    if (liveEntry?.sessionId) {                                  │
│      ✅ SUCCESS - session ID appeared                           │
│      return true;                                               │
│    }                                                             │
│                                                                  │
│    pollInterval = Math.min(pollInterval * 1.5, 5000);           │
│  }                                                               │
│                                                                  │
│  ❌ TIMEOUT - session might appear 1ms later                    │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  DUAL STATE TRACKING (Sync Issues)                              │
│                                                                  │
│  ┌────────────────────┐    ┌─────────────────────┐             │
│  │  sessions.json     │    │ SESSION-STATE.md    │             │
│  │  (runtime state)   │◄──►│ (human-readable)    │             │
│  │                    │    │                     │             │
│  │  {                 │    │ ## Active Sessions  │             │
│  │    "uuid-123": {   │    │ - Task #1: uuid-123 │             │
│  │      "agent": ...  │    │ - Task #2: uuid-456 │             │
│  │    }               │    │                     │             │
│  │  }                 │    │                     │             │
│  └────────────────────┘    └─────────────────────┘             │
│                                                                  │
│  ⚠️ Synchronization issues possible                             │
└─────────────────────────────────────────────────────────────────┘

PROBLEMS:
❌ Race condition: 60s timeout vs async session creation
❌ Inefficient: Polling every 500ms-5s (not real-time)
❌ Complex: Fork/exec + PID tracking + dual state
❌ Unreliable: Timeout increased from 20s → 60s (band-aid)
❌ No recovery: Process crash = manual restart
```

---

## Proposed Architecture (Forge - ROBUST)

```
┌─────────────────────────────────────────────────────────────────┐
│  USER: npx automagik-genie run implementor "build feature X"    │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  GENIE CLI (genie.ts)                                           │
│  - Parse command                                                │
│  - Call ForgeClient API (no forking)                            │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  FORGE CLIENT (forge.ts)                                        │
│                                                                  │
│  const attempt = await forge.createAndStartTask(projectId, {    │
│    title: "implementor - build feature X",                      │
│    description: "...",                                           │
│    executor_profile_id: 'CLAUDE_CODE',                          │
│    base_branch: 'main'                                           │
│  });                                                             │
│                                                                  │
│  ✅ GUARANTEED: attempt.id exists or API throws error           │
│  ⏱️  Latency: < 500ms (synchronous request-response)            │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  FORGE BACKEND (Single Source of Truth)                         │
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐    │
│  │  WORKTREE ISOLATION                                     │    │
│  │                                                         │    │
│  │  /var/tmp/automagik-forge/worktrees/                   │    │
│  │  ├── abc1-wish-feature-x/   ← Task Attempt #1          │    │
│  │  ├── def2-wish-feature-y/   ← Task Attempt #2          │    │
│  │  └── ghi3-wish-feature-z/   ← Task Attempt #3          │    │
│  │                                                         │    │
│  │  ✅ Zero collision (filesystem primitives)             │    │
│  │  ✅ Parallel execution (10+ tasks proven)              │    │
│  └────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐    │
│  │  TASK HIERARCHY (Single Source of Truth)               │    │
│  │                                                         │    │
│  │  Project                                                │    │
│  │   └─ Task (like GitHub issue)                          │    │
│  │       └─ Task Attempt (execution instance)             │    │
│  │           └─ Execution Process (running agent)         │    │
│  │                                                         │    │
│  │  ✅ All state persisted in backend DB                  │    │
│  │  ✅ No dual tracking                                   │    │
│  └────────────────────────────────────────────────────────┘    │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  REAL-TIME STREAMING (WebSocket)                                │
│                                                                  │
│  const logsUrl = forge.getRawLogsStreamUrl(processId);          │
│  const ws = new WebSocket(logsUrl);                             │
│                                                                  │
│  ws.onmessage = (event) => {                                    │
│    process.stdout.write(event.data); // < 100ms latency         │
│  };                                                              │
│                                                                  │
│  ✅ Real-time logs (not polling)                                │
│  ✅ Live diffs as files change                                  │
│  ✅ Structured events (not text parsing)                        │
└─────────────────────────────────────────────────────────────────┘

BENEFITS:
✅ No race conditions: Synchronous API response
✅ Real-time: WebSocket streaming (< 100ms latency)
✅ Simple: No forking, no polling, no dual state
✅ Reliable: Proven with 10+ parallel tasks
✅ Recoverable: Backend manages process lifecycle
```

---

## Side-by-Side Flow Comparison

### Session Creation

```
┌─────────────────────────┐   ┌─────────────────────────┐
│  GENIE (CURRENT)        │   │  FORGE (PROPOSED)       │
├─────────────────────────┤   ├─────────────────────────┤
│                         │   │                         │
│  1. Parse command       │   │  1. Parse command       │
│  2. Create UUID         │   │  2. Call API            │
│  3. Save sessions.json  │   │  3. Get attempt.id      │
│  4. Fork process        │   │  4. Done ✅             │
│  5. Start polling       │   │                         │
│  6. Wait 500ms-60s      │   │  Time: < 500ms          │
│  7. Check sessions.json │   │                         │
│  8. Repeat until ID     │   │                         │
│  9. Timeout or success  │   │                         │
│                         │   │                         │
│  Time: 500ms-60s ❌     │   │                         │
└─────────────────────────┘   └─────────────────────────┘
```

### Log Viewing

```
┌─────────────────────────┐   ┌─────────────────────────┐
│  GENIE (CURRENT)        │   │  FORGE (PROPOSED)       │
├─────────────────────────┤   ├─────────────────────────┤
│                         │   │                         │
│  1. Find log file       │   │  1. Get processId       │
│  2. tail -f file        │   │  2. Open WebSocket      │
│  3. Poll every 100ms    │   │  3. Stream logs         │
│  4. Parse ANSI codes    │   │  4. Done ✅             │
│                         │   │                         │
│  Latency: ~1s ❌        │   │  Latency: < 100ms ✅    │
└─────────────────────────┘   └─────────────────────────┘
```

### Session Resume

```
┌─────────────────────────┐   ┌─────────────────────────┐
│  GENIE (CURRENT)        │   │  FORGE (PROPOSED)       │
├─────────────────────────┤   ├─────────────────────────┤
│                         │   │                         │
│  1. Load sessions.json  │   │  1. Call followUp API   │
│  2. Find sessionId      │   │  2. Done ✅             │
│  3. Check if alive      │   │                         │
│  4. Fork new process    │   │  Time: < 500ms          │
│  5. Start polling       │   │                         │
│  6. Wait for ID         │   │                         │
│                         │   │                         │
│  Time: 1-60s ❌         │   │                         │
└─────────────────────────┘   └─────────────────────────┘
```

---

## State Management Comparison

### Genie (Current) - Dual Tracking

```
┌────────────────────────────────────────────────────────┐
│  sessions.json (Runtime State)                         │
│                                                        │
│  {                                                     │
│    "version": 2,                                       │
│    "sessions": {                                       │
│      "uuid-abc-123": {                                 │
│        "agent": "implementor",                         │
│        "status": "running",                            │
│        "runnerPid": 12345,                             │
│        "executorPid": 12346,                           │
│        "logFile": "/path/to/log"                       │
│      }                                                 │
│    }                                                   │
│  }                                                     │
└────────────────────────────────────────────────────────┘
                       ↕️ (Manual sync)
┌────────────────────────────────────────────────────────┐
│  SESSION-STATE.md (Human-Readable)                     │
│                                                        │
│  ## Active Sessions                                    │
│  - Task #1: uuid-abc-123 (implementor)                │
│    - Status: Running                                   │
│    - PID: 12345                                        │
│                                                        │
│  ⚠️ Sync issues possible                              │
└────────────────────────────────────────────────────────┘
```

### Forge (Proposed) - Single Source

```
┌────────────────────────────────────────────────────────┐
│  Forge Backend (API Queries)                           │
│                                                        │
│  GET /api/task-attempts/{id}                           │
│  {                                                     │
│    "id": "attempt-123",                                │
│    "task": { "id": "task-456", "title": "..." },       │
│    "status": "running",                                │
│    "executor_profile_id": "CLAUDE_CODE",               │
│    "worktree_path": "/var/tmp/.../abc1-wish-x/",       │
│    "branch_name": "forge/abc1-wish-x",                 │
│    "created_at": "2025-10-18T...",                     │
│    "updated_at": "2025-10-18T..."                      │
│  }                                                     │
│                                                        │
│  ✅ Single source of truth                            │
│  ✅ No sync issues                                    │
│  ✅ Full history preserved                            │
└────────────────────────────────────────────────────────┘
                       ↓ (Optional cache)
┌────────────────────────────────────────────────────────┐
│  SESSION-STATE.md (Optional Human View)                │
│                                                        │
│  ## Active Sessions                                    │
│  - Task #1: attempt-123 (implementor)                 │
│    - Forge URL: /task-attempts/attempt-123            │
│                                                        │
│  (Generated from Forge API, not authoritative)         │
└────────────────────────────────────────────────────────┘
```

---

## Error Handling Comparison

### Genie (Current)

```
❌ Failure Mode 1: Fork fails
  → spawn() throws error
  → No retry, manual restart

❌ Failure Mode 2: Polling timeout
  → Session ID doesn't appear in 60s
  → Could be race condition or actual failure
  → Manual investigation required

❌ Failure Mode 3: State corruption
  → sessions.json malformed
  → SESSION-STATE.md out of sync
  → Manual repair required
```

### Forge (Proposed)

```
✅ Failure Mode 1: API request fails
  → Clear error message from backend
  → Automatic retry (if transient)
  → Fallback to legacy executor (if backend down)

✅ No polling timeouts
  → Synchronous request-response
  → Either succeeds or fails immediately

✅ No state corruption
  → Forge backend is single source of truth
  → Backend handles all persistence
```

---

## Performance Comparison

| Operation | Genie (Current) | Forge (Proposed) | Improvement |
|-----------|----------------|------------------|-------------|
| Create session | 500ms-60s | < 500ms | **Up to 120x** |
| Resume session | 1-60s | < 500ms | **Up to 120x** |
| View logs | ~1s (polling) | < 100ms (WebSocket) | **10x** |
| Stop session | < 100ms | < 100ms | Same |
| List sessions | < 10ms (file I/O) | < 100ms (HTTP) | Comparable |

---

## Code Complexity Comparison

### Genie (Current) - ~500 lines

```
background-launcher.ts     125 lines  ❌ DELETE
background-manager.ts      153 lines  ❌ DELETE
Session polling logic       40 lines  ❌ DELETE
Dual state tracking         80 lines  ❌ DELETE
Session store migration    100 lines  ✂️  SIMPLIFY
                          ─────────
                           ~500 lines
```

### Forge (Proposed) - ~50 lines

```typescript
// forge-executor.ts (~50 lines)

export class ForgeExecutor {
  private forge: ForgeClient;

  async createSession(agentName: string, prompt: string) {
    const attempt = await this.forge.createAndStartTask(projectId, {
      title: agentName,
      description: prompt,
      executor_profile_id: 'CLAUDE_CODE',
      base_branch: 'main'
    });
    return attempt.id; // GUARANTEED
  }

  async resumeSession(sessionId: string, prompt: string) {
    await this.forge.followUpTaskAttempt(sessionId, prompt);
  }

  async stopSession(sessionId: string) {
    await this.forge.stopTaskAttemptExecution(sessionId);
  }

  streamLogs(processId: string) {
    const url = this.forge.getRawLogsStreamUrl(processId);
    return new WebSocket(url);
  }
}
```

**Code Reduction:** 90% less code (500 → 50 lines)

---

## Conclusion

**Current (Genie):** Complex, buggy, unreliable
**Proposed (Forge):** Simple, robust, proven

**Recommendation:** ✅ PROCEED WITH FORGE INTEGRATION

---

**Next:** Review detailed analysis in `FORGE-VS-GENIE-EXECUTOR-ANALYSIS.md`
