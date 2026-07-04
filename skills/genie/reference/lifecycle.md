# Genie Lifecycle & v5 Execution Model

Every piece of work follows this flow:

```
 Idea → /brainstorm → /wish → /review → /work → /review → PR → Ship
         (explore)    (plan)   (gate)   (build)  (verify)
```

## Skill Catalog

| Skill | Purpose | When to use |
|-------|---------|-------------|
| `/brainstorm` | Explore ambiguous ideas interactively; tracks Wish Readiness Score, crystallizes into a design | Idea is fuzzy, scope unclear |
| `/wish` | Convert a design into a structured plan at `.genie/wishes/<slug>/WISH.md` — scope, execution groups, acceptance criteria, validation | Idea is concrete, needs a plan |
| `/review` | Universal quality gate — SHIP / FIX-FIRST / BLOCKED with severity-tagged gaps | Before and after `/work`, or any plan/PR |
| `/work` | Execute an approved wish — dispatch native-team subagents per group in waves, fix loops, validation | Wish is SHIP-approved |
| `/fix` | Resolve FIX-FIRST gaps, re-review, escalate after 2 failed loops | Review returned FIX-FIRST |
| `/council` | Multi-perspective deliberation with specialist viewpoints | Major design decisions, tradeoffs |
| `/refine` | Transform a brief into a production-ready prompt | Prompt needs sharpening |
| `/report` | Investigate bugs — trace, capture evidence, open a GitHub issue | Bug reports |
| `/trace` | Reproduce and isolate root cause without patching | Unknown issues needing investigation |
| `/docs` | Audit, generate, and validate documentation against code | Docs stale or missing |
| `/dream` | Batch-execute SHIP-ready wishes overnight | Multiple wishes ready |
| `/learn` | Diagnose and fix agent behavioral surfaces | Recurring agent mistakes |
| `/pm` | Backlog triage, prioritization, tracking, reporting | Managing a stream of work |
| `/wizard` | First-run onboarding: scaffold, identity, first wish | New project setup |
| `/genie:omni` | Wire a Genie agent to an Omni channel | Channel wiring |
| `/genie-hacks` | Browse community patterns and hacks | Looking for prior art |

## v5 Execution Model (zero-daemon)

The v4 resident daemon, tmux worker fleet, and event bus are gone. v5 has three moving parts:

1. **Documents in git** — `.genie/wishes/<slug>/WISH.md`, `.genie/brainstorms/`, `.genie/INDEX.md`. Plans, acceptance criteria, and the group dependency DAG live here.
2. **State in SQLite** — `.genie/genie.db`, per-repo and shared across worktrees via the git common dir. `genie task` is the verb surface (`create`, `list`, `checkout`, `status`, `done`, `export`); `genie board` renders a kanban view by query. A separate global DB at `~/.genie/genie.db` holds only the Omni approval queue + inbox.
3. **Execution in native teams** — the orchestrator dispatches subagents with the Claude Code Agent tool and follows up via SendMessage. Completion is push (subagents notify when done), not poll.

### Task ↔ wish linkage

Execution groups defined in WISH.md map to task rows: `genie task create --wish <slug> --group <name>`. `/work` claims a group's task before executing it and completes it when review passes:

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

None required. The one optional foreground process is `genie omni serve` — the NATS bridge for Omni approvals and inbound chat routing (see the `/genie:omni` skill).

## Communication

- Same-session subagents: SendMessage (Claude Code native IPC).
- Cockpit panes are independent sessions — they coordinate through the shared task DB (atomic claims), not messages.
