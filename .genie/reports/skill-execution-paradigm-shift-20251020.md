# Spell Execution Paradigm Shift Analysis

**Date:** 2025-10-20
**Context:** Executable spells vs auto-loaded behavioral patterns
**Purpose:** Redesign AGENTS.md to reflect mandatory-only auto-loading + on-demand spell execution

---

## The Paradigm Shift

### OLD PARADIGM (Token Bloat)
```
ALL spells auto-loaded in base prompt every session
→ 23 spells × ~500 tokens avg = ~11,500 tokens
→ Most content never used in a given session
→ Spells = "read and follow" documentation
```

### NEW PARADIGM (Token Efficiency + Real-Time Execution)
```
ONLY mandatory spells auto-loaded in base prompt
→ ~3-5 core behavioral spells × ~500 tokens = ~2,500 tokens
→ OTHER spells = executable on-demand via MCP
→ Spells = callable workflows with real-time output
→ Execution: mcp__genie__run_skill(spell="prompt") → get output synchronously
```

**Token Savings:** ~9,000 tokens (78% reduction in spells overhead)

---

## Current Spells Inventory (23 total)

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

**Total Mandatory:** 5 spells (~2,500-3,500 tokens)

---

### Category B: EXECUTABLE ON-DEMAND (NOT Auto-Loaded)

**These are workflows/processes Genie can invoke when needed:**

#### Execution Protocols (Run when needed)

6. **execution-integrity-protocol.md** (Tier 3)
   - RUN WHEN: Starting complex multi-step execution
   - OUTPUT: Integrity checklist, validation plan

7. **meta-learn-protocol.md** (Tier 3)
   - RUN WHEN: Documenting lessons learned
   - OUTPUT: Learn report, spell updates

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
    - **EXAMPLE:** `mcp__genie__run_skill(spell="prompt", prompt="Create implementation prompt for MCP auth")` → returns generated prompt

---

## Recommended AGENTS.md Reorganization

### NEW STRUCTURE:

```markdown
## Core Spells Architecture

### MANDATORY (Auto-Loaded Every Session)

**Tier 1 (Identity):**
- `@.genie/spells/know-yourself.md`

**Tier 2 (Decision Framework):**
- `@.genie/spells/investigate-before-commit.md`
- `@.genie/spells/routing-decision-matrix.md`

**Tier 4 (Orchestration):**
- `@.genie/spells/delegate-dont-do.md`

**Tier 6 (Role Clarity):**
- `@.genie/spells/orchestrator-not-implementor.md`

**Tier 5 (Guardrails - Optional):**
- `@.genie/spells/ask-one-at-a-time.md` (behavioral guideline)
- `@.genie/spells/break-things-move-fast.md` (behavioral guideline)

### EXECUTABLE (On-Demand via MCP)

**Execution Spells:**
Run via `mcp__genie__run_skill(spell="<name>", ...)`

- `execution-integrity-protocol` - Multi-step execution validation
- `meta-learn-protocol` - Document lessons learned
- `persistent-tracking-protocol` - Track long-running tasks
- `triad-maintenance-protocol` - Validate wish→forge→review flow
- `wish-initiation-rule` - Qualify and create wishes
- `wish-issue-linkage-rule` - Validate GitHub issue linkage
- `wish-document-management` - Manage wish lifecycle

**Helper Spells:**
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

## Spell Execution Architecture

### How Spells Are Invoked

**Pattern 1: Direct Execution (Synchronous)**
```typescript
// Genie invokes spell, waits for output
const result = await mcp__genie__run_skill({
  spell: "prompt",
  prompt: "Create implementation prompt for MCP authentication"
});

// result contains generated prompt text immediately
// NO background task, NO later viewing - output RIGHT NOW
```

**Pattern 2: Spell with Context**
```typescript
// Pass context to spell
const validation = await mcp__genie__run_skill({
  spell: "wish-issue-linkage-rule",
  context: {
    issueNumber: 152,
    wishTitle: "MCP Server Authentication"
  }
});

// Returns: { valid: true, issue: {...} } or { valid: false, reason: "..." }
```

**Pattern 3: Spell Chain**
```typescript
// Spells can invoke other spells
const wishQualified = await mcp__genie__run_skill({
  spell: "wish-initiation-rule",
  userRequest: "Add voice agent transformation"
});

if (wishQualified.significant) {
  const issueValidated = await mcp__genie__run_skill({
    spell: "wish-issue-linkage-rule",
    wishTitle: wishQualified.title
  });

  if (!issueValidated.valid) {
    // Route to issue creation
  }
}
```

### Benefits of Executable Spells

**1. Token Efficiency**
- Base prompt: ~2,500-3,500 tokens (mandatory only)
- Spells loaded on-demand: 0 tokens until needed
- Total savings: ~9,000 tokens per session

**2. Real-Time Feedback**
- No background tasks to check later
- Immediate results (synchronous execution)
- Can chain spells dynamically

**3. Composability**
- Spells can invoke other spells
- Build complex workflows from simple spells
- Reuse spells across different agents

**4. Maintainability**
- Update spell = immediate effect (no base prompt changes)
- Test spells in isolation
- Clear separation of concerns

**5. Lighter Base Genie**
- Base Genie = thin orchestrator
- Intelligence in executable spells
- Easier to understand base behavior

---

## Implementation Checklist

### Phase 1: AGENTS.md Reorganization

- [ ] Update AGENTS.md to show Mandatory vs Executable sections
- [ ] Remove @ references for executable spells (not auto-loaded)
- [ ] Add spell execution pattern documentation
- [ ] Update token count baseline (expect ~9K reduction)

### Phase 2: Spell Metadata Enhancement

For each executable spell, add front-matter:

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
## Spells Available

**Auto-Loaded (Mandatory):**
- know-yourself (identity)
- evidence-based-thinking (decisions)
- routing-decision-matrix (delegation)
- delegation-discipline (architecture)
- role-clarity-protocol (boundaries)

**Executable (On-Demand):**
- Run any spell via: mcp__genie__run_skill(spell="<name>", ...)
- List: execution-integrity, meta-learn, wish-*, blocker, prompt, etc.
- Get real-time output (synchronous)
```

### Phase 4: Spell Invocation Examples

Document how to use spells in practice:

```markdown
## Spell Usage Examples

**Before creating wish:**
\`\`\`typescript
const qualified = await mcp__genie__run_skill({
  spell: "wish-initiation-rule",
  userRequest: request
});

if (qualified.significant) {
  const validated = await mcp__genie__run_skill({
    spell: "wish-issue-linkage-rule",
    wishTitle: qualified.title
  });

  // Continue wish creation...
}
\`\`\`

**When generating prompts:**
\`\`\`typescript
const prompt = await mcp__genie__run_skill({
  spell: "prompt",
  prompt: "Create implementation prompt for feature X",
  context: { files: [...], requirements: [...] }
});

// Use prompt immediately
\`\`\`

**When encountering blocker:**
\`\`\`typescript
await mcp__genie__run_skill({
  spell: "blocker-protocol",
  blocker: { type: "dependency", details: "..." }
});

// Returns blocker log entry + escalation signal
\`\`\`
```

---

## Migration Strategy

### Step 1: Identify Mandatory Core (DONE)
✅ 5 spells identified:
- know-yourself
- evidence-based-thinking
- routing-decision-matrix
- delegation-discipline
- role-clarity-protocol

### Step 2: Convert Executable Spells (IN PROGRESS)
🔄 Add execution metadata to 18 spells
🔄 Document input/output contracts
🔄 Add usage examples

### Step 3: Update AGENTS.md (PENDING)
⏳ Reorganize to Mandatory vs Executable
⏳ Remove @ references for executable spells
⏳ Add execution pattern documentation

### Step 4: Test Spell Execution (PENDING)
⏳ Test synchronous execution
⏳ Test spell chaining
⏳ Validate token savings

### Step 5: Document Patterns (PENDING)
⏳ Create spell execution guide
⏳ Add examples to common workflows
⏳ Update agent prompts to use spell execution

---

## Expected Outcomes

**Token Reduction:**
- Before: ~11,500 tokens (23 spells auto-loaded)
- After: ~2,500 tokens (5 mandatory + 0 executable until invoked)
- **Savings: ~78% reduction in spell overhead**

**Execution Improvements:**
- ✅ Real-time spell output (no background waiting)
- ✅ Composable workflows (spells invoke spells)
- ✅ Dynamic spell loading (load only what's needed)
- ✅ Lighter base Genie (thin orchestrator)

**Maintainability:**
- ✅ Update spells without touching base prompt
- ✅ Test spells in isolation
- ✅ Clear execution contracts (input → output)
- ✅ Reusable across agents

---

## Next Steps

1. **Review this analysis with Felipe** - validate categorization
2. **Update AGENTS.md** - reflect new structure
3. **Add execution metadata** - to all executable spells
4. **Test spell execution** - validate synchronous pattern works
5. **Document execution patterns** - in .genie/docs/

---

**Status:** Analysis complete, awaiting Felipe feedback on categorization
**Next:** Update AGENTS.md based on approved categorization
