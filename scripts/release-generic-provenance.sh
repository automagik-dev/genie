#!/usr/bin/env bash

set -euo pipefail

: "${RELEASE_REPOSITORY:?RELEASE_REPOSITORY is required}"
: "${VERSION:?VERSION is required}"
[[ "$RELEASE_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || exit 2
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 2

BUILDER_ID='https://github.com/slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@refs/tags/v2.1.0'
CONTROL_URI="git+https://github.com/${RELEASE_REPOSITORY}@refs/heads/main"
STABLE_ENTRY_POINT='.github/workflows/release.yml'
AUTOMATED_ENTRY_POINT='.github/workflows/version.yml'

verify_common() {
  local input="$1" control_sha="$2" entry_point="$3" event_name="$4"
  jq -e \
    --arg builder_id "$BUILDER_ID" \
    --arg control_uri "$CONTROL_URI" \
    --arg control_sha "$control_sha" \
    --arg entry_point "$entry_point" \
    --arg event_name "$event_name" \
    '
      type == "object" and
      .predicateType == "https://slsa.dev/provenance/v0.2" and
      .predicate.builder.id == $builder_id and
      .predicate.buildType == "https://github.com/slsa-framework/slsa-github-generator/generic@v1" and
      .predicate.invocation.configSource.uri == $control_uri and
      .predicate.invocation.configSource.digest.sha1 == $control_sha and
      .predicate.invocation.configSource.entryPoint == $entry_point and
      .predicate.invocation.environment.github_event_name == $event_name and
      .predicate.invocation.environment.github_ref == "refs/heads/main" and
      .predicate.invocation.environment.github_sha1 == $control_sha and
      any(.predicate.materials[];
        .uri == $control_uri and .digest.sha1 == $control_sha)
    ' "$input" >/dev/null
}

verify_dispatch_parameters() {
  local input="$1" require_exact="$2"
  local channel="${CHANNEL:-}" source_sha="${SOURCE_SHA:-}" source_branch="${SOURCE_BRANCH:-}"
  local source_ci_run_id="${SOURCE_CI_RUN_ID:-}"
  if [[ "$require_exact" == "true" ]]; then
    jq -e \
      --arg version "$VERSION" \
      --arg channel "$channel" \
      --arg source_sha "$source_sha" \
      --arg source_branch "$source_branch" \
      --arg source_ci_run_id "$source_ci_run_id" \
      '
        .predicate.invocation.parameters.event_inputs.version == $version and
        .predicate.invocation.parameters.event_inputs.channel == $channel and
        .predicate.invocation.parameters.event_inputs.source_sha == $source_sha and
        .predicate.invocation.parameters.event_inputs.source_branch == $source_branch and
        .predicate.invocation.parameters.event_inputs.source_ci_run_id == $source_ci_run_id
      ' "$input" >/dev/null
  else
    jq -e \
      --arg version "$VERSION" \
      '
        .predicate.invocation.parameters.event_inputs as $inputs |
        $inputs.version == $version and
        ($inputs.channel | test("^(stable|homolog|dev)$")) and
        ($inputs.source_sha | test("^[0-9a-f]{40}$")) and
        ($inputs.source_branch | test("^(main|homolog|dev)$")) and
        ($inputs.source_ci_run_id | test("^[0-9]+$"))
      ' "$input" >/dev/null
  fi
}

verify_automated_event() {
  local input="$1" require_exact="$2"
  local source_branch="${SOURCE_BRANCH:-}" source_ci_run_id="${SOURCE_CI_RUN_ID:-}"
  jq -e \
    --arg repository "$RELEASE_REPOSITORY" \
    --arg source_branch "$source_branch" \
    --arg source_ci_run_id "$source_ci_run_id" \
    --argjson require_exact "$require_exact" \
    '
      .predicate.invocation.environment.github_event_payload.workflow_run as $run |
      ($run.id | tostring | test("^[0-9]+$")) and
      $run.path == ".github/workflows/ci.yml" and
      $run.event == "push" and
      $run.status == "completed" and
      $run.conclusion == "success" and
      ($run.head_branch | test("^(dev|homolog)$")) and
      $run.repository.full_name == $repository and
      (if $require_exact then
         $run.head_branch == $source_branch and ($run.id | tostring) == $source_ci_run_id
       else true end)
    ' "$input" >/dev/null
}

verify_exact() {
  local input="${1:-}"
  : "${CHANNEL:?CHANNEL is required}"
  : "${SOURCE_SHA:?SOURCE_SHA is required}"
  : "${SOURCE_BRANCH:?SOURCE_BRANCH is required}"
  : "${SOURCE_CI_RUN_ID:?SOURCE_CI_RUN_ID is required}"
  : "${CONTROL_SHA:?CONTROL_SHA is required}"
  [[ -f "$input" ]] || exit 64
  [[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ && "$CONTROL_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 2
  [[ "$SOURCE_CI_RUN_ID" =~ ^[0-9]+$ ]] || exit 2
  case "$CHANNEL" in stable|homolog|dev) ;; *) exit 2 ;; esac
  case "$SOURCE_BRANCH" in main|homolog|dev) ;; *) exit 2 ;; esac
  if [[ "$CHANNEL" == "stable" ]]; then
    verify_common "$input" "$CONTROL_SHA" "$STABLE_ENTRY_POINT" workflow_dispatch
    verify_dispatch_parameters "$input" true
  else
    verify_common "$input" "$CONTROL_SHA" "$AUTOMATED_ENTRY_POINT" workflow_run
    verify_automated_event "$input" true
  fi
}

verify_reusable() {
  local input="${1:-}" control_sha entry_point
  [[ -f "$input" ]] || exit 64
  control_sha="$(jq -er '.predicate.invocation.configSource.digest.sha1 | strings' "$input")" || exit 3
  [[ "$control_sha" =~ ^[0-9a-f]{40}$ ]] || exit 3
  entry_point="$(jq -er '.predicate.invocation.configSource.entryPoint | strings' "$input")" || exit 3
  case "$entry_point" in
    "$STABLE_ENTRY_POINT")
      verify_common "$input" "$control_sha" "$entry_point" workflow_dispatch
      verify_dispatch_parameters "$input" false
      ;;
    "$AUTOMATED_ENTRY_POINT")
      verify_common "$input" "$control_sha" "$entry_point" workflow_run
      verify_automated_event "$input" false
      ;;
    *) exit 3 ;;
  esac
}

case "${1:-}" in
  verify-exact) verify_exact "${2:-}" ;;
  verify-reusable) verify_reusable "${2:-}" ;;
  *) exit 64 ;;
esac
