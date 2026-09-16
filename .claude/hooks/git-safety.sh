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

# Only check commands containing "git" or "gh " (the GitHub CLI can merge and mutate too)
echo "$command" | grep -qE 'git|gh ' || exit 0

# === HARD BLOCK: merging, API mutations, hook bypasses, direct refspecs ===
# The wish delivery workflow publishes a PR and reads it back; merging, mutating the PR through
# the API, disabling hooks, or pushing straight at a protected branch are the operator's calls.
if echo "$command" | grep -qE 'gh\s+pr\s+merge\b'; then
  echo "BLOCKED: gh pr merge is FORBIDDEN here. Merging is the operator's decision; report merge-ready instead." >&2
  exit 2
fi
# gh api mutations only where they merge or move a protected ref; review-thread replies and other POSTs stay allowed.
if echo "$command" | grep -qE 'gh\s+api\b' && echo "$command" | grep -qE '(^|\s)(-X|--method)\s+(PUT|POST|PATCH|DELETE)\b' && echo "$command" | grep -qE '/merges?(\s|$|\?)|/git/refs/heads/(main|master|dev)(\s|$)'; then
  echo "BLOCKED: merging or moving a protected ref through gh api is FORBIDDEN here. Merging is the operator's decision; report merge-ready instead." >&2
  exit 2
fi
if echo "$command" | grep -qE '(^|\s)HUSKY=0\b'; then
  echo "BLOCKED: HUSKY=0 disables every git hook. Fix the root cause instead." >&2
  exit 2
fi
# core.hooksPath as an override or a mutation; the read-only query (git config --get core.hooksPath) stays allowed.
if echo "$command" | grep -qE '(^|\s)-c\s*core\.hooksPath=' || echo "$command" | grep -qE 'git\s+config\b[^|;&]*\bcore\.hooksPath\s+\S'; then
  echo "BLOCKED: overriding core.hooksPath disables the repository hooks. Reading it is fine; changing it is not." >&2
  exit 2
fi
# dev is deliberately NOT here: AGENTS.md records that the integration-branch rule is operator policy with no client-side guard (#2705).
if echo "$command" | grep -qE 'git\s+push\b' && echo "$command" | grep -qE ':(main|master)(\s|$)'; then
  echo "BLOCKED: pushing a refspec straight at main or master is FORBIDDEN (the pre-push hook refuses those branches too). Open a PR against dev." >&2
  exit 2
fi

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
