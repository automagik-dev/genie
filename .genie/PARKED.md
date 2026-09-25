# Parked for stability — 2026-09-25

Genie is parked: stable `v6.260925.1` is current, no issues are open, the only open PR is the auto-maintained rolling promotion (`dev` → `main`), and CI is green. A council (architecture, delivery, product, security and dissent lenses, all `support-with-conditions`) decided how to handle what was left. The operator approved. This page records each deferral and its reason, so the next session does not investigate them again.

## Deferred — no code change while parked

| Item | Decision | Why | When to revisit |
|---|---|---|---|
| mikro offload (`wish-context`, `review-prep`) fails in Claude Code sessions | Leave off | `DEEPSEEK_API_KEY` is kept out of the session environment on purpose (it lives behind `~/.mikro/gate-env.sh`). `/wish` degrades cleanly: the offload costs about 0.1 s and 0 tokens, and correctness does not depend on it. mikro reports the missing key as "3 consecutive empty LLM responses"; that label is a mikro defect, not genie's | When the offload is wanted: load the key in the process that starts the session (never in every tool environment), and file the label upstream against mikro |
| Complexity hotspots over the 25 warn threshold: `parseJsonRejectingDuplicateKeys` (29, `src/lib/orca-orchestration-adapter.ts`) and `codexPluginSurfaceChecks` (26, `src/genie-commands/doctor.ts`) | Leave | `bun run lint:complexity-budget` reports "OK: budget intact". The first is a trust-boundary parser, so an opportunistic refactor is all risk and removes no defect | In a dedicated refactor wish only |
| `UNSAFE_VALIDATION` in `.claude/workflows/wish.js` over-blocks harmless commands: `git stash push`, `git log --grep push`, `gh issue view`, `gh repo view`, `gh release view`, `npm run publish`, and a verb inside a quoted argument (`git commit -m "push fix"`) | Leave, no regex change | It fails closed (the run ends `blocked` with the rule named), only in repositories with no hook system, and it guards agent-authored commands built from untrusted input | Only when a real run hits it. Fix test-first: the list above becomes negative fixtures, and the existing refusals (`git push;`, `$(git push)`, `bash -c 'git push'`, `npm publish;`) stay as regression cases |
| Records-only commits on `dev` but not `main` (#3059 board snapshot, #3060 wish closures) | Leave | No code is waiting for promotion, and promoting runs the version and release machinery. The auto-maintained rolling promotion PR already carries these commits | Merge that PR whenever the operator next promotes deliberately; nothing forces it sooner |

## Parked feature work

- **`orca-plugin-genie`** and **`dsh-genie-board`** stay `IN_PROGRESS`, each with a dated parked note. **`observe-skill-bundle`** and **`dsh-workflow-fork`** stay `APPROVED` and have never been executed. None of them is being worked on.
- The 23 ready board cards (the released one included) are planned work, not defects. The card "Package, smoke, and publish DSH discoverability" held a stale claim from 2026-09-07; the claim was released, and the card is `ready` with a comment.
- **The definition-of-done checklist for cards** (`feat/board-report-checklist`, `-v2`) conflicts with the v6 board freeze ("no new verb, lane or column"). It needs an owner decision to reopen the freeze before anyone revives it. Both versions are kept: `refs/archive/feat/board-report-checklist` (the uncommitted working tree, snapshotted) and `refs/archive/feat/board-report-checklist-v2`.

## Where removed work went

The remote was cut to four branches. Every unmerged branch, the old `v6/corpo-leve` stash and the checklist work are kept under `refs/archive/*` on origin, and in local bundles on the dogfood host. Restore one with `git fetch origin refs/archive/<name>:refs/heads/<name>`; list them with `git ls-remote origin 'refs/archive/*'`.
