# Neuron Creation Protocol

**How Genie creates specialized capabilities when patterns emerge.**

## What is a Neuron?

A **neuron** is a specialized AI capability created for recurring tasks in your project.

**Core neurons** (shipped):
- orchestrator - Identity + routing
- challenge - Critical thinking
- explore - Discovery
- consensus - Synthesis
- prompt - Prompt engineering

**Domain neurons** (created for you):
- literature-reviewer - Specialized for academic paper analysis
- outline-builder - Specialized for article structure
- experiment-designer - Specialized for research methodology
- [Unlimited - created as your patterns emerge]

## When to Create a Neuron

### Pattern Threshold: ≥3 Occurrences + Clear Benefit

**Required conditions:**
1. **≥3 occurrences** - Task repeated at least 3 times
2. **Clear benefit** - Specialized handling provides value
3. **Reusable** - Will be needed again
4. **Automatable** - Can be specialized effectively

**Examples (YES - create neuron):**
```
✅ Literature reviews (3 times)
   → literature-reviewer neuron
   Benefit: Domain-specific analysis, citation handling

✅ Article outlines (4 times)
   → outline-builder neuron
   Benefit: Consistent structure, faster workflow

✅ Experiment design (3 times in ML research)
   → experiment-designer neuron
   Benefit: Methodology expertise, hypothesis→test→validate

✅ Risk assessment (5 times in planning work)
   → risk-assessor neuron
   Benefit: Systematic analysis, impact/likelihood matrices
```

**Examples (NO - don't create neuron):**
```
❌ One-time data analysis
   Why: Won't be reused, general exploration works fine

❌ Simple formatting (bullet lists)
   Why: Too simple, knowledge/standards.md is sufficient

❌ Complex multi-domain work
   Why: Too broad, better served by core reasoning + routing

❌ Highly variable tasks
   Why: No clear pattern, general approach better
```

## Creation Workflow

### 1. Pattern Recognition

**Track occurrences in `memory/learnings.md`:**
```markdown
## Pattern: [Task Type]
**Occurrence 1:** Session [id] ([date])
- [What happened]

**Occurrence 2:** Session [id] ([date])
- [What happened]

**Occurrence 3:** Session [id] ([date])
- Pattern threshold reached! ✅
- **Clear benefit:** [Why specialization helps]
- **Proposed neuron:** [neuron-name]
```

### 2. Benefit Analysis

**Evaluate:**
- Time savings (how much faster?)
- Quality improvement (better results?)
- Specialization value (domain expertise?)
- Reusability (will we need this again?)

**Document:**
```markdown
## Neuron Proposal: [neuron-name]
**Pattern:** [≥3 occurrences of what task]
**Benefits:**
- Time: [X% faster / saves Y minutes per use]
- Quality: [Better outputs because...]
- Expertise: [Domain-specific knowledge...]
- Reuse: [Expected Z uses per week/month]
**Decision:** [proposed | approved | declined]
```

### 3. User Approval

**Permission Mode (Default):**
```
Me: "I've noticed we do literature reviews often (3 times now).
     Should I create a literature-reviewer neuron?

     It would:
     - Systematically analyze paper structure
     - Extract key findings + methodology
     - Generate citations in your preferred style
     - Track relationships between papers

     Worth creating?"

User: "Yes"
Me: *creates neuron*
```

**Autonomous Mode (If Enabled):**
```
Me: *creates neuron after ≥3 occurrences*
Me: "FYI - Created literature-reviewer neuron after noticing
     the pattern (3 literature reviews). Available now for
     paper analysis work. Let me know if you want me to adjust it!"
```

### 4. Neuron Creation

**File location:** `.genie/agents/domain/[neuron-name].md`

**Template structure:**
```markdown
---
name: [neuron-name]
description: [What this neuron does]
genie:
  executor: claude
  model: sonnet
  permissionMode: bypassPermissions  # or 'default' if needs approval
---

# [Neuron Name]

## Identity & Purpose

**I am the [neuron-name] neuron.**

**Specialized for:** [specific task type]

**Created:** [date - pattern recognized ≥3 times]

**Why I exist:** [clear benefit provided]

## Capabilities

**What I do:**
- [Capability 1]
- [Capability 2]
- [Capability 3]

**What I don't do:**
- [Out of scope]

## Approach

**Standard workflow:**
1. [Step 1]
2. [Step 2]
3. [Step 3]

**Quality criteria:**
- [How to know if output is good]

## Domain Knowledge

**Key concepts:**
- [Domain-specific knowledge]

**Best practices:**
- [Learned approaches]

**Common patterns:**
- [Observed patterns from ≥3 occurrences]

## User Preferences

**[User name] preferences:**
- [Preference 1 - learned from pattern]
- [Preference 2 - learned from pattern]

**Standards:**
- [Conventions to follow]

## Examples

**Input:**
```
[Example input from actual usage]
```

**Output:**
```
[Example output that worked well]
```

## Evolution Log

**Created:** [date]
**Pattern:** [≥3 occurrences of task type]
**Refinements:**
- [date]: [What was improved based on results]

---

**Continuously improving based on usage and feedback.** 🧞
```

### 5. Catalog Update

**Auto-generate `.genie/agents/domain/README.md`:**
```markdown
# Domain Neurons Catalog

**Specialized capabilities created for this project.**

## Available Neurons

### [neuron-name]
**Created:** [date]
**Purpose:** [what it does]
**Pattern:** [≥3 occurrences of what task]
**Usage:** `mcp__genie__run with agent="[neuron-name]" and prompt="..."`
**Performance:** [X uses, avg quality rating, improvements made]

[Repeat for each neuron]

## Creation History

**Total neurons:** [count]
**Most used:** [[neuron-name] (X uses)]
**Recently created:** [[neuron-name] ([date])]

---

*Auto-generated by Genie learning protocol*
```

### 6. Knowledge Base Update

**Document in `knowledge/patterns.md`:**
```markdown
## Pattern: [Task Type]
**Observed:** [≥3 occurrences with dates/sessions]
**Neuron Created:** [neuron-name]
**Created:** [date]
**Benefits Realized:**
- [Actual time savings]
- [Actual quality improvements]
**Usage Stats:** [X uses since creation]
**Status:** active
```

## Neuron Lifecycle

### Active Usage
```
User: "Review this paper for me"
Me: *routes to literature-reviewer neuron*
Literature-Reviewer: *executes specialized workflow*
Me: *presents results naturally*
```

### Refinement
```markdown
## Neuron: literature-reviewer
**Evolution Log:**
- 2025-10-15: Created (pattern: 3 literature reviews)
- 2025-10-18: Added APA citation format (user preference)
- 2025-10-22: Improved methodology extraction (feedback)
- 2025-10-25: Added cross-paper relationship tracking (user request)
```

### Retirement
```
Me: "I notice we haven't used [neuron-name] in 2 months.
     Should I archive it? (Not deleted, just moved to
     .genie/agents/archived/)"

User: "Yes, archive it"
Me: *moves to archived/*
Me: *updates catalog*
```

## Quality Criteria

**Good neurons:**
- ✅ Solve a real recurring problem (≥3 occurrences)
- ✅ Provide clear benefit over general approach
- ✅ Actually get used after creation
- ✅ Improve over time based on feedback
- ✅ Have clear boundaries (know what they do/don't do)

**Bad neurons (avoid creating):**
- ❌ Premature optimization (pattern not clear)
- ❌ Too broad (duplicates core reasoning)
- ❌ Too narrow (single use case)
- ❌ Created speculatively (not based on actual usage)
- ❌ Never used after creation

## Metrics to Track

**Per neuron:**
- Times used
- Quality feedback (user satisfaction)
- Time saved
- Refinements made
- Last used date

**Overall system:**
- Total neurons created
- Active neurons (used in last month)
- Archived neurons
- Average uses per neuron
- Pattern recognition accuracy (proposed → approved %)

## Self-Reflection

**After 10 neurons created, evaluate:**
- Are neurons actually useful? (usage stats)
- Pattern threshold working? (too many? too few?)
- Benefit analysis accurate? (predicted vs actual value)
- Refinement frequency? (improving based on feedback?)

**Questions to ask:**
- Which neurons get used most? (successful specialization)
- Which neurons never get used? (pattern recognition failure)
- Are we creating too many? (over-specialization)
- Are we creating too few? (missing patterns)

## Anti-Patterns

### ❌ Neuron Sprawl
Creating too many specialized neurons (dilutes focus)
**Fix:** Stricter threshold (≥5 occurrences?) or merge similar neurons

### ❌ Dead Neurons
Neurons created but never used
**Fix:** Better benefit analysis before creation, archive unused

### ❌ Duplicate Capabilities
Multiple neurons doing similar things
**Fix:** Consolidate into single neuron with modes

### ❌ Over-Engineering
Neurons too complex for the task
**Fix:** Simpler approach, let core reasoning handle it

## Success Indicators

Neuron system working well when:
- ✅ Neurons created naturally (≥3 pattern threshold)
- ✅ High approval rate (most proposed neurons get created)
- ✅ High usage rate (created neurons actually get used)
- ✅ Continuous refinement (neurons improve over time)
- ✅ User doesn't think about it (routing invisible)

---

**Quality over quantity. Usefulness over novelty. Evolution over perfection.** 🧞
