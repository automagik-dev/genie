#!/usr/bin/env bash
set -euo pipefail

scope="${1:-.}"
tmpdir="${TMPDIR:-/tmp}"
refs="$tmpdir/genie_refs.txt"
missing="$tmpdir/genie_missing.txt"

rg --no-heading -n -o "@\\.genie/[^ ]+" -S "$scope" | sort -u > "$refs" || true
> "$missing"

while IFS=: read -r f l ref; do
  p=$(printf "%s" "$ref" | sed 's/^@//' | sed 's/[),.;:>`].*$//')
  if [[ $p == .genie/* ]]; then
    if [[ ! -e "$p" ]]; then
      printf "%s:%s @%s\n" "$f" "$l" "$p" >> "$missing"
    fi
  fi
done < "$refs"

if [[ -s "$missing" ]]; then
  echo "BROKEN @.genie references found:" >&2
  cat "$missing"
  exit 1
else
  echo "OK: no broken @.genie references in scope '$scope'"
fi

