# Forge Executor POC: Test Plan
**Date:** 2025-10-18
**Task:** Issue #120 - Phase 1 POC Validation
**Status:** Ready for Execution

---

## Test Suite Overview

This test plan validates the ForgeExecutor POC implementation against Genie's current background-launcher.ts executor.

**Scope:** Phase 1 (POC Validation)
**Duration:** 1-2 days
**Environment:** Development (local Forge backend)

---

## Test Environment Setup

### Prerequisites

1. **Forge Backend Running**
   ```bash
   # Verify Forge backend is accessible
   curl http://localhost:3000/health
   # Expected: { "status": "ok" }
   ```

2. **Environment Variables**
   ```bash
   export FORGE_BASE_URL=http://localhost:3000
   export FORGE_TOKEN=<optional-auth-token>
   export GENIE_PROJECT_ID=<will-be-set-in-test-1>
   ```

3. **Dependencies Installed**
   ```bash
   cd .genie/cli
   npm install
   npm install ws @types/ws  # For WebSocket streaming (Phase 3)
   ```

---

## Test 1: Project Creation

### Objective
Create dedicated "Genie Sessions" project in Forge

### Pre-Conditions
- Forge backend running
- ForgeClient API accessible

### Test Steps

```bash
# Create test script
cat > .genie/cli/test-1-project-creation.ts << 'EOF'
import { ForgeClient } from '../../forge';

async function test() {
  const forge = new ForgeClient('http://localhost:3000');

  console.log('Creating Genie Sessions project...');
  const project = await forge.createProject({
    name: 'Genie Sessions',
    repo_path: process.cwd()
  });

  console.log('✅ Project created:');
  console.log('   ID:', project.id);
  console.log('   Name:', project.name);
  console.log('   Path:', project.repo_path);

  console.log('\n▸ Set environment variable:');
  console.log(`  export GENIE_PROJECT_ID=${project.id}`);
}

test().catch(console.error);
EOF

# Run test
npx tsx test-1-project-creation.ts
```

### Expected Results

✅ **Pass Criteria:**
- Project created successfully
- Project ID returned
- Project visible in Forge UI (`http://localhost:3000/projects`)

❌ **Fail Criteria:**
- HTTP error (500, 400, etc.)
- No project ID returned
- Project not visible in Forge UI

### Post-Conditions
- Set `GENIE_PROJECT_ID` environment variable for subsequent tests

---

## Test 2: Session Creation (Single Agent)

### Objective
Create one Genie session via Forge (eliminates timeout race)

### Pre-Conditions
- Test 1 passed (project exists)
- `GENIE_PROJECT_ID` set

### Test Steps

```bash
# Create test script
cat > .genie/cli/test-2-session-creation.ts << 'EOF'
import { createForgeExecutor } from './src/lib/forge-executor';
import type { CreateSessionParams } from './src/lib/forge-executor';

async function test() {
  const forgeExecutor = createForgeExecutor({
    forgeBaseUrl: 'http://localhost:3000',
    genieProjectId: process.env.GENIE_PROJECT_ID,
  });

  const params: CreateSessionParams = {
    agentName: 'analyze',
    prompt: 'POC Test: Analyze current directory structure',
    config: {
      defaults: { executor: 'claude-code' },
      background: { enabled: true, detach: true }
    },
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
  console.log(`\n✅ Session created: ${sessionId}`);
  console.log(`   Creation time: ${elapsed}ms`);
  console.log(`   Target: < 5000ms (current: 20000ms timeout)`);
  console.log(`   Improvement: ${((20000 - elapsed) / 20000 * 100).toFixed(1)}% faster`);
  console.log(`   Status: ${elapsed < 5000 ? '✅ PASS' : '❌ FAIL'}`);

  console.log(`\n▸ Verify worktree created:`);
  console.log(`  ls /var/tmp/automagik-forge/worktrees/ | grep ${sessionId}`);

  console.log(`\n▸ Verify branch created:`);
  console.log(`  cd /var/tmp/automagik-forge/worktrees/*${sessionId}* && git branch`);
}

test().catch(console.error);
EOF

# Run test
npx tsx test-2-session-creation.ts
```

### Expected Results

✅ **Pass Criteria:**
- Session created in < 5 seconds
- Session ID returned (valid UUID)
- No timeout race (guaranteed success/failure)
- Worktree created: `/var/tmp/automagik-forge/worktrees/{id}`
- Branch created: `forge/{id}`

❌ **Fail Criteria:**
- Creation time > 5 seconds
- Timeout occurred
- No session ID returned
- Worktree not created
- Branch not created

### Post-Conditions
- Save session ID for Test 3 (resume)

---

## Test 3: Session Resume (Follow-Up)

### Objective
Send follow-up prompt to existing session (native resume)

### Pre-Conditions
- Test 2 passed (session exists)
- Session ID from Test 2

### Test Steps

```bash
# Create test script
cat > .genie/cli/test-3-session-resume.ts << 'EOF'
import { createForgeExecutor } from './src/lib/forge-executor';

async function test() {
  const sessionId = process.argv[2];
  if (!sessionId) {
    console.error('Usage: test-3 <session-id>');
    process.exit(1);
  }

  const forgeExecutor = createForgeExecutor({
    forgeBaseUrl: 'http://localhost:3000',
  });

  console.log(`Resuming session: ${sessionId}...`);
  const startTime = Date.now();

  await forgeExecutor.resumeSession(
    sessionId,
    'POC Test Follow-Up: Now analyze package.json dependencies'
  );

  const elapsed = Date.now() - startTime;
  console.log(`\n✅ Follow-up sent: ${sessionId}`);
  console.log(`   Send time: ${elapsed}ms`);
  console.log(`   Target: < 2000ms`);
  console.log(`   Status: ${elapsed < 2000 ? '✅ PASS' : '❌ FAIL'}`);

  console.log(`\n▸ Verify same worktree used:`);
  console.log(`  ls /var/tmp/automagik-forge/worktrees/ | grep ${sessionId}`);

  console.log(`\n▸ Verify same branch used:`);
  console.log(`  cd /var/tmp/automagik-forge/worktrees/*${sessionId}* && git branch`);
}

test().catch(console.error);
EOF

# Run test (pass session ID from Test 2)
npx tsx test-3-session-resume.ts <session-id>
```

### Expected Results

✅ **Pass Criteria:**
- Follow-up sent in < 2 seconds
- No process re-spawning
- Same worktree used (not new worktree)
- Same branch used (not new branch)
- Agent continues in same context

❌ **Fail Criteria:**
- Send time > 2 seconds
- New process spawned
- New worktree created
- New branch created
- Context lost

---

## Test 4: Session Status

### Objective
Retrieve session status via Forge API

### Pre-Conditions
- Test 2 passed (session exists)

### Test Steps

```bash
cat > .genie/cli/test-4-session-status.ts << 'EOF'
import { createForgeExecutor } from './src/lib/forge-executor';

async function test() {
  const sessionId = process.argv[2];
  if (!sessionId) {
    console.error('Usage: test-4 <session-id>');
    process.exit(1);
  }

  const forgeExecutor = createForgeExecutor({
    forgeBaseUrl: 'http://localhost:3000',
  });

  console.log(`Getting status for session: ${sessionId}...`);
  const status = await forgeExecutor.getSessionStatus(sessionId);

  console.log(`\n✅ Status retrieved:`);
  console.log(`   Status: ${status.status}`);
  console.log(`   Expected: running | completed | failed | stopped`);
  console.log(`   Valid: ${['running', 'completed', 'failed', 'stopped'].includes(status.status) ? '✅ PASS' : '❌ FAIL'}`);
}

test().catch(console.error);
EOF

npx tsx test-4-session-status.ts <session-id>
```

### Expected Results

✅ **Pass Criteria:**
- Status retrieved successfully
- Status is one of: `running`, `completed`, `failed`, `stopped`

❌ **Fail Criteria:**
- HTTP error
- Invalid status value

---

## Test 5: Session Stop

### Objective
Stop running session via Forge API

### Pre-Conditions
- Test 2 passed (session exists and running)

### Test Steps

```bash
cat > .genie/cli/test-5-session-stop.ts << 'EOF'
import { createForgeExecutor } from './src/lib/forge-executor';

async function test() {
  const sessionId = process.argv[2];
  if (!sessionId) {
    console.error('Usage: test-5 <session-id>');
    process.exit(1);
  }

  const forgeExecutor = createForgeExecutor({
    forgeBaseUrl: 'http://localhost:3000',
  });

  console.log(`Stopping session: ${sessionId}...`);
  await forgeExecutor.stopSession(sessionId);

  console.log(`\n✅ Session stopped`);

  // Verify status changed
  console.log(`\n▸ Verifying status changed to 'stopped'...`);
  const status = await forgeExecutor.getSessionStatus(sessionId);
  console.log(`   Status: ${status.status}`);
  console.log(`   Expected: stopped`);
  console.log(`   Verified: ${status.status === 'stopped' ? '✅ PASS' : '❌ FAIL'}`);
}

test().catch(console.error);
EOF

npx tsx test-5-session-stop.ts <session-id>
```

### Expected Results

✅ **Pass Criteria:**
- Session stopped successfully
- Status changed to `stopped`

❌ **Fail Criteria:**
- HTTP error
- Status not changed
- Session still running

---

## Test 6: Performance Baseline

### Objective
Measure session creation performance (10 runs)

### Pre-Conditions
- Tests 1-5 passed

### Test Steps

```bash
cat > .genie/cli/test-6-performance.ts << 'EOF'
import { createForgeExecutor } from './src/lib/forge-executor';
import type { CreateSessionParams } from './src/lib/forge-executor';

async function test() {
  const forgeExecutor = createForgeExecutor({
    forgeBaseUrl: 'http://localhost:3000',
    genieProjectId: process.env.GENIE_PROJECT_ID,
  });

  const runs = 10;
  const times: number[] = [];
  const sessionIds: string[] = [];

  console.log(`Running ${runs} session creation tests...`);

  for (let i = 0; i < runs; i++) {
    const params: CreateSessionParams = {
      agentName: 'analyze',
      prompt: `Performance test run ${i + 1}`,
      config: { defaults: { executor: 'claude-code' } },
      paths: {
        baseDir: process.cwd(),
        sessionsFile: '.genie/sessions.json',
        logsDir: '.genie/logs',
        backgroundDir: '.genie/background',
      },
      store: { version: 2, sessions: {} },
      entry: { agent: 'analyze', status: 'pending' },
      executorKey: 'claude-code',
      executionMode: 'analyze',
      startTime: Date.now(),
    };

    const start = Date.now();
    const sessionId = await forgeExecutor.createSession(params);
    const elapsed = Date.now() - start;

    times.push(elapsed);
    sessionIds.push(sessionId);

    console.log(`  Run ${i + 1}: ${elapsed}ms`);

    // Stop session immediately to avoid resource exhaustion
    await forgeExecutor.stopSession(sessionId);
  }

  const avg = times.reduce((a, b) => a + b) / runs;
  const min = Math.min(...times);
  const max = Math.max(...times);
  const stdDev = Math.sqrt(
    times.reduce((sum, t) => sum + Math.pow(t - avg, 2), 0) / runs
  );

  console.log(`\n✅ Performance Baseline:`);
  console.log(`   Runs: ${runs}`);
  console.log(`   Average: ${avg.toFixed(0)}ms`);
  console.log(`   Min: ${min}ms`);
  console.log(`   Max: ${max}ms`);
  console.log(`   Std Dev: ${stdDev.toFixed(0)}ms`);
  console.log(`   Target: < 5000ms`);
  console.log(`   Status: ${avg < 5000 ? '✅ PASS' : '❌ FAIL'}`);

  console.log(`\n▸ Comparison to current implementation:`);
  console.log(`   Current: 20000ms timeout (polling)`);
  console.log(`   Forge: ${avg.toFixed(0)}ms (atomic)`);
  console.log(`   Improvement: ${((20000 - avg) / 20000 * 100).toFixed(1)}% faster`);
}

test().catch(console.error);
EOF

npx tsx test-6-performance.ts
```

### Expected Results

✅ **Pass Criteria:**
- Average creation time < 5000ms
- Standard deviation < 1000ms (consistent)
- All runs successful (no timeouts)
- > 75% improvement over current (20s timeout)

❌ **Fail Criteria:**
- Average > 5000ms
- High variance (> 1000ms std dev)
- Any runs timed out
- < 50% improvement

---

## Test 7: Parallel Execution (3 Sessions)

### Objective
Verify worktree isolation (3 parallel sessions)

### Pre-Conditions
- Tests 1-6 passed

### Test Steps

```bash
cat > .genie/cli/test-7-parallel.ts << 'EOF'
import { createForgeExecutor } from './src/lib/forge-executor';
import type { CreateSessionParams } from './src/lib/forge-executor';

async function test() {
  const forgeExecutor = createForgeExecutor({
    forgeBaseUrl: 'http://localhost:3000',
    genieProjectId: process.env.GENIE_PROJECT_ID,
  });

  const agents = ['analyze', 'implementor', 'tests'];

  console.log(`Starting ${agents.length} parallel sessions...`);
  const startTime = Date.now();

  const promises = agents.map(async (agent, i) => {
    const params: CreateSessionParams = {
      agentName: agent,
      prompt: `Parallel test: Task ${i + 1}`,
      config: { defaults: { executor: 'claude-code' } },
      paths: {
        baseDir: process.cwd(),
        sessionsFile: '.genie/sessions.json',
        logsDir: '.genie/logs',
        backgroundDir: '.genie/background',
      },
      store: { version: 2, sessions: {} },
      entry: { agent, status: 'pending' },
      executorKey: 'claude-code',
      executionMode: agent,
      startTime: Date.now(),
    };

    const sessionId = await forgeExecutor.createSession(params);
    console.log(`  ✅ ${agent}: ${sessionId}`);
    return sessionId;
  });

  const sessionIds = await Promise.all(promises);
  const elapsed = Date.now() - startTime;

  console.log(`\n✅ All ${sessionIds.length} sessions started successfully`);
  console.log(`   Total time: ${elapsed}ms`);
  console.log(`   Average: ${(elapsed / sessionIds.length).toFixed(0)}ms per session`);
  console.log(`   Status: ✅ PASS (no conflicts, no timeouts)`);

  // Verify unique worktrees
  console.log(`\n▸ Verifying unique worktrees...`);
  sessionIds.forEach(id => {
    console.log(`  ls /var/tmp/automagik-forge/worktrees/ | grep ${id}`);
  });

  // Stop all sessions
  console.log(`\n▸ Stopping all sessions...`);
  await Promise.all(sessionIds.map(id => forgeExecutor.stopSession(id)));
  console.log(`  ✅ All sessions stopped`);
}

test().catch(console.error);
EOF

npx tsx test-7-parallel.ts
```

### Expected Results

✅ **Pass Criteria:**
- All 3 sessions created successfully
- No file conflicts
- No git conflicts
- Each session in unique worktree
- Each session on unique branch
- Total time < 10 seconds

❌ **Fail Criteria:**
- Any session failed to create
- File conflicts detected
- Git conflicts detected
- Shared worktree (not isolated)
- Total time > 15 seconds

---

## Test Summary Report Template

### POC Validation Summary

**Date:** [DATE]
**Tester:** [NAME]
**Environment:** [Development | Staging | Production]

### Test Results

| Test | Status | Time (ms) | Notes |
|------|--------|-----------|-------|
| 1. Project Creation | ✅/❌ | XXX | |
| 2. Session Creation | ✅/❌ | XXX | |
| 3. Session Resume | ✅/❌ | XXX | |
| 4. Session Status | ✅/❌ | XXX | |
| 5. Session Stop | ✅/❌ | XXX | |
| 6. Performance Baseline | ✅/❌ | XXX avg | |
| 7. Parallel Execution | ✅/❌ | XXX total | |

### Performance Metrics

| Metric | Current | Proposed | Improvement |
|--------|---------|----------|-------------|
| Session creation | 5-20s | XXXms | XX% |
| Resume time | N/A | XXXms | N/A |
| Parallel safety | Unsafe | Safe | ✅ |
| Timeout failures | Yes | No | 100% |

### Issues Discovered

1. [Issue description]
   - **Severity:** High | Medium | Low
   - **Impact:** [Description]
   - **Recommendation:** [Fix strategy]

### Overall Assessment

**Recommendation:** ✅ Proceed to Phase 2 | ⚠️ Address issues first | ❌ Redesign needed

**Rationale:** [Explanation]

---

**Report Author:** [NAME]
**Session ID:** [SESSION-ID]
**Forge Task:** Issue #120
**Worktree:** c3d1-forge-120-execut
