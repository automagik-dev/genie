# Genie — Agent Orchestration (v5)
Genie is zero-daemon: docs live in git, task state in SQLite. Load `/genie` for full guidance.

## Dispatch — native teams
- Give every concurrent execution group its own branch and worktree; never place two writers in one checkout.
- Spawn workers with the **Agent tool** in those group worktrees: one call per execution group, all groups in a single message for parallel waves; workers run in the background and notify on completion.
- Follow-ups via **SendMessage**; each worker's final report returns as its Agent tool result. Push, not poll.
- Multi-session cockpit: `genie launch <slug> [--groups <csv>]` — one pane per ready group.

## Task DB — the shared truth
```bash
genie task checkout <id> --worker <name>  # worker atomically claims its task
genie task status <id>                    # task detail + stage log
genie task list --json                    # all task state
genie board --wish <slug> --json          # wish progress
genie task done <id>                      # ORCHESTRATOR, after merge, validation, and lane cleanup
```

## Never
- Terminal-scrape (`tmux capture-pane`) or sleep-poll workers — use the primitives above; a hook nudges this.
- Workers marking their own tasks done — `done` is the orchestrator's verb, post-review.
- Force-removing dirty/unmerged worktrees or branches — completed clean lanes are garbage-collected only after merge proof.
- Locally merge a wish into GitHub-backed `main` — use reviewed PRs, then fast-forward local `main` to its remote.

With zero configured remotes, the PM may validate a temporary candidate, archive that exact integrated closure as
`archive/wish/<slug>`, remove its clean active lanes, and then fast-forward unchanged local `main` to it. Other remote
topologies require a user decision.
