---
name: work
description: "Execute an approved wish plan — orchestrate subagents per task group with fix loops, validation, and review handoff."
---

# /work — Execute Wish Plan

Orchestrate execution of an approved wish from `.genie/wishes/<slug>/WISH.md`. The orchestrator never executes directly — always dispatch via subagent.

## Flow
1. **Load wish + status:** read `.genie/wishes/<slug>/WISH.md`, confirm scope and current progress.
2. **Pick next task:** select next unblocked pending execution group.
3. **Self-refine:** dispatch `/refine` on the task prompt (text mode) with WISH.md as context anchor. Read output from `/tmp/prompts/<slug>.md`. Fallback: proceed with original prompt if refiner fails (non-blocking).
4. **Dispatch worker:** send the task to a fresh subagent session (see Dispatch).
5. **Spec review:** dispatch `/review` subagent to check acceptance criteria. On FIX-FIRST, dispatch `/fix` (max 2 loops).
6. **Quality review:** dispatch `/review` subagent for quality pass (security, maintainability, perf). On FIX-FIRST, dispatch `/fix` (max 1 loop).
7. **Validate:** run the group validation command, record evidence.
8. **Mark complete:** update task state and wish checkboxes.
9. **Repeat** steps 2-8 until all groups done.
10. **Handoff:** `All work tasks complete. Run /review.`
11. **Close:** set `**Status:** SHIPPED` in wish file (replace existing Status line). Call `bd close <slug>` (log warning and continue if unavailable).

## When to Use
- An approved wish exists and is ready for execution
- Orchestrator needs to dispatch implementation tasks to subagents
- After `/review` returns SHIP on the plan

## Dispatch

Detect runtime: `Task` tool with `isolation: "worktree"` → Claude Code. `CODEX_ENV` set → Codex. Otherwise → OpenClaw. Default to Claude Code if ambiguous.

### Claude Code (primary)

```
TeamCreate("work-<slug>")

Task(
  model: "sonnet",
  isolation: "worktree",
  prompt: "<task prompt with acceptance criteria>",
  run_in_background: true
)
```

| Need | Method |
|------|--------|
| Implementation task | `Task` with `isolation: "worktree"`, `model: "sonnet"` |
| Review task | Separate `Task` subagent (never same agent as implementor) |
| Parallel tasks | Multiple `Task` calls with `run_in_background: true` |
| Quick validation | `Bash` tool directly — no subagent needed |

Coordinate via `SendMessage`. Clean up via `TeamDelete` after all workers report.

### Codex

```
codex_subagent(
  task: "<task prompt>",
  sandbox: true
)
```

Isolation and model managed by Codex runtime. Collect responses via native API.

### OpenClaw (via `term`)

Three-layer chain: OpenClaw → `term` → Claude Code → Teams.

```bash
# Heavy multi-file work with bead tracking
bd create "<task title>" --type task
term work <bead-id>

# Or spawn directly
term spawn --name "worker-<slug>" --model sonnet

# Monitor
term workers
term session read <session>
```

Fallback: `term work <task-name> --inline` when beads unavailable. Use timeouts — 3 layers of indirection can stall.

## Escalation

When a subagent fails or fix loop limit (2) is exceeded:
- Mark task **BLOCKED** in wish.
- Create follow-up task with concrete gaps.
- Continue with next unblocked task.
- Include blocked items in final handoff.

## Rules
- Never execute directly — always dispatch subagents.
- Never expand scope during execution.
- Never skip validation commands.
- Never overwrite WISH.md from workers — refined prompts are runtime context only.
- Keep work auditable: capture commands + outcomes.
