#!/usr/bin/env bash
set -euo pipefail

# Fails when a genie release tarball (scripts/build-binary.sh output) names a private host, a
# person or an internal service. It unpacks the tarball and reads every file in it, the compiled
# genie binary included (as bytes), plus the plugins, skills and templates staged next to it.
#
# Fails closed: a missing or empty tarball, or one without a genie binary, is a failure.
#
#   check-shipped-strings.sh <dist/genie-<version>-<platform>.tar.gz>

TARBALL="${1:?usage: check-shipped-strings.sh <release tarball>}"
PATTERN='juice|lembr\.ai|felipe'
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [[ ! -s "$TARBALL" ]]; then
  printf 'FAIL: %s is missing or empty\n' "$TARBALL" >&2
  exit 1
fi
tar -xzf "$TARBALL" -C "$WORK"
if [[ ! -s "$WORK/genie" ]]; then
  printf 'FAIL: %s holds no genie binary\n' "$TARBALL" >&2
  exit 1
fi

hits="$(grep -rlaiE "$PATTERN" "$WORK" || true)"
if [[ -z "$hits" ]]; then
  printf 'ok %s names no private host, person or internal service\n' "$(basename "$TARBALL")"
  exit 0
fi
while IFS= read -r file; do
  words="$(grep -oaiE "$PATTERN" "$file" | tr '[:upper:]' '[:lower:]' | sort | uniq -c | tr -s ' ' | tr '\n' ',')"
  printf 'FAIL: %s (%s)\n' "${file#"$WORK"/}" "$words" >&2
done <<<"$hits"
exit 1
