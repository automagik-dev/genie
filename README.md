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

Genie is a planning-and-execution layer for AI coding agents. You describe what you want in one sentence; Genie interviews you into a plan, dispatches agents to build it in parallel, reviews the result against acceptance criteria, and hands you something ready to merge.

The whole thing is a lightweight body: a set of skills, plain-markdown documents in git, and a single per-repo SQLite file. No daemons, no Postgres, nothing resident. A command opens the database, runs one transaction, and exits.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/install.sh | bash
```

Every release is cosign-signed (keyless OIDC) with SLSA provenance; the installer verifies the binary — via `gh attestation verify`, falling back to `cosign verify-blob` — before it runs.

Then, from inside your repo, run `genie setup` to configure Genie and wire up its Claude Code hooks. `genie doctor` checks the install at any time.

## Quickstart

The lifecycle runs as Claude Code skills. Open your repository in Claude Code and go:

```text
1. /brainstorm   an idea → a concrete DESIGN.md
2. /wish         DESIGN.md → a WISH.md with scoped execution groups
3. /work         dispatches agents wave by wave to build each group
4. /review       a severity-gated verdict: SHIP, FIX-FIRST, or BLOCKED
```

Re-run `genie board` any time for a current snapshot of task state on the kanban. The plan documents land in git as you go; the operational state lives in `.genie/genie.db`.

## What's inside

- **Skills** carry the methodology — `/brainstorm → /wish → /work → /review`, authored once, running natively in Claude Code.
- **Documents in git.** Wishes, designs, and brainstorms are plain markdown under `.claude/plans/<slug>/`; you diff, review, and version them like any other code.
- **One file of state.** Tasks, boards, dependency edges, and wish-group execution state live in a single per-repo SQLite file (`.genie/genie.db`), on Bun's built-in engine.
- **Small.** 10 CLI commands, 3 runtime dependencies (`@inquirer/prompts`, `commander`, `zod`), a ~0.9 MB single-file bundle. Bun-powered.
- **Zero daemons, no Postgres.** Nothing runs in the background between invocations.

## Commands

```bash
genie --help
```

| Command | What it does |
|---------|-------------|
| `genie board` | Kanban view of task state, derived live by query |
| `genie task` | Inspect and drive task state (SQLite, zero-daemon) |
| `genie setup` | Configure Genie and wire up its Claude Code hooks |
| `genie doctor` | Run diagnostic checks on the installation |
| `genie hook` | Hook middleware for Claude Code integration |
| `genie shortcuts` | Manage terminal keyboard shortcuts |
| `genie update` | Update Genie to the latest GitHub release |
| `genie install` | No-op on v5 (state lives in `genie.db`); reserved for managed installs |
| `genie uninstall` | Remove Genie and clean up its hooks |
| `genie help` | Show help for any command |

## Skills

Skills are the product. The four core skills are rewritten for the v5 body and run natively in Claude Code today:

| Skill | What it does |
|-------|-------------|
| `/brainstorm` | Explore a vague idea until it's a concrete DESIGN.md |
| `/wish` | Turn a design into a scoped WISH.md with execution groups |
| `/work` | Dispatch subagents wave by wave to execute a wish |
| `/review` | Severity-gated verdict — SHIP, FIX-FIRST, or BLOCKED |

The rest of the v4 skill library survives and is being ported onto the new body — mostly mechanical re-plumbing of dispatch and state:

- **Being ported:** `/genie` (natural-language router), `/wizard` (onboarding), `/learn`, `/refine`, `/fix`, `/trace`, `/council`, `/docs`, `/genie-hacks`.
- **Deferred:** `/report` waits on a new observability data path; `/omni` waits on the channel-runner port; `/pm` and `/dream` (overnight batch execution) need a background-execution capability the zero-daemon body doesn't yet ship.

## How it works

Documents live in git; operational state lives in one SQLite file. `/work` fans agents out through Claude Code's native teams — each subagent gets its own task to claim, build, and mark done, with state changes serialized through `genie.db` rather than a coordinator. Review runs as a separate subagent from the one that wrote the code (reviewer ≠ engineer), so the verdict is an independent read of the diff against the wish's acceptance criteria, not the author grading their own work.

All linked worktrees of a repository share one `genie.db`, resolved from the git common directory, so a task created in one worktree is immediately visible in another with no sync step.

## Roadmap

No dates — direction, not promises:

- **Warp integration.** Emit Warp Launch Configurations so `/work` drives a multi-session cockpit instead of individual panes.
- **Omni channel runner.** Port the channel runner forward so agents can be wired to external channels again.
- **More emit targets.** Codex and Hermes as skill targets alongside Claude Code.
- **CDN distribution.** Serve signed releases from a CDN for faster, wider installs.

## Coming from v4?

v4 is preserved on the [`v4` branch](https://github.com/automagik-dev/genie/tree/v4), and its final npm release stays published for existing v4 users — nothing you're running today disappears.

v5 is a deliberate cutover to a lightweight body. The v4 harness — a Postgres backend, pane-based process orchestration, executor registries, the telemetry spine, the full-screen console, and the desktop app — is gone. What remains is the part that always did the work: the skills, the documents, and one SQLite file of state.

---

<p align="center">
  <a href="https://automagik.dev/genie"><strong>Docs</strong></a> &middot;
  <a href="https://github.com/automagik-dev/genie/releases/latest"><strong>Releases</strong></a> &middot;
  <a href="https://discord.gg/xcW8c7fF3R"><strong>Discord</strong></a> &middot;
  <a href="LICENSE"><strong>MIT License</strong></a>
</p>

<p align="center"><sub>You describe the problem. Genie does the rest.</sub></p>
