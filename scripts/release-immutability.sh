#!/usr/bin/env bash

set -euo pipefail

RELEASE_REPOSITORY="${RELEASE_REPOSITORY:-${GITHUB_REPOSITORY:-}}"
: "${RELEASE_REPOSITORY:?RELEASE_REPOSITORY or GITHUB_REPOSITORY is required}"
[[ "$RELEASE_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
  echo "invalid release repository: ${RELEASE_REPOSITORY}" >&2
  exit 2
}

# shellcheck source=scripts/gh-retry.sh
source "$(dirname "$0")/gh-retry.sh"

case "${1:-}" in
  release)
    : "${VERSION:?VERSION is required for release verification}"
    [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
      echo "invalid immutable release version: ${VERSION}" >&2
      exit 2
    }
    # The release was published moments earlier by note-finalize, so a 404 on
    # the tag ref is replication lag, not absence — retried alongside other
    # transient failures. A successful response with immutable=false is a
    # policy failure and is never retried.
    response="$(gh_retry --not-found-transient gh api "repos/${RELEASE_REPOSITORY}/releases/tags/v${VERSION}")"
    jq -e '.immutable == true' <<<"$response" >/dev/null || {
      echo "published release v${VERSION} is not immutable; refusing to advance channel manifests" >&2
      exit 3
    }
    ;;
  *) echo 'usage: release-immutability.sh release' >&2; exit 64 ;;
esac
