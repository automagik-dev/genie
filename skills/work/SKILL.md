---
name: work
description: "Execute an approved wish plan - dispatches implementor subagents per task with bounded fix loops and verification until done."
---

# /work

Execute an approved wish from `.genie/wishes/<slug>/wish.md`.

## Flow
1. **Load wish + status:** confirm scope and current progress.
2. **Pick next task:** select next unblocked pending execution group.
3. **Dispatch implementor:** implement from wish + criteria (prefer TDD).
4. **Spec review:** check acceptance criteria; if fail, fix (max 3 loops).
5. **Quality review:** security/maintainability/perf check; if fail, fix (max 2 loops).
6. **Validate:** run the group validation command and record evidence.
7. **Mark complete:** update task state and wish checkboxes.
8. **Repeat** until all groups are done.
9. **Handoff:** `All work tasks complete. Run /review.`

## Escalation
If loop limit is exceeded:
- mark task BLOCKED,
- create follow-up task with concrete gaps,
- continue with next unblocked task,
- include blocked items in handoff.

## Rules
- Do not expand scope during execution.
- Do not skip validation commands.
- Keep work auditable: capture commands + outcomes.
- Prefer subagents for implementation and verification.
