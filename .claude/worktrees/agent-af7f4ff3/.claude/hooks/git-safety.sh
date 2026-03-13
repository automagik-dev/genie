#!/bin/bash
# Claude Code PreToolUse hook — catches what git hooks CAN'T:
# 1. --no-verify (bypasses all git hooks entirely)
# 2. bare --force (git pre-push doesn't receive push flags)
#
# Everything else (lint, typecheck, commitlint) is enforced by git hooks.

set -euo pipefail

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty')

[ -z "$command" ] && exit 0

# Only check commands containing "git"
echo "$command" | grep -q 'git' || exit 0

# === HARD BLOCK: --no-verify ===
# This bypasses ALL git hooks (pre-commit, pre-push, commit-msg).
# There is no legitimate reason to use it in this project.
if echo "$command" | grep -q '\-\-no-verify'; then
  cat >&2 <<'EOF'
BLOCKED: --no-verify is FORBIDDEN.

Pre-commit runs biome lint + CI-red check. Pre-push runs bun run check.
Commit-msg runs commitlint. These enforce zero-tolerance quality.

CORRECT BEHAVIOR:
1. Fix the lint/type/commit-msg error
2. Run: bun run check
3. Commit normally (without --no-verify)

NEVER bypass hooks. Fix the root cause.
EOF
  exit 2
fi

# === HARD BLOCK: bare --force (not --force-with-lease) ===
# Git pre-push hooks don't receive push flags, so this is the only guard.
if echo "$command" | grep -qE 'git\s+push\b' && echo "$command" | grep -qE '(^|\s)--force($|\s)|(^|\s)-f($|\s)' && ! echo "$command" | grep -q 'force-with-lease'; then
  cat >&2 <<'EOF'
BLOCKED: git push --force is FORBIDDEN.

CORRECT BEHAVIOR:
- Normal push after new commits: git push (no flags needed)
- After rebase/amend: git push --force-with-lease
- --force-with-lease protects against overwriting others' work

WHEN --force-with-lease is acceptable:
- Rewriting commit history (rebase, squash, amend)
- ALWAYS document why in the commit message

PREFER new commits over amend+force-push. It's always safer.
EOF
  exit 2
fi

exit 0
