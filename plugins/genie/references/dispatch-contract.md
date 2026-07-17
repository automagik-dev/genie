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
3. Every concurrent execution group owns a dedicated branch and worktree, even when expected file scopes are disjoint.
4. A group worktree has one writer at a time and persists across engineer and fixer handoffs.
5. The engineer commits and reports completion; it never marks the task done.
6. A different reviewer checks that exact commit in an ephemeral read-only worktree.
7. FIX-FIRST returns a separate fixer to the group worktree and then uses a fresh reviewer, at most three loops.
8. The PM merges reviewed group commits into the wish integration worktree and owns merge order and conflict resolution.
9. Only the orchestrator runs `genie task done <task-id>` after integrated validation and removal of the clean group
   worktree and merged branch.

Task completion notifications are push-based. Do not poll a running subagent. Use the active runtime's native follow-up or interrupt surface when it is exposed; if it is not, re-dispatch once with curated context rather than claiming an undocumented cross-client API.

## Wish mainline boundary

- When `main` tracks a GitHub remote's `main`, wishes ship through reviewed PRs. Local `main` is fast-forwarded and
  proven equal to that fetched ref before work and after merge evidence; direct local feature merges are forbidden.
- With zero configured remotes, the PM validates a temporary merge candidate, archives the exact integrated closure
  commit, removes its clean active lanes, and then fast-forwards unchanged local `main` to that archived commit.
- Non-GitHub or ambiguous remote topology requires an explicit user decision.

## Role map

| Need | Codex profile when installed | Required boundary |
|------|------------------------------|-------------------|
| Small mechanical change | `genie_engineer_trivial` | Workspace write, claimed task |
| Normal implementation | `genie_engineer_standard` | Workspace write, claimed task |
| Cross-module/stateful work | `genie_engineer_complex` | Workspace write, claimed task |
| Discovery | `genie_scout` | Read-only |
| Review | `genie_reviewer` | Built-in `:read-only`; report write-requiring checks as blocked |
| Surgical correction | `genie_fixer` | Workspace write; never self-review |
| Aggregate gate | `genie_final_gate` | Read-only |

The profile pins reasoning/sandbox policy, not the lifecycle decision. The wish owns complexity, acceptance criteria, and dependencies; the dispatch brief owns the group's worktree path and branch.
