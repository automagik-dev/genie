# Genie Lifecycle & v5 Execution Model

Every piece of work follows this flow:

```
 Idea → brainstorm → wish → review → work → review → PR → Ship
         (explore)    (plan)   (gate)   (build)  (verify)
```

## Persisted lifecycle state

A review verdict and a wish status are different things. `SHIP`, `FIX-FIRST`,
and `BLOCKED` are evidence returned by a reviewer. The `Status` field in
`WISH.md` is the durable routing state consumed after a restart:

| WISH status | Meaning | Next route |
|-------------|---------|------------|
| `DRAFT` | Plan exists but has not passed plan review | `wish`, then plan `review` |
| `FIX-FIRST` | Plan review found blocking gaps | `fix`, then plan `review` |
| `APPROVED` | Plan review returned SHIP and the plan is ready | `work` or `genie launch <slug>` |
| `IN_PROGRESS` | At least one execution group has started; execution/PR gates are not complete | resume `work` or the recorded corrective route |
| `BLOCKED` | A recorded external, environment, or specification blocker prevents progress | resolve the recorded blocker, then resume the prior stage |
| `SHIPPED` | The authorized merge and required QA/release gate completed | terminal/history only |

The invoking orchestrator is the single mutation owner. After a reviewer sends
its final evidence, the orchestrator appends a timestamped entry under
`## Review Results` and applies the transition: plan SHIP → `APPROVED`; plan
FIX-FIRST → `FIX-FIRST`; plan BLOCKED → `BLOCKED`; beginning execution →
`IN_PROGRESS`; execution FIX-FIRST/BLOCKED stays `IN_PROGRESS` unless a real
external blocker is recorded; authorized merge plus required QA → `SHIPPED`.
The reviewer remains read-only and never edits WISH.md or task state. A chat
verdict that was not persisted does not advance the lifecycle.

## Skill Catalog

| Skill | Purpose | When to use |
|-------|---------|-------------|
| `brainstorm` | Explore ambiguous ideas interactively; tracks Wish Readiness Score, crystallizes into a design | Idea is fuzzy, scope unclear |
| `wish` | Convert a design into a structured plan at `.genie/wishes/<slug>/WISH.md` — scope, execution groups, acceptance criteria, validation | Idea is concrete, needs a plan |
| `review` | Genie criteria gate — SHIP / FIX-FIRST / BLOCKED with severity-tagged gaps | Before and after `work`, or any plan/PR |
| `work` | Execute an approved wish — dispatch native subagents per group in waves, fix loops, validation | Wish is SHIP-approved |
| `fix` | Resolve FIX-FIRST gaps, re-review, escalate after 2 failed loops | Review returned FIX-FIRST |
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
