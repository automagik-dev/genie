#!/usr/bin/env bash

set -euo pipefail

PREDICATE_TYPE='https://slsa.dev/provenance/v1'
: "${RELEASE_REPOSITORY:?RELEASE_REPOSITORY is required}"
: "${VERSION:?VERSION is required}"

[[ "$RELEASE_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || exit 2
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 2

BUILDER_ID="https://github.com/${RELEASE_REPOSITORY}/.github/workflows/sign-attest.yml@refs/heads/main"
BUILD_TYPE="https://github.com/${RELEASE_REPOSITORY}/release-tarballs@v1"

require_exact_identity() {
  : "${CHANNEL:?CHANNEL is required}"
  : "${SOURCE_SHA:?SOURCE_SHA is required}"
  : "${SOURCE_BRANCH:?SOURCE_BRANCH is required}"
  : "${SOURCE_CI_RUN_ID:?SOURCE_CI_RUN_ID is required}"
  : "${CONTROL_SHA:?CONTROL_SHA is required}"
  : "${RUN_ID:?RUN_ID is required}"
  : "${RUN_ATTEMPT:?RUN_ATTEMPT is required}"
  [[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ && "$CONTROL_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 2
  [[ "$SOURCE_CI_RUN_ID" =~ ^[0-9]+$ && "$RUN_ID" =~ ^[0-9]+$ && "$RUN_ATTEMPT" =~ ^[0-9]+$ ]] || exit 2
  case "$CHANNEL" in stable|homolog|dev) ;; *) exit 2 ;; esac
  case "$SOURCE_BRANCH" in main|homolog|dev) ;; *) exit 2 ;; esac
  SOURCE_URI="git+https://github.com/${RELEASE_REPOSITORY}@refs/heads/${SOURCE_BRANCH}"
  CONTROL_URI="git+https://github.com/${RELEASE_REPOSITORY}@refs/heads/main"
}

create_predicate() {
  local output="${1:-}"
  [[ -n "$output" ]] || exit 64
  jq -n \
    --arg builder_id "$BUILDER_ID" \
    --arg build_type "$BUILD_TYPE" \
    --arg version "$VERSION" \
    --arg channel "$CHANNEL" \
    --arg source_sha "$SOURCE_SHA" \
    --arg source_branch "$SOURCE_BRANCH" \
    --arg source_ci_run_id "$SOURCE_CI_RUN_ID" \
    --arg source_uri "$SOURCE_URI" \
    --arg control_sha "$CONTROL_SHA" \
    --arg control_uri "$CONTROL_URI" \
    --arg invocation_id "https://github.com/${RELEASE_REPOSITORY}/actions/runs/${RUN_ID}/attempts/${RUN_ATTEMPT}" \
    '{
      buildDefinition: {
        buildType: $build_type,
        externalParameters: {
          version: $version,
          channel: $channel,
          source_sha: $source_sha,
          source_branch: $source_branch,
          source_ci_run_id: $source_ci_run_id,
          control_sha: $control_sha
        },
        internalParameters: {},
        resolvedDependencies: [
          {uri: $source_uri, digest: {gitCommit: $source_sha}},
          {uri: $control_uri, digest: {gitCommit: $control_sha}}
        ]
      },
      runDetails: {
        builder: {id: $builder_id},
        metadata: {invocationId: $invocation_id},
        byproducts: []
      }
    }' >"$output"
}

verify_result() {
  local input="${1:-}"
  [[ -f "$input" ]] || exit 64
  jq -e \
    --arg predicate_type "$PREDICATE_TYPE" \
    --arg builder_id "$BUILDER_ID" \
    --arg build_type "$BUILD_TYPE" \
    --arg version "$VERSION" \
    --arg channel "$CHANNEL" \
    --arg source_sha "$SOURCE_SHA" \
    --arg source_branch "$SOURCE_BRANCH" \
    --arg source_ci_run_id "$SOURCE_CI_RUN_ID" \
    --arg source_uri "$SOURCE_URI" \
    --arg control_sha "$CONTROL_SHA" \
    --arg control_uri "$CONTROL_URI" \
    'type == "array" and length > 0 and any(.[];
      .verificationResult.statement as $statement |
      $statement.predicateType == $predicate_type and
      $statement.predicate.runDetails.builder.id == $builder_id and
      $statement.predicate.buildDefinition.buildType == $build_type and
      $statement.predicate.buildDefinition.externalParameters.version == $version and
      $statement.predicate.buildDefinition.externalParameters.channel == $channel and
      $statement.predicate.buildDefinition.externalParameters.source_sha == $source_sha and
      $statement.predicate.buildDefinition.externalParameters.source_branch == $source_branch and
      $statement.predicate.buildDefinition.externalParameters.source_ci_run_id == $source_ci_run_id and
      $statement.predicate.buildDefinition.externalParameters.control_sha == $control_sha and
      ($statement.predicate.buildDefinition.resolvedDependencies | length) == 2 and
      any($statement.predicate.buildDefinition.resolvedDependencies[];
        .uri == $source_uri and .digest.gitCommit == $source_sha) and
      any($statement.predicate.buildDefinition.resolvedDependencies[];
        .uri == $control_uri and .digest.gitCommit == $control_sha)
    )' "$input" >/dev/null
}

# Promotion reuses the exact already-published assets. Their original source
# branch/control commit may differ from the promotion run, so validate that the
# signed predicate is internally consistent and was produced by the pinned
# main-branch signer, while retaining the exact release version/repository.
reusable_control_sha() {
  local input="${1:-}"
  [[ -f "$input" ]] || exit 64
  jq -er \
    --arg predicate_type "$PREDICATE_TYPE" \
    --arg builder_id "$BUILDER_ID" \
    --arg build_type "$BUILD_TYPE" \
    --arg version "$VERSION" \
    --arg repository "$RELEASE_REPOSITORY" \
    'first(
      .[] |
      .verificationResult.statement as $statement |
      $statement.predicate.buildDefinition.externalParameters as $parameters |
      select(
        $statement.predicateType == $predicate_type and
        $statement.predicate.runDetails.builder.id == $builder_id and
        $statement.predicate.buildDefinition.buildType == $build_type and
        $parameters.version == $version and
        ($parameters.channel | test("^(stable|homolog|dev)$")) and
        ($parameters.source_sha | test("^[0-9a-f]{40}$")) and
        ($parameters.source_branch | test("^(main|homolog|dev)$")) and
        ($parameters.source_ci_run_id | test("^[0-9]+$")) and
        ($parameters.control_sha | test("^[0-9a-f]{40}$")) and
        ($statement.predicate.buildDefinition.resolvedDependencies | length) == 2 and
        any($statement.predicate.buildDefinition.resolvedDependencies[];
          .uri == ("git+https://github.com/" + $repository + "@refs/heads/" + $parameters.source_branch) and
          .digest.gitCommit == $parameters.source_sha) and
        any($statement.predicate.buildDefinition.resolvedDependencies[];
          .uri == ("git+https://github.com/" + $repository + "@refs/heads/main") and
          .digest.gitCommit == $parameters.control_sha)
      ) |
      $parameters.control_sha
    )' "$input"
}

verify_reusable_result() {
  reusable_control_sha "${1:-}" >/dev/null
}

case "${1:-}" in
  create) require_exact_identity; create_predicate "${2:-}" ;;
  verify) require_exact_identity; verify_result "${2:-}" ;;
  verify-reusable) verify_reusable_result "${2:-}" ;;
  reusable-control-sha) reusable_control_sha "${2:-}" ;;
  *) exit 64 ;;
esac
