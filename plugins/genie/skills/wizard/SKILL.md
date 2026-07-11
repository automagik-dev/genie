---
name: wizard
description: "Guided onboarding — scaffold workspace, shape agent identity, create first wish, execute, and celebrate."
---

# wizard — First-Run Onboarding

**Runtime syntax:** invoke named skills as `$name` in Codex and `/name` in Claude Code or Hermes. This body uses bare skill names so the workflow stays portable.

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
genie init   # idempotent: .genie/INDEX.md + .gitignore rules
```

## Phase 2 — Agent Identity

Goal: an `AGENTS.md` defining this project's agent roles and voice. Delegate to `brainstorm` seeded with: "Shape the agent identity for this project — read the codebase first, propose an identity, confirm with the user once." If the user skips, write a minimal `AGENTS.md` placeholder and move on.

## Phase 3 — First Wish

Ask what to build or fix first. Fuzzy → `brainstorm`; concrete → `wish` (creates `.genie/wishes/<slug>/WISH.md` with scope, acceptance criteria, and execution groups). Then `review` the plan. Exit: a wish with a SHIP verdict.

## Phase 4 — Execute

State what's about to run (wish slug, group count), then run `work` — it dispatches native subagents per execution group, tracks per-group state via `genie task`, and runs fix loops. When it finishes, `review` for final verification. Terminal-first alternative: `genie launch <slug>` opens a Warp cockpit with one pane per ready group, each in its own worktree.

## Phase 5 — Celebrate

Open with one celebratory beat — "Your first wish has been granted." — then summarize outcome-first: wish slug, review verdict, files changed (from git), validation evidence. Next steps to offer:
- Plan the next piece of work: `genie` or `wish`
- See current state: `genie board`
- Lifecycle map: `genie` and its `reference/lifecycle.md`

## Resumption

On re-invocation, detect state and jump: `.genie/` exists → skip scaffolding; `AGENTS.md` exists → skip Phase 2; approved wish in `.genie/wishes/` → Phase 4; completed wish → Phase 5.

## Failure Handling

Show the failing command's output and offer retry / skip / abort. A delegated skill failing does not kill the wizard — continue from the next phase. Always leave the user with a concrete next action.
