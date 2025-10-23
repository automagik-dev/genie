# Spell Naming Review: Intuitive Triggers

**Date:** 2025-10-20
**Problem:** Current spell names are abstract and don't clearly signal when to use them
**Goal:** Rename spells to be instant cognitive triggers

---

## Current Spell Name Analysis

### ❌ UNCLEAR NAMES (What does this actually DO?)

| Current Name | Problem | When Would I Use This? |
|--------------|---------|------------------------|
| `evidence-based-thinking.md` | Abstract concept | ??? "Think with evidence"? |
| `delegation-discipline.md` | Sounds like scolding | ??? When delegating? |
| `role-clarity-protocol.md` | What role? What clarity? | ??? |
| `execution-integrity-protocol.md` | Generic business-speak | ??? |
| `persistent-tracking-protocol.md` | Track what? | ??? |
| `triad-maintenance-protocol.md` | What's a triad? | ??? |
| `wish-document-management.md` | Managing... documents? | ??? |
| `workspace-system.md` | System for workspaces? | ??? |
| `execution-patterns.md` | Patterns of execution? | ??? |
| `missing-context-protocol.md` | What context? | ??? |
| `orchestration-protocols.md` | Plural protocols? | ??? |
| `no-backwards-compatibility.md` | Negative name, unclear | ??? |
| `sequential-questioning.md` | Ask questions... sequentially? | ??? |

### ✅ CLEAR NAMES (I know what these do!)

| Current Name | Why Clear | Trigger |
|--------------|-----------|---------|
| `know-yourself.md` | Identity, self-awareness | "Who am I?" |
| `routing-decision-matrix.md` | Route work to agents | "Where should this go?" |
| `wish-initiation-rule.md` | Start wishes | "Should I create a wish?" |
| `wish-issue-linkage-rule.md` | Link wishes to issues | "Does this wish have an issue?" |
| `blocker-protocol.md` | Handle blockers | "I'm blocked!" |
| `experimentation-protocol.md` | Run experiments | "Let's try something" |
| `meta-learn-protocol.md` | Learn from mistakes | "I learned something" |
| `chat-mode-helpers.md` | Chat mode behavior | "Conversational mode" |
| `parallel-execution.md` | Run things in parallel | "Do these together" |

---

## Naming Principle: "When X happens, use Y spell"

Good spell names should complete this sentence naturally:
> "When **[situation]**, use the **[spell-name]** spell"

### Examples:

✅ **GOOD:**
- "When I'm blocked, use the **blocker** spell"
- "When creating a wish, use the **wish-initiation** spell"
- "When learning something, use the **meta-learn** spell"

❌ **BAD:**
- "When... uh... I need discipline? use the **delegation-discipline** spell"
- "When... maintaining... a triad? use the **triad-maintenance-protocol** spell"
- "When... thinking? use the **evidence-based-thinking** spell"

---

## Proposed Reorganization

### Category 1: IDENTITY (Who am I?)

**KEEP AS-IS:**
- `know-yourself.md` - Clear, foundational

### Category 2: ROUTING (Where does this work go?)

**KEEP AS-IS:**
- `routing-decision-matrix.md` - Clear name

**RENAME:**
- `delegation-discipline.md` → **`delegate-dont-do.md`**
  - **Trigger:** "Should I do this myself?"
  - **Answer:** "No, delegate to specialist"

- `role-clarity-protocol.md` → **`orchestrator-not-implementor.md`**
  - **Trigger:** "Am I the one who should implement this?"
  - **Answer:** "No, you orchestrate"

### Category 3: DECISION-MAKING (How do I decide?)

**RENAME:**
- `evidence-based-thinking.md` → **`investigate-before-commit.md`**
  - **Trigger:** "Should I commit to this approach?"
  - **Answer:** "Investigate first, gather evidence"

### Category 4: WISH WORKFLOW (Wish lifecycle)

**KEEP AS-IS:**
- `wish-initiation-rule.md` - Clear
- `wish-issue-linkage-rule.md` - Clear

**RENAME:**
- `wish-document-management.md` → **`wish-lifecycle.md`**
  - **Trigger:** "What happens to wishes after creation?"
  - **Answer:** "Discovery → Planning → Execution → Done"

**NEW (Split from triad-maintenance-protocol.md):**
- **`wish-forge-review-flow.md`** (the "triad")
  - **Trigger:** "What's the execution workflow?"
  - **Answer:** "Wish → Forge → Review"

### Category 5: EXECUTION (How do I work?)

**RENAME:**
- `execution-integrity-protocol.md` → **`multi-step-execution.md`**
  - **Trigger:** "I have a complex multi-step task"
  - **Answer:** "Break into groups, track progress"

- `parallel-execution.md` → **`run-in-parallel.md`**
  - **Trigger:** "Can these tasks run together?"
  - **Answer:** "Yes, launch agents in parallel"

**REMOVE (merge into other spells):**
- `execution-patterns.md` → Merge into `multi-step-execution.md`
- `orchestration-protocols.md` → Merge into `routing-decision-matrix.md`

### Category 6: BLOCKERS & CONTEXT (When stuck)

**KEEP AS-IS:**
- `blocker-protocol.md` - Clear

**RENAME:**
- `missing-context-protocol.md` → **`gather-context.md`**
  - **Trigger:** "I don't have enough information"
  - **Answer:** "Here's how to gather context"

### Category 7: TRACKING & LEARNING

**KEEP AS-IS:**
- `meta-learn-protocol.md` - Clear

**RENAME:**
- `persistent-tracking-protocol.md` → **`track-long-running-tasks.md`**
  - **Trigger:** "This task will take a while"
  - **Answer:** "Track progress with checkpoints"

### Category 8: WORKSPACE & COLLABORATION

**RENAME:**
- `workspace-system.md` → **`worktree-isolation.md`**
  - **Trigger:** "Where does work happen?"
  - **Answer:** "Isolated worktrees per task"

### Category 9: BEHAVIORAL GUARDRAILS

**RENAME:**
- `sequential-questioning.md` → **`ask-one-at-a-time.md`**
  - **Trigger:** "I have 10 questions"
  - **Answer:** "Ask one, wait for answer, then next"

- `no-backwards-compatibility.md` → **`break-things-move-fast.md`**
  - **Trigger:** "Will this break old code?"
  - **Answer:** "Yes, and that's okay - no BC required"

### Category 10: EXPERIMENTATION

**KEEP AS-IS:**
- `experimentation-protocol.md` - Clear
- `chat-mode-helpers.md` - Clear

---

## Complete Renaming Map

### Mandatory Spells (5)

| Old Name | New Name | Trigger |
|----------|----------|---------|
| ✅ `know-yourself.md` | ✅ `know-yourself.md` | "Who am I?" |
| `evidence-based-thinking.md` | **`investigate-before-commit.md`** | "Should I commit?" → Investigate first |
| ✅ `routing-decision-matrix.md` | ✅ `routing-decision-matrix.md` | "Where does this go?" |
| `delegation-discipline.md` | **`delegate-dont-do.md`** | "Should I do this?" → No, delegate |
| `role-clarity-protocol.md` | **`orchestrator-not-implementor.md`** | "Am I implementor?" → No, orchestrator |

### Executable Spells (18 → 15 after merging)

| Old Name | New Name | Trigger | Notes |
|----------|----------|---------|-------|
| `execution-integrity-protocol.md` | **`multi-step-execution.md`** | "Complex multi-step task" | |
| `persistent-tracking-protocol.md` | **`track-long-running-tasks.md`** | "Long-running task" | |
| `meta-learn-protocol.md` | ✅ `meta-learn.md` | "I learned something" | Drop "protocol" |
| `blocker-protocol.md` | ✅ `blocker.md` | "I'm blocked" | Drop "protocol" |
| `chat-mode-helpers.md` | ✅ `chat-mode.md` | "Conversational mode" | Drop "helpers" |
| `experimentation-protocol.md` | ✅ `experiment.md` | "Let's try something" | Drop "protocol" |
| `orchestration-protocols.md` | **[MERGE]** | | → `routing-decision-matrix.md` |
| `parallel-execution.md` | **`run-in-parallel.md`** | "Do these together" | |
| `sequential-questioning.md` | **`ask-one-at-a-time.md`** | "10 questions" → Ask one |
| `no-backwards-compatibility.md` | **`break-things-move-fast.md`** | "Will this break BC?" → Yes, that's ok |
| `triad-maintenance-protocol.md` | **`wish-forge-review-flow.md`** | "What's the workflow?" | |
| `wish-initiation-rule.md` | ✅ `wish-initiation.md` | "Create wish?" | Drop "rule" |
| `wish-issue-linkage-rule.md` | ✅ `wish-issue-linkage.md` | "Wish has issue?" | Drop "rule" |
| `wish-document-management.md` | **`wish-lifecycle.md`** | "Wish lifecycle?" | |
| `workspace-system.md` | **`worktree-isolation.md`** | "Where does work happen?" | |
| `execution-patterns.md` | **[MERGE]** | | → `multi-step-execution.md` |
| `missing-context-protocol.md` | **`gather-context.md`** | "Not enough info" | |

---

## Simplified Naming Convention

### Drop Suffixes:
- ❌ `-protocol` (sounds formal/stuffy)
- ❌ `-rule` (sounds authoritarian)
- ❌ `-discipline` (sounds like punishment)
- ❌ `-system` (sounds corporate)
- ❌ `-helpers` (unclear)
- ❌ `-patterns` (too abstract)

### Use Action Verbs:
- ✅ `delegate-dont-do` (action: delegate)
- ✅ `investigate-before-commit` (action: investigate)
- ✅ `run-in-parallel` (action: run)
- ✅ `ask-one-at-a-time` (action: ask)
- ✅ `gather-context` (action: gather)
- ✅ `track-long-running-tasks` (action: track)

### Use Clear Nouns:
- ✅ `orchestrator-not-implementor` (identity)
- ✅ `wish-lifecycle` (concept)
- ✅ `worktree-isolation` (pattern)
- ✅ `meta-learn` (action)
- ✅ `blocker` (situation)

---

## Token Impact

### Before:
- 23 spells with abstract names
- Average name length: ~25 characters
- Cognitive load: High (need to read docs to understand)

### After:
- 20 spells (3 merged) with action-based names
- Average name length: ~20 characters
- Cognitive load: Low (name = instant trigger)

**Benefit:** Not just tokens, but **cognitive efficiency** - I know which spell to use instantly

---

## Migration Plan

### Phase 1: Rename Mandatory Spells (High Priority)
1. `evidence-based-thinking.md` → `investigate-before-commit.md`
2. `delegation-discipline.md` → `delegate-dont-do.md`
3. `role-clarity-protocol.md` → `orchestrator-not-implementor.md`

### Phase 2: Rename & Merge Executable Spells
1. Merge `orchestration-protocols.md` → `routing-decision-matrix.md`
2. Merge `execution-patterns.md` → Create `multi-step-execution.md`
3. Rename remaining 15 spells per table above

### Phase 3: Update AGENTS.md References
- Update @ references to new spell names
- Organize by trigger category (not tier numbers)

### Phase 4: Update Spell Content
- Remove "protocol/rule/discipline" language from content
- Add "**Trigger:**" section at top of each spell
- Add "**Use When:**" examples

---

## Example: Updated Spell Front-Matter

**OLD (delegation-discipline.md):**
```markdown
---
name: Delegation Discipline *(CRITICAL)*
description: Delegate multi-file work to specialists
---

# Delegation Discipline *(CRITICAL)*

**NEVER** implement directly when orchestrating...
```

**NEW (delegate-dont-do.md):**
```markdown
---
name: Delegate, Don't Do
trigger: "Should I do this myself?"
answer: "No, delegate to specialist"
---

# Delegate, Don't Do

**When to use:** You see work you CAN do, but you're in orchestrator mode

**Trigger:** Thinking "I'll just do this myself"

**Action:** STOP → Check role → Delegate instead

**Why:** Orchestrators route, specialists implement
```

---

## Summary

**Core Insight:** Spell names should be **instant triggers** that map to situations, not abstract concepts.

**Naming Formula:**
- Action verb + clear outcome = `delegate-dont-do`
- Situation + action = `investigate-before-commit`
- Clear noun (if action doesn't fit) = `blocker`, `meta-learn`

**Reductions:**
- 23 spells → 20 spells (3 merged)
- Drop stuffy suffixes (-protocol, -rule, -discipline)
- Add trigger/answer pattern to front-matter

**Next Step:** Get Felipe approval on naming map, then execute migration

---

**Status:** Analysis complete, naming map proposed, awaiting feedback
