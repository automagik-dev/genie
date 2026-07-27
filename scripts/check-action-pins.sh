#!/usr/bin/env bash
# Verify every pinned GitHub Action SHA actually resolves to a commit.
#
# Pinning to a 40-hex SHA is necessary but not sufficient: a typo'd or
# hallucinated SHA is still "pinned" and passes every static lint, then fails
# at runtime with "Unable to resolve action". That is exactly what happened on
# 2026-07-25 — actions/upload-artifact was pinned to b7c4aadc…, which exists in
# no repository, and it took down three release-publish jobs the first time
# they ever executed.
#
# The matcher recognises all three YAML scalar spellings of `uses:` (bare,
# 'single-quoted', "double-quoted") and requires the ref to span the WHOLE
# scalar — an action ending in 40 hex chars followed by trailing garbage
# (`@<sha>oops`) is not a pin and must not be silently accepted (#2669).
#
# Usage: bash scripts/check-action-pins.sh   (needs gh auth; network required)
#        bash scripts/check-action-pins.sh --extract < lines   (offline; prints
#        the `owner/repo@sha` pin for every matching line, nothing for the rest)
set -euo pipefail

# YAML scalar spellings of the `uses:` value. Kept in variables because bash 3.2
# treats quoted regex fragments as literals inside [[ =~ ]].
uses_dquoted_re='uses:[[:space:]]*"([^"]*)"'
uses_squoted_re="uses:[[:space:]]*'([^']*)'"
uses_bare_re='uses:[[:space:]]*([^[:space:]#]+)'
# Anchored: the pin must be the ENTIRE scalar and end in exactly 40 hex chars.
pin_re='^([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)(/[A-Za-z0-9./_-]+)?@([0-9a-f]{40})$'

# extract_pin <line> — echo `owner/repo@sha` for a SHA-pinned `uses:` line.
# Returns 1 (printing nothing) for local (`./…`), docker://, tag/branch refs and
# for a 40-hex run that does not terminate the scalar.
extract_pin() {
  local line="$1" scalar
  line="${line%$'\r'}"
  if [[ $line =~ $uses_dquoted_re ]]; then
    scalar="${BASH_REMATCH[1]}"
  elif [[ $line =~ $uses_squoted_re ]]; then
    scalar="${BASH_REMATCH[1]}"
  elif [[ $line =~ $uses_bare_re ]]; then
    scalar="${BASH_REMATCH[1]}"
  else
    return 1
  fi
  [[ $scalar =~ $pin_re ]] || return 1
  # BASH_REMATCH[2] is the optional subpath (`owner/repo/sub@sha`); the commit
  # lives in the parent repository, so the API target and the dedupe key drop it.
  printf '%s@%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[3]}"
}

if [[ "${1:-}" == "--extract" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    extract_pin "$line" || true
  done
  exit 0
fi

# Workflows, the repo's own composite actions, and any other action manifest
# tracked anywhere in the tree (#2669). Overlap is harmless — pins are deduped.
scan_targets() {
  printf '%s\n' .github/workflows .github/actions
  git ls-files -- '*action.yml' '*action.yaml' 2>/dev/null || true
}

targets=()
while IFS= read -r target; do
  if [[ -n "$target" ]]; then targets+=("$target"); fi
done < <(scan_targets)

status=0
declare -a seen=()

while IFS= read -r line; do
  file="${line%%:*}"
  pin="$(extract_pin "$line" || true)"
  [[ -n "$pin" ]] || continue
  repo="${pin%@*}"
  sha="${pin##*@}"
  for s in ${seen[@]+"${seen[@]}"}; do [[ "$s" == "$pin" ]] && continue 2; done
  seen+=("$pin")
  if gh api "repos/${repo}/commits/${sha}" --jq .sha >/dev/null 2>&1; then
    printf '  ok           %s\n' "$pin"
  else
    printf '  UNRESOLVABLE %s  (%s)\n' "$pin" "$file" >&2
    status=1
  fi
done < <(grep -rn "uses:" ${targets[@]+"${targets[@]}"} 2>/dev/null || true)

if [[ "$status" -ne 0 ]]; then
  echo "::error ::one or more actions are pinned to a SHA that does not exist" >&2
fi
exit "$status"
