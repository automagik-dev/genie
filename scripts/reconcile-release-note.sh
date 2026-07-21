#!/usr/bin/env bash

set -euo pipefail

: "${VERSION:?VERSION is required}"
: "${CHANNEL:?CHANNEL is required}"
RELEASE_REPOSITORY="${RELEASE_REPOSITORY:-${GITHUB_REPOSITORY:-}}"
: "${RELEASE_REPOSITORY:?RELEASE_REPOSITORY or GITHUB_REPOSITORY is required}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "invalid release version: ${VERSION}" >&2
  exit 2
}
[[ "$RELEASE_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
  echo "invalid release repository: ${RELEASE_REPOSITORY}" >&2
  exit 2
}
case "$CHANNEL" in
  stable|homolog|dev) ;;
  *) echo "invalid release channel: ${CHANNEL}" >&2; exit 2 ;;
esac
DRAFT="${DRAFT:-false}"
case "${DRAFT}" in
  true|false) ;;
  *) echo "invalid DRAFT value: ${DRAFT}" >&2; exit 2 ;;
esac
MODE="${1:-}"
case "$MODE" in
  prepare|finalize) ;;
  *) echo "usage: reconcile-release-note.sh prepare|finalize" >&2; exit 64 ;;
esac

MIGRATION_MARKER="<!-- genie-agent-sync-migration-v1 -->"
MIGRATION_NOTE=$'<!-- genie-agent-sync-migration-v1 -->\n**One-time integration convergence:** when upgrading from a Genie release older than `5.260711.6` to `5.260711.6` or later, let the first command finish and run `genie update` once more explicitly. The newly installed binary preserves user-owned skills/agents and converges the plugin, hooks, and optional role agents. Confirm exactly H3/H4/H6, review changed hashes with `/hooks`, and start a new Codex task; SessionStart never performs this hop.'
TAG="v${VERSION}"

release_exists=false
if gh release view "${TAG}" --repo "${RELEASE_REPOSITORY}" >/dev/null 2>&1; then
  release_exists=true
fi

# A stable release is monotonic. Replaying the same immutable version through a
# prerelease channel must never bypass production approval to demote the release
# or clobber its assets while latest.json still names it.
if [[ "${release_exists}" == "true" && "${CHANNEL}" != "stable" ]]; then
  state="$(gh release view "${TAG}" --repo "${RELEASE_REPOSITORY}" --json isPrerelease,isDraft --jq '[.isPrerelease,.isDraft] | @tsv')"
  IFS=$'\t' read -r is_prerelease is_draft <<<"${state}"
  if [[ "${is_prerelease}" != "true" && "${is_draft}" != "true" ]]; then
    echo "refusing to demote existing stable release ${TAG} through channel ${CHANNEL}" >&2
    exit 3
  fi
fi

if [[ "$MODE" == "prepare" ]]; then
  if [[ "${release_exists}" != "true" ]]; then
    notes="Release ${TAG} (channel: ${CHANNEL})"
    notes+=$'\n\n'
    notes+="${MIGRATION_NOTE}"
    create_args=(release create "${TAG}" --repo "${RELEASE_REPOSITORY}" --title "${TAG}" --notes "${notes}" --draft --latest=false --verify-tag)
    [[ "${CHANNEL}" != "stable" ]] && create_args+=(--prerelease)
    gh "${create_args[@]}"
  fi

  body="$(gh release view "${TAG}" --repo "${RELEASE_REPOSITORY}" --json body --jq '.body // ""')"
  if [[ "${body}" != *"${MIGRATION_MARKER}"* ]]; then
    [[ -z "${body}" ]] || body+=$'\n\n'
    body+="${MIGRATION_NOTE}"
    gh release edit "${TAG}" --repo "${RELEASE_REPOSITORY}" --notes "${body}"
  fi
  exit 0
fi

[[ "$release_exists" == true ]] || {
  echo "cannot finalize missing release ${TAG}; prepare and verify assets first" >&2
  exit 3
}
body="$(gh release view "${TAG}" --repo "${RELEASE_REPOSITORY}" --json body --jq '.body // ""')"
[[ "$body" == *"${MIGRATION_MARKER}"* ]] || {
  echo "cannot finalize ${TAG} without the reconciled migration note" >&2
  exit 3
}

# Drafts intentionally remain unpublished. Non-drafts are finalized only after
# exact remote asset verification. Channel authority lives in the monotonic
# .well-known manifests, but GitHub's "Latest" pointer is a separate surface the
# stable channel MUST advance: stable finalize publishes as prerelease=false +
# make_latest=true, promoting to Latest even when the dev channel already
# published the very same tag as a prerelease. dev/homolog finalize is unchanged
# — they publish as prerelease (flag preserved) and are never Latest. A release
# already in its channel's terminal published state is left immutable so
# repository-level immutable releases can enforce that boundary.
if [[ "${DRAFT}" == "false" ]]; then
  final_state="$(gh release view "${TAG}" --repo "${RELEASE_REPOSITORY}" \
    --json databaseId,isDraft,isPrerelease --jq '[.databaseId,.isDraft,.isPrerelease] | @tsv')"
  IFS=$'\t' read -r release_id is_draft is_prerelease <<<"$final_state"
  [[ "$release_id" =~ ^[0-9]+$ && "$is_draft" =~ ^(true|false)$ && "$is_prerelease" =~ ^(true|false)$ ]] || {
    echo "invalid release state for ${TAG}" >&2
    exit 3
  }
  if [[ "${CHANNEL}" == "stable" ]]; then
    # Stable is the promotion channel. Publish (or promote an already-published
    # dev prerelease) to the sole GitHub Latest: prerelease=false + latest=true.
    # `make_latest` is the legacy string field ("true"/"false") — pass it with
    # -f, not -F. Idempotent: a release already published as non-prerelease
    # Latest is left untouched.
    if [[ "$is_draft" == false && "$is_prerelease" == false ]]; then
      echo "${TAG} is already published as the latest stable release; preserving its metadata"
      exit 0
    fi
    gh api -X PATCH "repos/${RELEASE_REPOSITORY}/releases/${release_id}" \
      -F draft=false -F prerelease=false -f make_latest=true >/dev/null
    exit 0
  fi
  # dev/homolog: prerelease flag preserved, never Latest. A published release is
  # left immutable.
  if [[ "$is_draft" == false ]]; then
    echo "${TAG} is already published; preserving its immutable release metadata"
    exit 0
  fi
  gh api -X PATCH "repos/${RELEASE_REPOSITORY}/releases/${release_id}" \
    -F draft=false -F "prerelease=${is_prerelease}" -f make_latest=false >/dev/null
fi
