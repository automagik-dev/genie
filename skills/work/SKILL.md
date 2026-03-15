---
name: work
description: "Execute an approved wish plan — orchestrate subagents per task group with fix loops, validation, and review handoff."
---

# /work — Execute Wish Plan

The engineer's skill, invoked via `genie work <agent> <ref>` dispatch. Orchestrate execution of an approved wish from `.genie/wishes/<slug>/WISH.md`. The orchestrator never executes directly — always dispatch via subagent.

## Context Injection

This skill receives its execution context from the dispatch layer:
- **Wish path** — `.genie/wishes/<slug>/WISH.md` in the shared worktree
- **Group context** — which execution group(s) to work on
- **Injected section** — the specific group definition extracted from the wish

If context is injected, use it directly. Do not re-parse the wish for information already provided.

## Flow
1. **Load wish:** read `.genie/wishes/<slug>/WISH.md` from the shared worktree, confirm scope.
2. **Pick next task:** select next unblocked pending execution group (or use injected group context).
3. **Self-refine:** dispatch `/refine` on the task prompt (text mode) with WISH.md as context anchor. Read output from `/tmp/prompts/<slug>.md`. Fallback: proceed with original prompt if refiner fails (non-blocking).
4. **Dispatch worker:** send the task to a fresh subagent session (see Dispatch).
5. **Local review:** run `/review` against the wish spec for this group's acceptance criteria before signaling done. On FIX-FIRST, dispatch fix subagent (max 2 loops).
6. **Quality review:** dispatch review subagent for quality pass (security, maintainability, perf). On FIX-FIRST, dispatch fix subagent (max 1 loop).
7. **Validate:** run the group validation command, record evidence.
8. **Signal completion:** notify the leader via `genie send 'Group N complete — all criteria met' --to <leader>`.
9. **Repeat** steps 2-8 until all groups done.
10. **Handoff:** `All work tasks complete. Run /review.`

## When to Use
- An approved wish exists and is ready for execution
- Orchestrator needs to dispatch implementation tasks to subagents
- After `/review` returns SHIP on the plan

## Dispatch

All dispatch uses the `genie spawn` command. The orchestrator spawns subagents for each role — never executes work directly.

```bash
# Spawn an engineer for the task
genie spawn engineer

# Spawn a reviewer (always separate from engineer)
genie spawn reviewer

# Spawn a fixer for FIX-FIRST gaps
genie spawn fixer
```

| Need | Method |
|------|--------|
| Implementation task | `genie spawn engineer` |
| Review task | `genie spawn reviewer` (never same agent as engineer) |
| Fix task | `genie spawn fixer` (separate from reviewer) |
| Quick validation | `Bash` tool directly — no subagent needed |

Coordinate via `genie send '<message>' --to <agent>`. Use `genie broadcast '<message>'` for team-wide updates.

## State Management

- **Workers signal** completion via `genie send` to the leader when a group is done.
- **Leader tracks** state via `genie status <slug>` and marks groups complete via `genie done <ref>`.
- Workers do NOT call `genie done` — that is the leader's responsibility after verifying the work.
- If a group gets stuck, the leader can use `genie reset <ref>` to retry.

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
- Run local `/review` per group before signaling done — never skip the review gate.
