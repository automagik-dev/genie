# Claude Code Pilot Runbook

Use this when a Hermes/Genie agent needs to turn an intent into coding work executed by Claude Code through the Genie CLI.

## 1. Preflight

```bash
git status --short --branch
which genie && genie --help | sed -n '1,80p'
which claude || true
```

Do not mutate a dirty repo until you understand what is already in progress.

## 2. Convert intent into an execution brief

A good brief includes:

- purpose / user outcome
- target repo or workspace
- acceptance criteria
- evidence required before reporting done
- explicit stop conditions: prod/main release, secrets, destructive data, auth/security, budget/provider changes, or broad scope changes

## 3. Dispatch native Claude Code via Genie

```bash
GENIE_TUI_DISABLE=1 GENIE_NO_V1_PROMPT=1   genie --no-interactive --no-tui spawn engineer     --provider claude     --team <purpose-or-wish-slug>     --role <focused-role>     --cwd <repo-or-workspace>     --prompt '<brief with acceptance criteria and evidence requirements>'
```

The canonical provider for this lane is `claude`. Do not use `claude-sdk` unless Felipe explicitly changes the rule.

## 4. Observe and steer

```bash
genie ls
genie log engineer
# If needed:
genie agent send '<additional constraint or evidence request>' --to engineer
```

## 5. Review before closing

```bash
git status --short --branch
git diff --stat
# Run the repo's relevant tests/builds, then capture output.
```

Close only as:

- `SHIP` — acceptance criteria met with proof.
- `FIX-FIRST` — useful progress, but review found issues.
- `HUMAN-GATE` — blocked by a decision or permission boundary.
- `NO-GO` — impossible/unsafe with current constraints.
