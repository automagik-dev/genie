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
# without manual approval. Privileged release code itself always runs from the
# trusted default branch; the tag is data, never the workflow ref. The source
# tag/SHA is bound to a successful CI run before build/sign/publish can start.
#
# Subcommands:
#   require-dispatch-tag         guard a stable-capable workflow_dispatch entry
#   check-run-provenance <json>  validate a gh-api run record (pure, no network)
#   guard-run-provenance         fetch + validate an upstream run_id (uses gh)
#   check-trusted-release <source-run.json> <control-runs.json>
#                                validate trusted-control/source provenance
#   check-version-child <parent-sha> <child-sha> <version>
#                                validate the deterministic auto-version delta
#   check-control-descendant <ci-sha> <control-sha>
#                                validate manifest-only control ancestry
#   check-manifest-equivalent-trees <left-sha> <right-sha>
#                                allow differences only in channel manifests
#   guard-trusted-release        fetch + validate the complete release identity
#
# Exit codes: 0 ok | 3 guard failed (fail closed) | 64 misuse
set -euo pipefail

# Release publication uses Genie's exact numeric 5.YYMMDD.N scheme. Channels
# carry dev/homolog semantics, so suffix-bearing tags are rejected before any
# asset upload or manifest reconciliation can begin.
VERSION_RE='^5\.[0-9]{6}\.[1-9][0-9]{0,3}$'
TAG_REF_RE='^refs/tags/v5\.[0-9]{6}\.[1-9][0-9]{0,3}$'

fail()   { printf 'release-guard: %s\n' "$*" >&2; exit 3; }
misuse() { printf 'release-guard: %s\n' "$*" >&2; exit 64; }
note()   { printf 'release-guard: %s\n' "$*" >&2; }

version_from_tag_ref() { printf '%s' "${1#refs/tags/v}"; }

valid_release_version() {
  local version="$1" date_part year month day max_day counter
  [[ "$version" =~ $VERSION_RE ]] || return 1
  date_part="${version#5.}"
  date_part="${date_part%.*}"
  counter="${version##*.}"
  year=$((2000 + 10#${date_part:0:2}))
  month=$((10#${date_part:2:2}))
  day=$((10#${date_part:4:2}))
  ((counter >= 1 && counter <= 9999)) || return 1
  case "$month" in
    1|3|5|7|8|10|12) max_day=31 ;;
    4|6|9|11) max_day=30 ;;
    2)
      max_day=28
      if ((year % 400 == 0 || (year % 4 == 0 && year % 100 != 0))); then max_day=29; fi
      ;;
    *) return 1 ;;
  esac
  ((day >= 1 && day <= max_day))
}

valid_release_tag_ref() {
  local ref="$1"
  [[ "$ref" =~ $TAG_REF_RE ]] && valid_release_version "$(version_from_tag_ref "$ref")"
}

require_release_inputs() {
  local event="${EVENT:-}" control_ref="${CONTROL_REF:-}" version="${VERSION:-}"
  local channel="${CHANNEL:-}" source_sha="${SOURCE_SHA:-}" source_branch="${SOURCE_BRANCH:-}"
  local source_ci_run_id="${SOURCE_CI_RUN_ID:-}"
  local dispatch_actor="${DISPATCH_ACTOR:-}" triggering_actor="${TRIGGERING_ACTOR:-}"
  local run_attempt="${RUN_ATTEMPT:-}"
  local expected_repo="${EXPECTED_REPO:-}" caller_workflow_ref="${CALLER_WORKFLOW_REF:-}"
  local caller_workflow_sha="${CALLER_WORKFLOW_SHA:-}" expected_caller

  [[ "$control_ref" == "refs/heads/main" ]] ||
    fail "privileged release workflow must run from trusted refs/heads/main (got '${control_ref:-<empty>}')"
  [[ -n "$expected_repo" ]] || misuse "trusted release orchestration needs EXPECTED_REPO"
  [[ "$caller_workflow_sha" == "${CONTROL_SHA:-}" ]] ||
    fail "caller workflow SHA '${caller_workflow_sha:-<empty>}' does not match trusted control SHA '${CONTROL_SHA:-<empty>}'"
  valid_release_version "$version" || fail "version input '${version:-<empty>}' fails the release version grammar"
  case "$channel" in
    stable|homolog|dev) ;;
    *) fail "unknown release channel '${channel:-<empty>}' (valid: stable, homolog, dev)" ;;
  esac
  if [[ "$channel" == "stable" ]]; then
    [[ "$event" == "workflow_dispatch" ]] ||
      fail "stable release orchestration is human workflow_dispatch-only (got event='${event:-<none>}')"
    expected_caller="${expected_repo}/.github/workflows/release.yml@refs/heads/main"
    [[ "$caller_workflow_ref" == "$expected_caller" ]] ||
      fail "stable release caller '${caller_workflow_ref:-<empty>}' is not trusted ${expected_caller}"
    [[ -n "$dispatch_actor" && -n "$triggering_actor" ]] ||
      fail "stable release initiation must carry human actor identity"
    [[ "$dispatch_actor" == "$triggering_actor" ]] ||
      fail "stable releases cannot be re-run by a different triggering actor; start a fresh dispatch"
    [[ "$dispatch_actor" != *'[bot]' && "$dispatch_actor" != "github-actions" ]] ||
      fail "stable releases require a human workflow_dispatch initiator (got '${dispatch_actor}')"
    [[ "$run_attempt" == "1" ]] ||
      fail "stable releases cannot reuse workflow attempt ${run_attempt:-<empty>}; start a fresh human dispatch"
  else
    [[ "$event" == "workflow_run" ]] ||
      fail "automated ${channel} releases must be called by trusted version workflow_run control (got event='${event:-<none>}')"
    expected_caller="${expected_repo}/.github/workflows/version.yml@refs/heads/main"
    [[ "$caller_workflow_ref" == "$expected_caller" ]] ||
      fail "automated ${channel} release caller '${caller_workflow_ref:-<empty>}' is not trusted ${expected_caller}"
  fi
  [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || fail "source SHA '${source_sha:-<empty>}' is not a full lowercase commit SHA"
  case "$source_branch" in
    main|homolog|dev) ;;
    *) fail "source branch '${source_branch:-<empty>}' is not an approved release branch" ;;
  esac
  [[ "$source_ci_run_id" =~ ^[0-9]+$ ]] || fail "source CI run id '${source_ci_run_id:-<empty>}' is not numeric"
}

check_ci_run_record() {
  local json="$1" expected_sha="$2" expected_branch="$3"
  local expected_repo="${EXPECTED_REPO:-}" expected_workflow="${EXPECTED_WORKFLOW:-.github/workflows/ci.yml}"
  local expected_event="${EXPECTED_SOURCE_EVENT:-push}"
  [[ -f "$json" ]] || fail "CI run provenance JSON not found: ${json}"
  command -v jq >/dev/null 2>&1 || misuse "jq is required for CI provenance validation"
  [[ -n "$expected_repo" ]] || misuse "CI provenance validation needs EXPECTED_REPO"

  jq -e \
    --arg repo "$expected_repo" \
    --arg workflow "$expected_workflow" \
    --arg sha "$expected_sha" \
    --arg branch "$expected_branch" \
    --arg event "$expected_event" \
    '.repository.full_name == $repo and
     .path == $workflow and
     .status == "completed" and
     .conclusion == "success" and
     .event == $event and
     .head_sha == $sha and
     .head_branch == $branch' \
    "$json" >/dev/null ||
    fail "CI run is not a successful ${expected_event} run for ${expected_repo}/${expected_workflow} at ${expected_branch}@${expected_sha}"
}

# The auto-version child inherits CI authority only when its complete semantic
# delta is the deterministic version bump produced by version.yml. Comparing
# normalized documents prevents an allowlisted package.json from smuggling a
# script or dependency change past the parent commit's successful CI run.
version_child_matches_parent() {
  local parent_sha="$1" child_sha="$2" version="$3" path changed expected child_yaml
  expected="$(printf '%s\n' \
    '.claude-plugin/marketplace.json' \
    'package.json' \
    'plugins/genie/.claude-plugin/plugin.json' \
    'plugins/genie/.codex-plugin/plugin.json' \
    'plugins/genie/package.json' \
    'plugins/hermes-genie/plugin.yaml' | LC_ALL=C sort)"
  changed="$(git diff --name-only "$parent_sha" "$child_sha" -- | LC_ALL=C sort)" || return 1
  [[ "$changed" == "$expected" ]] || return 1
  [[ "$(git show -s --format=%s "$child_sha")" == "chore(version): bump to ${version} [auto-version]" ]] || return 1

  for path in package.json \
    plugins/genie/.claude-plugin/plugin.json \
    plugins/genie/.codex-plugin/plugin.json \
    plugins/genie/package.json; do
    git show "${child_sha}:${path}" |
      jq -e --arg version "$version" '.version == $version' >/dev/null || return 1
    cmp -s \
      <(git show "${parent_sha}:${path}" | jq -S -e '.version = "__GENIE_VERSION__"') \
      <(git show "${child_sha}:${path}" | jq -S -e '.version = "__GENIE_VERSION__"') || return 1
  done

  path='.claude-plugin/marketplace.json'
  git show "${child_sha}:${path}" |
    jq -e --arg version "$version" \
      '([.plugins[]? | select(.name == "genie")] | length) == 1 and
       ([.plugins[]? | select(.name == "genie")][0].version == $version)' >/dev/null || return 1
  cmp -s \
    <(git show "${parent_sha}:${path}" |
      jq -S -e '.plugins |= map(if .name == "genie" then .version = "__GENIE_VERSION__" else . end)') \
    <(git show "${child_sha}:${path}" |
      jq -S -e '.plugins |= map(if .name == "genie" then .version = "__GENIE_VERSION__" else . end)') || return 1

  path='plugins/hermes-genie/plugin.yaml'
  child_yaml="$(git show "${child_sha}:${path}")" || return 1
  [[ "$(printf '%s\n' "$child_yaml" | grep -Ec '^version: [^[:space:]]+$')" == "1" ]] || return 1
  printf '%s\n' "$child_yaml" | grep -Fx "version: ${version}" >/dev/null || return 1
  cmp -s \
    <(git show "${parent_sha}:${path}" | sed -E 's/^version: .+$/version: __GENIE_VERSION__/') \
    <(printf '%s\n' "$child_yaml" | sed -E 's/^version: .+$/version: __GENIE_VERSION__/') || return 1
}

check_version_child() {
  local parent_sha="${1:-}" child_sha="${2:-}" version="${3:-}"
  [[ "$parent_sha" =~ ^[0-9a-f]{40}$ && "$child_sha" =~ ^[0-9a-f]{40}$ ]] ||
    misuse "check-version-child needs full lowercase parent and child commit SHAs"
  valid_release_version "$version" || fail "version input '${version:-<empty>}' fails the release version grammar"
  command -v git >/dev/null 2>&1 || misuse "git is required for version-child validation"
  command -v jq >/dev/null 2>&1 || misuse "jq is required for version-child validation"
  version_child_matches_parent "$parent_sha" "$child_sha" "$version" ||
    fail "${child_sha} is not the deterministic version-only child of ${parent_sha}"
  note "ok — deterministic version-only child ${child_sha}"
}

# release-publish advances main through a dedicated fine-grained PAT
# (RELEASE_MANIFESTS_TOKEN in the release-manifests environment). The resulting
# push runs CI but is explicitly excluded from auto-version recursion by its
# `[release-manifest]` marker. A concurrent/later release may still begin before
# that CI completes, so a main control descendant inherits authority only when
# an already-CI-approved main commit is an ancestor and the final tree differs
# solely in the three generated channel manifests. Net tree equivalence keeps
# workflow code and every executable input byte-identical to that ancestor.
trees_match_except_channel_manifests() {
  local left_sha="$1" right_sha="$2"
  git diff --quiet "$left_sha" "$right_sha" -- . \
    ':(exclude).well-known/latest.json' \
    ':(exclude).well-known/homolog.json' \
    ':(exclude).well-known/dev.json'
}

control_descends_only_by_manifests() {
  local ci_sha="$1" control_sha="$2"
  git merge-base --is-ancestor "$ci_sha" "$control_sha" 2>/dev/null || return 1
  trees_match_except_channel_manifests "$ci_sha" "$control_sha"
}

check_control_descendant() {
  local ci_sha="${1:-}" control_sha="${2:-}"
  [[ "$ci_sha" =~ ^[0-9a-f]{40}$ && "$control_sha" =~ ^[0-9a-f]{40}$ ]] ||
    misuse "check-control-descendant needs full lowercase CI and control commit SHAs"
  command -v git >/dev/null 2>&1 || misuse "git is required for control-descendant validation"
  control_descends_only_by_manifests "$ci_sha" "$control_sha" ||
    fail "control ${control_sha} is not a manifest-only descendant of CI-approved ${ci_sha}"
  note "ok — manifest-only control descendant ${control_sha} inherits ${ci_sha}"
}

check_manifest_equivalent_trees() {
  local left_sha="${1:-}" right_sha="${2:-}"
  [[ "$left_sha" =~ ^[0-9a-f]{40}$ && "$right_sha" =~ ^[0-9a-f]{40}$ ]] ||
    misuse "check-manifest-equivalent-trees needs two full lowercase commit SHAs"
  command -v git >/dev/null 2>&1 || misuse "git is required for manifest-equivalence validation"
  trees_match_except_channel_manifests "$left_sha" "$right_sha" ||
    fail "trees differ outside the three generated channel manifests"
  note "ok — trees differ only by generated channel manifests"
}

check_dev_reachability() {
  local source_sha="${1:-}" dev_ref="${2:-refs/remotes/origin/dev}"
  [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || misuse "check-dev-reachability needs a full lowercase source SHA"
  command -v git >/dev/null 2>&1 || misuse "git is required for dev reachability validation"
  git cat-file -e "${dev_ref}^{commit}" 2>/dev/null || fail "authoritative dev ref ${dev_ref} is unavailable"
  # Consume the complete rev-list stream. Under pipefail, grep -q can close a
  # long-history pipe early and turn git's resulting SIGPIPE into a false deny.
  git rev-list --first-parent "$dev_ref" | awk -v source="$source_sha" '$0 == source { found = 1 } END { exit !found }' ||
    fail "dev source ${source_sha} is not on the authoritative ${dev_ref} first-parent chain"
  note "ok — dev source ${source_sha} is on the ${dev_ref} first-parent chain"
}

# Pure half of the trusted-release guard. The source run is addressed by an
# explicit run id; the control-runs document is the successful main CI listing.
# ACTUAL_TAG_SHA is resolved separately from the remote tag, never trusted from
# a workflow input.
check_trusted_release() {
  local source_json="${1:-}" control_json="${2:-}"
  [[ -n "$source_json" && -n "$control_json" ]] ||
    misuse "check-trusted-release needs source-run and control-runs JSON files"
  require_release_inputs

  local control_sha="${CONTROL_SHA:-}" control_ci_sha="${CONTROL_CI_SHA:-${CONTROL_SHA:-}}"
  local control_manifest_only_match="${CONTROL_MANIFEST_ONLY_MATCH:-false}"
  local actual_tag_sha="${ACTUAL_TAG_SHA:-}" tag_tree_match="${TAG_TREE_MATCH:-false}"
  local version_parent_sha="${VERSION_PARENT_SHA:-}" version_only_match="${VERSION_ONLY_MATCH:-false}" source_ci_sha
  local dev_ref_reachable="${DEV_REF_REACHABLE:-false}"
  [[ "$control_sha" =~ ^[0-9a-f]{40}$ ]] || fail "control SHA '${control_sha:-<empty>}' is not a full lowercase commit SHA"
  [[ "$control_ci_sha" =~ ^[0-9a-f]{40}$ ]] ||
    fail "CI-approved control SHA '${control_ci_sha:-<empty>}' is not a full lowercase commit SHA"
  if [[ "$control_ci_sha" != "$control_sha" && "$control_manifest_only_match" != "true" ]]; then
    fail "trusted main control SHA ${control_sha} is not an approved manifest-only descendant of ${control_ci_sha}"
  fi
  [[ "$actual_tag_sha" =~ ^[0-9a-f]{40}$ ]] || fail "resolved tag SHA '${actual_tag_sha:-<empty>}' is not a full lowercase commit SHA"
  case "$CHANNEL" in
    dev)
      [[ "$SOURCE_BRANCH" == "dev" ]] || fail "dev releases require source_branch=dev"
      [[ "$actual_tag_sha" == "$SOURCE_SHA" ]] ||
        fail "dev release tag v${VERSION} resolves to ${actual_tag_sha}, not CI-approved source SHA ${SOURCE_SHA}"
      source_ci_sha="$(jq -r '.head_sha // empty' "$source_json")"
      [[ "$version_parent_sha" == "$source_ci_sha" ]] ||
        fail "dev tag commit ${SOURCE_SHA} is not a direct child of CI-approved SHA ${source_ci_sha:-<empty>}"
      [[ "$version_only_match" == "true" ]] ||
        fail "dev tag commit ${SOURCE_SHA} is not the exact deterministic version-only child"
      [[ "$dev_ref_reachable" == "true" ]] ||
        fail "dev tag commit ${SOURCE_SHA} is not reachable from the authoritative dev branch"
      EXPECTED_SOURCE_EVENT=push check_ci_run_record "$source_json" "$source_ci_sha" dev
      ;;
    homolog)
      [[ "$SOURCE_BRANCH" == "homolog" ]] || fail "homolog releases require source_branch=homolog"
      [[ "$tag_tree_match" == "true" ]] || fail "homolog source tree does not match v${VERSION}"
      EXPECTED_SOURCE_EVENT=push check_ci_run_record "$source_json" "$SOURCE_SHA" homolog
      ;;
    stable)
      [[ "$SOURCE_BRANCH" == "main" ]] || fail "stable releases require source_branch=main"
      [[ "$tag_tree_match" == "true" ]] || fail "stable main tree does not match v${VERSION}"
      EXPECTED_SOURCE_EVENT=push check_ci_run_record "$source_json" "$SOURCE_SHA" main
      ;;
  esac
  [[ -f "$control_json" ]] || fail "control CI listing JSON not found: ${control_json}"
  jq -e \
    --arg repo "${EXPECTED_REPO:-}" \
    --arg workflow "${EXPECTED_WORKFLOW:-.github/workflows/ci.yml}" \
    --arg sha "$control_ci_sha" \
    '.workflow_runs | any(
      .repository.full_name == $repo and
      .path == $workflow and
      .status == "completed" and
      .conclusion == "success" and
      .event == "push" and
      .head_branch == "main" and
      .head_sha == $sha
    )' "$control_json" >/dev/null ||
    fail "trusted main control ancestor ${control_ci_sha} has no successful CI push run"

  note "ok — trusted main control ${control_sha} (CI authority ${control_ci_sha}) will release CI-approved ${SOURCE_BRANCH}@${SOURCE_SHA} as v${VERSION} (${CHANNEL})"
}

guard_trusted_release() {
  require_release_inputs
  local expected_repo="${EXPECTED_REPO:-}"
  [[ -n "$expected_repo" ]] || misuse "guard-trusted-release needs EXPECTED_REPO"
  command -v gh >/dev/null 2>&1 || misuse "gh CLI is required for guard-trusted-release"
  command -v git >/dev/null 2>&1 || misuse "git is required for guard-trusted-release"

  local source_tmp control_tmp tag_ref tag_lines actual_tag_sha
  source_tmp="$(mktemp)"
  control_tmp="$(mktemp)"
  trap 'rm -f "${source_tmp:-}" "${control_tmp:-}"' EXIT

  if ! gh api "repos/${expected_repo}/actions/runs/${SOURCE_CI_RUN_ID}" >"$source_tmp" 2>/dev/null; then
    fail "could not fetch source CI run ${SOURCE_CI_RUN_ID} from ${expected_repo}"
  fi
  if ! gh api -X GET "repos/${expected_repo}/actions/workflows/ci.yml/runs" \
      -f branch=main -f event=push -f status=success -f per_page=100 >"$control_tmp" 2>/dev/null; then
    fail "could not fetch successful main CI runs from ${expected_repo}"
  fi

  tag_ref="refs/tags/v${VERSION}"
  if ! tag_lines="$(git ls-remote --exit-code origin "$tag_ref" "${tag_ref}^{}" 2>/dev/null)"; then
    fail "release tag ${tag_ref} does not exist on origin"
  fi
  actual_tag_sha="$(printf '%s\n' "$tag_lines" | awk '$2 ~ /\^\{\}$/ { print $1; found=1 } END { if (!found) exit 1 }' 2>/dev/null || true)"
  if [[ -z "$actual_tag_sha" ]]; then
    actual_tag_sha="$(printf '%s\n' "$tag_lines" | awk -v ref="$tag_ref" '$2 == ref { print $1; exit }')"
  fi
  local tag_tree_match=false version_parent_sha="" version_only_match=false dev_ref_reachable=false
  if [[ "$CHANNEL" == "dev" ]]; then
    git cat-file -e "${SOURCE_SHA}^{commit}" 2>/dev/null || git fetch --no-tags origin "$SOURCE_SHA" --quiet
    if ! git fetch --no-tags origin '+refs/heads/dev:refs/remotes/origin/dev' --quiet; then
      fail "could not refresh authoritative origin/dev before release"
    fi
    check_dev_reachability "$SOURCE_SHA" refs/remotes/origin/dev
    dev_ref_reachable=true
    version_parent_sha="$(git rev-list --parents -n1 "$SOURCE_SHA" 2>/dev/null | awk 'NF == 2 { print $2 }')"
    if [[ -n "$version_parent_sha" ]] && version_child_matches_parent "$version_parent_sha" "$SOURCE_SHA" "$VERSION"; then
      version_only_match=true
    fi
  else
    git cat-file -e "${SOURCE_SHA}^{commit}" 2>/dev/null || git fetch --no-tags origin "$SOURCE_SHA" --quiet
    git cat-file -e "${actual_tag_sha}^{commit}" 2>/dev/null || git fetch --no-tags origin "$actual_tag_sha" --quiet
    if trees_match_except_channel_manifests "$actual_tag_sha" "$SOURCE_SHA"; then
      tag_tree_match=true
    fi
  fi
  local control_ci_sha="" control_manifest_only_match=false candidate
  while IFS= read -r candidate; do
    [[ "$candidate" =~ ^[0-9a-f]{40}$ ]] || continue
    git cat-file -e "${candidate}^{commit}" 2>/dev/null || git fetch --no-tags origin "$candidate" --quiet || continue
    if [[ "$candidate" == "${CONTROL_SHA}" ]]; then
      control_ci_sha="$candidate"
      control_manifest_only_match=true
      break
    fi
    if control_descends_only_by_manifests "$candidate" "${CONTROL_SHA}"; then
      control_ci_sha="$candidate"
      control_manifest_only_match=true
      break
    fi
  done < <(jq -r '.workflow_runs[]?.head_sha // empty' "$control_tmp")

  ACTUAL_TAG_SHA="$actual_tag_sha" \
    TAG_TREE_MATCH="$tag_tree_match" \
    VERSION_PARENT_SHA="$version_parent_sha" \
    VERSION_ONLY_MATCH="$version_only_match" \
    DEV_REF_REACHABLE="$dev_ref_reachable" \
    CONTROL_CI_SHA="$control_ci_sha" \
    CONTROL_MANIFEST_ONLY_MATCH="$control_manifest_only_match" \
    check_trusted_release "$source_tmp" "$control_tmp"

  rm -f "$source_tmp" "$control_tmp"
  trap - EXIT
}

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
  valid_release_tag_ref "$ref" ||
    fail "refusing stable-capable dispatch on non-tag ref '${ref:-<empty>}' (channel='${channel:-<none>}'); dispatch recovery must target a protected v<version> tag that passed required CI"
  if [[ -n "$version" ]]; then
    valid_release_version "$version" || fail "version input '${version}' fails the release version grammar"
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
  valid_release_tag_ref "$expected_ref" ||
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
    valid_release_version "$expected_version" ||
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
  rm -f "$tmp"
  trap - EXIT
}

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    require-dispatch-tag) require_dispatch_tag ;;
    check-run-provenance) check_run_provenance "$@" ;;
    guard-run-provenance) guard_run_provenance ;;
    check-trusted-release) check_trusted_release "$@" ;;
    check-version-child) check_version_child "$@" ;;
    check-dev-reachability) check_dev_reachability "$@" ;;
    check-control-descendant) check_control_descendant "$@" ;;
    check-manifest-equivalent-trees) check_manifest_equivalent_trees "$@" ;;
    guard-trusted-release) guard_trusted_release ;;
    *) misuse "unknown subcommand '${cmd:-<none>}'" ;;
  esac
}

if [[ "${RELEASE_GUARD_SOURCE_ONLY:-0}" != "1" ]]; then
  main "$@"
fi
