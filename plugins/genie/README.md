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
- **Distribution**: the SessionStart hook stamps `LENS_ROOT` with the installed plugin path and copies the template to `~/.claude/workflows/council.js` — idempotent, and re-stamped on the first session after a plugin update.
- **Modes**:
  - `/council <topic>` — deliberation: 3-4 lenses routed by topic, 2-round Socratic exchange, dissent preserved verbatim.
  - `/council audit [focus]` — lane audit: assess-only, evidence-backed findings that route to `/wish`, profile updates merged single-writer into `.genie/repo-profile.md`.
- **Requirements**: Claude Code ≥ 2.1.154 with dynamic workflows available (paid plans; an org-level `disableWorkflows` setting turns the command off).
- **Override**: a project-level `.claude/workflows/council.js` takes precedence over the personal stamped copy.

## Release lag: pinned versions and update cadence

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
