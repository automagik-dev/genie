#!/bin/bash
# Claude Code PreToolUse hook — catches what git hooks CAN'T:
# 1. --no-verify / -n (bypasses all git hooks entirely)
# 2. bare --force (git pre-push doesn't receive push flags)
# 3. merging and core.hooksPath overrides, which no git hook sees at all
#
# Everything else (lint, typecheck, commitlint) is enforced by git hooks.
#
# WHAT THIS IS. A guardrail against accident, not a security boundary. It matches text, so a
# determined spelling will always get past it: `gh alias set m 'pr merge'`, a token list handed to
# python, a GraphQL document in a file, a name split across quotes (`ma"in"`), a Makefile target.
# The rules that matter most are therefore the ones that keep the REAL enforcement alive — the
# repository's git hooks (husky's pre-push refuses `main`/`master` for every push spelling, because
# it receives the refs rather than parsing the command line) and GitHub's branch protection.
#
# SCOPE (operator decision, 2026-09-17): merging and pushes aimed at main/master are refused;
# ordinary pushes to `dev` are not (AGENTS.md carries that as operator policy, #2705).

set -euo pipefail

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty')

[ -z "$command" ] && exit 0

# Only inspect commands that could reach git or gh.
echo "$command" | grep -qE 'git|gh' || exit 0

# One line, no tab/newline tricks: `gh<TAB>pr<TAB>merge` and a backslash-continued `gh pr \ merge`
# are the same command as the spaced ones.
runnable=$(echo "$command" | tr '\t\n' '  ' | sed -E 's/\\ +/ /g; s/  +/ /g')

# Redirects are not values: `git config --get core.hooksPath 2>/dev/null` reads, it does not write.
runnable=$(echo "$runnable" | sed -E 's/[[:space:]][0-9]*>&?[0-9]*([[:space:]]*[^[:space:];&|]+)?//g')

# Prose is not an act. Only the value of a message/body/title/description flag is blanked — an
# earlier version stripped EVERY quoted span, which let an apostrophe in ordinary English
# (`-m "it's ready" && git push --force`) swallow the force-push whole, hid `"$(gh pr merge 1)"`
# from the guard while the shell still ran it, and disarmed every rule for `git push origin 'main'`.
runnable=$(echo "$runnable" | sed -E \
  "s/(^|[[:space:]])(-m|--message|--body|--title|--description)[[:space:]]*=?[[:space:]]*'[^']*'/\1\2 TEXT/g; \
   s/(^|[[:space:]])(-m|--message|--body|--title|--description)[[:space:]]*=?[[:space:]]*\"[^\"]*\"/\1\2 TEXT/g; \
   s/(^|[[:space:]])(-f|-F|--field|--raw-field)[[:space:]]*(body|message|title|description|comment)=('[^']*'|\"[^\"]*\"|[^[:space:]]*)/\1\2 \3=TEXT/g")

# A pure read-only search for a forbidden form is a search, not an act — including one handed to a
# shell, which is how an agent greps from inside a wrapper. Only when it is the WHOLE command, so
# `grep … && git push --force` is still judged.
search=$(echo "$runnable" | sed -E "s/^[[:space:]]*(([^[:space:]]*\/)?(ba|z|k|d[a]?)?sh|eval)[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*-?c?[[:space:]]*['\"]?//; s/['\"][[:space:]]*$//")
if echo "$search" | grep -qE '^[[:space:]]*(grep|rg|ag|ack|git[[:space:]]+(grep|log|show-ref)|cat|sed|awk|head|tail)\b[^;&|]*$'; then
  exit 0
fi

has() { echo "$runnable" | grep -qiE "$1"; }
# The segment a verb appears in, so a rule about `git push` never fires on text belonging to another
# command on the same line — `git push origin dev && rm -f /tmp/log` is not a force push.
segment() { echo "$runnable" | tr ';|&' '\n' | grep -iE "$1" || true; }
in_segment() { echo "$2" | grep -qiE "$1"; }

block() {
  echo "BLOCKED: $1" >&2
  exit 2
}

# A subcommand is still the subcommand when flags sit in front of it: `gh -R owner/repo pr merge`
# and `git -C <worktree> push` are what an agent writes when it is not standing in the repository —
# `git -C` is how the wish executor drives the worktree it just created. The gap never crosses a
# command separator. A quoted subcommand (`gh pr "merge"`) is the same subcommand.
GH='gh[[:space:]]+([^;&|[:space:]]+[[:space:]]+)*'
GIT='git[[:space:]]+([^;&|[:space:]]+[[:space:]]+)*'
Q='["'"'"']?'

# === HARD BLOCK: merging ===
# Merging is the operator's decision; the wish workflow reports merge-ready and stops there.
if has "${GH}${Q}pr${Q}[[:space:]]+${Q}merge${Q}\b"; then
  block "gh pr merge is FORBIDDEN here. Merging is the operator's decision; report merge-ready instead."
fi

# `gh api` that merges or moves a protected ref, in every mutating spelling — including the implicit
# POST a field flag turns on, which needs no -X at all. Review-thread replies and every other POST
# stay allowed: that narrowing is deliberate, and it is why the endpoint must match too.
GH_API_MUTATION='(-X|--method)[[:space:]]*=?[[:space:]]*(PUT|POST|PATCH|DELETE)\b|(^|[[:space:]])(-f|-F|--field|--raw-field|--input)([[:space:]]|=)'
# `dev` appears HERE and nowhere else: moving an integration ref through the API is a rewrite, not
# the ordinary merge AGENTS.md leaves to operator policy, and this guard already refused it.
GH_API_PROTECTED='/merges?([[:space:]/?"'"'"']|$)|/merge-upstream|/pulls/[^[:space:]]*/merge|/git/refs/heads/(main|master|dev)([[:space:]/"'"'"']|$)'
if has "${GH}api\b" && has "$GH_API_MUTATION" && has "$GH_API_PROTECTED"; then
  block "merging or moving a protected ref through gh api is FORBIDDEN here. Merging is the operator's decision; report merge-ready instead."
fi
if has "${GH}api[[:space:]]+graphql" && has 'merge(PullRequest|Branch|Queue)'; then
  block "merging through the GraphQL API is FORBIDDEN here. Merging is the operator's decision; report merge-ready instead."
fi

# === HARD BLOCK: hook bypasses ===
if has '(^|[[:space:]])HUSKY=(0|false|off|no)\b'; then
  block "disabling husky hides every git hook. Fix the root cause instead."
fi

if has "${Q}core\.hookspath"; then
  # Only the segments that NAME core.hooksPath: `git config --get core.hooksPath && git config
  # --unset user.signingkey` unsets something else entirely.
  CONFIG_SEGMENT=$(segment "core\.hookspath")
  # Reading it is fine — `git config --get core.hooksPath` is what the wish gate runs to prove the
  # hooks are live. Setting, unsetting, emptying or repointing it is not: an EMPTY value disables
  # the hooks exactly as a wrong path does, and `git config unset` (no dashes) works on git 2.50+.
  if has "(^|[[:space:]])-c[[:space:]]*${Q}core\.hookspath=" ||
    has 'git_config_parameters=[^[:space:]]*core\.hookspath' ||
    has 'git_config_key_[0-9]+=[[:space:]]*core\.hookspath' ||
    has "(^|[[:space:]])--config-env[= ][^[:space:]]*core\.hookspath" ||
    in_segment "config[[:space:]]+(--)?(unset|unset-all|remove-section)" "$CONFIG_SEGMENT" ||
    in_segment "core\.hookspath${Q}[[:space:]]+[^-[:space:]]" "$CONFIG_SEGMENT"; then
    block "overriding, unsetting, emptying or repointing core.hooksPath disables the repository hooks. Reading it is fine; changing it is not."
  fi
fi

PUSH_SEGMENT=$(segment "${GIT}push\b")

# === HARD BLOCK: pushing at a protected branch ===
# An early, readable refusal — not the enforcement. The pre-push hook receives every ref a push
# updates, including the ones no text match can enumerate (`--all`, `--mirror`, a variable, a quoted
# name), and refuses main/master there; `main` is protected server-side as well. A BARE `main` token
# is deliberately not matched: it fired on every read-only mention on the same line
# (`git fetch origin main && git push origin dev`, a trailing `# never push main`) and added nothing
# the pre-push hook does not already refuse. `dev` is not guarded at all (AGENTS.md, #2705).
if [ -n "$PUSH_SEGMENT" ] &&
  in_segment ':(refs/heads/)?(main|master)([^[:alnum:]._/-]|$)|(^|[[:space:]])\+?refs/heads/(main|master)([^[:alnum:]._/-]|$)|(^|[[:space:]])\+(main|master)([^[:alnum:]._/-]|$)' "$PUSH_SEGMENT"; then
  block "pushing at main or master is FORBIDDEN (the pre-push hook refuses those refs for every push spelling). Open a PR against dev."
fi

# === HARD BLOCK: --no-verify ===
# This bypasses ALL git hooks (pre-commit, pre-push, commit-msg).
# There is no legitimate reason to use it in this project.
if has '\-\-no-verify' || in_segment "commit\b.*(^|[[:space:]])-[a-z]*n([[:space:]]|$)" "$(segment "${GIT}commit\b")"; then
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
# Git pre-push hooks don't receive push flags, so this is the only guard. Judged inside the push
# segment only, so another program's `-f` on the same line is not a force push, and combined short
# flags (`-uf`, `-fu`) count as one.
if [ -n "$PUSH_SEGMENT" ] &&
  in_segment '(^|[[:space:]])--force([[:space:]]|$)|(^|[[:space:]])-[a-z]*f[a-z]*([[:space:]]|$)' "$PUSH_SEGMENT" &&
  ! in_segment 'force-with-lease' "$PUSH_SEGMENT"; then
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
