# Dispatch contract

Runtime-specific adapters for the shared `work`, `dream`, `review`, and `fix` workflows.

## Detect the active surface

Use the native subagent tools actually exposed in the current session. Do not infer Claude merely because a particular legacy tool name is absent, and do not emit invented calls such as `codex_subagent(...)`.

- Codex: prefer an installed `genie_*` profile matching the role. Plugin-only installations do not receive custom agents, so fall back to a suitable available role.
- Claude Code: use its available Agent surface and named role.
- Warp: use `genie launch` only when the user wants isolated, human-supervised panes; it is not a substitute for awaitable native delegation.

## State and ownership

1. The orchestrator creates one task per execution group.
2. The engineer's first command is `genie task checkout <task-id> --worker <name>`.
3. Parallel writers require disjoint file ownership or separate worktrees.
4. The engineer reports completion; it never marks the task done.
5. A different reviewer checks the exact criteria and evidence.
6. FIX-FIRST dispatches a separate fixer and then a separate re-reviewer, at most two loops.
7. Only the orchestrator runs `genie task done <task-id>` after SHIP and passing validation.

Task completion notifications are push-based. Do not poll a running subagent. Use the active runtime's native follow-up or interrupt surface when it is exposed; if it is not, re-dispatch once with curated context rather than claiming an undocumented cross-client API.

## Role map

| Need | Codex profile when installed | Required boundary |
|------|------------------------------|-------------------|
| Small mechanical change | `genie_engineer_trivial` | Workspace write, claimed task |
| Normal implementation | `genie_engineer_standard` | Workspace write, claimed task |
| Cross-module/stateful work | `genie_engineer_complex` | Workspace write, claimed task |
| Discovery | `genie_scout` | Read-only |
| Review | `genie_reviewer` | Read-only; temp/cache test writes only |
| Surgical correction | `genie_fixer` | Workspace write; never self-review |
| Aggregate gate | `genie_final_gate` | Read-only |

The profile pins reasoning/sandbox policy, not the lifecycle decision. The wish owns complexity, acceptance criteria, dependencies, and file scope.
