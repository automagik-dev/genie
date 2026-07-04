# Mutation Gates

The rules that keep the Hermes-native surface read-only, and the gate every future mutation must pass.

## Read-only MVP boundary

- Every tool, slash command, hook, and skill in this plugin reports `mutation: "none"` and performs no state writes — no task claims, no dispatch, no sends, no writes under `.genie/`.
- The only subprocess surface is the argv-only bridge to read-only genie subcommands: `doctor --json`, `board --json`, `task list --json`, `task status <id>`, and `launch <slug> --dry-run`.
- The dry-run line is the boundary: `genie_work_plan` runs `genie launch <slug> --dry-run`, which prints the dispatch plan and touches nothing. Executing a real `genie launch` is a mutation and is out of scope here.

## Deferred mutation tools

These capabilities are deliberately not shipped. Adding any of them is a new wish with its own review — and at runtime, each individual invocation requires explicit human approval.

| Deferred capability | Would wrap | Why it is gated |
|---------------------|------------|-----------------|
| `genie_task_checkout` | `genie task checkout <id> --worker <name>` | claims a task — changes worker assignment and board truth |
| `genie_task_done` | `genie task done <ref>` | marks work complete — changes board truth |
| executing `genie launch` | `genie launch <slug>` (without `--dry-run`) | creates worktrees and branches, dispatches agents |
| spawn / send | any agent spawn or message dispatch | starts or steers autonomous work |

## Human-gate rule

Every mutation-capable invocation requires explicit human approval, requested with a human-gate packet:

- **What** — the exact command/argv to run, the target repo and working directory, and the state it will change.
- **Why** — the wish/task justification and the expected outcome.
- **Rollback** — the concrete undo path (task reset, branch/worktree deletion, revert), or an explicit statement that none exists.

No packet, no approval, no mutation. This mirrors the HUMAN-GATE evidence contract in the Genie Hermes profile seed (`profiles/hermes/genie/README.md`).

## Repo-state facts to check before approving

Four facts an operator must verify before approving any mutation — all answerable with the read-only surface plus `git status`:

1. **Working directory** — the packet's `cwd` points at the intended repo/worktree. `genie_status` echoes the resolved `cwd` and confirms `.genie/` presence.
2. **Branch / worktree target** — which branch or worktree the mutation lands on, and that it is not a protected branch (e.g. `main`). `genie_work_plan` shows the exact worktrees and branches a launch would create.
3. **Working-tree cleanliness** — no uncommitted or unrelated changes on the target that the mutation could clobber or entangle (`git status` on the target checkout).
4. **Board/task truth** — the affected wish and tasks are in the expected state (`genie_board`, `genie_wish_status`, `genie_task_status`): the task is ready, not already claimed or in progress by another worker, and its dependencies are done.

If any of the four cannot be established, the answer is no.
