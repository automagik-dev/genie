---
name: wizard
description: "Guided onboarding — scaffold workspace, shape agent identity, create first wish, execute, and celebrate."
---

# wizard — First-Run Onboarding

**Runtime syntax:** in Codex, invoke the plugin copy with the owner-qualified `$genie:<skill>` selector; use bare `$<skill>` only when intentionally selecting a user-tier copy (a separately installed personal copy; Genie no longer seeds this tier). Claude Code and Hermes use `/<skill>`. Cross-skill prose below uses bare names as portable semantic routes; the orchestrator resolves the selector for the active tier.

Walk a new user through complete Genie setup in five phases. Infer everything you can from the repo and confirm once — don't interrogate. Resumable: detect completed phases and skip them.

## When to Use
- First Genie run in a project, `wizard` invoked, or the installer directed the agent here
- No `.genie/` or `AGENTS.md` in the current repo

## Phase 1 — Environment Check

```bash
command -v genie && genie --version   # installed? (v5.x)
git rev-parse --git-dir               # inside a git repo?
ls .genie AGENTS.md CLAUDE.md 2>/dev/null
genie doctor                          # installation diagnostics
```

Show a compact found/missing checklist, then:
- `genie` missing → stop; have the user run `curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/install.sh | bash`
- Not a git repo → stop; ask the user to `git init` or move to one
- `.genie/` missing → scaffold it:

```bash
genie init   # idempotent state plus .mcp.json, .warp/.mcp.json, and conditional marker-owned .codex/config.toml routing
```

Before running it, tell the user that these are project-scoped writes and that
Codex uses the TOML fallback only when no installed, enabled, usable Genie
plugin route can be proven. Claude treats the project `.mcp.json` route as
pending until the user trusts the workspace; Codex users should inspect the
marker-owned dotted assignments in `.codex/config.toml` before using that route.

## Phase 2 — Agent Identity

Goal: an `AGENTS.md` defining this project's agent roles and voice. Delegate to `brainstorm` seeded with: "Shape the agent identity for this project — read the codebase first, propose an identity, confirm with the user once." If the user skips, write a minimal `AGENTS.md` placeholder and move on.

## Phase 3 — First Wish

Ask what to build or fix first. Fuzzy → `/brainstorm` in Claude or
`$genie:brainstorm` in the Codex plugin; concrete → `/wish` or `$genie:wish`
(creates `.genie/wishes/<slug>/WISH.md` with scope, acceptance criteria, and
execution groups). Then dispatch `/review` or `$genie:review` on the plan. The
reviewer remains read-only; the wizard/orchestrator appends its evidence under
`## Review Results` and persists SHIP as WISH status `APPROVED` (FIX-FIRST/
BLOCKED use those exact statuses). Exit only when the wish is `APPROVED` on
disk, not merely when a chat verdict said SHIP.

## Phase 4 — Execute

State what's about to run (wish slug, group count), then run `/work` in Claude
or `$genie:work` in the Codex plugin — it dispatches native subagents per
execution group, tracks per-group state via `genie task`, and runs fix loops.
When it finishes, run `/review` or `$genie:review` for final verification.
Terminal-first alternative: `genie launch <slug>` opens a Warp cockpit with one
pane per ready group, each in its own worktree.

## Phase 5 — Celebrate

Open with one celebratory beat — "Your first wish has been granted." — then summarize outcome-first: wish slug, review verdict, files changed (from git), validation evidence. Next steps to offer:
- Plan the next piece of work: `genie` or `wish`
- See current state: `genie board`
- Lifecycle map: invoke the active-tier `genie` skill and ask for its lifecycle map

## Resumption

On re-invocation, detect state and jump: `.genie/` exists → skip scaffolding; `AGENTS.md` exists → skip Phase 2; WISH status `APPROVED` or `IN_PROGRESS` → Phase 4; `SHIPPED` → Phase 5; `FIX-FIRST` or `BLOCKED` → show and take the recorded corrective route.

## Failure Handling

Show the failing command's output and offer retry / skip / abort for optional phases only. Phase 3 is a mandatory gate: a failed wish or plan review stays in Phase 3; route `FIX-FIRST` through `fix` and a fresh plan review, and stop on `BLOCKED` with its concrete unblocking action. Never enter Phase 4 until WISH status `APPROVED` is persisted on disk. Always leave the user with a concrete next action.
