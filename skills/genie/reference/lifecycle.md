# Genie Lifecycle & v5 Execution Model

Every piece of work follows this flow:

```
 Idea → brainstorm → design review → wish → plan review → work → implementation review → mainline integration → Ship
         (explore)   (design gate)    (plan)   (plan gate)  (build)       (verify)
```

The gates review different artifacts. For non-trivial work, `brainstorm` automatically routes the completed DESIGN.md
through read-only design review before `wish` may consume it. The resulting WISH.md must then pass plan review and persist
`APPROVED` before `work` starts. After execution, a different reviewer validates the implementation. Passing one gate
never substitutes for either of the others.

Design review has its own durable evidence block in DESIGN.md: verdict, reviewed-content SHA-256, reviewer identity, and UTC timestamp. The digest excludes only that bounded evidence block. Any later design edit invalidates the evidence, and `wish` plus the wish linter reject the linked design until a fresh review returns SHIP.

## Persisted lifecycle state

A review verdict and a wish status are different things. `SHIP`, `FIX-FIRST`,
and `BLOCKED` are evidence returned by a reviewer. The `Status` field in
`WISH.md` is the durable routing state consumed after a restart:

| WISH status | Meaning | Next route |
|-------------|---------|------------|
| `DRAFT` | Plan exists but has not passed plan review | `wish`, then plan `review` |
| `FIX-FIRST` | Plan review found blocking gaps | `fix`, then plan `review` |
| `APPROVED` | Plan review returned SHIP and the plan is ready | `work` or `genie launch <slug>` |
| `IN_PROGRESS` | At least one execution group has started; execution/mainline gates are not complete | resume `work` or the recorded corrective route |
| `BLOCKED` | A recorded external, environment, or specification blocker prevents progress | resolve the recorded blocker, then resume the prior stage |
| `SHIPPED` | Authoritative mainline integration and required QA/release gate completed | terminal delivery; finish any recorded archive/cleanup debt |

The invoking orchestrator is the single mutation owner. After a reviewer sends
its final evidence, the orchestrator appends a timestamped entry under
`## Review Results` and applies the transition: plan SHIP → `APPROVED`; plan
FIX-FIRST → `FIX-FIRST`; plan BLOCKED → `BLOCKED`; beginning execution →
`IN_PROGRESS`; execution FIX-FIRST/BLOCKED stays `IN_PROGRESS` unless a real
external blocker is recorded; proven mainline integration plus required QA → `SHIPPED`.
The reviewer remains read-only and never edits WISH.md or task state. A chat
verdict that was not persisted does not advance the lifecycle.

## Mainline ownership

The PM resolves repository mode before shipping:

- **GitHub-backed:** a configured `<remote>/main` GitHub upstream is authoritative. Before work, local `main` must be
  clean, fast-forwarded, and proven equal to that ref. Third-party PR merge makes remote `main` authoritative; the PM
  then attempts the same clean fast-forward/equality proof locally. A failed post-merge mirror is lifecycle debt. Genie
  never resets, force-pushes, or locally merges the wish into hosted `main`.
- **Local-only:** exactly zero configured remotes. The PM merges the finished wish in a temporary candidate worktree,
  resolves conflicts there, validates the exact candidate, records the closure commit, archives and cleans its lanes,
  then fast-forwards unchanged local `main` to that exact archived commit.
- **Other or ambiguous remotes:** require an explicit user-selected integration policy.

The GitHub PR plus archive tag, or the local archive tag, is durable closure evidence. Worktrees and local feature
branches represent active work only. A local failure before mainline promotion keeps the wish `IN_PROGRESS` and
preserves or recreates its lane. A hosted mirror, archive, or cleanup failure after remote merge is recorded lifecycle
debt: it cannot undo authoritative history, so the wish stays `SHIPPED`, any affected lane remains for retry, and
closure is not reported as fully clean.

Because WISH status is git-tracked, the PM stages `SHIPPED` plus completion evidence only in an exact candidate that has
already passed required QA, then reruns the candidate's final checks. In GitHub-backed mode that branch-local status is
not authoritative until third-party merge places it on remote `main`; failed local mirroring is recorded lifecycle debt.
In local-only mode archival and clean-lane removal happen first; it becomes authoritative only when unchanged local
`main` fast-forwards to that archived closure commit.

## Skill Catalog

| Skill | Purpose | When to use |
|-------|---------|-------------|
| `brainstorm` | Explore ambiguous ideas interactively; tracks Wish Readiness Score, crystallizes into a design | Idea is fuzzy, scope unclear |
| `wish` | Convert a design into a structured plan at `.genie/wishes/<slug>/WISH.md` — scope, execution groups, acceptance criteria, validation | Idea is concrete, needs a plan |
| `review` | Genie criteria gate — SHIP / FIX-FIRST / BLOCKED with severity-tagged gaps | Before and after `work`, or any plan/PR |
| `work` | Execute an approved wish — dispatch native subagents per group in waves, fix loops, validation | Wish is SHIP-approved |
| `fix` | Resolve FIX-FIRST gaps, re-review, escalate after 3 failed loops | Review returned FIX-FIRST |
| `council` | Multi-perspective deliberation with specialist viewpoints | Major design decisions, tradeoffs |
| `refine` | Transform a brief into a production-ready prompt | Prompt needs sharpening |
| `report` | Investigate bugs — trace, capture evidence, open a GitHub issue with confirmation | Bug reports |
| `trace` | Reproduce and isolate root cause without patching | Unknown issues needing investigation |
| `docs` | Audit, generate, and validate documentation against code | Docs stale or missing |
| `dream` | Batch-execute SHIP-ready wishes overnight | Multiple wishes ready |
| `pm` | Backlog triage, prioritization, tracking, reporting | Managing a stream of work |
| `wizard` | First-run onboarding: scaffold, identity, first wish | New project setup |
| `omni` | Wire a Genie agent to an Omni channel | Channel wiring |
| `genie-hacks` | Browse community patterns and hacks | Looking for prior art |

## v5 Execution Model (zero-daemon)

The v4 resident daemon, tmux worker fleet, and event bus are gone. v5 has three moving parts:

1. **Documents in git** — `.genie/wishes/<slug>/WISH.md`, `.genie/brainstorms/`, `.genie/INDEX.md`. Plans, acceptance criteria, and the group dependency DAG live here.
2. **State in SQLite** — `.genie/genie.db`, per-repo and shared across worktrees via the git common dir. `genie task` is the verb surface (`create`, `list`, `checkout`, `status`, `done`, `export`); `genie board` renders a kanban view by query. A separate global DB at `~/.genie/genie.db` holds only the Omni approval queue + inbox.
3. **Execution through native delegation** — the orchestrator delegates independent work through the active runtime's subagent surface, waits for completion notifications, and steers the same thread with native follow-up controls when available. Completion is push, not terminal polling.

### Task ↔ wish linkage

Execution groups defined in WISH.md map to task rows: `genie task create --wish <slug> --group <name>`. `work` checks out a group's task before executing it and completes it when review passes:

```bash
genie task checkout <id> --worker <name>   # atomic claim — one concurrent winner
genie task done <id>                       # recomputes the ready set
```

The checkout claim is atomic: exactly one concurrent claimant wins; the loser gets a typed conflict error. A task stuck `in_progress` becomes re-claimable once its claim passes the stale horizon (default 15 minutes).

### Warp cockpit

`genie launch <slug>` opens one Warp pane per ready group, each pane in its own worktree with a curated prompt. `--dry-run` prints the plan without touching anything; `--groups <csv>` scopes; `--agent claude|codex` picks the terminal agent. Worktrees share the main repo's task DB, so claims stay atomic across panes.

### Monitoring

```bash
genie board [--wish <slug>] [--json]   # kanban of current state
genie task status <id>                 # detail, dependencies, stage log
genie task list --status in_progress   # active claims
genie mcp                              # read-only stdio MCP server over the task DB
```

No terminal scraping, no sleep-polling — subagents notify on completion, and the orchestration-guard hook flags scraping patterns.

### Resident processes

None required. The one optional foreground process is `genie omni serve` — the NATS bridge for Omni approvals and inbound chat routing (see `omni`).

## Communication

- Same-session subagents: the active runtime's native follow-up messaging.
- Cockpit panes are independent sessions — they coordinate through the shared task DB (atomic claims), not messages.
