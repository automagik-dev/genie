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
- `.genie/wishes/YYYY-MM-DD-topic/YYYY-MM-DD-topic-wish.md`
- Context gathered from conversation
- Problem statement
- Proposed solution
- Acceptance criteria
- References to relevant code/docs

**Output:** Wish document path for next step

### Step 2: forge.md Agent (Execution Breakdown)

**Purpose:** Break wish into execution groups and create Forge tasks

**Genie delegates:**
```
mcp__genie__run with agent="forge" and prompt="Create forge plan for @.genie/wishes/<slug>/<slug>-wish.md"
```

**forge.md creates:**
- Forge plan document: `.genie/wishes/<slug>/reports/forge-plan-<slug>-<timestamp>.md`
- Task files: `.genie/wishes/<slug>/task-*.md` (one per execution group)
- **Forge MCP tasks** via `mcp__automagik_forge__create_task` (forge.md owns MCP operations)
- Validation hooks and evidence paths

**forge.md responsibilities:**
- Parse wish document `<spec_contract>`
- Define execution groups (A, B, C...)
- Assign personas (implementor, tests, polish)
- Create Forge task cards with proper context
- Document branch strategy
- Set up evidence collection paths

**Output:** Forge plan + task IDs for monitoring

### Step 3: review.md Agent (Validation)

**Purpose:** Validate implementation against wish acceptance criteria

**Genie delegates:**
```
mcp__genie__run with agent="review" and prompt="Review implementation for @.genie/wishes/<slug>/<slug>-wish.md"
```

**review.md validates:**
- All acceptance criteria met
- Tests passing
- Documentation updated
- Code quality standards met
- Evidence collected in wish qa/ folders

**Output:** Approval or change requests

---

## Part 3: Role Clarity - Who Does What

### Genie (Base Orchestrator)

**Responsibilities:**
- ✅ Human interface (receive requests, provide updates)
- ✅ Workflow coordination (delegate to wish → forge → review)
- ✅ Session tracking (via SESSION-STATE.md)
- ✅ Context aggregation (synthesize agent outputs)
- ✅ Final reporting (summarize outcomes to user)

**Forbidden:**
- ❌ NEVER create Forge tasks directly (that's forge.md's job)
- ❌ NEVER create wish documents directly (that's wish.md's job)
- ❌ NEVER run validation directly (that's review.md's job)
- ❌ NEVER execute implementation (that's specialist agents' job)

### wish.md Agent (Planner)

**Responsibilities:**
- ✅ Gather context from conversation
- ✅ Create wish document structure
- ✅ Document problem + solution + criteria
- ✅ Collect references to code/docs

**Forbidden:**
- ❌ NEVER create Forge tasks
- ❌ NEVER execute implementation
- ❌ NEVER perform validation

**Output:** Wish document for forge.md consumption

### forge.md Agent (Executor Orchestrator)

**Responsibilities:**
- ✅ Parse wish document `<spec_contract>`
- ✅ Break wish into execution groups
- ✅ Create task files in wish folder
- ✅ **Create Forge MCP tasks** via `mcp__automagik_forge__create_task`
- ✅ Assign personas to groups
- ✅ Document validation hooks
- ✅ Set up evidence paths

**Forbidden:**
- ❌ NEVER modify original wish document
- ❌ NEVER execute implementation directly
- ❌ NEVER skip task file creation
- ❌ NEVER delegate to other orchestrators

**Output:** Forge plan + Forge task IDs + task files

**MCP Operations Authority:**
- forge.md **OWNS** all Forge MCP tool usage:
  - `mcp__automagik_forge__create_task`
  - `mcp__automagik_forge__update_task`
  - `mcp__automagik_forge__list_tasks`
  - `mcp__automagik_forge__get_task`

**Why forge.md owns MCP:**
- Forge operations ARE execution breakdown (forge.md's specialty)
- Genie orchestrates workflows, not tools
- Separation: orchestration (Genie) vs execution coordination (forge.md)

### review.md Agent (Validator)

**Responsibilities:**
- ✅ Validate against wish acceptance criteria
- ✅ Check test coverage
- ✅ Verify documentation
- ✅ Approve or request changes

**Forbidden:**
- ❌ NEVER create tasks
- ❌ NEVER execute implementation
- ❌ NEVER modify wish

**Output:** Approval decision + feedback

---

## Part 4: Orchestration Patterns 🔴 CRITICAL

### Isolated Worktrees - No Cross-Task Waiting

- Each Forge task runs in isolated git worktree/sandbox
- Tasks CANNOT wait for each other - they don't share filesystem
- Task B cannot see Task A's changes until Task A is MERGED to base branch

### Humans Are The Merge Gate

- Only humans can review and merge Forge task PRs
- Agents NEVER merge - always human decision
- This is by design for quality control

### Sequential Dependency Pattern

If Task B depends on Task A's changes:
1. Launch Task A
2. Wait for Task A to complete
3. **STOP and ask human:** "Please review and merge Task A"
4. Human reviews/merges Task A to base branch
5. THEN launch Task B (now has Task A's changes in base)

### Parallel Tasks

- Tasks CAN run in parallel if independent
- Example: Fix test + Populate PR can run together
- But final validation MUST wait for test fix to be merged

### Common Mistake Pattern

- **Mistake:** Launch Task 3 (validation) telling it to 'wait' for Task 1 (test fix)
- **Why impossible:** Task 3's worktree doesn't have Task 1's changes
- **Result:** Task 3 would fail because test fix not in its base branch

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

- Explicit instruction tells Claude to spawn the subagent
- Agent reference points to actual agent prompt file
- File references provide context paths
- Avoids token waste from duplicating task file contents

### Agent Reference Pattern

- Code agents: `@.genie/code/agents/<agent>.md`
- Universal agents: `@.genie/code/agents/<agent>.md`
- Workflows: `@.genie/code/workflows/<workflow>.md`

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
- Use `mcp__automagik_forge__get_task` periodically (every 30-60s)
- Check for status changes (in-progress → in-review → done)
- Report meaningful updates to user
- Continue until task complete or user interrupts
- "Monitor" = active vigilance, not passive waiting

**Why this matters:**
- Forge tasks run in background (separate processes)
- User expects real-time updates on progress
- Genie's role is orchestration = keeping user informed
- Sleeping/polling is appropriate for async operations

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
- ✅ Request needs formal context capture
- ✅ Scope spans multiple components
- ✅ Ambiguity or risk is high
- ✅ Compliance/approval gates required

### Use forge.md when:
- ✅ Wish is APPROVED
- ✅ Need to break wish into execution groups
- ✅ Need to create Forge task cards
- ✅ Need to assign work to specialists

### Use review.md when:
- ✅ Implementation complete
- ✅ Need acceptance criteria validation
- ✅ Quality gate before merge

### Skip workflow when:
- Simple bug fix or trivial change
- Route directly to implementor/debug
- Escalate to wish.md if complexity grows

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
- [ ] Wish document exists and is APPROVED
- [ ] Genie delegated to wish.md (not created wish directly)
- [ ] Genie delegated to forge.md (not created Forge tasks directly)
- [ ] forge.md parsed wish `<spec_contract>`
- [ ] forge.md created task files in wish folder
- [ ] forge.md created Forge MCP tasks (not Genie)
- [ ] Evidence paths documented
- [ ] Validation hooks specified

**During implementation, verify:**
- [ ] Work happens in Forge task worktree
- [ ] Evidence collected in wish qa/ folders
- [ ] Progress tracked via Forge task updates

**After implementation, verify:**
- [ ] Genie delegated to review.md (not validated directly)
- [ ] Review validates against wish acceptance criteria
- [ ] All tests passing
- [ ] Documentation updated

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

- `@.genie/code/workflows/wish.md` - Wish workflow documentation
- `@.genie/code/workflows/forge.md` - Forge workflow documentation
- `@.genie/code/workflows/review.md` - Review workflow documentation (when exists)
- `@.genie/spells/forge-integration.md` - Forge-as-entry-point pattern
- `@.genie/spells/orchestrator-not-implementor.md` - Agent role boundaries

---

**Evidence:** Merged from 3 spell files (forge-orchestration-workflow, forge-orchestration-patterns, forge-mcp-task-patterns) on 2025-10-23 during duplicate cleanup initiative.
