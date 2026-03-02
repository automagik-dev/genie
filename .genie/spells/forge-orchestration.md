---
name: Forge Orchestration
description: Complete Forge orchestration - delegation workflow, patterns, MCP task descriptions
---

# Forge Orchestration - Complete Guide

**Purpose:** Proper delegation patterns for Forge operations and execution coordination

---

## Part 1: Orchestration Workflow 🔴 CRITICAL

**Core Principle:** Genie (base orchestrator) does NOT create Forge tasks directly.

Genie orchestrates via **wish → forge → review** workflow delegation.

### The Mistake Pattern (NEVER DO)

**What happened:**
```
User: "Learn about proper Forge workflow"
  ↓
Genie: Creates Forge task directly via mcp__automagik_forge__create_task
  ↓
❌ WRONG: Genie executed implementation instead of orchestrating
```

**Why this is wrong:**
1. Genie's role is **orchestration**, not execution
2. Skips wish planning step (no context gathering)
3. Skips forge breakdown step (no execution groups)
4. Skips review validation step (no quality gate)
5. Direct MCP usage = implementation work (not orchestration)

### The Correct Pattern (ALWAYS DO)

**Proper workflow:**
```
User: "Learn about proper Forge workflow"
  ↓
Genie: Delegates to wish.md agent
  ↓
wish.md: Creates wish document with context
  ↓
Genie: Delegates to forge.md agent
  ↓
forge.md: Breaks wish into execution groups, creates Forge tasks
  ↓
Genie: Delegates to review.md agent
  ↓
review.md: Validates implementation against wish acceptance criteria
  ↓
✅ CORRECT: Complete orchestration chain with proper delegation
```

---

## Part 2: Three-Step Workflow Breakdown

### Step 1: wish.md Agent (Planning)

**Purpose:** Gather context and create wish document

**Genie delegates:**
```
mcp__genie__run with agent="wish" and prompt="[User's request with full context]"
```

**wish.md creates:**
- [forge-orch-001] helpful=0 harmful=0: `.genie/wishes/YYYY-MM-DD-topic/YYYY-MM-DD-topic-wish.md`
- [forge-orch-002] helpful=0 harmful=0: Context gathered from conversation
- [forge-orch-003] helpful=0 harmful=0: Problem statement
- [forge-orch-004] helpful=0 harmful=0: Proposed solution
- [forge-orch-005] helpful=0 harmful=0: Acceptance criteria
- [forge-orch-006] helpful=0 harmful=0: References to relevant code/docs

**Output:** Wish document path for next step

### Step 2: forge.md Agent (Execution Breakdown)

**Purpose:** Break wish into execution groups and create Forge tasks

**Genie delegates:**
```
mcp__genie__run with agent="forge" and prompt="Create forge plan for @.genie/wishes/<slug>/<slug>-wish.md"
```

**forge.md creates:**
- [forge-orch-007] helpful=0 harmful=0: Forge plan document: `.genie/wishes/<slug>/reports/forge-plan-<slug>-<timestamp>.md`
- [forge-orch-008] helpful=0 harmful=0: Task files: `.genie/wishes/<slug>/task-*.md` (one per execution group)
- [forge-orch-009] helpful=0 harmful=0: **Forge MCP tasks** via `mcp__automagik_forge__create_task` (forge.md owns MCP operations)
- [forge-orch-010] helpful=0 harmful=0: Validation hooks and evidence paths

**forge.md responsibilities:**
- [forge-orch-011] helpful=0 harmful=0: Parse wish document `<spec_contract>`
- [forge-orch-012] helpful=0 harmful=0: Define execution groups (A, B, C...)
- [forge-orch-013] helpful=0 harmful=0: Assign personas (implementor, tests, polish)
- [forge-orch-014] helpful=0 harmful=0: Create Forge task cards with proper context
- [forge-orch-015] helpful=0 harmful=0: Document branch strategy
- [forge-orch-016] helpful=0 harmful=0: Set up evidence collection paths

**Output:** Forge plan + task IDs for monitoring

### Step 3: review.md Agent (Validation)

**Purpose:** Validate implementation against wish acceptance criteria

**Genie delegates:**
```
mcp__genie__run with agent="review" and prompt="Review implementation for @.genie/wishes/<slug>/<slug>-wish.md"
```

**review.md validates:**
- [forge-orch-017] helpful=0 harmful=0: All acceptance criteria met
- [forge-orch-018] helpful=0 harmful=0: Tests passing
- [forge-orch-019] helpful=0 harmful=0: Documentation updated
- [forge-orch-020] helpful=0 harmful=0: Code quality standards met
- [forge-orch-021] helpful=0 harmful=0: Evidence collected in wish qa/ folders

**Output:** Approval or change requests

---

## Part 3: Role Clarity - Who Does What

### Genie (Base Orchestrator)

**Responsibilities:**
- [forge-orch-022] helpful=0 harmful=0: ✅ Human interface (receive requests, provide updates)
- [forge-orch-023] helpful=0 harmful=0: ✅ Workflow coordination (delegate to wish → forge → review)
- [forge-orch-024] helpful=0 harmful=0: ✅ Session tracking (via SESSION-STATE.md)
- [forge-orch-025] helpful=0 harmful=0: ✅ Context aggregation (synthesize agent outputs)
- [forge-orch-026] helpful=0 harmful=0: ✅ Final reporting (summarize outcomes to user)

**Forbidden:**
- [forge-orch-027] helpful=0 harmful=0: ❌ NEVER create Forge tasks directly (that's forge.md's job)
- [forge-orch-028] helpful=0 harmful=0: ❌ NEVER create wish documents directly (that's wish.md's job)
- [forge-orch-029] helpful=0 harmful=0: ❌ NEVER run validation directly (that's review.md's job)
- [forge-orch-030] helpful=0 harmful=0: ❌ NEVER execute implementation (that's specialist agents' job)

### wish.md Agent (Planner)

**Responsibilities:**
- [forge-orch-031] helpful=0 harmful=0: ✅ Gather context from conversation
- [forge-orch-032] helpful=0 harmful=0: ✅ Create wish document structure
- [forge-orch-033] helpful=0 harmful=0: ✅ Document problem + solution + criteria
- [forge-orch-034] helpful=0 harmful=0: ✅ Collect references to code/docs

**Forbidden:**
- [forge-orch-035] helpful=0 harmful=0: ❌ NEVER create Forge tasks
- [forge-orch-036] helpful=0 harmful=0: ❌ NEVER execute implementation
- [forge-orch-037] helpful=0 harmful=0: ❌ NEVER perform validation

**Output:** Wish document for forge.md consumption

### forge.md Agent (Executor Orchestrator)

**Responsibilities:**
- [forge-orch-038] helpful=0 harmful=0: ✅ Parse wish document `<spec_contract>`
- [forge-orch-039] helpful=0 harmful=0: ✅ Break wish into execution groups
- [forge-orch-040] helpful=0 harmful=0: ✅ Create task files in wish folder
- [forge-orch-041] helpful=0 harmful=0: ✅ **Create Forge MCP tasks** via `mcp__automagik_forge__create_task`
- [forge-orch-042] helpful=0 harmful=0: ✅ Assign personas to groups
- [forge-orch-043] helpful=0 harmful=0: ✅ Document validation hooks
- [forge-orch-044] helpful=0 harmful=0: ✅ Set up evidence paths

**Forbidden:**
- [forge-orch-045] helpful=0 harmful=0: ❌ NEVER modify original wish document
- [forge-orch-046] helpful=0 harmful=0: ❌ NEVER execute implementation directly
- [forge-orch-047] helpful=0 harmful=0: ❌ NEVER skip task file creation
- [forge-orch-048] helpful=0 harmful=0: ❌ NEVER delegate to other orchestrators

**Output:** Forge plan + Forge task IDs + task files

**MCP Operations Authority:**
- [forge-orch-049] helpful=0 harmful=0: forge.md **OWNS** all Forge MCP tool usage:
  - `mcp__automagik_forge__create_task`
  - `mcp__automagik_forge__update_task`
  - `mcp__automagik_forge__list_tasks`
  - `mcp__automagik_forge__get_task`

**Why forge.md owns MCP:**
- [forge-orch-050] helpful=0 harmful=0: Forge operations ARE execution breakdown (forge.md's specialty)
- [forge-orch-051] helpful=0 harmful=0: Genie orchestrates workflows, not tools
- [forge-orch-052] helpful=0 harmful=0: Separation: orchestration (Genie) vs execution coordination (forge.md)

### review.md Agent (Validator)

**Responsibilities:**
- [forge-orch-053] helpful=0 harmful=0: ✅ Validate against wish acceptance criteria
- [forge-orch-054] helpful=0 harmful=0: ✅ Check test coverage
- [forge-orch-055] helpful=0 harmful=0: ✅ Verify documentation
- [forge-orch-056] helpful=0 harmful=0: ✅ Approve or request changes

**Forbidden:**
- [forge-orch-057] helpful=0 harmful=0: ❌ NEVER create tasks
- [forge-orch-058] helpful=0 harmful=0: ❌ NEVER execute implementation
- [forge-orch-059] helpful=0 harmful=0: ❌ NEVER modify wish

**Output:** Approval decision + feedback

---

## Part 4: Orchestration Patterns 🔴 CRITICAL

### Isolated Worktrees - No Cross-Task Waiting

- [forge-orch-060] helpful=0 harmful=0: Each Forge task runs in isolated git worktree/sandbox
- [forge-orch-061] helpful=0 harmful=0: Tasks CANNOT wait for each other - they don't share filesystem
- [forge-orch-062] helpful=0 harmful=0: Task B cannot see Task A's changes until Task A is MERGED to base branch

### Humans Are The Merge Gate

- [forge-orch-063] helpful=0 harmful=0: Only humans can review and merge Forge task PRs
- [forge-orch-064] helpful=0 harmful=0: Agents NEVER merge - always human decision
- [forge-orch-065] helpful=0 harmful=0: This is by design for quality control

### Sequential Dependency Pattern

If Task B depends on Task A's changes:
1. Launch Task A
2. Wait for Task A to complete
3. **STOP and ask human:** "Please review and merge Task A"
4. Human reviews/merges Task A to base branch
5. THEN launch Task B (now has Task A's changes in base)

### Parallel Tasks

- [forge-orch-066] helpful=0 harmful=0: Tasks CAN run in parallel if independent
- [forge-orch-067] helpful=0 harmful=0: Example: Fix test + Populate PR can run together
- [forge-orch-068] helpful=0 harmful=0: But final validation MUST wait for test fix to be merged

### Common Mistake Pattern

- [forge-orch-069] helpful=0 harmful=0: **Mistake:** Launch Task 3 (validation) telling it to 'wait' for Task 1 (test fix)
- [forge-orch-070] helpful=0 harmful=0: **Why impossible:** Task 3's worktree doesn't have Task 1's changes
- [forge-orch-071] helpful=0 harmful=0: **Result:** Task 3 would fail because test fix not in its base branch

### Correct Pattern

1. Launch Task 1 & 2 (parallel, independent)
2. Wait for completion
3. Ask human to merge Task 1
4. After merge, launch Task 3 (now has test fix)

---

## Part 5: MCP Task Description Patterns (Claude Executor Only)

When creating Forge MCP tasks via `mcp__forge__create_task` with Claude as executor, explicitly instruct Claude to use the subagent and load context from files only.

### Pattern

```
Use the <persona> subagent to [action verb] this task.

`@.genie/code/agents/<persona>.md`
`@.genie/wishes/<slug>/task-<group>.md`
`@.genie/wishes/<slug>/<slug>-wish.md`

Load all context from the referenced files above. Do not duplicate content here.
```

### Example

```
Use the implementor subagent to implement this task.

`@.genie/code/agents/implementor.md`
`@.genie/wishes/claude-executor/task-a.md`
`@.genie/wishes/claude-executor-wish.md`

Load all context from the referenced files above. Do not duplicate content here.
```

### Why This Pattern

- [forge-orch-072] helpful=0 harmful=0: Explicit instruction tells Claude to spawn the subagent
- [forge-orch-073] helpful=0 harmful=0: Agent reference points to actual agent prompt file
- [forge-orch-074] helpful=0 harmful=0: File references provide context paths
- [forge-orch-075] helpful=0 harmful=0: Avoids token waste from duplicating task file contents

### Agent Reference Pattern

- [forge-orch-076] helpful=0 harmful=0: Code agents: `@.genie/code/agents/<agent>.md`
- [forge-orch-077] helpful=0 harmful=0: Universal agents: `@.genie/code/agents/<agent>.md`
- [forge-orch-078] helpful=0 harmful=0: Workflows: `@.genie/code/workflows/<workflow>.md`

**Note:** This pattern is ONLY for Forge MCP task descriptions when using Claude executor. Task file creation (task-*.md) remains unchanged with full context.

---

## Part 6: Monitoring Pattern - Sleep, Don't Stop

**Critical Learning:** When instructed to "monitor" tasks, Genie does NOT stop/idle.

**Incorrect behavior:**
```
Felipe: "Monitor these Forge tasks"
  ↓
Genie: Reports status once, then waits passively
  ↓
❌ WRONG: Monitoring means periodic checking, not one-shot
```

**Correct behavior:**
```
Felipe: "Monitor these Forge tasks"
  ↓
Genie: Reports status, then continues checking periodically
  ↓
✅ RIGHT: Monitoring = sleep/wait loop, check again, report updates
```

**Implementation:**
- [forge-orch-079] helpful=0 harmful=0: Use `mcp__automagik_forge__get_task` periodically (every 30-60s)
- [forge-orch-080] helpful=0 harmful=0: Check for status changes (in-progress → in-review → done)
- [forge-orch-081] helpful=0 harmful=0: Report meaningful updates to user
- [forge-orch-082] helpful=0 harmful=0: Continue until task complete or user interrupts
- [forge-orch-083] helpful=0 harmful=0: "Monitor" = active vigilance, not passive waiting

**Why this matters:**
- [forge-orch-084] helpful=0 harmful=0: Forge tasks run in background (separate processes)
- [forge-orch-085] helpful=0 harmful=0: User expects real-time updates on progress
- [forge-orch-086] helpful=0 harmful=0: Genie's role is orchestration = keeping user informed
- [forge-orch-087] helpful=0 harmful=0: Sleeping/polling is appropriate for async operations

---

## Part 7: File Structure Created by Workflow

```
.genie/wishes/
└── YYYY-MM-DD-topic/
    ├── YYYY-MM-DD-topic-wish.md          # Created by wish.md
    ├── task-a.md                          # Created by forge.md
    ├── task-b.md                          # Created by forge.md
    ├── qa/                                # Evidence collection
    │   ├── group-a/
    │   └── group-b/
    └── reports/
        ├── forge-plan-<slug>-<timestamp>.md    # Created by forge.md
        └── review-<slug>-<timestamp>.md        # Created by review.md
```

---

## Part 8: Integration with Forge-as-Entry-Point Pattern

**Context:** Forge is PRIMARY entry point for ALL work

**Workflow alignment:**
```
GitHub issue → wish.md (plan) → forge.md (creates Forge task) → Forge executor → review.md
                                            ↓
                                    Forge task = PR = worktree
                                            ↓
                                    All work converges on main
```

**Key points:**
1. **wish.md** captures GitHub issue context in wish document
2. **forge.md** creates Forge task card (1 task = 1 PR)
3. **Forge executor** performs implementation in worktree
4. **review.md** validates before merge to main
5. **Genie** orchestrates entire chain (does not execute)

---

## Part 9: When to Use Each Agent

### Use wish.md when:
- [forge-orch-088] helpful=0 harmful=0: ✅ Request needs formal context capture
- [forge-orch-089] helpful=0 harmful=0: ✅ Scope spans multiple components
- [forge-orch-090] helpful=0 harmful=0: ✅ Ambiguity or risk is high
- [forge-orch-091] helpful=0 harmful=0: ✅ Compliance/approval gates required

### Use forge.md when:
- [forge-orch-092] helpful=0 harmful=0: ✅ Wish is APPROVED
- [forge-orch-093] helpful=0 harmful=0: ✅ Need to break wish into execution groups
- [forge-orch-094] helpful=0 harmful=0: ✅ Need to create Forge task cards
- [forge-orch-095] helpful=0 harmful=0: ✅ Need to assign work to specialists

### Use review.md when:
- [forge-orch-096] helpful=0 harmful=0: ✅ Implementation complete
- [forge-orch-097] helpful=0 harmful=0: ✅ Need acceptance criteria validation
- [forge-orch-098] helpful=0 harmful=0: ✅ Quality gate before merge

### Skip workflow when:
- [forge-orch-099] helpful=0 harmful=0: Simple bug fix or trivial change
- [forge-orch-100] helpful=0 harmful=0: Route directly to implementor/debug
- [forge-orch-101] helpful=0 harmful=0: Escalate to wish.md if complexity grows

---

## Part 10: Common Anti-Patterns to Avoid

### ❌ Anti-Pattern 1: Genie Creates Forge Tasks

```
# WRONG
mcp__automagik_forge__create_task(...)  # Called by Genie
```

**Why wrong:** Genie orchestrates, doesn't execute. MCP operations belong to forge.md.

**Correct:**
```
# RIGHT
mcp__genie__run(agent="forge", prompt="...")  # Genie delegates to forge.md
  ↓
forge.md calls mcp__automagik_forge__create_task(...)  # forge.md executes
```

### ❌ Anti-Pattern 2: Skipping wish.md

```
# WRONG
User request → Genie → forge.md directly
```

**Why wrong:** No context gathering, no wish document for reference.

**Correct:**
```
# RIGHT
User request → Genie → wish.md → forge.md → review.md
```

### ❌ Anti-Pattern 3: forge.md Modifies Wish

```
# WRONG
forge.md edits .genie/wishes/<slug>/<slug>-wish.md
```

**Why wrong:** Wish is source of truth, forge.md only reads it.

**Correct:**
```
# RIGHT
forge.md reads wish, creates companion files (forge plan, task files)
```

---

## Part 11: Validation Checklist

**Before creating Forge tasks, verify:**
- [forge-orch-102] helpful=0 harmful=0: [ ] Wish document exists and is APPROVED
- [forge-orch-103] helpful=0 harmful=0: [ ] Genie delegated to wish.md (not created wish directly)
- [forge-orch-104] helpful=0 harmful=0: [ ] Genie delegated to forge.md (not created Forge tasks directly)
- [forge-orch-105] helpful=0 harmful=0: [ ] forge.md parsed wish `<spec_contract>`
- [forge-orch-106] helpful=0 harmful=0: [ ] forge.md created task files in wish folder
- [forge-orch-107] helpful=0 harmful=0: [ ] forge.md created Forge MCP tasks (not Genie)
- [forge-orch-108] helpful=0 harmful=0: [ ] Evidence paths documented
- [forge-orch-109] helpful=0 harmful=0: [ ] Validation hooks specified

**During implementation, verify:**
- [forge-orch-110] helpful=0 harmful=0: [ ] Work happens in Forge task worktree
- [forge-orch-111] helpful=0 harmful=0: [ ] Evidence collected in wish qa/ folders
- [forge-orch-112] helpful=0 harmful=0: [ ] Progress tracked via Forge task updates

**After implementation, verify:**
- [forge-orch-113] helpful=0 harmful=0: [ ] Genie delegated to review.md (not validated directly)
- [forge-orch-114] helpful=0 harmful=0: [ ] Review validates against wish acceptance criteria
- [forge-orch-115] helpful=0 harmful=0: [ ] All tests passing
- [forge-orch-116] helpful=0 harmful=0: [ ] Documentation updated

---

## Key Takeaways

1. **Genie orchestrates, doesn't execute**
   - Delegates to wish.md, forge.md, review.md
   - Synthesizes outputs, reports to user
   - Never touches MCP Forge tools directly
   - **Monitors actively** when tasks are running

2. **forge.md owns MCP operations**
   - Creates/updates Forge tasks
   - Owns all `mcp__automagik_forge__*` tool usage
   - Coordinates execution groups

3. **Complete chain = quality**
   - wish.md (context) → forge.md (breakdown) → review.md (validation)
   - Skipping steps = incomplete orchestration
   - Each step adds value and safety

4. **Isolated worktrees = sequential dependencies**
   - Tasks cannot wait for each other
   - Humans are the merge gate
   - Sequential dependencies require human approval between tasks

5. **Monitoring = active vigilance**
   - Sleep/poll/check/report loop
   - Not one-shot status check
   - Keep user informed of progress
   - Continue until completion or interruption

---

## References

- [forge-orch-117] helpful=0 harmful=0: `@.genie/code/workflows/wish.md` - Wish workflow documentation
- [forge-orch-118] helpful=0 harmful=0: `@.genie/code/workflows/forge.md` - Forge workflow documentation
- [forge-orch-119] helpful=0 harmful=0: `@.genie/code/workflows/review.md` - Review workflow documentation (when exists)
- [forge-orch-120] helpful=0 harmful=0: `@.genie/spells/forge-integration.md` - Forge-as-entry-point pattern
- [forge-orch-121] helpful=0 harmful=0: `@.genie/spells/orchestrator-not-implementor.md` - Agent role boundaries

---

**Evidence:** Merged from 3 spell files (forge-orchestration-workflow, forge-orchestration-patterns, forge-mcp-task-patterns) on 2025-10-23 during duplicate cleanup initiative.
