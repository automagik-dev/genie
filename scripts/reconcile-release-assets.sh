#!/usr/bin/env bash

set -euo pipefail

: "${VERSION:?VERSION is required}"
RELEASE_REPOSITORY="${RELEASE_REPOSITORY:-${GITHUB_REPOSITORY:-}}"
: "${RELEASE_REPOSITORY:?RELEASE_REPOSITORY or GITHUB_REPOSITORY is required}"
DIST_DIR="${DIST_DIR:-dist}"

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
EXPECTED=()
for platform in "${PLATFORMS[@]}"; do
  tarball="genie-${VERSION}-${platform}.tar.gz"
  EXPECTED+=("$tarball" "${tarball}.bundle" "${tarball}.intoto.jsonl")
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

WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/genie-release-assets.XXXXXX")"
trap 'rm -rf "$WORK_ROOT"' EXIT HUP INT TERM
REMOTE_JSON="$WORK_ROOT/remote.json"
EXPECTED_JSON="$(printf '%s\n' "${EXPECTED[@]}" | jq -R . | jq -s .)"

fetch_remote_inventory() {
  gh release view "$TAG" --repo "$RELEASE_REPOSITORY" --json assets,isDraft >"$REMOTE_JSON"
  jq -e --argjson expected "$EXPECTED_JSON" '
    (.assets | type == "array") and
    (.isDraft | type == "boolean") and
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
    [[ "$differs" == false ]] || {
      echo "complete draft assets differ from this run; refusing to publish mixed or stale bytes" >&2
      exit 3
    }
    echo "${TAG} draft already has this run's exact complete release inventory"
    exit 0
  fi

  command -v cosign >/dev/null || { echo 'cosign is required to verify published assets' >&2; exit 3; }
  command -v slsa-verifier >/dev/null || { echo 'slsa-verifier is required to verify published assets' >&2; exit 3; }
  for platform in "${PLATFORMS[@]}"; do
    tarball="$complete/genie-${VERSION}-${platform}.tar.gz"
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
      --predicate-type https://slsa.dev/provenance/v1 \
      --cert-identity "https://github.com/${RELEASE_REPOSITORY}/.github/workflows/sign-attest.yml@refs/heads/main" \
      --source-ref refs/heads/main \
      --signer-workflow "${RELEASE_REPOSITORY}/.github/workflows/sign-attest.yml" \
      --format json >"$result"
    native_helper="$(dirname "$0")/release-native-predicate.sh"
    remote_control_sha="$(bash "$native_helper" reusable-control-sha "$result")"
    exact_result="$WORK_ROOT/native-exact-${platform}.json"
    gh attestation verify "$tarball" \
      --repo "$RELEASE_REPOSITORY" \
      --predicate-type https://slsa.dev/provenance/v1 \
      --cert-identity "https://github.com/${RELEASE_REPOSITORY}/.github/workflows/sign-attest.yml@refs/heads/main" \
      --source-ref refs/heads/main \
      --source-digest "$remote_control_sha" \
      --signer-digest "$remote_control_sha" \
      --signer-workflow "${RELEASE_REPOSITORY}/.github/workflows/sign-attest.yml" \
      --format json >"$exact_result"
    exact_control_sha="$(bash "$native_helper" reusable-control-sha "$exact_result")"
    [[ "$exact_control_sha" == "$remote_control_sha" ]] || {
      echo "certificate-filtered attestation control digest mismatch for ${platform}" >&2
      exit 3
    }
  done
  if [[ "$differs" == false ]]; then
    echo "${TAG} already has the exact complete release inventory"
  else
    echo "::notice ::release-assets.reused ${TAG} has a complete verified inventory; preserving its exact published bytes"
  fi
  exit 0
fi

# A partial draft may be resumed only when every already-uploaded byte matches
# this run. Any mismatch fails closed; `--clobber` is deliberately forbidden.
[[ "$(jq -r '.isDraft' "$REMOTE_JSON")" == true ]] || {
  echo "refusing to mutate an incomplete published release: ${TAG}" >&2
  exit 3
}
MISSING=()
index=0
for name in "${EXPECTED[@]}"; do
  if remote_has "$name"; then
    destination="$WORK_ROOT/partial-${index}"
    download_remote "$name" "$destination"
    cmp -- "$DIST_DIR/$name" "$destination/$name" || {
      echo "existing partial release asset differs; refusing to replace it: ${name}" >&2
      exit 3
    }
  else
    MISSING+=("$DIST_DIR/$name")
  fi
  index=$((index + 1))
done

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
  cmp -- "$DIST_DIR/$name" "$destination/$name" || {
    echo "remote release asset verification failed after upload: ${name}" >&2
    exit 3
  }
  index=$((index + 1))
done
echo "verified exact ${#EXPECTED[@]}-asset inventory for ${TAG}"
