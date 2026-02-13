---
name: work
description: "Execute an approved wish plan - dispatches implementor subagents per task with bounded fix loops and verification until done."
---

# /work

Execute an approved wish from `.genie/wishes/<slug>/wish.md`.

**Core principle: the orchestrator never executes directly. Always dispatch via subagent.**

## Flow
1. **Load wish + status:** confirm scope and current progress.
2. **Pick next task:** select next unblocked pending execution group.
3. **Dispatch subagent:** send the task to a fresh session (see Dispatch below).
4. **Spec review:** dispatch reviewer subagent to check acceptance criteria; if fail, dispatch `/fix` (max 2 loops).
5. **Validate:** run the group validation command and record evidence.
6. **Mark complete:** update task state and wish checkboxes.
7. **Repeat** until all groups are done.
8. **Handoff:** `All work tasks complete. Run /review.`

## Dispatch

The orchestrator dispatches work via `sessions_send` to fresh session keys. This creates an isolated subagent with clean context.

```
sessions_send(
  agentId: "<self>",
  sessionKey: "agent:<self>:worker-<group>-<timestamp>",
  message: "Implement Group A from wish <slug>: <goal>. Acceptance criteria: ...",
  timeoutSeconds: 120
)
```

The subagent executes, replies with results. Orchestrator collects and moves to next group.

### Route Selection

| Task needs… | Route | Example | Don't use for |
|-------------|-------|---------|---------------|
| Any implementation task | `sessions_send` to fresh key | Subagent with clean context | — |
| Multi-file coding (heavy) | `term work <bead>` | CC worker via claudio | Simple edits, reasoning-only |
| Quick validation only | `exec("command")` | Direct shell, immediate result | Complex multi-step work |
| Another agent's expertise | `sessions_send(agentId, msg)` | Cross-agent delegation via ClawNet | Tasks you can do locally |

**Default: `sessions_send` to fresh key.** Use `term work` for heavy coding. Use `exec` only for validation commands.

## Escalation
If a subagent fails or loop limit (2) is exceeded:
- mark task BLOCKED,
- create follow-up task with concrete gaps,
- continue with next unblocked task,
- include blocked items in handoff.

## Rules
- Orchestrator never executes directly — always dispatch subagents.
- Do not expand scope during execution.
- Do not skip validation commands.
- Keep work auditable: capture commands + outcomes.
