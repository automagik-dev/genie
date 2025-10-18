# Critical Discovery: Forge Architecture & Integration Pattern
**Date:** 2025-10-18
**Task:** Issue #120 - Forge Executor Investigation
**Status:** ⚠️ MAJOR ARCHITECTURAL DISCOVERY

---

## Executive Summary

**Critical Finding:** The ForgeClient TypeScript class in `forge.ts` is **NOT** how Genie integrates with Forge.

**Actual Integration:** Genie uses Forge via **MCP tools** (`mcp__automagik_forge__*`), not direct HTTP API calls.

**Impact on Executor Replacement:** The analysis in FORGE-EXECUTOR-ANALYSIS-20251018.md needs significant revision. The proposed solution (ForgeClient API calls) is **not the correct integration pattern**.

---

## Architecture Discovery

### What I Initially Thought (INCORRECT)

```
Genie CLI
  ↓
ForgeClient.createAndStartTask() → HTTP API call
  ↓
Forge Backend Server (http://localhost:18887)
  ↓
Task Attempt created, session started
```

**This was based on:**
- Reading `forge.ts` (80+ API endpoints)
- Seeing `PUBLIC_BASE_URL=http://localforge.namastex.ai:18887` in environment
- Assuming direct HTTP integration

### What Actually Happens (CORRECT)

```
Claude Code (or any MCP client)
  ↓
MCP Protocol
  ↓
mcp__automagik_forge__create_task
mcp__automagik_forge__start_task_attempt
mcp__automagik_forge__update_task
  ↓
Forge MCP Server (running as --mcp process)
  ↓
Task/Attempt operations (creates worktrees, manages git branches)
```

**Evidence:**
1. Forge process running with `--mcp` flag (ps aux output)
2. No HTTP server listening on port 18887
3. Integration documented in `.genie/agents/code/skills/forge-integration.md`
4. MCP tools listed in skill documentation

---

## Forge MCP Tools Available

Based on `.genie/docs/mcp-interface.md` and skill documentation:

### Core Forge MCP Tools

```typescript
// List all projects
mcp__automagik_forge__list_projects()

// Create a task/ticket in a project
mcp__automagik_forge__create_task({
  project_id: string,
  title: string,
  description?: string
})

// Update a task/ticket
mcp__automagik_forge__update_task({
  task_id: string,
  title?: string,
  description?: string,
  status?: "todo" | "inprogress" | "inreview" | "done" | "cancelled"
})

// List tasks in a project
mcp__automagik_forge__list_tasks({
  project_id: string,
  status?: string,
  limit?: number
})

// Get specific task details
mcp__automagik_forge__get_task({
  task_id: string
})

// Start working on a task (creates task attempt)
mcp__automagik_forge__start_task_attempt({
  task_id: string,
  executor: "CLAUDE_CODE" | "CODEX" | "GEMINI" | "CURSOR" | "OPENCODE",
  base_branch: string,
  variant?: string
})

// Delete a task
mcp__automagik_forge__delete_task({
  task_id: string
})
```

### Genie MCP Tools (for delegation)

```typescript
// List available Genie agents
mcp__genie__list_agents()

// Start a Genie agent session
mcp__genie__run({
  agent: string,  // "plan", "forge", "implementor", "tests", etc.
  prompt: string,
  name?: string   // Session name
})

// Resume an existing session
mcp__genie__resume({
  sessionId: string,
  prompt: string
})

// View session transcript
mcp__genie__view({
  sessionId: string,
  full: boolean  // true for complete history, false for recent only
})

// List active and recent sessions
mcp__genie__list_sessions()

// Stop a running session
mcp__genie__stop({
  sessionId: string
})
```

---

## Current Integration Pattern

### Forge as Entry Point (from forge-integration.md)

**Core Principle:** Forge is the PRIMARY entry point for ALL work.

**Workflow:**
```
GitHub issue → Forge task card → worktree + feature branch → PR back to main
```

**Architecture:**
1. One forge task = one PR (direct 1:1 mapping)
2. All PRs converge on main (single integration point)
3. Work units are atomic at forge card level
4. Parallel safety via independent worktrees

**Example Flow:**
```
Issue #123: "Fix auth bug"
  ↓
mcp__automagik_forge__create_task({
  project_id: "...",
  title: "Fix auth bug",
  description: "Issue #123: Fix auth token validation"
})
  ↓
mcp__automagik_forge__start_task_attempt({
  task_id: "...",
  executor: "CLAUDE_CODE",
  base_branch: "main"
})
  ↓
Forge creates worktree: .worktrees/task-fix-auth-bug/
Forge creates branch: task/fix-auth-bug
Executor (Claude Code) starts working in worktree
  ↓
Work completes, commits pushed to branch
  ↓
PR #124: "Fix: Auth token validation" → main
  ↓
Merge to main + archive worktree
```

---

## What This Means for Executor Replacement

### Original Plan (NEEDS REVISION)

❌ **Replace background-launcher.ts with ForgeClient API calls**
- This won't work because Genie doesn't use HTTP APIs
- ForgeClient is likely for Forge's internal backend communication

### Corrected Understanding

The relationship between Genie and Forge is:

**Genie:** User interface + workflow orchestration + agent definitions
**Forge:** Execution engine + worktree management + task tracking

**Integration layer:** MCP tools (not HTTP APIs)

### Genie's Current Executor Architecture

```
User: npx automagik-genie run plan "task"
  ↓
genie.ts (CLI entry)
  ↓
background-launcher.ts (spawns child process)
  ↓
Child process runs agent (plan, implementor, etc.)
  ↓
Agent executes in current directory (no worktree isolation)
  ↓
Agent commits to current branch
```

**Problems:**
- No worktree isolation → parallel execution risks
- Session polling → timeout race conditions
- No task tracking → sessions exist only in sessions.json

### Forge's Executor Architecture

```
MCP client: mcp__automagik_forge__start_task_attempt(...)
  ↓
Forge MCP Server receives request
  ↓
Forge creates worktree (/var/tmp/automagik-forge/worktrees/XXXX-YYY/)
Forge creates branch (forge/XXXX-YYY or feat/task-name)
  ↓
Forge spawns executor (CLAUDE_CODE, GEMINI, etc.)
  ↓
Executor runs in isolated worktree
  ↓
Executor commits to feature branch
  ↓
Task attempt tracked in Forge database
```

**Benefits:**
- ✅ Worktree isolation → safe parallel execution
- ✅ No polling → immediate task attempt ID
- ✅ Task tracking → database-backed persistence
- ✅ Branch management → automatic cleanup

---

## Revised Understanding: Two Possible Integration Patterns

### Pattern A: Genie Delegates to Forge Tasks

**Concept:** When user runs `npx automagik-genie run plan "task"`, Genie creates a Forge task and delegates execution.

**Flow:**
```
User: npx automagik-genie run plan "task"
  ↓
genie.ts detects this should use Forge
  ↓
Creates Forge task: mcp__automagik_forge__create_task(...)
  ↓
Starts task attempt: mcp__automagik_forge__start_task_attempt({
  executor: "CLAUDE_CODE",
  base_branch: "main"
})
  ↓
Forge handles execution (worktree, branch, commits)
  ↓
Returns task attempt ID to user
```

**Pros:**
- ✅ Leverages all Forge benefits (worktrees, tracking, isolation)
- ✅ Simplifies Genie (no executor management)
- ✅ Unified execution model

**Cons:**
- ⚠️ Requires Forge for all agent execution
- ⚠️ Changes user experience (everything becomes a task)

### Pattern B: Hybrid - Genie for Simple, Forge for Complex

**Concept:** Simple one-off agents use Genie's executor, complex tasks use Forge.

**Flow:**
```
# Simple agent (Genie executor)
User: npx automagik-genie run plan --quick "analyze this"
  ↓
Runs in current directory, no worktree
  ↓
Returns result immediately

# Complex task (Forge executor)
User: npx automagik-genie run implementor "build feature X"
  ↓
Creates Forge task + attempt
  ↓
Isolated worktree, full tracking, PR workflow
```

**Pros:**
- ✅ Best of both worlds
- ✅ Lightweight for quick tasks
- ✅ Full power for complex work

**Cons:**
- ⚠️ Two execution paths to maintain
- ⚠️ User confusion about when to use which

---

## Key Questions to Answer

### 1. What is ForgeClient for?

**Hypothesis:** ForgeClient (`forge.ts`) is Forge's **internal** backend client, not for external integration.

**Evidence:**
- 80+ endpoints documented in forge.ts
- Covers full Forge backend API (projects, tasks, attempts, processes)
- But Genie doesn't import or use it

**Likely use case:** Forge's frontend (UI) uses ForgeClient to talk to Forge backend server.

**Implications:** ForgeClient is irrelevant for Genie-Forge integration.

### 2. How does Forge MCP Server work internally?

**Unknown:** Does Forge MCP Server use ForgeClient internally, or does it directly manipulate worktrees/database?

**To investigate:**
- Read Forge MCP Server source code
- Trace how `mcp__automagik_forge__start_task_attempt` works
- Understand if it's a wrapper around HTTP APIs or direct DB access

### 3. Can Genie replace background-launcher with Forge MCP tools?

**Key question:** Can we replace:
```typescript
// Current (background-launcher.ts)
backgroundManager.launch({
  rawArgs: parsed.options.rawArgs,
  startTime,
  logFile,
  ...
})
```

With:
```typescript
// Proposed (Forge MCP delegation)
mcp__automagik_forge__start_task_attempt({
  task_id: taskId,
  executor: "CLAUDE_CODE",
  base_branch: "main"
})
```

**Requirements to validate:**
1. Can Genie agents run via Forge task attempts?
2. Can follow-up prompts work via Forge?
3. Can session state be tracked via Forge tasks?
4. Can logs be accessed via Forge?

### 4. What happens to Genie-specific features?

**Features that might be lost:**
- Custom agent definitions (plan, forge, implementor, tests)
- Agent-specific prompts and workflows
- Genie session management (sessions.json)
- MCP tool integration (mcp__genie__run, mcp__genie__resume)

**Question:** If Genie delegates to Forge, how do Genie agents map to Forge executors?

**Possible mapping:**
```
Genie Agent       →  Forge Executor
-------------------------------------
plan              →  CLAUDE_CODE (with plan prompt)
implementor       →  CLAUDE_CODE (with implementor prompt)
tests             →  CLAUDE_CODE (with tests prompt)
forge             →  CLAUDE_CODE (with forge prompt)
```

**Challenge:** Forge executors are model-based (CLAUDE_CODE, GEMINI), not role-based (plan, implementor). How to preserve Genie's agent roles?

---

## Investigation Roadmap (Revised)

### Phase 1: Understand Forge MCP Server Architecture ✅ IN PROGRESS

**Tasks:**
1. ✅ Read Forge integration skill docs (completed)
2. ✅ Read MCP interface docs (completed)
3. ✅ Document MCP tools available (completed)
4. ⏳ Read Forge MCP Server source code
5. ⏳ Trace how task attempts are created
6. ⏳ Understand worktree + branch management
7. ⏳ Understand executor spawning

**Success criteria:**
- Detailed understanding of Forge MCP → worktree → executor flow
- Documented how Forge tracks tasks/attempts
- Identified integration points for Genie

### Phase 2: Validate Integration Feasibility

**Tasks:**
1. Test creating Forge task via MCP
2. Test starting task attempt with CLAUDE_CODE executor
3. Test following up on task attempt
4. Test getting logs from task attempt
5. Test stopping task attempt
6. Test listing active attempts

**Success criteria:**
- All MCP Forge tools tested and working
- Task attempt execution validated
- Logs accessible
- Follow-up prompts work

### Phase 3: Design Genie-Forge Integration Pattern

**Tasks:**
1. Decide: Pattern A (full delegation) vs Pattern B (hybrid)
2. Design session mapping (Genie sessions → Forge task attempts)
3. Design agent role preservation (Genie agents → Forge executors)
4. Design prompt injection (Genie agent prompts → Forge task descriptions)
5. Design backward compatibility (migrate existing sessions)

**Success criteria:**
- Integration pattern documented
- Session mapping clear
- Agent roles preserved
- Backward compatibility plan

### Phase 4: Implement Proof of Concept

**Tasks:**
1. Create ForgeExecutor class (wrapper around MCP tools)
2. Refactor genie.ts to use ForgeExecutor
3. Map Genie agents to Forge executors
4. Test basic workflow (run → resume → stop → view)
5. Performance comparison

**Success criteria:**
- PoC works for single task
- No functionality regressions
- Performance equal or better

### Phase 5: Full Migration

**Tasks:**
1. Delete background-launcher.ts (if full delegation)
2. Delete background-manager.ts (if full delegation)
3. Simplify session-store.ts (map to Forge)
4. Update MCP tools (mcp__genie__run → Forge delegation)
5. Migrate existing sessions
6. Update documentation

**Success criteria:**
- All tests pass
- All Genie agents work via Forge
- Existing sessions migrated
- Documentation updated

---

## Critical Open Questions

1. **Does Forge support arbitrary executors?**
   - Can we define custom Genie agents as Forge executors?
   - Or are we limited to CLAUDE_CODE, GEMINI, etc.?

2. **How does Forge handle agent prompts?**
   - Can task descriptions include agent-specific instructions?
   - Does Forge inject system prompts before execution?

3. **What happens to Genie sessions if we delegate to Forge?**
   - Do we maintain dual tracking (sessions.json + Forge tasks)?
   - Or do we fully migrate to Forge-only tracking?

4. **Can Genie agents access Forge task context?**
   - When Forge spawns CLAUDE_CODE, does it pass task description?
   - Can agent read task metadata (title, description, images)?

5. **How do we preserve Genie's multi-turn conversations?**
   - Forge has task attempts with follow-ups
   - Genie has sessions with resume
   - Are these equivalent?

6. **What's the performance impact?**
   - Current: spawn() + poll (500ms-20s)
   - Forge: MCP call → worktree creation → executor spawn
   - Which is faster?

7. **Can Forge run without worktrees?**
   - For quick one-off agents (plan --quick)
   - Or does every execution require worktree isolation?

---

## Next Actions

1. ✅ **Document this discovery** (completed - this file)
2. ⏳ **Read Forge MCP Server source code** (find implementation)
3. ⏳ **Test Forge MCP tools directly** (validate functionality)
4. ⏳ **Answer critical open questions** (design integration pattern)
5. ⏳ **Update FORGE-EXECUTOR-ANALYSIS report** (correct architecture)
6. ⏳ **Design integration pattern** (Pattern A vs B)
7. ⏳ **Create PoC** (prove feasibility)

---

## Lessons Learned

**Assumption Validation is Critical:**
- I assumed ForgeClient was the integration point (based on code reading)
- Actual integration is via MCP tools (based on runtime behavior)
- **Lesson:** Always validate assumptions with runtime evidence

**Documentation Hierarchy:**
- Code (`forge.ts`) shows what's *possible*
- Skills (`forge-integration.md`) show what's *actual*
- **Lesson:** Skills/docs > code for understanding real architecture

**Architecture Discovery Process:**
1. Read code → form hypothesis
2. Read docs → validate/correct hypothesis
3. Test runtime → confirm actual behavior
4. **Lesson:** Don't skip step 3 (runtime testing)

---

**Status:** Investigation phase redirected. Original analysis needs significant revision based on MCP integration pattern.

**Next Step:** Read Forge MCP Server source code to understand internal architecture.

---

**Report End**
