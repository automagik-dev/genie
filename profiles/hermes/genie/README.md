# Genie Hermes Profile Seed

This directory contains the portable, non-secret Genie persona/profile seed that Felipe uses as a Hermes-side lane for operating the Genie CLI and piloting Claude Code.

Use it when cloning `genie` onto a new VM and teaching another agent how to run the same ritual:

```text
brainstorm -> wish -> work/team -> review -> learn
```

## What is included

- `AGENTS.md` — primary agent instructions for a clone/workspace.
- `SOUL.md` — durable Genie identity and operating law.
- `HEARTBEAT.md` — per-iteration health/status checklist.
- `agent.yaml` — compact metadata for agent registries.
- `hermes-profile.yaml` — Hermes/profile-facing metadata and evidence contract.
- `CLAUDE_CODE_PILOT.md` — minimal runbook for using Genie to dispatch native Claude Code workers.

This seed intentionally excludes `.env`, `config.yaml`, `state.db`, sessions, memories, auth tokens, logs, and any runtime-specific `.hermes/` material.

## Bootstrap on a fresh VM

```bash
# 1. Clone canonical Genie source
git clone https://git.namastex.io/namastexlabs/genie.git ~/workspace/repos/genie
cd ~/workspace/repos/genie

# 2. Install/build according to the repo's current requirements
bun install
bun run build

# 3. Materialize the Genie workspace/profile seed
mkdir -p ~/workspace/agents/genie
cp profiles/hermes/genie/{AGENTS.md,SOUL.md,HEARTBEAT.md,agent.yaml,hermes-profile.yaml} ~/workspace/agents/genie/
ln -sfn ~/workspace/repos ~/workspace/agents/genie/repos

# 4. Optional: create/use a Hermes profile named genie
hermes profile create genie --clone default || true
hermes -p genie chat -q 'Read ~/workspace/agents/genie/AGENTS.md and explain how you will operate Genie.'
```

If the VM should run Genie through Hermes permanently, configure secrets and providers in the VM's Hermes profile (`~/.hermes/profiles/genie/.env` / `config.yaml`) rather than committing them here.

## Canonical lane for Claude Code work

The house lane is **native Claude Code CLI through Genie**, not the Claude SDK provider:

```bash
GENIE_TUI_DISABLE=1 GENIE_NO_V1_PROMPT=1   genie --no-interactive --no-tui spawn engineer     --provider claude     --team <purpose-or-wish-slug>     --role <focused-role>     --cwd <repo-or-workspace>     --prompt '<brief with acceptance criteria and evidence requirements>'
```

`--provider claude-sdk` is noncanonical for this house coding lane unless Felipe explicitly reverses that rule.

## Evidence contract

A clone should not report success from vibes. Before claiming done, collect at least one relevant proof artifact:

- files changed / commit SHA
- test or build output
- `genie ls`, `genie log`, `genie observe`, or cost/runtime proof
- PR URL or runtime readback
- clear `HUMAN-GATE` packet when blocked by auth, budget, prod/main release, secrets, security, client communication, or destructive data changes
