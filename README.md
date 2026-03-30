<p align="center">
  <picture>
    <img src=".github/assets/genie-header.png" alt="Genie" width="800" />
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@automagik/genie"><img alt="npm version" src="https://img.shields.io/npm/v/@automagik/genie?style=flat-square&color=00D9FF" /></a>
  <a href="https://github.com/automagik-dev/genie"><img alt="GitHub" src="https://img.shields.io/github/stars/automagik-dev/genie?style=flat-square&color=00D9FF" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/automagik-dev/genie?style=flat-square&color=00D9FF" /></a>
  <a href="https://discord.gg/xcW8c7fF3R"><img alt="Discord" src="https://img.shields.io/discord/1095114867012292758?style=flat-square&color=00D9FF&label=discord" /></a>
</p>

<h2 align="center">Wishes in, PRs out.</h2>

<!-- METRICS:START -->

| Metric | Value | Updated |
|--------|-------|---------|
| Releases/day | **0** | 2026-03-30 |
| Avg merge time | **0.3h** | 2026-03-30 |
| SHIP rate | **84%** | 2026-03-30 |
| Merged PRs (7d) | **32** | 2026-03-30 |

<!-- METRICS:END -->

## What is Genie?

Genie is an AI orchestration CLI that turns vague ideas into shipped PRs. You describe the problem — Genie interviews you, plans the work, dispatches parallel agents, and reviews the code. You approve and ship.

## Get Started

**Prerequisites:** curl, bash, git (pre-installed on macOS/Linux/WSL)

```bash
curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/install.sh | bash
genie
/wizard
```

The wizard handles everything: project scaffold, identity, first wish, execution, and review.

## How It Works

```
 You describe an idea
  └─ /brainstorm ─── Genie asks clarifying questions until the idea is concrete
      └─ /wish ───── Crystallizes intent into a plan with scope + acceptance criteria
          └─ /work ── Agents spawn in isolated worktrees, execute in parallel
              └─ /review ── Automated severity-gated review. You approve the PR.
```

## Features

### Orchestration
- **Wish pipeline** — Brainstorm, plan, execute, review, ship. One continuous flow.
- **Parallel agents** — Multiple agents work simultaneously in isolated worktrees.
- **Automated review** — Severity-tagged gaps. Nothing ships with CRITICAL issues.
- **10-critic council** — 10 specialist perspectives critique your design before you commit.
- **Overnight mode** — Queue wishes before bed. Wake up to reviewed PRs.

### Task Management
- **Boards** — Kanban-style pipelines with columns, gates, and WIP limits. Create from templates or build your own.
- **Tasks** — Full lifecycle: create, assign, move through stages (`draft` → `brainstorm` → `wish` → `build` → `review` → `qa` → `ship`), block/unblock, add dependencies.
- **Projects** — Named task boards that scope work to a specific initiative.
- **Tags, types, releases** — Organize tasks with custom tags, define task types with stage pipelines, group work into releases.

### Observability
- **Events** — Audit log with error aggregation, cost breakdown, tool analytics, and per-entity timelines.
- **Metrics** — Machine snapshots, heartbeat history, per-agent resource usage.
- **Sessions** — List, replay, and full-text search across Claude Code session transcripts.
- **Unified log** — `genie log --follow` streams transcript, messages, tool calls, and state changes from the PG event log in one feed.

### Infrastructure
- **Postgres-backed** — All state in PostgreSQL (pgserve). Tasks, messages, events, metrics — queryable with `genie db query`.
- **Scheduling** — Cron-based triggers with a systemd daemon. Heartbeat collection and orphan reconciliation built in.
- **Export/Import** — Full backup and restore across boards, tasks, tags, projects, schedules, agents, and conversations.
- **PG messaging** — Direct messages, broadcasts, threaded conversations, and inbox — all persisted and searchable.

### Developer Experience
- **14 built-in skills** — `/brainstorm`, `/wish`, `/work`, `/review`, `/council`, `/dream`, `/trace`, `/fix`, `/report`, `/refine`, `/learn`, `/docs`, `/genie`, `/wizard`.
- **BYOA** — Bring your own agent. Works with Claude, Codex, or any OpenAI-compatible provider.
- **Portable context** — Identity, skills, memory — markdown files you own, git-versioned.
- **QA system** — Self-testing specs with `genie qa run`. Validates CLI correctness continuously.

### CLI at a Glance

46 commands across agent lifecycle, task management, boards, observability, messaging, and infrastructure. [Full CLI reference →](https://docs.automagik.dev/genie/cli/session)

```bash
genie spawn engineer --model sonnet     # Spawn an agent
genie task create "Add dark mode"       # Create a task
genie board show                        # View your Kanban board
genie events costs --last 24h           # Check API spend
genie log --follow --team my-team       # Stream team activity
genie export all -o backup.json         # Full backup
```

---

<p align="center">
  <a href="https://docs.automagik.dev/genie"><strong>Documentation</strong></a> &middot;
  <a href="https://github.com/automagik-dev/genie"><strong>GitHub</strong></a> &middot;
  <a href="https://discord.gg/xcW8c7fF3R"><strong>Discord</strong></a> &middot;
  <a href="LICENSE"><strong>MIT License</strong></a>
</p>

<p align="center">
  <sub>You make the decisions. Genie does everything else.</sub>
</p>
