#!/usr/bin/env bash
# release-guard.sh — testable validation helpers for the protected stable
# release chain (wish stable-release-security-gate, F16/F17).
#
# CI has no workflow simulator, so the ref/tag guard and the upstream run-id
# provenance validation live here as shell helpers with colocated bun:test
# fixtures (scripts/release-guard.test.ts) rather than as inline `${{ }}`
# expressions that can never be unit-tested.
#
# HARD INVARIANT (wish): dev-channel releases must keep publishing end-to-end
# without any manual approval. The guard is a tag-ref requirement on the manual
# `workflow_dispatch` entry points ONLY. The automated dev release path tags the
# freshly-built commit `v<version>` and dispatches release.yml on THAT tag (see
# version.yml), so the dev flow always satisfies the tag guard. Orchestrated
# workflow_call sub-runs pass no run_id and inherit the tag ref, so they are
# never blocked. A tag-ref requirement is the invariant's explicitly permitted
# guard form ("channel == 'stable' (or tag-ref) exemption").
#
# Subcommands:
#   require-dispatch-tag         guard a stable-capable workflow_dispatch entry
#   check-run-provenance <json>  validate a gh-api run record (pure, no network)
#   guard-run-provenance         fetch + validate an upstream run_id (uses gh)
#
# Exit codes: 0 ok | 3 guard failed (fail closed) | 64 misuse
set -euo pipefail

# Version grammar shared with install.sh:parse_version_token and version.yml's
# 5.YYMMDD.N derivation. Tolerates an optional -prerelease / +build suffix.
VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'
TAG_REF_RE='^refs/tags/v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'

fail()   { printf 'release-guard: %s\n' "$*" >&2; exit 3; }
misuse() { printf 'release-guard: %s\n' "$*" >&2; exit 64; }
note()   { printf 'release-guard: %s\n' "$*" >&2; }

version_from_tag_ref() { printf '%s' "${1#refs/tags/v}"; }

# Guard a stable-capable `workflow_dispatch` entry point. Fails closed unless the
# dispatch targets a protected `refs/tags/v<version>` tag; when a version input
# is supplied it must match the release grammar AND the dispatched tag.
require_dispatch_tag() {
  local event="${EVENT:-}" ref="${REF:-}" version="${VERSION:-}" channel="${CHANNEL:-}"
  # Only the manual workflow_dispatch entry is operator-reachable. Tag pushes,
  # pull_request builds, and inherited workflow_call runs are governed by their
  # own trigger filters and orchestrator, so no tag guard is applied to them.
  if [[ "$event" != "workflow_dispatch" ]]; then
    note "event=${event:-<none>} is not a manual dispatch; no tag guard applied"
    return 0
  fi
  [[ "$ref" =~ $TAG_REF_RE ]] ||
    fail "refusing stable-capable dispatch on non-tag ref '${ref:-<empty>}' (channel='${channel:-<none>}'); dispatch recovery must target a protected v<version> tag that passed required CI"
  if [[ -n "$version" ]]; then
    [[ "$version" =~ $VERSION_RE ]] || fail "version input '${version}' fails the release version grammar"
    local tag_version
    tag_version="$(version_from_tag_ref "$ref")"
    [[ "$version" == "$tag_version" ]] ||
      fail "version input '${version}' does not match dispatched tag 'v${tag_version}'"
  fi
  note "ok — dispatch bound to protected tag ${ref}"
}

# Validate a `gh api repos/<repo>/actions/runs/<id>` record against the expected
# upstream identity. Pure: reads a JSON file, no network — unit-tested against
# fixtures. Binds a break-glass recovery dispatch to the SAME repository,
# workflow file, successful conclusion, tag ref, and head SHA.
check_run_provenance() {
  local json="${1:-}"
  [[ -n "$json" ]] || misuse "check-run-provenance requires a JSON file argument"
  [[ -f "$json" ]] || fail "run provenance JSON not found: ${json}"
  command -v jq >/dev/null 2>&1 || misuse "jq is required for check-run-provenance"

  local expected_repo="${EXPECTED_REPO:-}" expected_workflow="${EXPECTED_WORKFLOW:-}"
  local expected_ref="${EXPECTED_REF:-}" expected_sha="${EXPECTED_SHA:-}" expected_version="${EXPECTED_VERSION:-}"
  [[ -n "$expected_repo" && -n "$expected_workflow" && -n "$expected_ref" ]] ||
    misuse "check-run-provenance needs EXPECTED_REPO, EXPECTED_WORKFLOW, EXPECTED_REF"
  [[ "$expected_ref" =~ $TAG_REF_RE ]] ||
    fail "EXPECTED_REF '${expected_ref}' is not a protected v<version> tag"

  local repo path conclusion status head_branch head_sha
  repo="$(jq -r '.repository.full_name // empty' "$json")"
  path="$(jq -r '.path // empty' "$json")"
  conclusion="$(jq -r '.conclusion // empty' "$json")"
  status="$(jq -r '.status // empty' "$json")"
  head_branch="$(jq -r '.head_branch // empty' "$json")"
  head_sha="$(jq -r '.head_sha // empty' "$json")"

  [[ "$repo" == "$expected_repo" ]] ||
    fail "upstream run repository '${repo:-<none>}' != expected '${expected_repo}'"
  [[ "$path" == "$expected_workflow" ]] ||
    fail "upstream run workflow '${path:-<none>}' != expected '${expected_workflow}'"
  [[ "$status" == "completed" ]] ||
    fail "upstream run status '${status:-<none>}' != 'completed'"
  [[ "$conclusion" == "success" ]] ||
    fail "upstream run conclusion '${conclusion:-<none>}' != 'success'"

  local expected_tag
  expected_tag="v$(version_from_tag_ref "$expected_ref")"
  [[ "$head_branch" == "$expected_tag" ]] ||
    fail "upstream run head ref '${head_branch:-<none>}' != dispatched tag '${expected_tag}'"

  if [[ -n "$expected_sha" ]]; then
    [[ "$head_sha" == "$expected_sha" ]] ||
      fail "upstream run head SHA '${head_sha:-<none>}' != dispatched SHA '${expected_sha}'"
  fi

  if [[ -n "$expected_version" ]]; then
    [[ "$expected_version" =~ $VERSION_RE ]] ||
      fail "expected version '${expected_version}' fails the release version grammar"
    local tag_version
    tag_version="$(version_from_tag_ref "$expected_ref")"
    [[ "$expected_version" == "$tag_version" ]] ||
      fail "expected version '${expected_version}' does not match tag 'v${tag_version}'"
  fi

  note "ok — upstream ${expected_workflow} run at ${head_sha} verified (${conclusion}, ${expected_tag})"
}

# Fetch the upstream run record for a break-glass run_id and validate it. A
# missing run_id is the orchestrated same-run path (workflow_call) and is a
# no-op — the artifacts came from THIS run's shared store, not an external run.
guard_run_provenance() {
  local run_id="${RUN_ID:-}"
  if [[ -z "$run_id" ]]; then
    note "no upstream run_id supplied (orchestrated same-run path); skipping provenance check"
    return 0
  fi
  # Validate inputs before probing the environment so malformed input is
  # rejected (exit 3) even on hosts without the gh CLI.
  [[ "$run_id" =~ ^[0-9]+$ ]] || fail "run_id '${run_id}' is not a numeric run id"
  local expected_repo="${EXPECTED_REPO:-}"
  [[ -n "$expected_repo" ]] || misuse "guard-run-provenance needs EXPECTED_REPO"
  command -v gh >/dev/null 2>&1 || misuse "gh CLI is required for guard-run-provenance"
  local tmp
  tmp="$(mktemp)"
  # ${tmp:-} because the EXIT trap outlives this function's local under set -u.
  trap 'rm -f "${tmp:-}"' EXIT
  if ! gh api "repos/${expected_repo}/actions/runs/${run_id}" >"$tmp" 2>/dev/null; then
    fail "could not fetch upstream run ${run_id} from ${expected_repo} (bad run_id or insufficient token scope)"
  fi
  check_run_provenance "$tmp"
}

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    require-dispatch-tag) require_dispatch_tag ;;
    check-run-provenance) check_run_provenance "$@" ;;
    guard-run-provenance) guard_run_provenance ;;
    *) misuse "unknown subcommand '${cmd:-<none>}' (want: require-dispatch-tag | check-run-provenance | guard-run-provenance)" ;;
  esac
}

if [[ "${RELEASE_GUARD_SOURCE_ONLY:-0}" != "1" ]]; then
  main "$@"
fi
