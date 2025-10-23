# 🧞📚 Learning Report: Human Interaction Patterns
**Sequence:** 02
**Context ID:** human-interaction-pattern
**Type:** pattern
**Severity:** high
**Teacher:** Felipe (namastex)

---

## Teaching Input

> "i prefer to address one issue at a time> humans TEND to give their best output when presented with a single task at aa time, so, lets improve that behavior, as you just bombed me with a lot of things to review at once."

**Context:** After presenting 5 decision points simultaneously from issue audit.

---

## Analysis

### Type Identified
**Pattern** - Human decision-making workflow optimization

### Key Information Extracted

**What:** Present decisions sequentially, not in bulk
**Why:** Humans give best output when focused on single task at a time
**Where:** Any context requiring human decisions/review
**How:** Queue decisions, present one at a time, wait for response, then next

### Pattern Description

When multiple decisions are needed from humans:
- ❌ **Don't:** Present all 5 decisions simultaneously in one message
- ✅ **Do:** Present decision #1, wait for response, then present decision #2

**Example (WRONG - What I did):**
```
## Needs Your Review (5 Decisions)

1. Issue #41: Choose Option A/B/C
2. Issue #40: Roadmap linkage
3. Issue #38: Roadmap linkage
4. Issue #37: Roadmap linkage
5. Issue #39: Auto-close approach

Which would you like to address first?
```

**Example (CORRECT - What I should do):**
```
## Decision Needed: Issue #41 Agent Inventory

[Present single decision with full context]

After you decide, I'll move to the next decision.
```

### Rationale

**Cognitive load:** 5 decisions at once = overwhelming
**Focus:** Single decision = better quality response
**Progress:** Sequential completion more satisfying than partial progress on multiple fronts
**Clarity:** One context at a time reduces confusion

---

## Additional Context: Issue #41 Sensitivity

**Felipe's clarification:**
> "about issue 41... the issue is a bit sensitive in context.. the amount of agents in .genie reflects genie's agents, not necessarily what we want as templates... some stuff could not fit that criteria, that needs to be analyzed..."

**Key insight:**
- `.genie/` agents = Genie's own development agents (meta-level)
- `templates/` = What users get (subset of .genie/)
- Not all Genie agents should be templated
- Issue #41 inventory mismatch needs nuanced analysis, not simple "30 vs 25" counting

**Implication:** Issue #41 blocker report may have oversimplified the problem by treating all agents equally.

---

## Pattern Application

### Discovery Phase
When gathering multiple decision points:
1. **Collect all decisions** (as I did)
2. **Prioritize by criticality/dependency**
3. **Queue them** in todo list

### Presentation Phase
**Sequential presentation pattern:**
```
1. Present Decision #1 with full context
2. Wait for human response
3. Execute based on decision
4. Present Decision #2
5. Repeat until queue empty
```

### Queue Management
Use TodoWrite to track:
- `DECISION QUEUE #1: [description]` (in_progress)
- `DECISION QUEUE #2: [description]` (pending)
- `DECISION QUEUE #3: [description]` (pending)

**Important:** Mark as `in_progress` ONLY the current decision being presented.

---

## Target Files

This pattern applies to:
- **All agents that interact with humans** - orchestrator, plan, wish, forge, review, learn
- **AGENTS.md** - Add to behavioral principles
- **CLAUDE.md** - Add to project patterns

---

## Changes Made

### File 1: `.genie/reports/02-human-interaction-pattern-learn.md`
**Action:** Created this learning report

**Content:** Pattern documentation for sequential decision presentation

---

## Validation

### How to Verify

**Test scenario:** Multiple decisions needed from human

**Correct behavior:**
```
Agent: "Decision #1: Issue #41 agent inventory. Choose Option A/B/C.
       [Full context for decision #1]

       (4 more decisions in queue, will present after this one)"