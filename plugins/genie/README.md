# Genie Plugin

Company-standard Claude Code plugin for the Genie workflow.

## Features

- **Core workflow skills**: `/brainstorm`, `/wish`, `/work`, `/review`
- **Bootstrap skills**: `genie-base`, `genie-blank-init`
- **Shared skill source**: `plugins/genie/skills -> ../../skills`
- **Agents + hooks + references** for wish execution and validation

## Workflow

```text
/brainstorm → /wish → /work → /review → SHIP
```

### 1) `/brainstorm`
Explore options, validate direction, and produce a design handoff.

### 2) `/wish`
Turn a validated idea into `.genie/wishes/<slug>/wish.md` with scope, criteria, and validation commands.

### 3) `/work`
Execute wish tasks with bounded fix loops and per-group validation evidence.

### 4) `/review`
Universal review gate (plan, execution, PR) returning `SHIP`, `FIX-FIRST`, or `BLOCKED`.

## `/council` workflow

The multi-perspective engine ships as a native dynamic workflow, not a skill:

- **What ships**: `workflows/council.js` (the engine template), `references/lenses/` (6 deliberation cards), and the 7 lane skills (`repo-hygiene`, `architecture`, `code-quality`, `qa`, `perf`, `supply-chain`, `dx-docs`) doubling as audit lenses.
- **Distribution**: `genie update` is the canonical updater — it stamps `LENS_ROOT` with the stable source root (`~/.genie/plugins/genie`) and writes `~/.claude/workflows/council.js`; the SessionStart hook is only a throttled trigger that delegates to it, with a CLI-less fallback stamp on plugin-only machines. See [Agent sync](#agent-sync) below.
- **Modes**:
  - `/council <topic>` — deliberation: 3-4 lenses routed by topic, 2-round Socratic exchange, dissent preserved verbatim.
  - `/council audit [focus]` — lane audit: assess-only, evidence-backed findings that route to `/wish`, profile updates merged single-writer into `.genie/repo-profile.md`.
- **Requirements**: Claude Code ≥ 2.1.154 with dynamic workflows available (paid plans; an org-level `disableWorkflows` setting turns the command off).
- **Override**: a project-level `.claude/workflows/council.js` takes precedence over the personal stamped copy.

## Agent sync

`genie update` is the canonical updater. On every run — even when the binary is already at the latest release — it converges every **detected** coding agent from the single source root `~/.genie/plugins/genie`:

| Agent | Target | What lands |
|-------|--------|------------|
| Claude Code | `~/.claude/skills/` + `~/.claude/workflows/council.js` | all genie skills + the stamped `/council` workflow |
| Codex | `~/.codex/skills/.curated/` | genie skills as Agent-Skills folders (`.system` is OpenAI's, never touched) |
| Hermes | `~/.hermes/plugins/genie` | symlink into `~/.genie/plugins/hermes-genie` |

- **One-time caveat on the delivering update**: the "on every run" guarantee starts one release late. The `genie update` that first brings agent-sync is still executed by the *old* binary, which only swaps the binary and has no sync phase — that run converges nothing. Run `genie update` once more, or let the SessionStart hook converge within its ~6h throttle window. Every update after that is self-syncing.
- **Managed and reversible**: every synced skill dir carries a `.genie-sync.json` manifest, so a re-run can tell "unchanged" from "you edited this" from "genie never shipped this name". Any dir genie replaces or removes is backed up first under `~/.genie/state-backups/` — nothing is ever lost, and dirs genie never shipped are left untouched.
- **The SessionStart hook is only a trigger**: when the genie CLI is on PATH it delegates to `genie update` (throttled ~6h via `~/.genie/.last-agent-sync`) and duplicates no sync logic. On a plugin-only machine with no CLI it falls back to stamping `~/.claude/workflows/council.js` directly.
- **The marketplace plugin is optional on CLI machines**: because `genie update` converges skills directly, the `genie@automagik` marketplace plugin is not required where the CLI is installed. `genie doctor` reports its state but never re-enables it.
- **Visibility and removal**: `genie doctor` prints a per-agent freshness line (current vs stale skills, council-stamp state, hermes link), advising `genie update` when anything is stale; `genie uninstall` removes only what genie provably shipped (skill dirs by manifest; council.js by its stamp signature; the hermes link only when it resolves into the genie home).

## Release lag: pinned versions and update cadence

On a machine **with the genie CLI installed**, `genie update` is the convergence path described in [Agent sync](#agent-sync) — it refreshes all detected agents directly, so the marketplace pin below matters mainly for plugin-only machines.

Installed plugin versions **pin to GitHub Releases** — a `/plugin install` snapshots
whatever release is current and stays there until you update. It does **not** track
`dev` or `main`. The update cadence is manual: run `/plugin update` to advance a
machine to the latest published release.

Because the pin is sticky, a machine can drift well behind the source tree. Observed
example: a machine sat pinned at `5.260703.5` for a week while `dev` moved on — the
plugin kept working, but none of the intervening fixes reached it until someone ran
`/plugin update`. Treat `/plugin update` as a periodic hygiene step, not a one-time
setup action.

## Directory Structure

```text
genie/
├── .claude-plugin/plugin.json
├── genie.ts
├── skills -> ../../skills
├── agents/
├── hooks/
├── scripts/
├── workflows/
└── references/
```

## Verification

```bash
ls ~/.claude/plugins/genie/plugin.json
```

Smoke-test the core commands:
- `/brainstorm`
- `/wish`
- `/work`
- `/review`

## Sibling surface: Hermes

This Claude Code plugin and the Hermes-native plugin ([`plugins/hermes-genie/`](../hermes-genie/README.md)) are sibling surfaces of the same Genie substrate. This one carries the workflow skills into Claude Code; the Hermes plugin exposes read-only Genie state (status, board, wish/task queries, dry-run plans) inside Hermes sessions — Hermes acts as the chat/reasoning cockpit while Genie remains the execution system and source of task truth.
