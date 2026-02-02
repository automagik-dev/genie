---
name: "forge"
description: "Use when executing an approved wish plan - dispatches implementor subagents per task with two-stage review (spec + quality) and fix loops"
---

# Forge - Execute the Plan

## Overview

Execute an approved wish by working through each task sequentially. For each task: dispatch an implementor, run spec review, run quality review, fix if needed, mark complete.

**Never implements directly. Always dispatches subagents.**

---

## The Flow

### 1. Load Wish

```
Read .genie/wishes/<slug>/wish.md
Parse execution groups and tasks
Verify wish status is DRAFT or IN_PROGRESS
Update wish status to IN_PROGRESS
```

### 2. Find Next Task

```
TaskList → find next unblocked pending task
If no tasks remain → proceed to handoff
TaskUpdate → mark task as in_progress
```

### 3. Dispatch Implementor

Launch a subagent via the Task tool:

```
Task tool dispatch:
  subagent_type: general-purpose
  prompt: |
    You are the implementor agent.

    Read the wish document at: .genie/wishes/<slug>/wish.md

    Your task: [task description from TaskGet]

    Acceptance criteria:
    - [criteria from wish document]

    Follow TDD discipline:
    1. Write failing test (RED)
    2. Implement to pass (GREEN)
    3. Clean up (REFINE)

    Validation command: [from wish]

    When done, report what you implemented and verification results.
```

**The implementor reads the wish from disk** (not from prompt injection). The prompt tells it WHERE to read, not WHAT to do in full detail.

### 4. Spec Review

After implementor completes, dispatch spec-reviewer:

```
Task tool dispatch:
  subagent_type: general-purpose
  prompt: |
    You are the spec-reviewer agent.

    Wish: .genie/wishes/<slug>/wish.md
    Task: [task name]
    Acceptance criteria: [from wish]

    Check each acceptance criterion. Verdict: PASS or FAIL.
    If FAIL, explain what's missing and how to fix it.
```

**If FAIL:** Dispatch implementor again with the gap feedback. Loop up to 3 times.

### 5. Quality Review

After spec-reviewer PASSES, dispatch quality-reviewer:

```
Task tool dispatch:
  subagent_type: general-purpose
  prompt: |
    You are the quality-reviewer agent.

    Review the changes made for task: [task name]
    Check: security, maintainability, performance, correctness.

    Verdict: SHIP or FIX-FIRST with severity-tagged findings.
```

**If FIX-FIRST:** Dispatch implementor with the quality findings. Loop up to 2 times.

### 6. Mark Task Complete

```
TaskUpdate → mark task as completed
Update wish document checkboxes if applicable
```

### 7. Next Task

Return to step 2 until all tasks are complete.

### 8. Handoff

```
All tasks complete.
Output: "All forge tasks complete. Run /forge-review for validation."
```

---

## Specialist Routing

The implementor handles most tasks. For specialized needs, adjust the dispatch:

| Task Type | Agent | When |
|-----------|-------|------|
| Implementation | implementor | Default for all coding tasks |
| Test-only | tests | When task is purely about test coverage |
| Bug fix | fix | When task is fixing a specific bug |
| Refactoring | refactor | When task is purely structural improvement |
| Git operations | git | When task involves branch/commit/push |

---

## Fix Loop Protocol

```
Max spec review loops: 3
Max quality review loops: 2

If max loops exceeded:
  - Mark task as BLOCKED
  - Create new task describing the unresolved issue
  - Continue to next unblocked task
  - Report blocked task in handoff summary
```

---

## Key Principles

- **Never implement directly** - Always dispatch subagents via Task tool
- **Implementor reads wish from disk** - Don't inject the entire wish into the prompt
- **Spec before quality** - Verify correctness before polish
- **Fix loops are bounded** - Don't loop forever, escalate blocked tasks
- **One task at a time** - Sequential execution, clear state tracking
- **Update wish document** - Check off criteria as they're verified

---

## Never Do

- Implement code directly (dispatch subagents)
- Skip spec review after implementation
- Skip quality review after spec passes
- Loop more than 3 times on spec review
- Loop more than 2 times on quality review
- Move to next task before current one passes both reviews
- Modify the wish document's scope (that's wish skill territory)
- Dispatch parallel implementors for dependent tasks
