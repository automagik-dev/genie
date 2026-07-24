#!/usr/bin/env bash

set -euo pipefail

: "${VERSION:?VERSION is required}"
: "${CHANNEL:?CHANNEL is required}"
RELEASE_REPOSITORY="${RELEASE_REPOSITORY:-${GITHUB_REPOSITORY:-}}"
: "${RELEASE_REPOSITORY:?RELEASE_REPOSITORY or GITHUB_REPOSITORY is required}"
DIST_DIR="${DIST_DIR:-dist}"
: "${CANDIDATE_MANIFEST_DIR:?CANDIDATE_MANIFEST_DIR is required}"

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "invalid release asset version: ${VERSION}" >&2
  exit 2
}
[[ "$RELEASE_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
  echo "invalid release repository: ${RELEASE_REPOSITORY}" >&2
  exit 2
}
[[ -d "$DIST_DIR" && ! -L "$DIST_DIR" ]] || {
  echo "release asset directory must be a physical directory: ${DIST_DIR}" >&2
  exit 3
}

TAG="v${VERSION}"
PLATFORMS=(linux-x64-glibc linux-x64-musl linux-arm64 darwin-arm64)
case "$CHANNEL" in
  stable) EVIDENCE_CHANNELS=(stable homolog dev) ;;
  homolog) EVIDENCE_CHANNELS=(homolog dev) ;;
  dev) EVIDENCE_CHANNELS=(dev) ;;
  *) echo "invalid release asset channel: ${CHANNEL}" >&2; exit 2 ;;
esac
EXPECTED=()
for platform in "${PLATFORMS[@]}"; do
  tarball="genie-${VERSION}-${platform}.tar.gz"
  EXPECTED+=("$tarball" "${tarball}.bundle" "${tarball}.intoto.jsonl")
  for evidence_channel in "${EVIDENCE_CHANNELS[@]}"; do
    descriptor="${tarball}.${evidence_channel}.delivery.json"
    EXPECTED+=("$descriptor" "${descriptor}.sigstore.json")
  done
done

is_expected_name() {
  local candidate="$1" expected
  for expected in "${EXPECTED[@]}"; do
    [[ "$candidate" == "$expected" ]] && return 0
  done
  return 1
}

# Validate the complete local inventory before asking GitHub about the release.
# Artifact downloads are untrusted filesystem input: directories, symlinks,
# empty files, missing sidecars, and extra names all fail before any upload.
shopt -s nullglob dotglob
LOCAL_ENTRIES=("$DIST_DIR"/*)
shopt -u nullglob dotglob
[[ ${#LOCAL_ENTRIES[@]} -eq ${#EXPECTED[@]} ]] || {
  echo "local release inventory must contain exactly ${#EXPECTED[@]} assets; found ${#LOCAL_ENTRIES[@]}" >&2
  exit 3
}
for path in "${LOCAL_ENTRIES[@]}"; do
  name="${path##*/}"
  is_expected_name "$name" || {
    echo "unexpected local release asset: ${name}" >&2
    exit 3
  }
  [[ -f "$path" && ! -L "$path" && -s "$path" ]] || {
    echo "local release asset must be a nonempty physical regular file: ${name}" >&2
    exit 3
  }
done
for name in "${EXPECTED[@]}"; do
  [[ -f "$DIST_DIR/$name" && ! -L "$DIST_DIR/$name" && -s "$DIST_DIR/$name" ]] || {
    echo "missing or unsafe local release asset: ${name}" >&2
    exit 3
  }
done

validate_descriptor() {
  local path="$1" platform="$2" evidence_channel="$3"
  local tarball="genie-${VERSION}-${platform}.tar.gz"
  local platform_triple artifact_path artifact_sha manifest_name manifest_path manifest_sha
  case "$platform" in
    linux-x64-glibc|linux-x64-musl) platform_triple=linux-x64 ;;
    linux-arm64) platform_triple=linux-arm64 ;;
    darwin-arm64) platform_triple=darwin-arm64 ;;
    *) return 1 ;;
  esac
  artifact_path="$(dirname "$path")/${tarball}"
  [[ -f "$artifact_path" && ! -L "$artifact_path" && -s "$artifact_path" ]] || return 1
  if command -v sha256sum >/dev/null 2>&1; then
    artifact_sha="$(sha256sum "$artifact_path" | awk '{print $1}')"
  else
    artifact_sha="$(shasum -a 256 "$artifact_path" | awk '{print $1}')"
  fi
  case "$evidence_channel" in
    stable) manifest_name=latest.json ;;
    homolog) manifest_name=homolog.json ;;
    dev) manifest_name=dev.json ;;
    *) return 1 ;;
  esac
  manifest_path="${CANDIDATE_MANIFEST_DIR}/${manifest_name}"
  [[ -f "$manifest_path" && ! -L "$manifest_path" && -s "$manifest_path" ]] || return 1
  if command -v sha256sum >/dev/null 2>&1; then
    manifest_sha="$(sha256sum "$manifest_path" | awk '{print $1}')"
  else
    manifest_sha="$(shasum -a 256 "$manifest_path" | awk '{print $1}')"
  fi
  jq -e \
    --arg repository "$RELEASE_REPOSITORY" \
    --arg version "$VERSION" \
    --arg channel "$evidence_channel" \
    --arg platform_id "$platform" \
    --arg platform_triple "$platform_triple" \
    --arg release_name "$tarball" \
    --arg artifact_sha "$artifact_sha" \
    --arg manifest_sha "$manifest_sha" \
    '
      type == "object" and
      (keys == [
        "artifactSha256", "canonicalPayloadSha256", "channel", "controlSha", "digestAlgorithm",
        "installedBinarySha256", "platformId", "platformTriple", "releaseManifestSha256", "releaseName",
        "releaseTag", "repository", "schemaVersion", "sourceBranch", "sourceCiRunId", "sourceSha", "version"
      ]) and
      .schemaVersion == 1 and
      .repository == $repository and
      .version == $version and
      .channel == $channel and
      .platformId == $platform_id and
      .platformTriple == $platform_triple and
      .releaseTag == ("v" + $version) and
      .releaseName == $release_name and
      .artifactSha256 == $artifact_sha and
      .releaseManifestSha256 == $manifest_sha and
      .digestAlgorithm == "genie-physical-tree-v1" and
      (.sourceBranch == "main" or .sourceBranch == "homolog" or .sourceBranch == "dev") and
      (if .channel == "stable" then .sourceBranch == "main"
       elif .channel == "homolog" then (.sourceBranch == "main" or .sourceBranch == "homolog")
       else true end) and
      (.sourceCiRunId | type == "string" and test("^[0-9]+$")) and
      ([.releaseManifestSha256, .artifactSha256, .installedBinarySha256, .canonicalPayloadSha256]
        | all(type == "string" and test("^[0-9a-f]{64}$"))) and
      ([.sourceSha, .controlSha] | all(type == "string" and test("^[0-9a-f]{40}$")))
    ' "$path" >/dev/null
}

for platform in "${PLATFORMS[@]}"; do
  for evidence_channel in "${EVIDENCE_CHANNELS[@]}"; do
    descriptor="$DIST_DIR/genie-${VERSION}-${platform}.tar.gz.${evidence_channel}.delivery.json"
    validate_descriptor "$descriptor" "$platform" "$evidence_channel" || {
      echo "delivery descriptor schema or binding is invalid: ${descriptor##*/}" >&2
      exit 3
    }
  done
done

WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/genie-release-assets.XXXXXX")"
trap 'rm -rf "$WORK_ROOT"' EXIT HUP INT TERM
REMOTE_JSON="$WORK_ROOT/remote.json"
EXPECTED_JSON="$(printf '%s\n' "${EXPECTED[@]}" | jq -R . | jq -s .)"

fetch_remote_inventory() {
  gh release view "$TAG" --repo "$RELEASE_REPOSITORY" --json assets,isDraft,isPrerelease >"$REMOTE_JSON"
  jq -e --argjson expected "$EXPECTED_JSON" '
    (.assets | type == "array") and
    (.isDraft | type == "boolean") and
    (.isPrerelease | type == "boolean") and
    (all(.assets[]; (.name | type == "string"))) and
    (([.assets[].name] | length) == ([.assets[].name] | unique | length)) and
    (all(.assets[]; .name as $name | ($expected | index($name)) != null))
  ' "$REMOTE_JSON" >/dev/null || {
    echo "remote release contains malformed, duplicate, or unexpected assets: ${TAG}" >&2
    exit 3
  }
}

remote_has() {
  jq -e --arg name "$1" 'any(.assets[]; .name == $name)' "$REMOTE_JSON" >/dev/null
}

remote_is_complete() {
  jq -e --argjson expected "$EXPECTED_JSON" '([.assets[].name] | sort) == ($expected | sort)' \
    "$REMOTE_JSON" >/dev/null
}

download_remote() {
  local name="$1" destination="$2" path
  mkdir "$destination"
  gh release download "$TAG" --repo "$RELEASE_REPOSITORY" --pattern "$name" --dir "$destination"
  path="$destination/$name"
  [[ -f "$path" && ! -L "$path" && -s "$path" ]] || {
    echo "downloaded release asset must be a nonempty physical regular file: ${name}" >&2
    exit 3
  }
}

verify_inventory() {
  local inventory="$1" platform tarball generic_result result remote_control_sha exact_result exact_control_sha
  local evidence_channel descriptor bundle delivery_result
  command -v cosign >/dev/null || { echo 'cosign is required to verify published assets' >&2; exit 3; }
  command -v slsa-verifier >/dev/null || { echo 'slsa-verifier is required to verify published assets' >&2; exit 3; }
  for platform in "${PLATFORMS[@]}"; do
    tarball="$inventory/genie-${VERSION}-${platform}.tar.gz"
    cosign verify-blob \
      --bundle "${tarball}.bundle" \
      --certificate-identity "https://github.com/${RELEASE_REPOSITORY}/.github/workflows/sign-attest.yml@refs/heads/main" \
      --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
      "$tarball"
    generic_result="$WORK_ROOT/generic-${platform}.json"
    slsa-verifier verify-artifact "$tarball" \
      --provenance-path "${tarball}.intoto.jsonl" \
      --source-uri "github.com/${RELEASE_REPOSITORY}" \
      --source-branch main \
      --print-provenance >"$generic_result"
    bash "$(dirname "$0")/release-generic-provenance.sh" verify-reusable "$generic_result"
    result="$WORK_ROOT/native-${platform}.json"
    gh attestation verify "$tarball" \
      --repo "$RELEASE_REPOSITORY" \
      --predicate-type "https://github.com/${RELEASE_REPOSITORY}/release-tarballs/v1" \
      --cert-identity "https://github.com/${RELEASE_REPOSITORY}/.github/workflows/sign-attest.yml@refs/heads/main" \
      --source-ref refs/heads/main \
      --format json >"$result"
    remote_control_sha="$(bash "$(dirname "$0")/release-native-predicate.sh" reusable-control-sha "$result")"
    exact_result="$WORK_ROOT/native-exact-${platform}.json"
    gh attestation verify "$tarball" \
      --repo "$RELEASE_REPOSITORY" \
      --predicate-type "https://github.com/${RELEASE_REPOSITORY}/release-tarballs/v1" \
      --cert-identity "https://github.com/${RELEASE_REPOSITORY}/.github/workflows/sign-attest.yml@refs/heads/main" \
      --source-ref refs/heads/main \
      --source-digest "$remote_control_sha" \
      --signer-digest "$remote_control_sha" \
      --format json >"$exact_result"
    exact_control_sha="$(bash "$(dirname "$0")/release-native-predicate.sh" reusable-control-sha "$exact_result")"
    [[ "$exact_control_sha" == "$remote_control_sha" ]] || {
      echo "certificate-filtered attestation control digest mismatch for ${platform}" >&2
      exit 3
    }
    for evidence_channel in "${EVIDENCE_CHANNELS[@]}"; do
      descriptor="$inventory/genie-${VERSION}-${platform}.tar.gz.${evidence_channel}.delivery.json"
      bundle="${descriptor}.sigstore.json"
      validate_descriptor "$descriptor" "$platform" "$evidence_channel" || {
        echo "published delivery descriptor schema or binding is invalid: ${descriptor##*/}" >&2
        exit 3
      }
      delivery_result="$WORK_ROOT/delivery-${platform}-${evidence_channel}.json"
      gh attestation verify "$descriptor" \
        --bundle "$bundle" \
        --repo "$RELEASE_REPOSITORY" \
        --predicate-type "https://github.com/${RELEASE_REPOSITORY}/delivery-evidence/v1" \
        --cert-identity "https://github.com/${RELEASE_REPOSITORY}/.github/workflows/release-publish.yml@refs/heads/main" \
        --source-ref refs/heads/main \
        --format json >"$delivery_result"
      jq -e --slurpfile descriptor "$descriptor" \
        'length == 1 and .[0].verificationResult.statement.predicate == $descriptor[0]' \
        "$delivery_result" >/dev/null || {
          echo "delivery attestation predicate does not equal descriptor: ${descriptor##*/}" >&2
          exit 3
        }
    done
  done
}

fetch_remote_inventory

if remote_is_complete; then
  # Promotions rebuild functionally equivalent but not bit-for-bit identical
  # tarballs. A complete published inventory is immutable input: download and
  # validate it, but never replace it with the current run's bytes.
  differs=false
  complete="$WORK_ROOT/complete"
  mkdir "$complete"
  for name in "${EXPECTED[@]}"; do
    gh release download "$TAG" --repo "$RELEASE_REPOSITORY" --pattern "$name" --dir "$complete"
    [[ -f "$complete/$name" && ! -L "$complete/$name" && -s "$complete/$name" ]] || {
      echo "downloaded release asset must be a nonempty physical regular file: ${name}" >&2
      exit 3
    }
    if ! cmp -- "$DIST_DIR/$name" "$complete/$name"; then
      differs=true
    fi
  done

  if [[ "$(jq -r '.isDraft' "$REMOTE_JSON")" == true ]]; then
    verify_inventory "$complete"
    if [[ "$differs" == true ]]; then
      echo "::notice ::release-assets.draft_reused ${TAG} preserves its complete authenticated draft inventory"
    else
      echo "${TAG} draft already has this run's exact complete release inventory"
    fi
    exit 0
  fi

  verify_inventory "$complete"
  if [[ "$differs" == false ]]; then
    echo "${TAG} already has the exact complete release inventory"
  else
    echo "::notice ::release-assets.reused ${TAG} has a complete verified inventory; preserving its exact published bytes"
  fi
  exit 0
fi

if [[ "$(jq -r '.isDraft' "$REMOTE_JSON")" == false ]]; then
  echo "refusing to mutate an incomplete published immutable release: ${TAG}" >&2
  exit 3
fi

# A partial draft may be resumed only when every already-uploaded byte matches
# an authenticated effective inventory. Nondeterministic Sigstore bundle bytes
# from the prior attempt are preserved; `--clobber` is deliberately forbidden.
effective="$WORK_ROOT/partial-effective"
mkdir "$effective"
for name in "${EXPECTED[@]}"; do cp "$DIST_DIR/$name" "$effective/$name"; done
MISSING=()
index=0
for name in "${EXPECTED[@]}"; do
  if remote_has "$name"; then
    destination="$WORK_ROOT/partial-${index}"
    download_remote "$name" "$destination"
    cp "$destination/$name" "$effective/$name"
  else
    MISSING+=("$effective/$name")
  fi
  index=$((index + 1))
done
verify_inventory "$effective"

if [[ ${#MISSING[@]} -gt 0 ]]; then
  gh release upload "$TAG" --repo "$RELEASE_REPOSITORY" "${MISSING[@]}"
fi

fetch_remote_inventory
remote_is_complete || {
  echo "remote release inventory is incomplete after upload: ${TAG}" >&2
  exit 3
}

index=0
for name in "${EXPECTED[@]}"; do
  destination="$WORK_ROOT/final-${index}"
  download_remote "$name" "$destination"
  cmp -- "$effective/$name" "$destination/$name" || {
    echo "remote release asset verification failed after upload: ${name}" >&2
    exit 3
  }
  index=$((index + 1))
done
verify_inventory "$effective"
echo "verified exact ${#EXPECTED[@]}-asset inventory for ${TAG}"
