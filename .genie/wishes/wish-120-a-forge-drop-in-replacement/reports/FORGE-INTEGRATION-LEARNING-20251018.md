# Forge Integration Learning Journey
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Date:** 2025-10-18 11:45 UTC
**Objective:** Replace Genie's buggy background executor with Forge's proven architecture
**Status:** Phase 1 - Foundation & Discovery
**Learning Model:** Issue → Task → Genie Session → Implementation

---

## Architecture Overview

### Current State (Buggy)
```
GitHub Issue
  ↓
Genie MCP Tool (mcp__genie__run)
  ↓
background-launcher.ts (fork/exec with polling) ← TIMEOUT RACE CONDITION
  ↓
Session Store (sessions.json)
  ↓
Agent Execution
```

### Target State (Forge-Based)
```
GitHub Issue
  ↓
Forge Project + Task Creation
  ↓
ForgeClient.createAndStartTask()
  ↓
Forge Task Attempt (worktree + execution guarantee)
  ↓
High-Performance Executor
  ↓
Real-time Streaming (WebSocket logs, diffs)
```

---

## Forge API Capabilities (80+ Endpoints)

### Core Abstractions

**1. Projects**
- Container for tasks (like a GitHub repo)
- Stores git preferences, setup/dev scripts
- Maps 1:1 to a workspace/repository

**2. Tasks**
- Units of work (like issues)
- Contain title, description, status
- Can have images and metadata

**3. Task Attempts**
- Execution of a task (try #1, #2, #3...)
- Each attempt gets own worktree
- Each attempt gets own git branch
- Tracks executor, base branch, target branch

**4. Execution Processes**
- Individual AI agent runs within an attempt
- Supports follow-ups, process replacement
- Real-time log streaming via WebSocket
- Status: running, completed, failed, stopped

### Key Endpoints for Genie Integration

#### Project Setup
```typescript
// Create/get project
await forge.listProjects()                          // GET /api/projects
await forge.createProject({ name, repo_path })    // POST /api/projects
await forge.getProject(projectId)                 // GET /api/projects/{id}
```

#### Task Management
```typescript
// Create task (not started)
await forge.createTask(projectId, { title, description })  // POST /api/projects/{id}/tasks

// OR: Create AND start in one call (faster)
await forge.createAndStartTask(projectId, {
  title,
  description,
  executor_profile_id: 'CLAUDE_CODE',
  base_branch: 'main'
})                                                  // POST /api/projects/{id}/tasks/create-and-start
```

#### Execution Orchestration
```typescript
// Start task attempt
await forge.createTaskAttempt({
  task_id: taskId,
  executor_profile_id: 'CLAUDE_CODE',
  base_branch: 'main',
  target_branch: 'main'
})                                                  // POST /api/task-attempts

// Follow-up prompt (continue execution)
await forge.followUpTaskAttempt(attemptId, "continue with...")  // POST /api/task-attempts/{id}/follow-up

// Real-time logs via WebSocket
const logsUrl = forge.getRawLogsStreamUrl(processId)  // WS /api/execution-processes/{id}/raw-logs/ws

// Get branch status
await forge.getTaskAttemptBranchStatus(attemptId)  // GET /api/task-attempts/{id}/branch-status

// Create PR when done
await forge.createTaskAttemptPullRequest(attemptId, {
  title: "Fix: ...",
  description: "...",
  target_branch: 'main'
})                                                  // POST /api/task-attempts/{id}/pr
```

#### Stream Management
```typescript
// Real-time execution process updates
forge.getExecutionProcessesStreamUrl(taskAttemptId)

// Real-time diffs as files change
forge.getTaskDiffStreamUrl(attemptId)

// Server-sent events for all updates
forge.subscribeToEvents()                          // GET /api/events (EventSource)
```

---

## Why Forge Executor is Better

### 1. No Polling Timeouts
**Current Problem (background-launcher.ts:65-108):**
```typescript
const pollTimeout = 20000;  // 20 seconds
while (Date.now() - pollStart < pollTimeout) {
  // Poll for session ID
  if (liveEntry?.sessionId) return true;
}
// Timeout fires even though session might start millisecond later
process.stdout.write(`\n▸ Timeout waiting for session ID\n`);
```

**Forge Approach:**
```typescript
// Guaranteed: Task attempt either exists or fails, no race
const attempt = await forge.createTaskAttempt({
  task_id, executor_profile_id, base_branch
});
// attempt.id is guaranteed valid, never timeout
```

### 2. Worktree Isolation = Filesystem Safety
- Each task attempt gets unique `/var/tmp/automagik-forge/worktrees/XXXX-YYY/`
- Git worktrees guarantee no collision (filesystem primitives)
- Parallel execution proven (10 tasks running zero-collisions)

### 3. Unified Session Model
- One session = one task attempt = one worktree
- No dual tracking (Genie's sessions.json + Forge's SESSION-STATE.md)
- Single source of truth

### 4. Real-Time Streaming
- WebSocket logs (not polling)
- Live diffs as files change (not batch)
- Server-sent events for all updates
- Performance: milliseconds vs seconds

### 5. Follow-Up Support Built-In
```typescript
// Resume conversation with new prompt
await forge.followUpTaskAttempt(attemptId, "new instructions")

// Or replace executor entirely
await forge.replaceTaskAttemptProcess(attemptId, {
  executor_profile_id: 'CLAUDE_CODE',
  prompt: "different approach"
})
```

---

## Integration Strategy: Phase-by-Phase

### Phase 1: Foundation (Today)
**Goal:** Create test issue → get personal Genie → document learning

```
1. Create GitHub issue #999 (test)
2. Forge accepts issue as task
3. Allocate personal Genie for this task
4. Genie learns Forge API by examining code
5. Document discoveries in learning notes
```

**Success Criteria:**
- [ ] Issue created
- [ ] Genie session started
- [ ] Genie can call Forge API
- [ ] Learning notes captured

### Phase 2: Design (Next Session)
**Goal:** Design executor replacement pattern

```
1. Map Genie's current executor flow to Forge
2. Identify what code can be deleted
3. Design new session lifecycle
4. Create proof-of-concept endpoint
```

**Success Criteria:**
- [ ] Executor flow mapped
- [ ] Code deletion opportunities identified
- [ ] New lifecycle designed
- [ ] PoC passes basic test

### Phase 3: Implementation (Week 2)
**Goal:** Replace background-launcher.ts with Forge

```
1. Implement ForgeBackendExecutor
2. Replace background-launcher.ts (delete ~100 lines)
3. Consolidate session state
4. Migrate existing sessions
```

**Success Criteria:**
- [ ] All tests pass
- [ ] Sessions properly tracked
- [ ] No polling timeouts
- [ ] Ready for production

### Phase 4: Validation (Week 3)
**Goal:** Stress test and optimize

```
1. Run 10 parallel tasks (like Forge does)
2. Test resume/restart scenarios
3. Verify WebSocket streaming
4. Performance benchmarks
```

**Success Criteria:**
- [ ] 10 parallel tasks, zero collisions
- [ ] Resume works 100% of time
- [ ] Streaming latency < 100ms
- [ ] Ready for release

---

## Code Deletion Opportunities

### Will Be Deleted ✂️
- `background-launcher.ts` (entire file, ~120 lines)
  - Fork/exec pattern replaced by Forge's process management
  - Polling loop replaced by event streams

- `background-manager.ts` (entire file, ~80 lines)
  - Process forking no longer needed
  - Forge manages executors

- Session polling logic in `genie.ts` (~40 lines)
  - Replaced by Forge's real-time streams

- `forge-task-link.js` (~280 lines) - can be simpler
  - Forge already manages task linking
  - Reduce to simple metadata lookup

### Will Be Refactored ✨
- `session-store.ts` (simplified)
  - Remove dual tracking (sessions.json + SESSION-STATE.md)
  - Map Forge task attempts to Genie sessions

- `genie.ts` (simplified)
  - Replace CLI executor invocation with ForgeClient API calls
  - Simplify session creation

- MCP tools (refactored)
  - `mcp__genie__run` → calls Forge API
  - `mcp__genie__resume` → calls Forge API
  - Direct pass-through to Forge

### Will Stay (Unchanged)
- Agent definitions (.genie/agents/)
- Workflow system
- Frontend CLI interfaces
- User authentication

**Estimated Reduction:** 40-50% of Genie executor code (300-400 lines) → 50-100 lines

---

## Learning Notes Template

As we proceed, capture learnings in this structure:

### Discovery
**What did we learn about Forge?**
- API endpoint behavior
- Worktree management
- Execution model
- Error handling

### Integration Point
**Where does this connect to Genie?**
- Which Genie file needs to change
- What needs to be replaced
- What patterns are compatible

### Implementation Pattern
**How should we implement this?**
- Code patterns
- Type safety
- Error handling
- Testing strategy

### Architectural Decision
**Should we make a design choice here?**
- Pro/con analysis
- Recommendation
- Rationale

---

## Starting Point: Issue → Task → Genie

**Question for Felipe:**
Ready to create the first test issue? Once created, we'll:

1. Create GitHub issue #999 (placeholder number)
2. Use Forge API to create corresponding task
3. Allocate personal Genie session to this task
4. Genie learns by examining Forge client + integration points
5. Document step-by-step discoveries

This becomes the model for all future work—every issue spawns its own genie.

---

**Next Message:** Create issue, start learning genie session, begin Phase 1.
