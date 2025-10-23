# Genie CLI Architecture

**Version:** v2.4.0-rc.28+
**Status:** Production (Forge Integration Active)

---

## 🎯 Overview

Automagik Genie is a universal development companion that manages AI agent sessions through a command-line interface. The architecture evolved from a file-based session manager to a Forge-backed execution system.

---

## 🏗️ System Architecture

### High-Level Components

```
┌─────────────────────────────────────────────────────────────┐
│                      Genie CLI                              │
│  (User Interface - commands: run, resume, stop, view, list) │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ├─ Forge Integration (Primary)
                 │  └─ ForgeClient → Automagik Forge Backend
                 │     ├─ Worktree isolation
                 │     ├─ Task execution
                 │     ├─ Postgres state
                 │     └─ WebSocket streaming
                 │
                 └─ Traditional Launcher (Fallback)
                    └─ background-launcher.ts
                       ├─ Process spawning
                       ├─ PID tracking
                       └─ File-based logs
```

---

## 📁 Directory Structure

```
.genie/
├── cli/                          # CLI implementation
│   ├── src/
│   │   ├── cli-core/
│   │   │   ├── handlers/         # Command handlers
│   │   │   │   ├── run.ts       # Session creation
│   │   │   │   ├── resume.ts    # Session continuation
│   │   │   │   ├── stop.ts      # Session termination
│   │   │   │   ├── view.ts      # Log viewing
│   │   │   │   └── list.ts      # Session listing
│   │   │   └── shared.ts        # Shared utilities
│   │   ├── lib/
│   │   │   ├── forge-executor.ts      # Forge integration (NEW)
│   │   │   ├── background-launcher.ts # Traditional launcher (fallback)
│   │   │   └── background-manager.ts  # PID management (fallback)
│   │   ├── session-store.ts     # Session state management
│   │   └── genie.ts             # CLI entry point
│   └── dist/                    # Compiled output
│
├── state/                       # Runtime state
│   └── agents/
│       ├── sessions.json        # Session metadata
│       ├── logs/                # CLI log files (fallback)
│       └── backups/             # Session backups
│
├── docs/                        # Documentation
│   ├── architecture.md          # This file
│   ├── forge-quick-start.md     # Forge setup guide
│   └── forge-rollback-plan.md   # Rollback procedures
│
└── evidence/                    # Validation artifacts
    └── wish-120-a-validation.md
```

---

## 🔀 Execution Modes

### Forge Mode (Primary)

**Enabled when:**
- `FORGE_BASE_URL` environment variable is set
- OR `GENIE_USE_FORGE=true`

**Characteristics:**
- ✅ Atomic session creation (<5s)
- ✅ Worktree isolation (safe parallel execution)
- ✅ Postgres-backed state (ACID guarantees)
- ✅ Native resume via `followUpTaskAttempt()` API
- ✅ WebSocket log streaming
- ✅ No PID tracking required

**Architecture:**
```
User Command
    ↓
Handler (run.ts, resume.ts, etc.)
    ↓
forge-executor.ts
    ↓
ForgeClient (API wrapper)
    ↓
Automagik Forge Backend
    ↓
Isolated Worktree + Executor Process
```

---

### Traditional Mode (Fallback)

**Enabled when:**
- `FORGE_BASE_URL` is NOT set
- OR Forge backend is unreachable

**Characteristics:**
- ⚠️ Polling-based session creation (5-20s)
- ⚠️ File-based PID tracking
- ⚠️ Shared filesystem (race conditions possible)
- ⚠️ Manual process spawning
- ✅ No external dependencies

**Architecture:**
```
User Command
    ↓
Handler (run.ts, resume.ts, etc.)
    ↓
background-launcher.ts
    ↓
Process Spawn (genie.js)
    ↓
PID tracked in sessions.json
```

---

## 🔄 Session Lifecycle

### Session Creation (Forge Mode)

```
1. User runs: genie run analyze "analyze codebase"
   ↓
2. Handler checks FORGE_BASE_URL
   ↓
3. ForgeExecutor.createSession()
   ├─ Get or create "Genie Sessions" project
   ├─ Create task: "Genie: analyze (default)"
   ├─ Call createAndStartTask() API
   └─ Return task attempt ID
   ↓
4. Save session entry
   {
     name: "analyze-2510181530",
     executor: "forge",
     sessionId: "uuid-of-task-attempt",
     status: "running"
   }
   ↓
5. Display session info to user
```

**Performance:** <5s (atomic API call)

---

### Session Resume (Forge Mode)

```
1. User runs: genie resume analyze-2510181530 "continue"
   ↓
2. Handler loads session from sessions.json
   ↓
3. Check if executor === 'forge'
   ↓
4. ForgeExecutor.resumeSession(sessionId, prompt)
   └─ Call followUpTaskAttempt(sessionId, prompt)
   ↓
5. Forge backend:
   ├─ Appends prompt to task conversation
   ├─ Resumes executor process
   └─ Streams new output
   ↓
6. User sees continuation output
```

**Advantage:** No new process spawning, native conversation continuation

---

### Session Stop (Forge Mode)

```
1. User runs: genie stop analyze-2510181530
   ↓
2. Handler loads session from sessions.json
   ↓
3. Check if executor === 'forge'
   ↓
4. ForgeExecutor.stopSession(sessionId)
   └─ Call stopTaskAttemptExecution(sessionId)
   ↓
5. Forge backend:
   ├─ Sends SIGTERM to executor process
   ├─ Updates task status to 'stopped'
   └─ Preserves logs in Postgres
   ↓
6. Update session status in sessions.json
```

**Advantage:** Graceful termination, logs preserved

---

### Session View (Forge Mode)

```
1. User runs: genie view analyze-2510181530
   ↓
2. Handler loads session from sessions.json
   ↓
3. Check if executor === 'forge'
   ↓
4. ForgeExecutor.getSessionStatus(sessionId)
   └─ Call listExecutionProcesses(sessionId)
   ↓
5. Forge backend returns:
   ├─ Process output (combined stdout/stderr)
   ├─ Execution status
   └─ Timestamps
   ↓
6. Display logs with source indicator: "Forge logs"
```

**Fallback:** If Forge fails, read from CLI log file

---

### Session List (Hybrid Mode)

```
1. User runs: genie list sessions
   ↓
2. Handler reads sessions.json
   ↓
3. Display all sessions (Forge + Traditional)
   ├─ Forge sessions: executor === 'forge'
   └─ Traditional sessions: executor === 'codex'/'claude'
   ↓
4. Sort by lastUsed (descending)
```

**Note:** Future enhancement (Wish #120-B) will query Forge for live status

---

## 🔌 Forge Integration Details

### API Endpoints Used

**Core Operations (9 endpoints):**

| Endpoint | Purpose | Used By |
|----------|---------|---------|
| `healthCheck()` | Verify Forge availability | All handlers |
| `listProjects()` | Find "Genie Sessions" project | run.ts |
| `createProject()` | Auto-create project if missing | run.ts |
| `listTasks()` | List all Genie sessions | list.ts (future) |
| `createAndStartTask()` | Create + start session (atomic) | run.ts |
| `getTaskAttempt()` | Get session status | view.ts |
| `followUpTaskAttempt()` | Resume session | resume.ts |
| `stopTaskAttemptExecution()` | Stop session | stop.ts |
| `listExecutionProcesses()` | Get logs | view.ts |

**See also:** `.genie/docs/forge-endpoint-mapping.md` for complete API documentation

---

### Forge Session Metadata

**Session entry in sessions.json (Forge mode):**
```json
{
  "name": "analyze-2510181530",
  "agent": "analyze",
  "executor": "forge",
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "running",
  "created": "2025-10-18T15:30:45.123Z",
  "lastUsed": "2025-10-18T15:30:45.123Z",
  "background": true,
  "runnerPid": null,
  "executorPid": null
}
```

**Key differences from traditional sessions:**
- `executor: "forge"` (vs `"codex"`, `"claude"`)
- `sessionId`: Forge task attempt ID (not MCP session ID)
- `runnerPid`/`executorPid`: Always null (Forge manages processes)

---

### Filesystem Restrictions (CRITICAL)

**Rule:** Genie CLI MUST NOT directly access Forge worktree filesystem

**Reason:**
- Forge manages worktree isolation
- Direct access causes race conditions
- Risk of data corruption

**Enforcement:**
- All worktree operations go through Forge API
- Pre-commit hooks block direct worktree access
- Code reviews validate API usage

**Violations fixed in Wish #120-A:**
- `view.ts`: Replaced direct log file reading with `listExecutionProcesses()` API
- `resume.ts`: Replaced process spawning with `followUpTaskAttempt()` API
- `stop.ts`: Replaced PID termination with `stopTaskAttemptExecution()` API

**See also:** `.genie/discovery/filesystem-restrictions-audit.md`

---

## 🔄 Backwards Compatibility

### Coexistence Model

Genie supports both Forge and traditional sessions simultaneously:

```javascript
// sessions.json contains BOTH types:
{
  "sessions": {
    "analyze-2510181530": {
      "executor": "forge",        // Forge-managed
      "sessionId": "uuid-1"
    },
    "debug-2510181600": {
      "executor": "codex",        // Traditional
      "sessionId": "uuid-2",
      "runnerPid": 12345
    }
  }
}
```

**Handler logic:**
```javascript
if (forgeEnabled && session.executor === 'forge') {
  // Use Forge API
  await forgeExecutor.resumeSession(sessionId, prompt);
} else {
  // Use traditional launcher
  await backgroundLauncher.spawn(sessionId, prompt);
}
```

---

### Migration Strategy

**Approach:** Hybrid (no forced migration)

**New sessions:**
- Use Forge when `FORGE_BASE_URL` is set
- Use traditional launcher otherwise

**Existing sessions:**
- Continue using their original executor
- No automatic migration required

**Manual migration:**
- Optional (via `genie migrate --execute`)
- Converts traditional sessions to Forge tasks
- Creates backups before migration

**See also:** `.genie/discovery/migration-sessions-to-forge.md`

---

## 📊 Performance Characteristics

### Session Creation

| Mode | Latency | Method | Reliability |
|------|---------|--------|-------------|
| **Forge** | <5s | Atomic API call | 100% (no timeouts) |
| **Traditional** | 5-20s | Polling (30s timeout) | ~90% (false negatives) |

---

### Parallel Session Safety

| Mode | Max Concurrent | Isolation Method | Risk |
|------|---------------|------------------|------|
| **Forge** | 10+ | Worktree isolation | ✅ Safe |
| **Traditional** | ~3 | Shared filesystem | ⚠️ Race conditions |

---

### State Persistence

| Mode | Storage | Durability | Recovery |
|------|---------|------------|----------|
| **Forge** | Postgres | ACID guarantees | ✅ Survives crashes |
| **Traditional** | sessions.json | File write | ⚠️ Corruption possible |

---

## 🐛 Bugs Eliminated (Wish #120-A)

### Before Forge Integration

1. **#115** - MCP Run Creates Multiple Sessions
   - **Cause:** Polling timeout race
   - **Impact:** Duplicate sessions in sessions.json

2. **#92** - Sessions Stuck in 'running'
   - **Cause:** PID tracking failures
   - **Impact:** Orphaned processes

3. **#91** - Sessions Missing from sessions.json
   - **Cause:** File write failures
   - **Impact:** Lost session metadata

4. **#93** - MCP Agent Start Failures
   - **Cause:** 30-second timeout insufficient
   - **Impact:** False negatives

5. **#104** - Background Launch Timeout
   - **Cause:** Polling timeout race
   - **Impact:** Session creation fails despite success

6. **#122** - UUID Reuse
   - **Cause:** Shared filesystem collisions
   - **Impact:** Session name conflicts

---

### After Forge Integration

**All bugs eliminated:**
- ✅ Atomic session creation (no duplicates)
- ✅ Postgres lifecycle management (no stuck sessions)
- ✅ ACID transactions (no missing sessions)
- ✅ No polling timeout (no false negatives)
- ✅ Atomic API (no timeout race)
- ✅ Worktree isolation (no UUID reuse)

---

## 🔧 Configuration

### Environment Variables

```bash
# Forge Integration (Primary)
export FORGE_BASE_URL="http://localhost:3000"  # Required for Forge mode
export FORGE_TOKEN="your-api-token"            # Optional (auth)
export GENIE_PROJECT_ID="uuid"                 # Optional (pre-created project)
export GENIE_USE_FORGE="true"                  # Optional (force Forge)

# Traditional Mode (Fallback)
# No configuration needed - just unset FORGE_BASE_URL
```

---

## 🧪 Testing

### Unit Tests

Located in: `tests/genie-cli.test.js`

**Coverage:**
- Session creation (Forge + Traditional)
- Session resume (Forge + Traditional)
- Session stop (Forge + Traditional)
- Session view (Forge + Traditional)
- Session list (Hybrid)

---

### Integration Tests

**Smoke tests:**
```bash
# Run all tests
pnpm run test:genie

# Forge-specific tests
export FORGE_BASE_URL="http://localhost:3000"
node .genie/cli/dist/genie.js run analyze "test"
```

---

### Stress Tests (Wish #120-A Group C)

**Parallel session creation:**
```bash
# Create 10 concurrent sessions
for i in {1..10}; do
  genie run test-$i "test $i" &
done
wait

# Validate all succeeded
genie list sessions | grep -c "test-"
```

**Expected:** All 10 sessions created successfully (Forge isolation)

---

## 📚 Related Documentation

- **Quick Start:** `.genie/docs/forge-quick-start.md`
- **Rollback Plan:** `.genie/docs/forge-rollback-plan.md`
- **API Reference:** `.genie/docs/forge-endpoint-mapping.md`
- **Implementation:** `.genie/discovery/wish-120-a-implementation-summary.md`
- **Contributing:** `CONTRIBUTING.md`

---

## 🔮 Future Enhancements

### Wish #120-B (Low-Hanging Fruits)
- PR creation automation
- Omni notifications
- Images as context
- Executor visibility

### Wish #120-C (Advanced Features)
- Templates unification
- Advanced inspection
- Migration & updating agent
- SSE automations

**See also:** `.genie/wishes/wish-120-a-forge-drop-in-replacement/`

---

**Document maintained by:** Genie Team
**Questions?** Open an issue: https://github.com/automagik-genie/genie/issues
