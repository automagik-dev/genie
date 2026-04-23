#!/usr/bin/env bash
# Verify a signed @automagik/genie release tarball locally.
#
# Usage:
#   scripts/verify-release.sh <TAG>             # download from GitHub Release and verify
#   scripts/verify-release.sh --local <tarball> # verify an already-downloaded tarball (expects
#                                                 <tarball>.sig, <tarball>.cert, and
#                                                 provenance.intoto.jsonl alongside)
#
# Requires: cosign (>=2.2), slsa-verifier (>=2.6), gh, jq.
#
# Exit codes mirror `genie sec verify-install` semantics (Group 2):
#   0 = verified
#   2 = cosign signature verification failed
#   4 = SLSA provenance verification failed
#   5 = signature material missing / not downloadable
#   64 = misuse (bad args)
#   127 = required binary missing

set -euo pipefail

REPO="automagik-dev/genie"
WORKFLOW_IDENTITY_REGEXP="^https://github.com/${REPO}/.github/workflows/release.yml@"
OIDC_ISSUER="https://token.actions.githubusercontent.com"
SOURCE_URI="github.com/${REPO}"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required binary not found in PATH: $1" >&2
    echo "hint: install cosign via https://docs.sigstore.dev/cosign/installation/" >&2
    exit 127
  fi
}

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
  exit 64
}

main() {
  need cosign
  need slsa-verifier

  local tarball=""
  local workdir=""
  local cleanup="false"

  case "${1:-}" in
    ""|-h|--help)
      usage
      ;;
    --local)
      [ -n "${2:-}" ] || usage
      tarball="$(readlink -f "$2")"
      workdir="$(dirname "${tarball}")"
      ;;
    *)
      need gh
      local tag="$1"
      workdir="$(mktemp -d -t genie-verify-XXXXXX)"
      cleanup="true"
      echo "-> Downloading release ${tag} to ${workdir}"
      (
        cd "${workdir}"
        gh release download "${tag}" \
          --repo "${REPO}" \
          --pattern '*.tgz' \
          --pattern '*.sig' \
          --pattern '*.cert' \
          --pattern 'provenance.intoto.jsonl' \
          || { echo "error: release assets missing — exit 5" >&2; exit 5; }
      )
      tarball="$(ls "${workdir}"/*.tgz 2>/dev/null | head -1)"
      ;;
  esac

  if [ -z "${tarball}" ] || [ ! -f "${tarball}" ]; then
    echo "error: no tarball found — exit 5" >&2
    exit 5
  fi

  trap '[ "${cleanup}" = "true" ] && rm -rf "${workdir}"' EXIT

  local sig="${tarball}.sig"
  local cert="${tarball}.cert"
  local provenance="${workdir}/provenance.intoto.jsonl"

  for required in "${sig}" "${cert}" "${provenance}"; do
    if [ ! -s "${required}" ]; then
      echo "error: missing signature material: ${required} — exit 5" >&2
      exit 5
    fi
  done

  echo "-> cosign verify-blob (certificate identity + OIDC issuer pinned)"
  if ! cosign verify-blob \
      --certificate-identity-regexp "${WORKFLOW_IDENTITY_REGEXP}" \
      --certificate-oidc-issuer "${OIDC_ISSUER}" \
      --signature "${sig}" \
      --certificate "${cert}" \
      "${tarball}"; then
    echo "error: cosign signature verification failed — exit 2" >&2
    exit 2
  fi

  echo "-> slsa-verifier verify-artifact"
  if ! slsa-verifier verify-artifact "${tarball}" \
      --provenance-path "${provenance}" \
      --source-uri "${SOURCE_URI}"; then
    echo "error: SLSA provenance verification failed — exit 4" >&2
    exit 4
  fi

  echo "OK: $(basename "${tarball}") is cosign-signed AND SLSA-attested by ${REPO}"
  exit 0
}

main "$@"
