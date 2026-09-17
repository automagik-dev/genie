#!/bin/bash
# Claude Code PreToolUse hook — catches what git hooks CAN'T:
# 1. --no-verify (bypasses all git hooks entirely)
# 2. bare --force (git pre-push doesn't receive push flags)
# 3. merging, protected-ref moves and hooksPath overrides, which no git hook sees at all
#
# Everything else (lint, typecheck, commitlint) is enforced by git hooks.
#
# SCOPE (operator decision, 2026-09-17): the guard stays NARROW — it refuses merging and pushes
# aimed at main/master, and it deliberately does not guard `dev`. Within that scope it is CLOSED:
# each forbidden form is refused in every spelling it can be written in, and a command that merely
# QUOTES one as data is not refused at all. Both halves were defects found reviewing PR #2935:
# `-XPUT`, `--method=PUT`, the implicit POST of `gh api … -f`, a GraphQL merge mutation, a
# lowercase `core.hookspath`, `--unset core.hooksPath` and `HEAD:refs/heads/main` all walked
# through, while `grep 'gh pr merge'` and a PR body quoting the rule were refused.

set -euo pipefail

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty')

[ -z "$command" ] && exit 0

# Only inspect commands that could reach git or gh.
echo "$command" | grep -qE 'git|gh ' || exit 0

# What a shell would RUN, with quoted data removed. A forbidden form inside quotes is text — a PR
# body, a commit message, a grep pattern — not an action; refusing those blocked read-only searches,
# a commit whose message explained the rule, and the wish publisher whose PR body quoted the
# contract it was obeying. Quotes are KEPT when the command hands them to a shell, where the quoted
# string is itself the command.
runnable=$command
if ! echo "$command" | grep -qE '(^|[;&|(]|[[:space:]])(eval|(ba|z)?sh[[:space:]]+-[a-zA-Z]*c)'; then
  runnable=$(echo "$command" | sed -E "s/'[^']*'//g; s/\"[^\"]*\"//g")
fi

# Every rule reads the runnable text, case-insensitively: git config keys are case-insensitive and
# `-XPUT` is as real as `-X put`.
has() { echo "$runnable" | grep -qiE "$1"; }

block() {
  echo "BLOCKED: $1" >&2
  exit 2
}

# === HARD BLOCK: merging ===
# Merging is the operator's decision; the wish workflow reports merge-ready and stops there.
if has 'gh[[:space:]]+pr[[:space:]]+merge\b'; then
  block "gh pr merge is FORBIDDEN here. Merging is the operator's decision; report merge-ready instead."
fi

# `gh api` that merges or moves a protected ref, in every mutating spelling — including the implicit
# POST a field flag turns on, which needs no -X at all. Review-thread replies and every other POST
# stay allowed: that narrowing is deliberate, and it is why the endpoint must match too.
GH_API_MUTATION='(-X|--method)[[:space:]]*=?[[:space:]]*(PUT|POST|PATCH|DELETE)\b|(^|[[:space:]])(-f|-F|--field|--raw-field|--input)([[:space:]]|=)'
# `dev` appears HERE and nowhere else: moving an integration ref through the API is a rewrite, not
# the ordinary merge AGENTS.md leaves to operator policy, and this guard already refused it.
GH_API_PROTECTED='/merges?([[:space:]]|/|\?|$)|/pulls/[^[:space:]]*/merge|/git/refs/heads/(main|master|dev)([[:space:]]|/|$)'
if has 'gh[[:space:]]+api\b' && has "$GH_API_MUTATION" && has "$GH_API_PROTECTED"; then
  block "merging or moving a protected ref through gh api is FORBIDDEN here. Merging is the operator's decision; report merge-ready instead."
fi
if has 'gh[[:space:]]+api[[:space:]]+graphql' && has 'merge(PullRequest|Branch|Queue)'; then
  block "merging through the GraphQL API is FORBIDDEN here. Merging is the operator's decision; report merge-ready instead."
fi

# === HARD BLOCK: hook bypasses ===
if has '(^|[[:space:]])HUSKY=(0|false|off|no)\b'; then
  block "disabling husky hides every git hook. Fix the root cause instead."
fi

if has 'core\.hookspath'; then
  # Reading it is fine — `git config --get core.hooksPath` is what the wish gate runs to prove the
  # hooks are live. Setting, unsetting or overriding it is not.
  if has '(^|[[:space:]])-c[[:space:]]*core\.hookspath=' ||
    has 'git_config_parameters=[^[:space:]]*core\.hookspath' ||
    has '(^|[[:space:]])--config-env[= ][^[:space:]]*core\.hookspath' ||
    has 'git[[:space:]]+config[^|;&]*--(unset|unset-all|remove-section)' ||
    has 'core\.hookspath[[:space:]]+[^-[:space:]|&;><]'; then
    block "overriding, unsetting or repointing core.hooksPath disables the repository hooks. Reading it is fine; changing it is not."
  fi
fi

# === HARD BLOCK: pushing at a protected branch ===
# `dev` is deliberately NOT here: AGENTS.md records the integration-branch rule as operator policy
# with no client-side guard (#2705). main and master are refused as a refspec in any spelling and as
# a bare branch argument, because `git push origin main` reaches the same ref as `HEAD:main`.
if has 'git[[:space:]]+push\b' &&
  has ':(refs/heads/)?(main|master)([^[:alnum:]._/-]|$)|(^|[[:space:]])(main|master)([^[:alnum:]._/-]|$)'; then
  block "pushing at main or master is FORBIDDEN (the pre-push hook refuses those branches too). Open a PR against dev."
fi

# === HARD BLOCK: --no-verify ===
# This bypasses ALL git hooks (pre-commit, pre-push, commit-msg).
# There is no legitimate reason to use it in this project.
if echo "$runnable" | grep -q '\-\-no-verify'; then
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
if echo "$runnable" | grep -qE 'git\s+push\b' && echo "$runnable" | grep -qE '(^|\s)--force($|\s)|(^|\s)-f($|\s)' && ! echo "$runnable" | grep -q 'force-with-lease'; then
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
