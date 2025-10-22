# Skill Execution Paradigm Shift Analysis

**Date:** 2025-10-20
**Context:** Executable skills vs auto-loaded behavioral patterns
**Purpose:** Redesign AGENTS.md to reflect mandatory-only auto-loading + on-demand skill execution

---

## The Paradigm Shift

### OLD PARADIGM (Token Bloat)
```
ALL skills auto-loaded in base prompt every session
→ 23 skills × ~500 tokens avg = ~11,500 tokens
→ Most content never used in a given session
→ Skills = "read and follow" documentation
```

### NEW PARADIGM (Token Efficiency + Real-Time Execution)
```
ONLY mandatory skills auto-loaded in base prompt
→ ~3-5 core behavioral skills × ~500 tokens = ~2,500 tokens
→ OTHER skills = executable on-demand via MCP
→ Skills = callable workflows with real-time output
→ Execution: mcp__genie__run_skill(skill="prompt") → get output synchronously
```

**Token Savings:** ~9,000 tokens (78% reduction in skills overhead)

---

## Current Skills Inventory (23 total)

### Category A: MANDATORY (Auto-Load in Base Prompt)

**These define WHO Genie is and HOW Genie behaves:**

1. **know-yourself.md** (Tier 1 - Identity)
   - Core identity: orchestrator, not executor
   - Token efficiency principles
   - Self-awareness of capabilities
   - **WHY MANDATORY:** Foundational behavioral pattern, affects ALL decisions

2. **evidence-based-thinking.md** (Tier 2 - Decision Framework)
   - Evidence-first decision making
   - No speculation without validation
   - **WHY MANDATORY:** Core decision-making pattern

3. **routing-decision-matrix.md** (Tier 2 - Decision Framework)
   - When to delegate vs execute
   - Agent/workflow routing logic
   - **WHY MANDATORY:** Orchestration depends on correct routing

4. **delegation-discipline.md** (Tier 4 - Discovery & Tools)
   - Never self-delegate
   - Delegation hierarchy rules
   - **WHY MANDATORY:** Prevents paradoxes, ensures clean architecture

5. **role-clarity-protocol.md** (Tier 6 - Workflow & State Management)
   - Genie = coordinator, not implementor
   - Clear boundaries for each agent
   - **WHY MANDATORY:** Prevents scope creep, maintains architecture

**Total Mandatory:** 5 skills (~2,500-3,500 tokens)

---

### Category B: EXECUTABLE ON-DEMAND (NOT Auto-Loaded)

**These are workflows/processes Genie can invoke when needed:**

#### Execution Protocols (Run when needed)

6. **execution-integrity-protocol.md** (Tier 3)
   - RUN WHEN: Starting complex multi-step execution
   - OUTPUT: Integrity checklist, validation plan

7. **meta-learn-protocol.md** (Tier 3)
   - RUN WHEN: Documenting lessons learned
   - OUTPUT: Learn report, skill updates

8. **persistent-tracking-protocol.md** (Tier 3)
   - RUN WHEN: Need to track long-running task state
   - OUTPUT: State tracking plan, checkpoints

9. **triad-maintenance-protocol.md** (Tier 6)
   - RUN WHEN: Validating wish → forge → review flow
   - OUTPUT: Triad validation report

10. **wish-initiation-rule.md** (Tier 6)
    - RUN WHEN: User requests significant work
    - OUTPUT: Wish qualification decision + wish creation

11. **wish-issue-linkage-rule.md** (Tier 6)
    - RUN WHEN: Creating wish (validates issue exists)
    - OUTPUT: Issue validation + creation if needed

12. **wish-document-management.md** (Tier 6)
    - RUN WHEN: Managing wish lifecycle
    - OUTPUT: Wish status update, completion check

#### Helper Protocols (Lightweight, run on-demand)

13. **blocker-protocol.md** (Tier 4)
    - RUN WHEN: Encounter blocker
    - OUTPUT: Blocker log entry, escalation signal

14. **chat-mode-helpers.md** (Tier 4)
    - RUN WHEN: In conversational mode
    - OUTPUT: Response formatting guidance

15. **experimentation-protocol.md** (Tier 4)
    - RUN WHEN: Trying experimental approach
    - OUTPUT: Experiment documentation template

16. **orchestration-protocols.md** (Tier 4)
    - RUN WHEN: Coordinating multiple agents
    - OUTPUT: Orchestration plan

17. **parallel-execution.md** (Tier 4)
    - RUN WHEN: Running tasks in parallel
    - OUTPUT: Parallel execution strategy

18. **missing-context-protocol.md** (Tier 6)
    - RUN WHEN: Context gap detected
    - OUTPUT: Context gathering plan

#### Guardrails (Decision rules, not executable)

19. **sequential-questioning.md** (Tier 5)
    - NATURE: Behavioral guideline (could stay auto-loaded)
    - USE: Prevent overwhelming user with questions

20. **no-backwards-compatibility.md** (Tier 5)
    - NATURE: Behavioral guideline (could stay auto-loaded)
    - USE: Move fast, break things intentionally

#### Workspace Patterns (Reference only)

21. **workspace-system.md** (Tier 6)
    - NATURE: Documentation reference
    - USE: Understand worktree patterns

22. **execution-patterns.md** (Tier 6)
    - NATURE: Documentation reference
    - USE: Common execution patterns

#### Advanced Workflows (Executable)

23. **prompt.md** (Special - full agent)
    - RUN WHEN: Need to generate prompts
    - OUTPUT: Generated prompt (synchronous)
    - **EXAMPLE:** `mcp__genie__run_skill(skill="prompt", prompt="Create implementation prompt for MCP auth")` → returns generated prompt

---

## Recommended AGENTS.md Reorganization

### NEW STRUCTURE:

```markdown
## Core Skills Architecture

### MANDATORY (Auto-Loaded Every Session)

**Tier 1 (Identity):**
- `@.genie/skills/know-yourself.md`

**Tier 2 (Decision Framework):**
- `@.genie/skills/investigate-before-commit.md`
- `@.genie/skills/routing-decision-matrix.md`

**Tier 4 (Orchestration):**
- `@.genie/skills/delegate-dont-do.md`

**Tier 6 (Role Clarity):**
- `@.genie/skills/orchestrator-not-implementor.md`

**Tier 5 (Guardrails - Optional):**
- `@.genie/skills/ask-one-at-a-time.md` (behavioral guideline)
- `@.genie/skills/break-things-move-fast.md` (behavioral guideline)

### EXECUTABLE (On-Demand via MCP)

**Execution Skills:**
Run via `mcp__genie__run_skill(skill="<name>", ...)`

- `execution-integrity-protocol` - Multi-step execution validation
- `meta-learn-protocol` - Document lessons learned
- `persistent-tracking-protocol` - Track long-running tasks
- `triad-maintenance-protocol` - Validate wish→forge→review flow
- `wish-initiation-rule` - Qualify and create wishes
- `wish-issue-linkage-rule` - Validate GitHub issue linkage
- `wish-document-management` - Manage wish lifecycle

**Helper Skills:**
- `blocker-protocol` - Log blockers, escalate
- `experimentation-protocol` - Document experiments
- `orchestration-protocols` - Coordinate multiple agents
- `parallel-execution` - Parallel task strategy
- `missing-context-protocol` - Gather missing context

**Advanced Workflows:**
- `prompt` - Generate prompts (full agent, returns output synchronously)

**Reference Documentation:**
- `workspace-system` - Worktree patterns
- `execution-patterns` - Common execution patterns
```

---

## Skill Execution Architecture

### How Skills Are Invoked

**Pattern 1: Direct Execution (Synchronous)**
```typescript
// Genie invokes skill, waits for output
const result = await mcp__genie__run_skill({
  skill: "prompt",
  prompt: "Create implementation prompt for MCP authentication"
});

// result contains generated prompt text immediately
// NO background task, NO later viewing - output RIGHT NOW
```

**Pattern 2: Skill with Context**
```typescript
// Pass context to skill
const validation = await mcp__genie__run_skill({
  skill: "wish-issue-linkage-rule",
  context: {
    issueNumber: 152,
    wishTitle: "MCP Server Authentication"
  }
});

// Returns: { valid: true, issue: {...} } or { valid: false, reason: "..." }
```

**Pattern 3: Skill Chain**
```typescript
// Skills can invoke other skills
const wishQualified = await mcp__genie__run_skill({
  skill: "wish-initiation-rule",
  userRequest: "Add voice agent transformation"
});

if (wishQualified.significant) {
  const issueValidated = await mcp__genie__run_skill({
    skill: "wish-issue-linkage-rule",
    wishTitle: wishQualified.title
  });

  if (!issueValidated.valid) {
    // Route to issue creation
  }
}
```

### Benefits of Executable Skills

**1. Token Efficiency**
- Base prompt: ~2,500-3,500 tokens (mandatory only)
- Skills loaded on-demand: 0 tokens until needed
- Total savings: ~9,000 tokens per session

**2. Real-Time Feedback**
- No background tasks to check later
- Immediate results (synchronous execution)
- Can chain skills dynamically

**3. Composability**
- Skills can invoke other skills
- Build complex workflows from simple skills
- Reuse skills across different agents

**4. Maintainability**
- Update skill = immediate effect (no base prompt changes)
- Test skills in isolation
- Clear separation of concerns

**5. Lighter Base Genie**
- Base Genie = thin orchestrator
- Intelligence in executable skills
- Easier to understand base behavior

---

## Implementation Checklist

### Phase 1: AGENTS.md Reorganization

- [ ] Update AGENTS.md to show Mandatory vs Executable sections
- [ ] Remove @ references for executable skills (not auto-loaded)
- [ ] Add skill execution pattern documentation
- [ ] Update token count baseline (expect ~9K reduction)

### Phase 2: Skill Metadata Enhancement

For each executable skill, add front-matter:

```yaml
---
name: wish-issue-linkage-rule
description: Validate GitHub issue exists before wish creation
executable: true
genie:
  executor: claude
  model: sonnet
  background: false  # Synchronous execution
  returns: { valid: boolean, issue?: object, reason?: string }
---
```

### Phase 3: Base Prompt Simplification

Update base Genie prompt:

```markdown
## Skills Available

**Auto-Loaded (Mandatory):**
- know-yourself (identity)
- evidence-based-thinking (decisions)
- routing-decision-matrix (delegation)
- delegation-discipline (architecture)
- role-clarity-protocol (boundaries)

**Executable (On-Demand):**
- Run any skill via: mcp__genie__run_skill(skill="<name>", ...)
- List: execution-integrity, meta-learn, wish-*, blocker, prompt, etc.
- Get real-time output (synchronous)
```

### Phase 4: Skill Invocation Examples

Document how to use skills in practice:

```markdown
## Skill Usage Examples

**Before creating wish:**
\`\`\`typescript
const qualified = await mcp__genie__run_skill({
  skill: "wish-initiation-rule",
  userRequest: request
});

if (qualified.significant) {
  const validated = await mcp__genie__run_skill({
    skill: "wish-issue-linkage-rule",
    wishTitle: qualified.title
  });

  // Continue wish creation...
}
\`\`\`

**When generating prompts:**
\`\`\`typescript
const prompt = await mcp__genie__run_skill({
  skill: "prompt",
  prompt: "Create implementation prompt for feature X",
  context: { files: [...], requirements: [...] }
});

// Use prompt immediately
\`\`\`

**When encountering blocker:**
\`\`\`typescript
await mcp__genie__run_skill({
  skill: "blocker-protocol",
  blocker: { type: "dependency", details: "..." }
});

// Returns blocker log entry + escalation signal
\`\`\`
```

---

## Migration Strategy

### Step 1: Identify Mandatory Core (DONE)
✅ 5 skills identified:
- know-yourself
- evidence-based-thinking
- routing-decision-matrix
- delegation-discipline
- role-clarity-protocol

### Step 2: Convert Executable Skills (IN PROGRESS)
🔄 Add execution metadata to 18 skills
🔄 Document input/output contracts
🔄 Add usage examples

### Step 3: Update AGENTS.md (PENDING)
⏳ Reorganize to Mandatory vs Executable
⏳ Remove @ references for executable skills
⏳ Add execution pattern documentation

### Step 4: Test Skill Execution (PENDING)
⏳ Test synchronous execution
⏳ Test skill chaining
⏳ Validate token savings

### Step 5: Document Patterns (PENDING)
⏳ Create skill execution guide
⏳ Add examples to common workflows
⏳ Update agent prompts to use skill execution

---

## Expected Outcomes

**Token Reduction:**
- Before: ~11,500 tokens (23 skills auto-loaded)
- After: ~2,500 tokens (5 mandatory + 0 executable until invoked)
- **Savings: ~78% reduction in skill overhead**

**Execution Improvements:**
- ✅ Real-time skill output (no background waiting)
- ✅ Composable workflows (skills invoke skills)
- ✅ Dynamic skill loading (load only what's needed)
- ✅ Lighter base Genie (thin orchestrator)

**Maintainability:**
- ✅ Update skills without touching base prompt
- ✅ Test skills in isolation
- ✅ Clear execution contracts (input → output)
- ✅ Reusable across agents

---

## Next Steps

1. **Review this analysis with Felipe** - validate categorization
2. **Update AGENTS.md** - reflect new structure
3. **Add execution metadata** - to all executable skills
4. **Test skill execution** - validate synchronous pattern works
5. **Document execution patterns** - in .genie/docs/

---

**Status:** Analysis complete, awaiting Felipe feedback on categorization
**Next:** Update AGENTS.md based on approved categorization
