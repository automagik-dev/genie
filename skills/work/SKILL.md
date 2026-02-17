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
5. **Quality review:** dispatch reviewer subagent for quality pass (security, maintainability, perf); if fail, dispatch `/fix` (max 1 loop).
6. **Validate:** run the group validation command and record evidence.
7. **Mark complete:** update task state and wish checkboxes.
8. **Repeat** until all groups are done.
9. **Handoff:** `All work tasks complete. Run /review.`

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

### CC via term work

For heavy multi-file coding tasks, spawn a Claude Code worker:

```bash
bd create "task title" --type task   # get a bead ID
term work <bead-id>                  # spawns CC in tmux worktree
# if no beads: term work <bead-id> --inline
term workers                         # monitor running workers
term session read <session>          # read worker output
```

Worker runs autonomously. Returns via bead status update or session output.

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
