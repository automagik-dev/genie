#!/usr/bin/env bash
# Audit script for the `release-race.next-tag-mismatch.detected` v2 detector
# (severity Medium). Resolves what `npm view @automagik/genie@next` currently
# advertises, follows that version → `vX.Y.Z` git tag → tag's parent commit,
# and compares against the most recent dev merge commit. When they diverge,
# it means @next is advertising a build whose source SHA is no longer the
# tip of dev's merge ledger — the exact symptom of the back-to-back-merge
# race fixed by `.github/workflows/version.yml`.
#
# Companion event: `release-race.next-tag-pin-skipped.detected` (emitted by
# `version.yml` when `git push --atomic` rejects because dev advanced past
# the SHA the Version workflow checked out — the intentional Invariant A
# skip path). This audit script does NOT emit that event; it only consumes
# the post-publish state. Both events are documented in
# `docs/_internal/detectors/release-race.md`.
#
# Wish:    .genie/wishes/fix-next-tag-commit-pinning/WISH.md (Group 2)
# Issue:   #1303
#
# Exit codes (distinct so CI can branch on the cause):
#   0 — healthy state OR non-blocking skip (npm registry unreachable,
#       no merged PR yet, no @next advertised yet). Audit is non-blocking
#       by design — never block a release for an audit hiccup.
#   1 — drift detected: tag parent SHA != most-recent merge commit SHA.
#       A `release-race.next-tag-mismatch.detected` JSON event is emitted
#       on stdout naming both SHAs.
#   2 — misuse: a required tool (`npm`, `gh`, `git`, `jq`) is missing.
#       Distinct from drift so CI workflows install dependencies before
#       running and surface the install gap clearly.
#
# Environment overrides (for testing / local dev):
#   FAKE_NEXT_TAG     — bypass `npm view`; treat this as the @next tag.
#                       Pair with FAKE_NEXT_PARENT.
#   FAKE_NEXT_PARENT  — bypass `git rev-parse <tag>^`; treat this SHA as
#                       the tag's parent. Pair with FAKE_NEXT_TAG.
#   NPM_REGISTRY      — override the registry URL (`npm view --registry=`).
#                       Use a non-routable URL to exercise the SKIP path.
#   NPM_PACKAGE       — override the package name (default
#                       `@automagik/genie`).
#   BASE_BRANCH       — override the base branch for `gh pr list`
#                       (default `dev`).
#
# Manual:  bash scripts/audit-next-tag-pinning.sh
# CI:      .github/workflows/audit-next-tag.yml (nightly, non-blocking)
#          .github/workflows/version.yml        (post-publish, informational)

set -uo pipefail

NPM_PACKAGE="${NPM_PACKAGE:-@automagik/genie}"
BASE_BRANCH="${BASE_BRANCH:-dev}"
EVENT_TYPE="release-race.next-tag-mismatch.detected"

# --- 1. Tool check ----------------------------------------------------------
# Hard-require the four tools the script depends on. Exit 2 (not 1) so CI can
# distinguish "we forgot to install jq" from "the audit found real drift".
require_tool() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "MISSING_TOOL: $name — required for audit-next-tag-pinning.sh" >&2
    echo "Install: ${name} (e.g. apt-get install -y ${name}, or actions/setup-node@v4 for npm)" >&2
    exit 2
  fi
}

require_tool git
require_tool jq
# npm and gh are skipped only when both fake env vars are set, since the
# fake-data path bypasses live registry / GitHub queries entirely.
if [ -z "${FAKE_NEXT_TAG:-}" ] || [ -z "${FAKE_NEXT_PARENT:-}" ]; then
  require_tool npm
  require_tool gh
fi

# --- 2. Resolve repo root + ensure tags are present -------------------------
if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "ERROR: not inside a git repository — audit requires repo context" >&2
  exit 2
fi
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# --- 3. Resolve @next-advertised tag ---------------------------------------
NEXT_TAG=""
NEXT_VERSION=""

if [ -n "${FAKE_NEXT_TAG:-}" ]; then
  # Synthetic-regression path: skip live npm query.
  NEXT_TAG="${FAKE_NEXT_TAG}"
  NEXT_VERSION="${NEXT_TAG#v}"
  echo "INFO: using FAKE_NEXT_TAG=${NEXT_TAG} (live npm query skipped)" >&2
else
  NPM_VIEW_ARGS=("view" "${NPM_PACKAGE}@next" "version")
  if [ -n "${NPM_REGISTRY:-}" ]; then
    NPM_VIEW_ARGS+=("--registry=${NPM_REGISTRY}")
  fi

  # Capture stderr separately so we can print it for diagnostics on failure
  # while still classifying the failure mode (network vs. no-such-version).
  NPM_OUT=""
  NPM_ERR=""
  if NPM_OUT="$(npm "${NPM_VIEW_ARGS[@]}" 2>/tmp/audit-npm-err.$$)"; then
    NEXT_VERSION="$(printf '%s' "$NPM_OUT" | tr -d '[:space:]')"
  else
    NPM_ERR="$(cat /tmp/audit-npm-err.$$ 2>/dev/null || true)"
    rm -f /tmp/audit-npm-err.$$ 2>/dev/null || true
    echo "SKIP: npm registry unreachable — ${NPM_ERR:-no stderr}" >&2
    exit 0
  fi
  rm -f /tmp/audit-npm-err.$$ 2>/dev/null || true

  if [ -z "$NEXT_VERSION" ]; then
    echo "SKIP: npm view returned no version for ${NPM_PACKAGE}@next" >&2
    exit 0
  fi
  NEXT_TAG="v${NEXT_VERSION}"
fi

# --- 4. Resolve tag's parent commit ----------------------------------------
TAG_PARENT=""

if [ -n "${FAKE_NEXT_PARENT:-}" ]; then
  TAG_PARENT="${FAKE_NEXT_PARENT}"
  echo "INFO: using FAKE_NEXT_PARENT=${TAG_PARENT} (git rev-parse skipped)" >&2
else
  # Make sure tags are fetched. Best-effort — local dev may already have them
  # and CI runs `actions/checkout@v4` with `fetch-depth: 0` already.
  git fetch --tags --quiet 2>/dev/null || true

  if ! git rev-parse --verify "${NEXT_TAG}" >/dev/null 2>&1; then
    echo "SKIP: tag ${NEXT_TAG} not found locally — fetch tags or check tag history" >&2
    exit 0
  fi
  if ! TAG_PARENT="$(git rev-parse "${NEXT_TAG}^" 2>/dev/null)"; then
    echo "SKIP: ${NEXT_TAG} has no parent commit (root commit?) — cannot audit" >&2
    exit 0
  fi
fi

# --- 5. Resolve most-recent merge commit on base branch --------------------
MERGE_SHA=""

if [ -n "${FAKE_NEXT_TAG:-}" ] && [ -n "${FAKE_NEXT_PARENT:-}" ]; then
  # Synthetic-regression path: the most-recent merge is the actual current
  # HEAD of the base branch (or HEAD if the branch is unavailable). This
  # makes the drift scenario obvious — FAKE_NEXT_PARENT is intentionally
  # pinned at HEAD~5 in the wish's validation, which won't match HEAD.
  if MERGE_SHA="$(git rev-parse --verify "origin/${BASE_BRANCH}" 2>/dev/null)"; then
    :
  elif MERGE_SHA="$(git rev-parse --verify "${BASE_BRANCH}" 2>/dev/null)"; then
    :
  else
    MERGE_SHA="$(git rev-parse HEAD)"
  fi
  echo "INFO: synthetic mode — most-recent merge SHA = ${MERGE_SHA} (HEAD-equivalent)" >&2
else
  # Live path: most recent PR merged into BASE_BRANCH.
  GH_OUT=""
  if ! GH_OUT="$(gh pr list --state merged --base "${BASE_BRANCH}" --limit 1 --json mergeCommit 2>/dev/null)"; then
    echo "SKIP: gh pr list failed — auth or network issue" >&2
    exit 0
  fi
  MERGE_SHA="$(printf '%s' "$GH_OUT" | jq -r '.[0].mergeCommit.oid // empty')"
  if [ -z "$MERGE_SHA" ] || [ "$MERGE_SHA" = "null" ]; then
    echo "SKIP: no merged PR found on base ${BASE_BRANCH}" >&2
    exit 0
  fi
fi

# --- 6. Compare and emit ---------------------------------------------------
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ "${TAG_PARENT}" = "${MERGE_SHA}" ]; then
  echo "PASS: ${NPM_PACKAGE}@next is at ${NEXT_VERSION} (tag ${NEXT_TAG}); parent ${TAG_PARENT:0:7} matches latest ${BASE_BRANCH} merge."
  exit 0
fi

# Drift — emit the v2 event JSON line on stdout.
jq -n \
  --arg type "${EVENT_TYPE}" \
  --arg subject "release-race-audit" \
  --arg severity "medium" \
  --arg ts "${TIMESTAMP}" \
  --arg pkg "${NPM_PACKAGE}" \
  --arg base_branch "${BASE_BRANCH}" \
  --arg next_version "${NEXT_VERSION}" \
  --arg next_tag "${NEXT_TAG}" \
  --arg tag_parent_sha "${TAG_PARENT}" \
  --arg most_recent_merge_sha "${MERGE_SHA}" \
  '{type: $type, subject: $subject, severity: $severity, ts: $ts, payload: {package: $pkg, base_branch: $base_branch, next_version: $next_version, next_tag: $next_tag, tag_parent_sha: $tag_parent_sha, most_recent_merge_sha: $most_recent_merge_sha}}'

echo "FAIL: ${EVENT_TYPE} — @next ${NEXT_VERSION} (tag ${NEXT_TAG}) has parent ${TAG_PARENT:0:7}, but latest ${BASE_BRANCH} merge is ${MERGE_SHA:0:7}." >&2
exit 1
