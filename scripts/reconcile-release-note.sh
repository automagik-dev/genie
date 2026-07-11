#!/usr/bin/env bash

set -euo pipefail

: "${VERSION:?VERSION is required}"
: "${CHANNEL:?CHANNEL is required}"
RELEASE_REPOSITORY="${RELEASE_REPOSITORY:-${GITHUB_REPOSITORY:-}}"
: "${RELEASE_REPOSITORY:?RELEASE_REPOSITORY or GITHUB_REPOSITORY is required}"
DRAFT="${DRAFT:-false}"
case "${DRAFT}" in
  true|false) ;;
  *) echo "invalid DRAFT value: ${DRAFT}" >&2; exit 2 ;;
esac

MIGRATION_MARKER="<!-- genie-agent-sync-migration-v1 -->"
MIGRATION_NOTE=$'<!-- genie-agent-sync-migration-v1 -->\n**One-time integration convergence:** when upgrading from a Genie release older than `5.260711.6` to `5.260711.6` or later, let the first command finish and run `genie update` once more explicitly. The newly installed binary preserves user-owned skills/agents and converges the plugin, hooks, and optional role agents. Confirm exactly H3/H4/H6, review changed hashes with `/hooks`, and start a new Codex task; SessionStart never performs this hop.'
TAG="v${VERSION}"

if ! gh release view "${TAG}" --repo "${RELEASE_REPOSITORY}" >/dev/null 2>&1; then
  notes="Release ${TAG} (channel: ${CHANNEL})"
  notes+=$'\n\n'
  notes+="${MIGRATION_NOTE}"
  create_args=(release create "${TAG}" --repo "${RELEASE_REPOSITORY}" --title "${TAG}" --notes "${notes}")
  [[ "${DRAFT}" == "true" ]] && create_args+=(--draft)
  [[ "${CHANNEL}" != "stable" ]] && create_args+=(--prerelease)
  gh "${create_args[@]}"
fi

body="$(gh release view "${TAG}" --repo "${RELEASE_REPOSITORY}" --json body --jq '.body // ""')"
if [[ "${body}" != *"${MIGRATION_MARKER}"* ]]; then
  [[ -z "${body}" ]] || body+=$'\n\n'
  body+="${MIGRATION_NOTE}"
  gh release edit "${TAG}" --repo "${RELEASE_REPOSITORY}" --notes "${body}"
fi

# Drafts cannot be latest. A stable re-dispatch promotes an existing
# prerelease; non-stable channels remain prereleases.
if [[ "${DRAFT}" == "false" ]]; then
  if [[ "${CHANNEL}" == "stable" ]]; then
    gh release edit "${TAG}" --repo "${RELEASE_REPOSITORY}" --prerelease=false --latest
  else
    gh release edit "${TAG}" --repo "${RELEASE_REPOSITORY}" --prerelease=true --latest=false
  fi
fi
