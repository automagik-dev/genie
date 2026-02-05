---
name: work
description: "Activate work mode. Enter focused session with clear context loading, goal orientation, and structured execution. Use when ready to tackle a task with full engagement."
---

# Work Mode Activation

**When `/work` is invoked, execute this framework:**

## Phase 1: Context Initialization (Always)

1. **Memory Check** — Search memory for:
   - Recent work on the topic (last 7 days)
   - Related decisions, patterns, preferences
   - Any ongoing work that might be affected

2. **Environment Scan** — Quick sweep of:
   - Current workspace state
   - Any running processes relevant to the work
   - Existing files that may be touched

3. **State Declaration** — Announce:
   ```
   WORK MODE ACTIVATED

   Context loaded:
   - [memory findings]
   - [environment state]

   Ready for task.
   ```

## Phase 2: Task Clarification

If the user provided a task with `/work <task>`:
- Parse the task intent
- Identify deliverables
- Surface any ambiguities before proceeding

If `/work` was invoked without args:
- Ask: "What are we working on?"

## Phase 3: Execution Loop

Enter focused execution:

1. **Plan** — Break task into concrete steps
2. **Execute** — Work through steps, committing progress
3. **Checkpoint** — After significant progress, brief status
4. **Iterate** — Continue until deliverable is complete

## Phase 4: Completion

When work is done:
1. Summarize what was accomplished
2. Note anything for future reference (-> memory)
3. Declare completion:
   ```
   WORK COMPLETE

   [summary of deliverables]
   ```

## Behavior Notes

- **Focus**: Minimize tangents. Stay on task.
- **Progress over perfection**: Deliver working increments.
- **Transparency**: Announce intentions before major actions.
- **Memory**: Update memory with decisions and context worth preserving.
- **Exit clean**: Leave the workspace in a good state.

---

*Work mode is structured engagement. Enter focused, exit with results.*
