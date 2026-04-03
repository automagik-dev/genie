<p align="center">
  <picture>
    <img src=".github/assets/genie-header.png" alt="Genie" width="800" />
  </picture>
</p>

<p align="center">
  <strong>Describe what you want. Wake up to pull requests.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@automagik/genie"><img alt="npm" src="https://img.shields.io/npm/v/@automagik/genie?style=flat-square&color=00D9FF" /></a>
  <a href="https://www.npmjs.com/package/@automagik/genie"><img alt="downloads" src="https://img.shields.io/npm/dm/@automagik/genie?style=flat-square&color=00D9FF" /></a>
  <a href="https://github.com/automagik-dev/genie/stargazers"><img alt="stars" src="https://img.shields.io/github/stars/automagik-dev/genie?style=flat-square&color=00D9FF" /></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/github/license/automagik-dev/genie?style=flat-square&color=00D9FF" /></a>
  <a href="https://discord.gg/xcW8c7fF3R"><img alt="discord" src="https://img.shields.io/discord/1095114867012292758?style=flat-square&color=00D9FF&label=discord" /></a>
</p>

<br />

<!-- TODO: Record a 30-second terminal demo with vhs/asciinema and uncomment this:
<p align="center">
  <img src=".github/assets/genie-demo.gif" alt="Genie demo — from wish to PR in 60 seconds" width="720" />
</p>
-->

Genie is a CLI that turns one sentence into a finished pull request. You describe what you want — Genie interviews you, writes a plan, spawns parallel agents in isolated worktrees, reviews the code with a 10-critic council, and opens a PR. You review. You merge. That's it.

```bash
curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/install.sh | bash
```

```bash
genie            # opens the TUI
/wish            # "Add dark mode with system preference detection"
# ... go get coffee. Come back to a reviewed PR.
```

---

## How it works

```
  "Add dark mode"
       |
   /brainstorm ──── Genie asks questions until the idea is concrete
       |
   /wish ────────── Turns it into a plan: scope, criteria, task groups
       |
   /work ────────── Agents spawn in parallel worktrees. Each gets its own branch.
       |
   /review ──────── 10 critics review. Severity-tagged. Nothing ships dirty.
       |
   Pull Request ─── You approve. You merge. Done.
```

---

## Why Genie?

<table>
<tr>
<td width="50%">

### Without Genie

- Re-explain context every time you open a new chat
- One agent, one file at a time
- Copy-paste PR descriptions manually
- Review AI code yourself, line by line
- "Can you also..." — context lost mid-conversation
- No memory between sessions

</td>
<td width="50%">

### With Genie

- Context captured once, inherited by every agent
- Parallel agents in isolated worktrees
- Automated severity-gated review before you see it
- Queue wishes overnight, wake up to reviewed PRs
- 10-critic council catches what you'd miss
- Persistent brain — agents remember everything

</td>
</tr>
</table>

---

## Features

| | Feature | What it does |
|---|---------|-------------|
| **🧞** | **Wish Pipeline** | Brainstorm → Plan → Execute → Review → Ship. One flow from idea to PR. |
| **⚡** | **Parallel Agents** | Multiple agents work simultaneously, each in its own worktree. No conflicts. |
| **🏛️** | **10-Critic Council** | Architecture, security, DX, performance, ops — 10 specialist perspectives on every design. |
| **🔍** | **Automated Review** | Severity-tagged findings. CRITICAL blocks the PR. You only see clean code. |
| **🌙** | **Overnight Mode** | `/dream` — queue wishes before bed. Wake up to reviewed PRs. |
| **📋** | **Kanban Boards** | Task boards with custom pipelines, WIP limits, and stage gates. |
| **🧠** | **Brain** | Optional knowledge graph with Obsidian vaults. Agents share context and memory. |
| **🗄️** | **Postgres-Backed** | All state in PG. Tasks, events, messages — queryable, durable, real-time. |
| **🖥️** | **Terminal UI** | Full TUI with session tree, system stats, and one-click agent management. |
| **🔌** | **Any AI Provider** | Claude, Codex, or any OpenAI-compatible model. Your agents, your choice. |
| **📦** | **Portable Context** | Identity, skills, memory — markdown files in your repo. Git-versioned. You own it. |
| **🔭** | **Full Observability** | Events, metrics, session replay, cost tracking. See everything your agents do. |

---

## Quick start

### Option 1: Paste into your AI agent

Copy this into Claude Code, Codex, or any AI coding agent:

```
Install Genie, then run /wizard to set up this project:

curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/install.sh | bash
genie
/wizard
```

### Option 2: Install manually

**Prerequisites:** curl, bash, git (pre-installed on macOS / Linux / WSL)

```bash
curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/install.sh | bash
genie
/wizard
```

The wizard handles everything: project scaffold, agent identity, first wish, execution, and review.

---

## Skills

14 built-in skills that compose into workflows:

| Skill | What it does |
|-------|-------------|
| `/brainstorm` | Explore vague ideas with guided questions |
| `/wish` | Turn an idea into a scoped plan with acceptance criteria |
| `/work` | Execute a wish with parallel agents |
| `/review` | Severity-gated code review (SHIP or FIX-FIRST) |
| `/council` | 10-perspective architectural deliberation |
| `/dream` | Batch-execute wishes overnight |
| `/trace` | Investigate bugs — reproduce, isolate, root cause |
| `/fix` | Minimal targeted bug fixes |
| `/report` | Deep investigation with browser + trace |
| `/refine` | Transform rough prompts into structured specs |
| `/learn` | Correct agent behavior from mistakes |
| `/docs` | Audit and generate documentation |
| `/pm` | Full project management playbook |
| `/wizard` | Guided first-run onboarding |

---

## CLI at a glance

```bash
genie                                  # Launch TUI
genie spawn engineer --model sonnet    # Spawn an agent
genie team create my-team --wish auth  # Multi-agent team on a wish
genie task create "Add dark mode"      # Create a task
genie board show                       # View your Kanban board
genie send 'check auth' --to engineer  # Message an agent
genie events costs --last 24h          # Check API spend
genie log --follow                     # Stream all activity
genie export all -o backup.json        # Full backup
```

46 commands. [Full CLI reference →](https://docs.automagik.dev/genie/cli/session)

---

## What's new in v4

v4 is a ground-up rewrite. 700 commits. 300 files changed. ~19K lines added.

| What changed | v3 | v4 |
|---|---|---|
| **State** | JSON files + NATS | PostgreSQL + LISTEN/NOTIFY |
| **Default UI** | CLI help | Full terminal UI |
| **Agent memory** | None | Brain with Obsidian vaults + pgvector |
| **Task management** | Basic | Kanban boards, templates, projects |
| **Observability** | Minimal | OTLP, session capture, audit trail |
| **Review** | Single pass | 10-critic council, real multi-agent deliberation |
| **Stability** | Best effort | Advisory locks, spawn watchdog, 205 bug fixes |

[Full v4 release notes →](https://github.com/automagik-dev/genie/releases/tag/v4.260402.18)

---

## Architecture

```
┌──────────────────────────────────────────────┐
│                  genie CLI                    │
├──────────┬──────────┬───────────┬────────────┤
│  Skills  │  Agents  │   Tasks   │   Events   │
│ 14 built │ spawn,   │  boards,  │ audit log, │
│ in + DIY │ resume,  │  kanban,  │ metrics,   │
│          │ teams    │  projects │ sessions   │
├──────────┴──────────┴───────────┴────────────┤
│              PostgreSQL (pgserve)              │
│  agents │ tasks │ events │ messages │ brain   │
├──────────────────────────────────────────────┤
│     Claude Code  /  Codex  /  any LLM         │
└──────────────────────────────────────────────┘
```

Genie orchestrates — it doesn't replace your AI coding tool. It adds structure, parallelism, review, and memory on top of whatever agent you already use.

---

## Community

- **[Discord](https://discord.gg/xcW8c7fF3R)** — Questions, show & tell, wish sharing
- **[GitHub Issues](https://github.com/automagik-dev/genie/issues)** — Bug reports and feature requests
- **[Documentation](https://docs.automagik.dev/genie)** — Full guides and CLI reference

---

<p align="center">
  <a href="https://docs.automagik.dev/genie"><strong>Docs</strong></a> &middot;
  <a href="https://github.com/automagik-dev/genie/releases/tag/v4.260402.18"><strong>v4 Release Notes</strong></a> &middot;
  <a href="https://discord.gg/xcW8c7fF3R"><strong>Discord</strong></a> &middot;
  <a href="LICENSE"><strong>MIT License</strong></a>
</p>

<p align="center">
  <sub>Wishes in, PRs out.</sub>
</p>
