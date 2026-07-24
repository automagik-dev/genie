#!/usr/bin/env bash

set -euo pipefail

: "${VERSION:?VERSION is required}"
RELEASE_REPOSITORY="${RELEASE_REPOSITORY:-${GITHUB_REPOSITORY:-}}"
: "${RELEASE_REPOSITORY:?RELEASE_REPOSITORY or GITHUB_REPOSITORY is required}"
DIST_DIR="${DIST_DIR:-dist}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 2
[[ "$RELEASE_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || exit 2
[[ -d "$DIST_DIR" && ! -L "$DIST_DIR" ]] || exit 3

PLATFORMS=(linux-x64-glibc linux-x64-musl linux-arm64 darwin-arm64)
BASE_ASSETS=()
for platform in "${PLATFORMS[@]}"; do
  tarball="genie-${VERSION}-${platform}.tar.gz"
  BASE_ASSETS+=("$tarball" "${tarball}.bundle" "${tarball}.intoto.jsonl")
done
for name in "${BASE_ASSETS[@]}"; do
  [[ -f "$DIST_DIR/$name" && ! -L "$DIST_DIR/$name" && -s "$DIST_DIR/$name" ]] || {
    echo "missing or unsafe same-run release subject input: ${name}" >&2
    exit 3
  }
done

work_root="$(mktemp -d "${TMPDIR:-/tmp}/genie-release-subjects.XXXXXX")"
trap 'rm -rf "$work_root"' EXIT HUP INT TERM
effective="$work_root/effective"
mkdir "$effective"
for name in "${BASE_ASSETS[@]}"; do cp "$DIST_DIR/$name" "$effective/$name"; done

remote_json="$work_root/remote.json"
remote_exists=true
if ! gh release view "v${VERSION}" --repo "$RELEASE_REPOSITORY" --json assets >"$remote_json" 2>"$work_root/view.err"; then
  if grep -qiE 'release not found|HTTP[^0-9]*404|status[^0-9]*404' "$work_root/view.err"; then
    remote_exists=false
  else
    cat "$work_root/view.err" >&2
    echo "could not determine whether v${VERSION} already has release subjects" >&2
    exit 3
  fi
fi

if [[ "$remote_exists" == true ]]; then
  jq -e '
    (.assets | type == "array") and
    (all(.assets[]; .name | type == "string")) and
    (([.assets[].name] | length) == ([.assets[].name] | unique | length))
  ' "$remote_json" >/dev/null || {
    echo "existing release asset inventory is malformed or duplicated" >&2
    exit 3
  }
  for name in "${BASE_ASSETS[@]}"; do
    if jq -e --arg name "$name" 'any(.assets[]; .name == $name)' "$remote_json" >/dev/null; then
      destination="$work_root/remote-${name//[^A-Za-z0-9]/_}"
      mkdir "$destination"
      gh release download "v${VERSION}" --repo "$RELEASE_REPOSITORY" --pattern "$name" --dir "$destination"
      [[ -f "$destination/$name" && ! -L "$destination/$name" && -s "$destination/$name" ]] || {
        echo "downloaded release subject must be a nonempty physical file: ${name}" >&2
        exit 3
      }
      cp "$destination/$name" "$effective/$name"
    fi
  done
fi

# The effective set may combine preserved remote bytes with missing same-run
# sidecars after an interrupted upload. Verify the composed triplets before
# any descriptor subject is built or endorsed.
for platform in "${PLATFORMS[@]}"; do
  bash "$(dirname "$0")/verify-release.sh" --local "$effective/genie-${VERSION}-${platform}.tar.gz"
done
for name in "${BASE_ASSETS[@]}"; do cp "$effective/$name" "$DIST_DIR/$name"; done
echo "materialized verified effective release subjects for v${VERSION}"
