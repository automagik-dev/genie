#!/usr/bin/env bash
#
# Genie CLI installer — GitHub Releases consumer (post genie-distribution-cutover G4).
#
# Audit: curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/install.sh > install.sh; less install.sh; bash install.sh
#
# Trust anchor (cosign keyless OIDC). Verification pins the certificate
# identity + OIDC issuer — there is no long-lived public key to pin.
#   cert-identity: ^https://github.com/automagik-dev/genie/.github/workflows/sign-attest.yml@
#   issuer:        https://token.actions.githubusercontent.com
#
# Default flow (gh attestation verify, falls back to cosign verify-blob):
#   curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/install.sh | bash
#
# INSECURE=1 (audit-logged bypass; SHA256 floor only — DO NOT USE in production):
#   INSECURE=1 curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/install.sh | bash
#
# Exit codes: 0 ok | 1 generic | 2 unsupported platform | 3 missing prereq | 4 verification failed | 5 download failed
#
set -euo pipefail

REPO="automagik-dev/genie"
LATEST_URL="https://raw.githubusercontent.com/${REPO}/main/.well-known/latest.json"
EXPECTED_COSIGN_IDENTITY="^https://github.com/${REPO}/.github/workflows/sign-attest.yml@"
EXPECTED_COSIGN_ISSUER="https://token.actions.githubusercontent.com"
GENIE_HOME="${GENIE_HOME:-$HOME/.genie}"
LOCAL_BIN="$HOME/.local/bin"
TMP_DIR="$(mktemp -d -t genie-install-XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$1" >&2; exit "${2:-1}"; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing prerequisite: $1" 3; }

detect_platform() {
  local os arch libc=""
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Linux)
      case "$arch" in
        x86_64|amd64)
          command -v ldd >/dev/null 2>&1 || die "missing prerequisite: ldd (required to detect glibc vs musl)" 3
          if ldd --version 2>&1 | grep -qi musl; then libc="-musl"; else libc="-glibc"; fi
          echo "linux-x64${libc}" ;;
        aarch64|arm64) echo "linux-arm64" ;;
        *) die "unsupported Linux architecture: $arch" 2 ;;
      esac ;;
    Darwin)
      case "$arch" in
        arm64) echo "darwin-arm64" ;;
        x86_64) die "darwin-x64 (Intel Mac) is no longer supported; use an Apple Silicon Mac" 2 ;;
        *) die "unsupported macOS architecture: $arch" 2 ;;
      esac ;;
    *) die "unsupported OS: $os (Windows users: install via WSL)" 2 ;;
  esac
}

resolve_channel() { echo "${GENIE_CHANNEL:-stable}"; }

fetch_latest() {
  local channel="$1" payload
  payload="$(curl -fsSL "$LATEST_URL")" || die "could not fetch $LATEST_URL" 5
  printf '%s\n' "$payload" | jq -e --arg c "$channel" '.channel == $c or (.channel == null and $c == "stable")' >/dev/null \
    || die "latest.json channel mismatch (wanted $channel)" 1
  printf '%s\n' "$payload"
}

audit_log() {
  mkdir -p "$GENIE_HOME/audit"
  printf '%s\n' "$1" >> "$GENIE_HOME/audit/install.jsonl"
}

verify_with_gh_attestation() {
  command -v gh >/dev/null 2>&1 || return 1
  log "verifying via gh attestation (repo=${REPO}, identity pinned)"
  gh attestation verify "$1" \
    --repo "$REPO" \
    --cert-identity-regex "$EXPECTED_COSIGN_IDENTITY" \
    --cert-oidc-issuer "$EXPECTED_COSIGN_ISSUER" \
    >/dev/null 2>&1
}

verify_with_cosign() {
  local tarball="$1" bundle="$2"
  command -v cosign >/dev/null 2>&1 || return 1
  [[ -s "$bundle" ]] || return 1
  log "verifying via cosign verify-blob (bundle=${bundle##*/})"
  cosign verify-blob \
    --bundle "$bundle" \
    --certificate-identity-regexp "$EXPECTED_COSIGN_IDENTITY" \
    --certificate-oidc-issuer "$EXPECTED_COSIGN_ISSUER" \
    "$tarball" >/dev/null 2>&1
}

emit_insecure_banner() {
  printf '\033[1;31m'
  printf '!! ============================================================\n'
  printf '!! INSECURE=1 — cosign + attestation verification SKIPPED.\n'
  printf '!! SHA256 logged; signing identity NOT cross-checked.\n'
  printf '!! Bypass audit-logged to %s/audit/install.jsonl.\n' "$GENIE_HOME"
  printf '!! ============================================================\n'
  printf '\033[0m'
}

download_and_verify() {
  local version="$1" platform="$2" tarball_base="$3"
  local fname="genie-${version}-${platform}.tar.gz"
  local tarball="$TMP_DIR/$fname"
  local bundle="$TMP_DIR/${fname}.bundle"
  log "downloading ${tarball_base}/${fname}"
  curl -fsSL -o "$tarball" "${tarball_base}/${fname}" || die "download failed: ${fname}" 5
  curl -fsSL -o "$bundle"  "${tarball_base}/${fname}.bundle" 2>/dev/null || true
  local sha
  sha="$(sha256sum "$tarball" 2>/dev/null | awk '{print $1}')" \
    || sha="$(shasum -a 256 "$tarball" | awk '{print $1}')"
  if [[ "${INSECURE:-0}" == "1" ]]; then
    emit_insecure_banner >&2
    audit_log "$(printf '{"ts":"%s","event":"insecure_install","version":"%s","platform":"%s","sha256":"%s","expected_identity":"%s"}' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$version" "$platform" "$sha" "$EXPECTED_COSIGN_IDENTITY")"
  elif verify_with_gh_attestation "$tarball"; then
    log "gh attestation: OK (sha256=${sha:0:12}...)"
  elif verify_with_cosign "$tarball" "$bundle"; then
    log "cosign verify-blob: OK (sha256=${sha:0:12}...)"
  else
    die "verification failed for ${fname} — refuse to install. Expected identity: ${EXPECTED_COSIGN_IDENTITY}" 4
  fi
  printf '%s\n' "$tarball"
}

extract_and_link() {
  local tarball="$1"
  mkdir -p "$GENIE_HOME/bin" "$LOCAL_BIN"
  log "extracting to $GENIE_HOME/bin"
  tar -xzf "$tarball" -C "$GENIE_HOME/bin"
  chmod +x "$GENIE_HOME/bin/genie"
  ln -sfn "$GENIE_HOME/bin/genie" "$LOCAL_BIN/genie"
  log "symlink: $LOCAL_BIN/genie → $GENIE_HOME/bin/genie"
}

handoff_to_subcommand() {
  log "handing off to: genie install (shell-rc + completions wiring)"
  rm -rf "$TMP_DIR"
  exec "$LOCAL_BIN/genie" install
}

main() {
  need curl; need jq; need tar; need uname
  local platform channel payload version tarball_base tarball
  platform="$(detect_platform)"
  channel="$(resolve_channel)"
  log "platform=${platform} channel=${channel}"
  payload="$(fetch_latest "$channel")"
  version="$(printf '%s\n' "$payload" | jq -r '.version')"
  tarball_base="$(printf '%s\n' "$payload" | jq -r '.tarball_base')"
  [[ -n "$version"      && "$version"      != "null" ]] || die "latest.json missing .version" 1
  [[ -n "$tarball_base" && "$tarball_base" != "null" ]] || die "latest.json missing .tarball_base" 1
  log "installing genie v${version}"
  tarball="$(download_and_verify "$version" "$platform" "$tarball_base")"
  extract_and_link "$tarball"
  handoff_to_subcommand
}

main "$@"
