# Forge Backend Integration - QA Plan

**Date:** 2025-10-18
**Objective:** Verify Genie now uses Forge as task backend
**Status:** In Progress

---

## 🎯 Success Criteria

**Forge Integration Working When:**
1. ✅ Genie creates tasks in Forge (visible in Forge UI)
2. ✅ Genie sessions run in Forge worktrees (not local)
3. ✅ Genie CLI commands work with Forge backend
4. ✅ Multiple sessions can run in parallel via Forge

---

## Phase 1: Sequential Setup (MUST be done in order)

### Step 1: Verify ForgeClient HTTP Communication ⏳
**Command:**
```bash
node -e "
const { ForgeClient } = require('./forge.js');
const client = new ForgeClient('http://localhost:8887');
client.listProjects().then(projects => {
  console.log('✅ ForgeClient works!');
  console.log('Projects:', projects.length);
}).catch(err => {
  console.error('❌ ForgeClient failed:', err.message);
});
"
```

**Expected:** Should list 4 projects

**Validates:** HTTP wrapper works, can talk to Forge backend

---

### Step 2: Setup Genie Sessions Project ⏳
**Options:**
- **A:** Use existing `automagik-genie` project (f8924071)
- **B:** Create new "Genie Sessions" project

**Recommended:** Option A (use existing)

**Set Environment:**
```bash
export FORGE_BASE_URL=http://localhost:8887
export GENIE_PROJECT_ID=f8924071-fa8e-43ee-8fbc-96ec5b49b3da
```

**Validates:** Forge knows where to create Genie sessions

---

### Step 3: Test Single Genie Session Creation ⏳
**Command:**
```bash
FORGE_BASE_URL=http://localhost:8887 \
GENIE_PROJECT_ID=f8924071-fa8e-43ee-8fbc-96ec5b49b3da \
node .genie/cli/dist/genie-cli.js run learn "QA test - Forge backend integration" --name qa-forge-test --background
```

**Expected Output:**
```
▸ Creating Forge task for learn...
▸ Task attempt created: <uuid>
▸ Worktree: /var/tmp/automagik-forge/worktrees/<uuid>
▸ Branch: forge/<uuid>

  View output:
    npx automagik-genie view qa-forge-test
```

**Verify in Forge UI:**
- Navigate to: http://localhost:8887/projects/f8924071-fa8e-43ee-8fbc-96ec5b49b3da/tasks
- Should see new task: "Genie: learn (default)"
- Task should have active attempt

**Validates:**
- ✅ Forge backend is being used (not traditional launcher)
- ✅ Task created in Forge
- ✅ Worktree created
- ✅ Session tracked in sessions.json with `executor: 'forge'`

---

### Step 4: Test Genie CLI Commands with Forge Backend ⏳

**List Sessions:**
```bash
node .genie/cli/dist/genie-cli.js list sessions
```
**Expected:** Shows `qa-forge-test` with `executor: forge`

**View Session:**
```bash
FORGE_BASE_URL=http://localhost:8887 \
node .genie/cli/dist/genie-cli.js view qa-forge-test
```
**Expected:** Shows Forge logs (source: 'Forge logs')

**Stop Session:**
```bash
FORGE_BASE_URL=http://localhost:8887 \
node .genie/cli/dist/genie-cli.js stop qa-forge-test
```
**Expected:** Calls `stopTaskAttemptExecution()` API

**Validates:**
- ✅ View fetches logs from Forge
- ✅ Stop uses Forge API (not PID kill)
- ✅ List shows Forge sessions

---

## Phase 2: Parallel Orchestration (Can run simultaneously)

**Goal:** Start Groups B, C, D in Forge and monitor execution

### Group B: Migration & Safety (Sequential within group)
**Task ID:** 92d8f6c3-8ea2-4488-b13a-40a3084f46a5

**Start Task Attempt:**
```bash
# Via MCP
mcp__automagik_forge__start_task_attempt({
  task_id: "92d8f6c3-8ea2-4488-b13a-40a3084f46a5",
  executor: "CLAUDE_CODE",
  base_branch: "rc28"
})
```

**Dependencies:** None (can start immediately)

**Estimated:** 2-3 hours

**Validation:** Check Forge UI for progress

---

### Group C: Testing & Validation (Parallel within group)
**Task ID:** b2fefad3-a6af-42ba-81ed-cedf2eea118a

**Start Task Attempt:**
```bash
mcp__automagik_forge__start_task_attempt({
  task_id: "b2fefad3-a6af-42ba-81ed-cedf2eea118a",
  executor: "CLAUDE_CODE",
  base_branch: "rc28"
})
```

**Dependencies:** Group B (Task 11) for pre-commit hooks
**Workaround:** Can start testing without hooks, validate hooks later

**Estimated:** 2-3 hours

**Validation:** Check test results in task logs

---

### Group D: Documentation & Release (Parallel, mostly independent)
**Task ID:** 78aaf266-06ab-454f-a3df-3e76e5596811

**Start Task Attempt:**
```bash
mcp__automagik_forge__start_task_attempt({
  task_id: "78aaf266-06ab-454f-a3df-3e76e5596811",
  executor: "CLAUDE_CODE",
  base_branch: "rc28"
})
```

**Dependencies:** Groups B & C for evidence checklist (Task 17)
**Workaround:** Can start docs now, complete checklist when B & C done

**Estimated:** 1-2 hours

**Validation:** Check documentation files created

---

## Orchestration Strategy

### Sequential Execution Plan
```
Phase 1 (Setup)
├─ Step 1: Verify ForgeClient (2 min)
├─ Step 2: Setup environment (1 min)
├─ Step 3: Test single session (5 min)
└─ Step 4: Test CLI commands (5 min)
    └─ GATE: If all pass → Phase 2
```

### Parallel Execution Plan
```
Phase 2 (Work Execution)
├─ Group B (Migration) → Sequential tasks within
│  ├─ Task 9: Migration script
│  ├─ Task 10: Rollback docs
│  └─ Task 11: Pre-commit hooks
│
├─ Group C (Testing) → Can overlap with B
│  ├─ Task 12: POC tests (parallel)
│  ├─ Task 13: Stress test (sequential after 12)
│  └─ Task 14: Performance (parallel with 13)
│
└─ Group D (Docs) → Can overlap with B & C
   ├─ Task 15: CLI docs (parallel)
   ├─ Task 16: Upgrade guide (parallel)
   ├─ Task 17: Evidence (sequential after B & C)
   └─ Task 18: Done report (sequential after all)
```

---

## Verification Checklist

### Forge Backend Integration ✅
- [ ] ForgeClient HTTP calls work
- [ ] Genie creates tasks in Forge
- [ ] Sessions run in Forge worktrees
- [ ] Forge UI shows active sessions
- [ ] CLI commands use Forge API
- [ ] Logs retrieved from Forge
- [ ] Stop uses Forge API (not PID kill)

### Parallel Execution ✅
- [ ] Multiple Forge task attempts running
- [ ] No conflicts between parallel tasks
- [ ] Worktree isolation working
- [ ] All tasks complete successfully

### Final Validation ✅
- [ ] All tests passing (Group C)
- [ ] Documentation complete (Group D)
- [ ] Migration script validated (Group B)
- [ ] 6 bugs confirmed eliminated
- [ ] Ready for RC28 release

---

## Execution Commands

**Start All Groups in Parallel:**
```javascript
// Run via Claude Code MCP
const tasks = [
  { id: "92d8f6c3-8ea2-4488-b13a-40a3084f46a5", name: "Group B" },
  { id: "b2fefad3-a6af-42ba-81ed-cedf2eea118a", name: "Group C" },
  { id: "78aaf266-06ab-454f-a3df-3e76e5596811", name: "Group D" }
];

for (const task of tasks) {
  await mcp__automagik_forge__start_task_attempt({
    task_id: task.id,
    executor: "CLAUDE_CODE",
    base_branch: "rc28"
  });
  console.log(`✅ Started ${task.name}`);
}
```

**Monitor Progress:**
```bash
# Check all task statuses
mcp__automagik_forge__list_tasks({
  project_id: "f8924071-fa8e-43ee-8fbc-96ec5b49b3da",
  status: "in-progress"
})
```

---

## Next Action

**Recommended:** Execute Phase 1 now (sequential setup)
- If Phase 1 passes → Start Phase 2 (parallel execution)
- If Phase 1 fails → Debug Forge integration

**Command to run first:**
```bash
node -e "const { ForgeClient } = require('./forge.js'); const client = new ForgeClient('http://localhost:8887'); client.listProjects().then(p => console.log('✅ Projects:', p.length)).catch(e => console.error('❌ Error:', e.message));"
```
