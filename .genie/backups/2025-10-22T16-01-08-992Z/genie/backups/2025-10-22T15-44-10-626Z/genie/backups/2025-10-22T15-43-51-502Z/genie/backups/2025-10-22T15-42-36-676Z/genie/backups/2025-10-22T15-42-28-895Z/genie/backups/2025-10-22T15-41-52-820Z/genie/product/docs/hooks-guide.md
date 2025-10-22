# Git Hooks Guide (Consolidated)
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`

This guide consolidates and replaces prior hook docs. It reflects the current scripts in `scripts/hooks/` and how Genie integrates with validation workflows.

## Overview
- Pre-commit (non-blocking Genie workflow + local validations)
- Pre-push (blocking tests + advisory checks + changelog update)

## File Map (truth)
- `.git/hooks/pre-commit` → `scripts/hooks/pre-commit`
  - Runs bash `scripts/prevent-worktree-access.sh`
  - Runs Node validators under `.genie/scripts/`:
    - `validate-user-files-not-committed.js`
    - `validate-cross-references.js`
    - `forge-task-link.js`
  - Starts a non-blocking Genie workflow: `neurons/git/commit-advisory`
    - Fire-and-forget; does not block the commit
- `.git/hooks/pre-push` → `scripts/hooks/pre-push`
  - Runs tests via `.genie/scripts/run-tests.js` (blocking)
  - Runs commit advisory `.genie/scripts/commit-advisory.js` (warning only)
  - Updates changelog `.genie/scripts/update-changelog.js` (non-blocking)

## Current Behavior (verified)
- Pre-commit
  - Displays “🧞 Genie pre-commit validation”
  - Validates worktree access prevention
  - Validates user-protected files and @ cross-references
  - Links Forge tasks to wishes (first commit)
  - Starts Genie workflow in background (non-blocking)
  - Prints “✅ All pre-commit validations passed” on success
- Pre-push
  - Displays branch info (works correctly in worktrees)
  - Blocks push if tests fail
  - Prints advisory warnings; enforcement happens at PR approval time
  - Non-blocking CHANGELOG update

## Design Notes
- Pre-commit remains fast and non-blocking for a smooth dev loop. It kicks off background advisory workflows that can be reviewed later.
- Pre-push enforces correctness by blocking on tests; ensures critical issues don’t land on remote.

## Extending Hooks
- Add new validators to `.genie/scripts/` and call them from `scripts/hooks/*`.
- For advisory-only items, prefer pre-commit or PR automation.
- For blocking policies, prefer pre-push or CI.

## Troubleshooting
- Hooks not executing: ensure executable bits (`chmod +x`) on `scripts/hooks/pre-commit` and `scripts/hooks/pre-push`.
- Non-blocking workflow didn’t start: ensure `.genie/cli/dist/genie-cli.js` exists (build with `pnpm run build:genie`).

