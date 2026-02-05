---
name: wish
description: "Use when starting non-trivial work that needs structured planning - converts ideas into wish documents with scope, acceptance criteria, and execution tasks."
---

# Wish - Turn Ideas Into Plans

## Overview

Convert a validated design (from `/brainstorm`) or direct request into a structured wish document. Create native Claude Code tasks for execution.

**Output:** `.genie/wishes/<slug>/wish.md` + native tasks ready for `/make`

---

## The Flow

### Phase 1: Brainstorm (if needed)

If coming from `/brainstorm`, the design is already validated. If starting fresh:

Enter plan mode to explore the codebase read-only. Understand the landscape before proposing anything.

**One question at a time. Multiple choice when possible.**

1. **Resonate** - Understand the intent
   - What does the user actually want? (not just what they said)
   - Ask clarifying questions, one at a time
   - Prefer multiple choice: "Which of these best describes what you want?"

2. **Explore approaches** - Propose 2-3 alternatives
   - Present options with trade-offs
   - Lead with your recommendation and explain why
   - Let the user choose (or propose something different)

3. **Align on scope** - Define boundaries
   - What's IN scope?
   - What's explicitly OUT of scope?
   - What assumptions are we making?

### Phase 2: Design (200-300 Word Sections)

Present the design incrementally. Check after each section.

**Sections to cover:**
- Summary (what and why, 2-3 sentences)
- Architecture approach
- Key decisions with rationale
- Risks and mitigations

### Phase 3: Plan (Bite-Sized Tasks)

Break the design into execution groups. Each task should be:
- **Small enough** to implement in one focused session
- **Testable** with clear acceptance criteria
- **Independent** where possible (minimize blocking dependencies)

**Per task, define:**
- What to do (deliverables)
- Acceptance criteria (checkboxes)
- Validation command (how to verify it worked)
- Files likely touched

### Phase 4: Write the Wish Document

Write to `.genie/wishes/<slug>/wish.md` using the template from `references/wish-template.md`.

**Required sections:**
- Status, Slug, Created date
- Summary (what and why)
- Scope (IN and OUT - OUT must not be empty)
- Decisions with rationale
- Success Criteria (checkboxes)
- Execution Groups with acceptance criteria and validation commands

### Phase 5: Create Native Tasks

After writing the wish document:
- Use `TaskCreate` for each execution group
- Set up `addBlockedBy` dependencies between tasks
- Include wish slug and group name in task description

### Phase 6: Handoff

After creating tasks, link them to the wish for tracking:

```bash
term task link <task-id> <wish-slug>   # Link task to wish
term wish status <slug>                 # Check wish progress
```

Output: **"Wish documented. Run `/plan-review` to validate, then `/make` to begin execution."**

---

## Key Principles

- **One question at a time** - Never ask multiple questions in one message
- **Multiple choice preferred** - Easier for users to answer
- **YAGNI ruthlessly** - Remove unnecessary features from all designs
- **Acceptance criteria are king** - Every task must have testable criteria
- **Validation commands required** - Every task must have a way to verify completion
- **Explore before proposing** - Read code before designing changes
- **Small tasks** - If a task feels big, split it

---

## Never Do

- Skip brainstorming and jump to plan writing
- Ask more than one question per message
- Create tasks without acceptance criteria
- Create tasks without validation commands
- Write a wish without user agreement on scope
- Start implementation during wish creation (plan mode only)
- Create overly broad tasks ("implement everything")
- Leave OUT scope empty (always exclude something explicitly)
