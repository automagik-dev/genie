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
# The matcher reads the scalar that follows each `uses:` occurrence on the line
# and keeps the first one that is a pin, recognises all three YAML spellings
# (bare, 'single-quoted', "double-quoted"),
# and requires the ref to span the WHOLE scalar — an action ending in 40 hex
# chars followed by trailing garbage (`@<sha>oops`) is not a pin and must not be
# silently accepted (#2669).
#
# Usage: bash scripts/check-action-pins.sh   (needs gh auth; network required)
#        bash scripts/check-action-pins.sh --extract < lines   (offline; prints
#        the `owner/repo@sha` pin for every matching line, nothing for the rest)
set -euo pipefail

# YAML scalar spellings of the `uses:` value, matched against the text AFTER the
# key. Kept in variables because bash 3.2 treats quoted regex fragments as
# literals inside [[ =~ ]]. All three are anchored so a later `uses:` inside a
# trailing comment cannot shadow the real scalar. A bare scalar also ends at `,`
# and `}` so flow mappings (`- { uses: owner/repo@<sha>, name: X }`) extract.
uses_dquoted_re='^"([^"]*)"'
uses_squoted_re="^'([^']*)'"
uses_bare_re='^([^][:space:]#,}]+)'
# Anchored: the pin must be the ENTIRE scalar and end in exactly 40 hex chars.
pin_re='^([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)(/[A-Za-z0-9./_-]+)?@([0-9a-f]{40})$'

# extract_pin <line> — echo `owner/repo@sha` for a SHA-pinned `uses:` line.
# Returns 1 (printing nothing) for local (`./…`), docker://, tag/branch refs and
# for a 40-hex run that does not terminate the scalar.
#
# Every `uses:` occurrence is tried in order and the FIRST scalar that parses as
# a pin wins. Stopping at the first occurrence failed open: a literal `uses:`
# inside an earlier quoted value (`- { name: "literal uses: x", uses: o/r@<sha> }`)
# shadowed the real key, so the pin was silently never validated. Returning on
# the first VALID pin still keeps a trailing comment from shadowing a good
# scalar, because the real pin is matched before the comment is reached.
extract_pin() {
  local line="$1" rest cand scalar
  line="${line%$'\r'}"
  rest="$line"
  while [[ $rest == *uses:* ]]; do
    rest="${rest#*uses:}"
    cand="${rest#"${rest%%[![:space:]]*}"}"
    if [[ $cand =~ $uses_dquoted_re ]]; then
      scalar="${BASH_REMATCH[1]}"
    elif [[ $cand =~ $uses_squoted_re ]]; then
      scalar="${BASH_REMATCH[1]}"
    elif [[ $cand =~ $uses_bare_re ]]; then
      scalar="${BASH_REMATCH[1]}"
    else
      continue
    fi
    if [[ $scalar =~ $pin_re ]]; then
      # BASH_REMATCH[2] is the optional subpath (`owner/repo/sub@sha`); the
      # commit lives in the parent repository, so the API target and the dedupe
      # key drop it.
      printf '%s@%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[3]}"
      return 0
    fi
  done
  return 1
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
