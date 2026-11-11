#!/usr/bin/env bash
# Verify a signed @automagik/genie release tarball locally.
#
# Releases ship, per platform (sign-attest.yml + release-publish.yml):
#   genie-<version>-<platform>.tar.gz                  compiled tarball
#   genie-<version>-<platform>.tar.gz.bundle           cosign keyless sigstore bundle
#   genie-<version>-<platform>.tar.gz.intoto.jsonl     SLSA L3 provenance (DSSE)
# and a GitHub-native build-provenance attestation looked up by digest.
#
# Usage:
#   scripts/verify-release.sh <TAG>             # download every tarball for the
#                                                 tag from the GitHub Release and
#                                                 verify each one
#   scripts/verify-release.sh --local <tarball> # verify an already-downloaded
#                                                 tarball (expects <tarball>.bundle
#                                                 and <tarball>.intoto.jsonl beside it)
#
# Requires: cosign (>=2.2), slsa-verifier (>=2.6). gh is required for <TAG> mode
# and, when present, adds a GitHub-native attestation cross-check.
#
# Exit codes are the public contract consumed by SECURITY.md:
#   0 = verified
#   2 = cosign signature verification failed
#   4 = SLSA provenance verification failed
#   5 = signature material missing / not downloadable
#   64 = misuse (bad args)
#   127 = required binary missing

set -euo pipefail

# Canonical signing-identity pin — verified by scripts/check-fingerprint-pinning.sh.
# The comment lines below mirror the substring-grep contract in that script.
# Rotating the pin requires editing this block AND every witness listed in
# scripts/check-fingerprint-pinning.sh WITNESSES array.
#
# A release verifies only when its certificate carries the OIDC issuer, the
# signing workflow at refs/heads/main under one of the two spellings of this
# repository's name, AND both of GitHub's numeric ids for this repository and
# for its owner. A rename changes the name and neither id.
#
# certificate-identity-regexp: ^https://github\.com/automagik-si/genie/\.github/workflows/sign-attest\.yml@refs/heads/main$
# certificate-identity-regexp (pre-rename releases): ^https://github\.com/automagik-dev/genie/\.github/workflows/sign-attest\.yml@refs/heads/main$
# certificate-oidc-issuer:     https://token.actions.githubusercontent.com
# provenance source-uri:       github.com/automagik-si/genie
# provenance source-uri (pre-rename releases): github.com/automagik-dev/genie
# source-repository-id:        1030039430
# source-repository-owner-id:  245047546
REPO="automagik-si/genie"
# The name this repository carried until the 2026-11 rename. Releases published
# before it are signed under this spelling. Nothing is downloaded from it.
PRE_RENAME_REPO="automagik-dev/genie"
ACCEPTED_REPOS=("$REPO" "$PRE_RENAME_REPO")
OIDC_ISSUER="https://token.actions.githubusercontent.com"

workflow_identity_regexp() {
  printf '^https://github\\.com/%s/\\.github/workflows/sign-attest\\.yml@refs/heads/main$\n' "$1"
}

# release_certificate_carries_pinned_ids: reads the two ids from the certificate
# inside a bundle cosign has verified.
# shellcheck source=scripts/release-certificate-ids.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-certificate-ids.sh"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required binary not found in PATH: $1" >&2
    echo "hint: install cosign via https://docs.sigstore.dev/cosign/installation/" >&2
    exit 127
  fi
}

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 64
}

# Resolve the containing directory physically without GNU-only `readlink -f`.
# Keep the final basename unchanged so its adjacent .bundle/.intoto.jsonl files
# remain the verification inputs on both macOS and Linux.
physical_local_path() {
  local input="$1" directory basename
  case "$input" in
    */*)
      directory="${input%/*}"
      basename="${input##*/}"
      [[ -n "$directory" ]] || directory='/'
      ;;
    *)
      directory='.'
      basename="$input"
      ;;
  esac
  [[ -n "$basename" ]] || return 1
  (cd -P "$directory" 2>/dev/null && printf '%s/%s\n' "$PWD" "$basename")
}

# Verify a single tarball against its sidecar cosign bundle + SLSA provenance,
# plus a best-effort GitHub-native attestation cross-check when gh is available.
verify_one() {
  local tarball="$1"
  local bundle="${tarball}.bundle"
  local provenance="${tarball}.intoto.jsonl"

  for required in "${bundle}" "${provenance}"; do
    if [ ! -s "${required}" ]; then
      echo "error: missing signature material: ${required} — exit 5" >&2
      exit 5
    fi
  done

  echo "-> cosign verify-blob --bundle (certificate identity + OIDC issuer pinned)"
  local repo signed_as=""
  for repo in "${ACCEPTED_REPOS[@]}"; do
    if cosign verify-blob \
        --bundle "${bundle}" \
        --certificate-identity-regexp "$(workflow_identity_regexp "${repo}")" \
        --certificate-oidc-issuer "${OIDC_ISSUER}" \
        "${tarball}"; then
      signed_as="${repo}"
      break
    fi
  done
  if [ -z "${signed_as}" ]; then
    echo "error: cosign signature verification failed — exit 2" >&2
    exit 2
  fi

  echo "-> repository ids on the verified certificate (${EXPECTED_REPOSITORY_ID}, owner ${EXPECTED_REPOSITORY_OWNER_ID})"
  if ! release_certificate_carries_pinned_ids "${bundle}"; then
    echo "error: cosign signature verification failed — the certificate does not carry the pinned repository ids — exit 2" >&2
    exit 2
  fi

  echo "-> slsa-verifier verify-artifact"
  # --source-branch main matches reconcile-release-assets.sh: provenance
  # generated from any other branch of the repo must not satisfy this leg.
  # The source is the repository under the spelling the release was signed
  # with; slsa-verifier compares names and has no option for the numeric ids,
  # which the step above already checked for this same tarball.
  if ! slsa-verifier verify-artifact "${tarball}" \
      --provenance-path "${provenance}" \
      --source-uri "github.com/${signed_as}" \
      --source-branch main; then
    echo "error: SLSA provenance verification failed — exit 4" >&2
    exit 4
  fi

  # GitHub-native attestation is an additional cross-check, not a fourth trust
  # anchor: cosign + SLSA above already prove the artifact. Only enforced when
  # gh is installed and its attestation subsystem is reachable.
  if command -v gh >/dev/null 2>&1 && gh attestation verify --help >/dev/null 2>&1; then
    echo "-> gh attestation verify (GitHub-native cross-check)"
    if ! gh attestation verify "${tarball}" --owner "${signed_as%%/*}" >/dev/null 2>&1; then
      echo "warning: gh attestation verify could not confirm ${tarball##*/} (cosign + SLSA already passed)" >&2
    fi
  fi

  echo "OK: $(basename "${tarball}") is cosign-signed AND SLSA-attested by ${signed_as} (repository id ${EXPECTED_REPOSITORY_ID})"
}

main() {
  need cosign
  need slsa-verifier

  local workdir="" cleanup="false"
  local -a tarballs=()

  case "${1:-}" in
    ""|-h|--help)
      usage
      ;;
    --local)
      [ -n "${2:-}" ] || usage
      local one
      one="$(physical_local_path "$2")" || {
        echo "error: no tarball found: ${2} — exit 5" >&2
        exit 5
      }
      [ -f "${one}" ] || { echo "error: no tarball found: ${2} — exit 5" >&2; exit 5; }
      tarballs=("${one}")
      ;;
    *)
      need gh
      local tag="$1"
      workdir="$(mktemp -d -t genie-verify-XXXXXX)"
      cleanup="true"
      trap '[ "${cleanup}" = "true" ] && rm -rf "${workdir}"' EXIT
      echo "-> Downloading release ${tag} to ${workdir}"
      (
        cd "${workdir}"
        gh release download "${tag}" \
          --repo "${REPO}" \
          --pattern '*.tar.gz' \
          --pattern '*.tar.gz.bundle' \
          --pattern '*.tar.gz.intoto.jsonl' \
          || { echo "error: release assets missing — exit 5" >&2; exit 5; }
      )
      shopt -s nullglob
      tarballs=("${workdir}"/*.tar.gz)
      shopt -u nullglob
      # Sidecars share the .tar.gz stem, so exclude the .bundle/.intoto.jsonl the
      # glob would otherwise sweep in (they do not end in .tar.gz, so the glob is
      # already precise — this guard documents intent).
      if [ "${#tarballs[@]}" -eq 0 ]; then
        echo "error: no *.tar.gz assets downloaded for ${tag} — exit 5" >&2
        exit 5
      fi
      ;;
  esac

  local verified=0
  for tarball in "${tarballs[@]}"; do
    verify_one "${tarball}"
    verified=$((verified + 1))
  done
  echo "OK: verified ${verified} tarball(s) for ${REPO}"
  exit 0
}

main "$@"
