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

# shellcheck source=scripts/gh-retry.sh
source "$(dirname "$0")/gh-retry.sh"

# Status-aware existence probe: transient API failures are retried and an
# unresolvable state fails closed instead of being misread as "no release".
# The lookup also resolves drafts (which carry no tag ref) via the listing.
remote_json="$work_root/remote.json"
remote_exists=true
lookup_rc=0
gh_release_lookup "$RELEASE_REPOSITORY" "v${VERSION}" >"$remote_json" || lookup_rc=$?
case "$lookup_rc" in
  0) ;;
  4) remote_exists=false ;;
  *)
    echo "could not determine whether v${VERSION} already has release subjects" >&2
    exit 3
    ;;
esac

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
      # Download by asset id — bound to the validated inventory, and free of
      # the by-tag draft-listing resolution.
      asset_id="$(jq -r --arg name "$name" 'first(.assets[] | select(.name == $name)) | .id' "$remote_json")"
      gh_download_release_asset "$RELEASE_REPOSITORY" "$asset_id" "$destination/$name"
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
