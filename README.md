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
**🚀 0 commits** this week · **0 releases** · **+0 LoC** · **0 contributors**

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

It interviews you, scaffolds the project, and walks you through your first wish. Run `genie doctor` any time to check your install.

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

**Parallel agents.** Multiple agents working at once in isolated worktrees, dispatched through Claude Code's native teams. No conflicts, no re-explaining context.

**Automated review.** Specialist critics (architecture, security, DX, performance, ops…) review every change. Severity-tagged. CRITICAL blocks the merge.

**Documents in git.** Wishes, designs, and brainstorms are plain markdown — you diff them, review them, and version them like any other code.

**One file of state.** Tasks, boards, and wish-group state live in a single per-repo SQLite file (`.genie/genie.db`), Bun's built-in engine. No server, no daemon, nothing resident.

**Claude today, more on the way.** Skills run natively in Claude Code now; Codex and Hermes emit targets are planned.

## Why Genie?

<table>
<tr>
<td width="50%">

### Without Genie

- Re-explain context every new chat
- One agent, one file at a time
- Copy-paste PR descriptions by hand
- Review AI code yourself, line by line
- Plans and decisions live in your head

</td>
<td width="50%">

### With Genie

- Context captured once, inherited by every agent
- Parallel agents in isolated worktrees
- Automated severity-gated review
- Wishes, designs, and brainstorms versioned in git
- One SQLite file of state — zero daemons, no Postgres

</td>
</tr>
</table>

## Skills

Skills carry the methodology. These compose into the core workflow and run natively in Claude Code today:

| Skill | What it does |
|-------|-------------|
| `/brainstorm` | Explore vague ideas until they're concrete |
| `/wish` | Turn an idea into a scoped plan with acceptance criteria |
| `/work` | Execute a wish with parallel agents |
| `/review` | Severity-gated code review (SHIP or FIX-FIRST) |
| `/refine` | Turn rough briefs into structured prompts |
| `/learn` | Correct agent behavior from mistakes |

Several more skills — `/council`, `/dream`, `/trace`, `/fix`, `/report`, `/docs`, `/pm`, `/omni`, `/genie` (the auto-router), `/genie-hacks`, and `/wizard` — shipped in v4 and are being ported to the v5 body. They're coming back.

## What's new in v5

v5 is a **lightweight body**. The v4 harness — Postgres, tmux orchestration, executor registries, the telemetry spine, the full-screen TUI and the desktop app — is gone. What remains is the part that always did the work: the skills and the `.genie` taxonomy.

- **Skills are the product.** brainstorm → wish → work → review, authored once, running natively in Claude Code.
- **Documents in git.** Wishes, designs, and brainstorms are markdown you diff and review.
- **State is one file.** Tasks, boards, and wish-group state live in a single per-repo SQLite file at `.genie/genie.db` — Bun's built-in engine, no server, no daemon.
- **Zero daemons, no Postgres.** Nothing resident.
- **Small.** 10 CLI commands, 3 runtime dependencies, a ~0.9 MB single-file binary.
- **Native dispatch.** `/work` fans agents out through Claude Code's native teams, each in its own worktree.

**On the way:** Warp as the multi-session driver (Genie emits Warp Launch Configurations — planned), the Omni channel integration (its state is being ported to `genie.db`; temporarily offline on the v5 line), and Codex and Hermes as additional emit targets (planned).

[Full release notes →](https://github.com/automagik-dev/genie/releases/latest)

## Design

Fewer moving parts, not fewer lines. Content plus glue: skills carry the methodology, git carries the documents, one SQLite file carries the state, and your coding agent carries the execution.

---

<p align="center">
  <a href="https://automagik.dev/genie"><strong>Docs</strong></a> &middot;
  <a href="https://github.com/automagik-dev/genie/releases/latest"><strong>Releases</strong></a> &middot;
  <a href="https://discord.gg/xcW8c7fF3R"><strong>Discord</strong></a> &middot;
  <a href="LICENSE"><strong>MIT License</strong></a>
</p>

<p align="center"><sub>You describe the problem. Genie does everything else.</sub></p>
