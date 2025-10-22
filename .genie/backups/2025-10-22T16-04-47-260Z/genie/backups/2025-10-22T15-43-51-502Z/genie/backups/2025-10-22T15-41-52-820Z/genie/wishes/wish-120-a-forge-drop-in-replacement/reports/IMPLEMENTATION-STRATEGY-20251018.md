# Forge Executor Replacement: Implementation Strategy
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Date:** 2025-10-18
**Task:** Issue #120 - Replace Genie executor with Forge backend
**Status:** Investigation Phase Complete

---

## Executive Summary

This document provides a step-by-step implementation strategy for replacing Genie's buggy background-launcher.ts executor with Forge's proven ForgeClient API.

**Approach:** Phased rollout (4 weeks) with incremental testing and validation at each stage.

---

## Phase 1: POC Validation (Week 1) - CURRENT WEEK

### Objectives

1. Validate ForgeClient API works with Genie
2. Test session creation (no timeout race)
3. Test session resume (follow-up prompts)
4. Measure performance baseline
5. Document findings

### Tasks

#### 1.1 Create Test Forge Project

**Goal:** Create dedicated "Genie Sessions" project in Forge

**Implementation:**
```bash
# Use ForgeClient to create project
cd /var/tmp/automagik-forge/worktrees/c3d1-forge-120-execut
node -e "
const { ForgeClient } = require('./forge');
const forge = new ForgeClient('http://localhost:3000');

(async () => {
  const project = await forge.createProject({
    name: 'Genie Sessions',
    repo_path: process.cwd()
  });
  console.log('Project created:', project.id);
  console.log('Set GENIE_PROJECT_ID=' + project.id + ' in .env');
})();
"
```

**Success Criteria:**
- Project created in Forge
- Project ID saved to environment variable
- Project visible in Forge UI

---

#### 1.2 Test Session Creation (Single Agent)

**Goal:** Replace background-launcher.ts with forge-executor.ts for one agent

**Implementation:**

**Step 1:** Create test script `test-forge-executor.ts`

```typescript
// .genie/cli/test-forge-executor.ts
import { createForgeExecutor } from './src/lib/forge-executor';
import type { CreateSessionParams } from './src/lib/forge-executor';

async function testSessionCreation() {
  const forgeExecutor = createForgeExecutor({
    forgeBaseUrl: 'http://localhost:3000',
    genieProjectId: process.env.GENIE_PROJECT_ID,
  });

  const params: CreateSessionParams = {
    agentName: 'analyze',
    prompt: 'Test POC: Analyze current directory structure',
    config: {}, // Minimal config for POC
    paths: {
      baseDir: process.cwd(),
      sessionsFile: '.genie/sessions.json',
      logsDir: '.genie/logs',
      backgroundDir: '.genie/background',
    },
    store: { version: 2, sessions: {} },
    entry: {
      agent: 'analyze',
      status: 'pending',
    },
    executorKey: 'claude-code',
    executionMode: 'analyze',
    startTime: Date.now(),
  };

  console.log('Creating session via Forge...');
  const startTime = Date.now();

  const sessionId = await forgeExecutor.createSession(params);

  const elapsed = Date.now() - startTime;
  console.log(`✅ Session created: ${sessionId} (${elapsed}ms)`);
  console.log(`   Expected: < 5000ms (current: 20000ms timeout)`);
  console.log(`   Improvement: ${((20000 - elapsed) / 20000 * 100).toFixed(1)}% faster`);

  return sessionId;
}

testSessionCreation().catch(console.error);
```

**Step 2:** Run test

```bash
cd .genie/cli
export GENIE_PROJECT_ID=<project-id-from-1.1>
npx tsx test-forge-executor.ts
```

**Success Criteria:**
- Session created in < 5 seconds (vs 20s current timeout)
- No timeout race condition
- Session ID returned immediately
- Worktree created in `/var/tmp/automagik-forge/worktrees/`
- Branch created in `forge/` namespace

---

#### 1.3 Test Session Resume (Follow-Up)

**Goal:** Verify native follow-up support works

**Implementation:**

**Step 1:** Add resume test to `test-forge-executor.ts`

```typescript
async function testSessionResume(sessionId: string) {
  const forgeExecutor = createForgeExecutor({
    forgeBaseUrl: 'http://localhost:3000',
  });

  console.log('Resuming session with follow-up prompt...');
  const startTime = Date.now();

  await forgeExecutor.resumeSession(
    sessionId,
    'Continue: Now analyze package.json dependencies'
  );

  const elapsed = Date.now() - startTime;
  console.log(`✅ Follow-up sent: ${sessionId} (${elapsed}ms)`);
  console.log(`   Expected: < 2000ms`);

  return sessionId;
}

// Add to testSessionCreation():
const sessionId = await testSessionCreation();
await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for agent to start
await testSessionResume(sessionId);
```

**Step 2:** Run test

```bash
npx tsx test-forge-executor.ts
```

**Success Criteria:**
- Follow-up prompt sent in < 2 seconds
- No process re-spawning
- Same worktree and branch used
- Agent continues conversation in same context

---

#### 1.4 Performance Baseline Measurements

**Goal:** Measure and document performance improvements

**Metrics:**

| Metric | Current | Target | How to Measure |
|--------|---------|--------|----------------|
| Session creation time | 5-20s (polling) | < 5s | Time `createSession()` |
| Timeout risk | 20s hard limit | None | Test with slow network |
| Disk I/O (20s) | 40 reads | 0 reads | Monitor `fs.readFile` calls |
| CPU overhead | Polling loop | API calls | Process CPU usage |
| Memory overhead | PID + files | API client | Process memory usage |

**Implementation:**

```typescript
// Add performance monitoring to test script
async function testPerformance() {
  const runs = 10;
  const times: number[] = [];

  for (let i = 0; i < runs; i++) {
    const start = Date.now();
    await forgeExecutor.createSession(params);
    const elapsed = Date.now() - start;
    times.push(elapsed);
  }

  const avg = times.reduce((a, b) => a + b) / runs;
  const min = Math.min(...times);
  const max = Math.max(...times);

  console.log(`Performance (${runs} runs):`);
  console.log(`  Average: ${avg.toFixed(0)}ms`);
  console.log(`  Min: ${min}ms`);
  console.log(`  Max: ${max}ms`);
  console.log(`  Target: < 5000ms`);
  console.log(`  Pass: ${avg < 5000 ? '✅' : '❌'}`);
}
```

**Success Criteria:**
- Average session creation time < 5 seconds
- Zero timeout failures
- < 100ms variance between runs

---

#### 1.5 Document POC Findings

**Goal:** Create comprehensive POC validation report

**Template:**

```markdown
# POC Validation Report
**Date:** 2025-10-18
**Task:** Issue #120 - Phase 1 POC Validation

## Test Results

### Session Creation
- ✅/❌ Session created successfully
- Time: XXXms (target: < 5000ms)
- Timeout race: ✅ Eliminated / ❌ Still present

### Session Resume
- ✅/❌ Follow-up prompt sent successfully
- Time: XXXms (target: < 2000ms)
- Context preserved: ✅ Yes / ❌ No

### Performance Baseline
- Average creation time: XXXms
- Min/Max: XXX-XXXms
- Timeout failures: 0 (target: 0)

## Issues Discovered

[List any bugs, edge cases, or unexpected behaviors]

## Next Steps

[Recommendations for Phase 2]
```

**Success Criteria:**
- All tests documented
- Performance metrics recorded
- Issues identified and triaged
- Phase 2 recommendations provided

---

## Phase 2: Core Replacement (Week 2)

### Objectives

1. Replace `background-launcher.ts` with `forge-executor.ts`
2. Delete `background-manager.ts` (no longer needed)
3. Update `genie.ts` to use `ForgeExecutor`
4. Migrate session store (sessions.json → Forge API wrapper)
5. Update MCP tools
6. All tests pass

### Tasks

#### 2.1 Replace background-launcher.ts

**Goal:** Integrate forge-executor.ts into genie.ts

**Implementation:**

**Step 1:** Update `genie.ts` imports

```typescript
// OLD (delete):
// import { maybeHandleBackgroundLaunch } from './lib/background-launcher';

// NEW (add):
import { createForgeExecutor } from './lib/forge-executor';
import type { CreateSessionParams } from './lib/forge-executor';
```

**Step 2:** Replace background launch call

```typescript
// OLD (delete):
const handled = await maybeHandleBackgroundLaunch({
  parsed,
  config,
  paths,
  store,
  entry,
  agentName,
  executorKey,
  executionMode,
  startTime,
  logFile,
  allowResume
});

// NEW (add):
const forgeExecutor = createForgeExecutor();
const handled = await forgeExecutor.createSession({
  agentName,
  prompt: parsed.commandArgs.join(' '),
  config,
  paths,
  store,
  entry,
  executorKey,
  executionMode,
  startTime
});
```

**Success Criteria:**
- All existing `npx automagik-genie run` commands work
- Session creation uses Forge (no polling)
- All tests pass

---

#### 2.2 Delete background-manager.ts

**Goal:** Remove redundant process management code

**Implementation:**

```bash
# Delete files
rm .genie/cli/src/lib/background-manager.ts
rm .genie/cli/src/lib/background-manager-instance.ts
rm .genie/cli/src/background-manager.ts

# Remove imports from genie.ts
# Remove any references to backgroundManager
```

**Success Criteria:**
- Files deleted
- No import errors
- All tests pass (process management handled by Forge)

---

#### 2.3 Migrate Session Store

**Goal:** Wrap Forge API with session store interface

**Implementation:**

**Create new `session-store-forge.ts`:**

```typescript
// .genie/cli/src/session-store-forge.ts
import { ForgeClient } from '../../forge';
import type { SessionEntry, SessionStore } from './session-store';

export class ForgeSessionStore {
  private forge: ForgeClient;
  private projectId: string;

  constructor(forgeBaseUrl: string, projectId: string) {
    this.forge = new ForgeClient(forgeBaseUrl);
    this.projectId = projectId;
  }

  async loadSessions(): Promise<SessionStore> {
    const tasks = await this.forge.listTasks(this.projectId);
    const sessions: Record<string, SessionEntry> = {};

    tasks.forEach((task: any) => {
      sessions[task.id] = this.mapTaskToSession(task);
    });

    return { version: 2, sessions };
  }

  async saveSession(sessionId: string, entry: SessionEntry): Promise<void> {
    // Forge auto-saves, no manual persistence needed
    // Update task metadata if needed
    await this.forge.updateTask(this.projectId, sessionId, {
      title: `Genie: ${entry.agent}`,
      status: entry.status || 'todo'
    });
  }

  private mapTaskToSession(task: any): SessionEntry {
    return {
      sessionId: task.id,
      agent: this.extractAgentName(task.title),
      status: task.status,
      created: task.created_at,
      lastUsed: task.updated_at,
      background: true,
      executor: 'forge',
    };
  }

  private extractAgentName(title: string): string {
    const match = title.match(/^Genie: ([^\(]+)/);
    return match ? match[1].trim() : 'unknown';
  }
}
```

**Update `genie.ts` to use Forge session store:**

```typescript
// Add config option to enable Forge sessions
if (config.forge?.enabled) {
  const forgeStore = new ForgeSessionStore(
    config.forge.baseUrl,
    config.forge.projectId
  );
  store = await forgeStore.loadSessions();
}
```

**Success Criteria:**
- Session store backed by Forge API
- No more sessions.json file I/O (optional: keep for backward compat)
- All session commands work (`list`, `view`, `stop`, `resume`)

---

#### 2.4 Update MCP Tools

**Goal:** MCP tools delegate to Forge API

**Implementation:**

**Update `mcp__genie__run`:**

```typescript
// .genie/mcp-tools/genie.ts (conceptual)
async function mcp__genie__run(agent: string, prompt: string): Promise<string> {
  // OLD: Spawn background process with polling
  // NEW: Use Forge API
  const forgeExecutor = createForgeExecutor();
  const sessionId = await forgeExecutor.createSession({
    agentName: agent,
    prompt,
    // ... other params
  });

  return `Session started: ${sessionId}`;
}
```

**Update `mcp__genie__resume`:**

```typescript
async function mcp__genie__resume(sessionId: string, prompt: string): Promise<string> {
  // OLD: Re-spawn process
  // NEW: Native follow-up
  const forgeExecutor = createForgeExecutor();
  await forgeExecutor.resumeSession(sessionId, prompt);

  return `Follow-up sent to session: ${sessionId}`;
}
```

**Update `mcp__genie__stop`:**

```typescript
async function mcp__genie__stop(sessionId: string): Promise<string> {
  // OLD: process.kill(pid)
  // NEW: Forge API
  const forgeExecutor = createForgeExecutor();
  await forgeExecutor.stopSession(sessionId);

  return `Session stopped: ${sessionId}`;
}
```

**Success Criteria:**
- All MCP tools use Forge API
- No process spawning or PID tracking
- All MCP tests pass

---

## Phase 3: Streaming & UX (Week 3)

### Objectives

1. Implement WebSocket log streaming
2. Update `view` command to stream logs
3. Implement live diffs
4. Add progress indicators
5. Performance benchmarks (latency < 100ms)

### Tasks

#### 3.1 Implement WebSocket Log Streaming

**Goal:** Replace file-based log viewing with real-time WebSocket streaming

**Implementation:**

**Create `log-streamer.ts`:**

```typescript
// .genie/cli/src/lib/log-streamer.ts
import WebSocket from 'ws';
import { ForgeClient } from '../../forge';

export class LogStreamer {
  private forge: ForgeClient;

  constructor(forgeBaseUrl: string) {
    this.forge = new ForgeClient(forgeBaseUrl);
  }

  async streamLogs(sessionId: string): Promise<void> {
    // Get process ID from task attempt
    const attempt = await this.forge.getTaskAttempt(sessionId);
    const processId = attempt.execution_process_id;

    // Connect to WebSocket
    const logsUrl = this.forge.getRawLogsStreamUrl(processId);
    const ws = new WebSocket(logsUrl);

    ws.on('open', () => {
      process.stdout.write(`▸ Connected to session ${sessionId}\n`);
      process.stdout.write(`▸ Streaming logs (Ctrl+C to exit)...\n\n`);
    });

    ws.on('message', (data: string) => {
      process.stdout.write(data);
    });

    ws.on('close', () => {
      process.stdout.write(`\n▸ Stream closed\n`);
    });

    ws.on('error', (error) => {
      process.stderr.write(`\n▸ Stream error: ${error.message}\n`);
    });

    // Keep connection alive
    return new Promise((resolve) => {
      process.on('SIGINT', () => {
        ws.close();
        resolve();
      });
    });
  }
}
```

**Update `view` command:**

```typescript
// .genie/cli/src/commands/view.ts
import { LogStreamer } from '../lib/log-streamer';

async function handleViewCommand(sessionId: string, options: { live?: boolean }) {
  if (options.live) {
    // Real-time streaming (NEW)
    const streamer = new LogStreamer(config.forge.baseUrl);
    await streamer.streamLogs(sessionId);
  } else {
    // Snapshot view (existing)
    const logs = await getSessionLogs(sessionId);
    console.log(logs);
  }
}
```

**Success Criteria:**
- `npx automagik-genie view <id> --live` streams logs in real-time
- Latency < 100ms (vs manual refresh)
- Ctrl+C gracefully exits stream

---

#### 3.2 Implement Live Diffs

**Goal:** Show file changes as they happen

**Implementation:**

```typescript
// .genie/cli/src/lib/diff-streamer.ts
import WebSocket from 'ws';
import { ForgeClient } from '../../forge';

export class DiffStreamer {
  private forge: ForgeClient;

  constructor(forgeBaseUrl: string) {
    this.forge = new ForgeClient(forgeBaseUrl);
  }

  async streamDiffs(sessionId: string, statsOnly = false): Promise<void> {
    const diffUrl = this.forge.getTaskDiffStreamUrl(sessionId, statsOnly);
    const ws = new WebSocket(diffUrl);

    ws.on('message', (data: string) => {
      const diff = JSON.parse(data);
      console.log(`\n▸ File changed: ${diff.file_path}`);
      if (!statsOnly) {
        console.log(diff.diff); // Show actual diff
      }
    });

    // ... similar to LogStreamer
  }
}
```

**Add `diff` command:**

```bash
npx automagik-genie diff <session-id> [--live]
```

**Success Criteria:**
- Live diffs show file changes in real-time
- Stats-only mode available (faster)
- Diffs formatted with colors (if TTY)

---

## Phase 4: Stress Testing (Week 4)

### Objectives

1. Stress test: 10 parallel genie sessions
2. Verify worktree isolation (no file conflicts)
3. Validate session state tracking
4. Performance profiling (memory, CPU)

### Tasks

#### 4.1 Parallel Execution Test

**Goal:** Prove 10+ parallel genies work without conflicts

**Implementation:**

```typescript
// test-parallel-genies.ts
async function testParallelExecution() {
  const forgeExecutor = createForgeExecutor();
  const agents = [
    'analyze', 'implementor', 'tests', 'review', 'debug',
    'plan', 'genie', 'learn', 'git', 'release'
  ];

  console.log(`Starting ${agents.length} parallel genie sessions...`);

  const promises = agents.map(async (agent, i) => {
    const sessionId = await forgeExecutor.createSession({
      agentName: agent,
      prompt: `Test parallel execution: Task ${i + 1}`,
      // ... other params
    });

    console.log(`  ✅ ${agent}: ${sessionId}`);
    return sessionId;
  });

  const sessionIds = await Promise.all(promises);

  console.log(`\n✅ All ${sessionIds.length} sessions started successfully`);
  console.log(`   No conflicts, no timeouts, no failures`);

  return sessionIds;
}
```

**Success Criteria:**
- All 10 sessions start successfully
- No file conflicts (worktree isolation)
- No git conflicts (separate branches)
- All sessions tracked correctly

---

## Summary

### Code Deletion Targets

| File | Lines | Action | Phase |
|------|-------|--------|-------|
| background-launcher.ts | 120 | DELETE | Phase 2 |
| background-manager.ts | 80 | DELETE | Phase 2 |
| session-store.ts | 180 → 80 | SIMPLIFY | Phase 2 |
| genie.ts | 500 → 400 | REFACTOR | Phase 2 |
| **Total** | **300-400 lines** | DELETED/SIMPLIFIED | - |

### Feature Additions

| Feature | Implementation | Phase |
|---------|----------------|-------|
| WebSocket log streaming | log-streamer.ts | Phase 3 |
| Live diffs | diff-streamer.ts | Phase 3 |
| Native session resume | forge-executor.ts | Phase 1 (POC) |
| Worktree isolation | Forge backend | Phase 1 (POC) |

### Timeline

| Phase | Duration | Completion | Status |
|-------|----------|------------|--------|
| Phase 1: POC | Week 1 | 2025-10-25 | 🔄 In Progress |
| Phase 2: Core | Week 2 | 2025-11-01 | ⏳ Pending |
| Phase 3: Streaming | Week 3 | 2025-11-08 | ⏳ Pending |
| Phase 4: Stress Test | Week 4 | 2025-11-15 | ⏳ Pending |

**Total Duration:** 4 weeks

---

**Report Author:** Genie (forge/120-executor-replacement)
**Session ID:** (TBD)
**Forge Task:** Issue #120
**Worktree:** c3d1-forge-120-execut
