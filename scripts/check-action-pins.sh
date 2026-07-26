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
# Usage: bash scripts/check-action-pins.sh   (needs gh auth; network required)
set -euo pipefail

status=0
declare -a seen=()

while IFS= read -r line; do
  file="${line%%:*}"
  rest="${line#*:}"
  [[ "$rest" =~ uses:[[:space:]]*([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)(/[A-Za-z0-9./_-]+)?@([0-9a-f]{40}) ]] || continue
  repo="${BASH_REMATCH[1]}"
  sha="${BASH_REMATCH[3]}"
  key="${repo}@${sha}"
  for s in ${seen[@]+"${seen[@]}"}; do [[ "$s" == "$key" ]] && continue 2; done
  seen+=("$key")
  if gh api "repos/${repo}/commits/${sha}" --jq .sha >/dev/null 2>&1; then
    printf '  ok           %s\n' "$key"
  else
    printf '  UNRESOLVABLE %s  (%s)\n' "$key" "$file" >&2
    status=1
  fi
done < <(grep -rn "uses:" .github/workflows .github/actions 2>/dev/null || true)

if [[ "$status" -ne 0 ]]; then
  echo "::error ::one or more actions are pinned to a SHA that does not exist" >&2
fi
exit "$status"

