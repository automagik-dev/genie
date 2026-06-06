<p align="center">
  <img src=".github/assets/genie-header.png" alt="Genie" width="800" />
</p>

<p align="center"><strong>Wishes in, PRs out.</strong></p>

<p align="center">
  <a href="https://github.com/automagik-dev/genie/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/automagik-dev/genie?style=flat-square&color=00D9FF" /></a>
  <a href="https://github.com/automagik-dev/genie/stargazers"><img alt="stars" src="https://img.shields.io/github/stars/automagik-dev/genie?style=flat-square&color=00D9FF" /></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/github/license/automagik-dev/genie?style=flat-square&color=00D9FF" /></a>
  <a href="https://discord.gg/xcW8c7fF3R"><img alt="discord" src="https://img.shields.io/discord/1095114867012292758?style=flat-square&color=00D9FF&label=discord" /></a>
</p>

<br />

<!-- METRICS:START -->
**🚀 18 commits** this week · **0 releases** · **-52 LoC** · **4 contributors**

![Commits per day (30d, all branches)](.genie/assets/commits-30d.svg)

[📊 Full velocity dashboard →](VELOCITY.md)
<!-- METRICS:END -->

Genie is a CLI that turns one sentence into a finished pull request. You describe what you want — Genie interviews you, writes a plan, spawns parallel agents in isolated worktrees, reviews the code, and opens a PR. You approve. You merge. That's it.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/install.sh | bash
```

Every release is cosign-signed with SLSA provenance — the installer verifies the binary before it runs.

Then, in Claude Code, Codex, or any AI coding agent, run the onboarding wizard:

```text
/wizard
```

It interviews you, scaffolds the project, and walks you through your first wish. Prefer the cockpit? `genie` opens the terminal UI; `genie doctor` checks your install.

## What you get

```
  "Add dark mode"
       |
   /brainstorm ──── Genie asks questions until the idea is concrete
       |
   /wish ────────── Turns it into a plan: scope, criteria, task groups
       |
   /work ────────── Agents spawn in parallel worktrees, each on its own branch
       |
   /review ──────── A council of critics reviews. Severity-tagged. Nothing ships dirty.
       |
   Pull Request ─── You approve. You merge. Ship it.
```

**Parallel agents.** Multiple agents working at once in isolated worktrees. No conflicts, no re-explaining context.

**Teams.** Spin up a coordinated team of agents — shared mailbox and chat, with native Claude Code teammate UI.

**Automated review.** A council of specialist critics (architecture, security, DX, performance, ops…) reviews every change. Severity-tagged. CRITICAL blocks the merge.

**Overnight mode.** `/dream` — queue wishes before bed, wake up to reviewed PRs.

**Persistent memory.** A git-versioned knowledge brain — agents search it before answering and write back what they learn, so context compounds instead of resetting every session.

**Postgres-backed.** Tasks, events, and messages live in PostgreSQL — queryable, durable, real-time via LISTEN/NOTIFY. Your identity, skills, and memory stay as markdown in your repo.

**Self-healing.** Built-in detectors catch and recover from zombie teams, orphaned sessions, and drift automatically.

**Claude or Codex.** Bring your own agent — Genie drives either under the hood.

## Why Genie?

<table>
<tr>
<td width="50%">

### Without Genie

- Re-explain context every new chat
- One agent, one file at a time
- Copy-paste PR descriptions by hand
- Review AI code yourself, line by line
- No memory between sessions

</td>
<td width="50%">

### With Genie

- Context captured once, inherited by every agent
- Parallel agents in isolated worktrees
- Automated severity-gated review
- Queue wishes overnight, wake to PRs
- Persistent memory across sessions

</td>
</tr>
</table>

## Skills

17 built-in skills that compose into workflows:

| Skill | What it does |
|-------|-------------|
| `/brainstorm` | Explore vague ideas until they're concrete |
| `/wish` | Turn an idea into a scoped plan with acceptance criteria |
| `/work` | Execute a wish with parallel agents |
| `/review` | Severity-gated code review (SHIP or FIX-FIRST) |
| `/council` | Multi-agent architectural deliberation (smart-routed) |
| `/dream` | Batch-execute SHIP-ready wishes overnight |
| `/trace` | Reproduce, isolate, and root-cause bugs |
| `/fix` | Minimal targeted bug fixes |
| `/report` | Deep bug investigation → issue |
| `/refine` | Turn rough briefs into structured prompts |
| `/learn` | Correct agent behavior from mistakes |
| `/docs` | Audit and generate documentation |
| `/pm` | Full project-management playbook |
| `/omni` | Wire a Genie agent to an Omni channel |
| `/genie` | Auto-router — natural language to the right skill |
| `/genie-hacks` | Community patterns and real-world workflows |
| `/wizard` | Guided first-run onboarding |

## What's new in v4

A ground-up rewrite.

| | v3 | v4 |
|---|---|---|
| **State** | JSON files + NATS | PostgreSQL + LISTEN/NOTIFY (+ git-versioned markdown) |
| **UI** | CLI only | Full terminal UI |
| **Memory** | None | Knowledge brain |
| **Tasks** | Basic | Kanban boards, templates, projects |
| **Review** | Single pass | Critic-council deliberation |
| **Stability** | Best effort | Advisory locks, spawn watchdog, self-healing detectors |

[Full release notes →](https://github.com/automagik-dev/genie/releases/latest)

## Design

A single dark-only palette from one source of truth (`packages/genie-tokens/`), shared by three consumers (TUI, desktop app, tmux).

---

<p align="center">
  <a href="https://automagik.dev/genie"><strong>Docs</strong></a> &middot;
  <a href="https://github.com/automagik-dev/genie/releases/latest"><strong>Releases</strong></a> &middot;
  <a href="https://discord.gg/xcW8c7fF3R"><strong>Discord</strong></a> &middot;
  <a href="LICENSE"><strong>MIT License</strong></a>
</p>

<p align="center"><sub>You describe the problem. Genie does everything else.</sub></p>
