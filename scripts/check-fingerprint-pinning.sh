#!/usr/bin/env bash
# Assert that the pinned cosign keyless signing identity is byte-identical
# across every channel in which @automagik/genie publishes it.
#
# @automagik/genie release signing is cosign KEYLESS ONLY. There is no
# long-lived public key to pin — the "pin" is the three-value tuple below
# (certificate-identity-regexp + OIDC issuer + provenance source-uri). The
# rotation procedure (docs/security/key-rotation.md) requires two Namastex
# security officers to land any change; this script is the CI merge-gate
# that blocks a single-channel edit from slipping through.
#
# Witnesses (all four MUST contain each canonical line as a substring):
#   1. SECURITY.md                                            in-repo canonical
#   2. .well-known/security.txt                               RFC 9116 mirror
#   3. .github/ISSUE_TEMPLATE/signing-key-fingerprint.md      out-of-band tmpl
#   4. .github/cosign.pub                                     NO-KEY sentinel
#
# The script greps each witness for three verbatim lines. Prefix characters
# (`- `, `# `, ``` ` ```) are tolerated because grep uses substring matching;
# the value strings themselves must match byte-for-byte. If any witness is
# missing a line or carries a divergent value, the script exits 1 with a
# diagnostic that names the witness, the expected line, and the nearest
# candidate match so operators can locate drift quickly.
#
# Exit codes:
#   0 — all four witnesses agree
#   1 — drift detected (one or more witnesses missing or divergent)
#   2 — misuse / missing witness file / run outside a git repo
#
# Manual: scripts/check-fingerprint-pinning.sh
# CI:     .github/workflows/signing-identity-pin.yml

set -euo pipefail

# --- Resolve repo root -------------------------------------------------------
if git rev-parse --show-toplevel >/dev/null 2>&1; then
  REPO_ROOT="$(git rev-parse --show-toplevel)"
else
  REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
cd "${REPO_ROOT}"

# --- Canonical identity lines (byte-exact) -----------------------------------
#
# These three lines are the source of truth. They are duplicated verbatim in
# this script on purpose: if the script itself drifts, CI catches it against
# the witnesses below. To rotate the pin, follow docs/security/key-rotation.md
# and update this constant list in the same two-officer PR that updates the
# witnesses.
CANONICAL=(
  "certificate-identity-regexp: ^https://github.com/automagik-dev/genie/.github/workflows/sign-attest.yml@"
  "certificate-oidc-issuer:     https://token.actions.githubusercontent.com"
  "provenance source-uri:       github.com/automagik-dev/genie"
)

WITNESSES=(
  "SECURITY.md"
  ".well-known/security.txt"
  ".github/ISSUE_TEMPLATE/signing-key-fingerprint.md"
  ".github/cosign.pub"
)

# Optional witnesses: warn-if-absent now, will become required once they
# ship. Keeps the pin discipline locked-in across all future channels even
# if the file lands later in the umbrella sequence.
#
# - scripts/installer/install.sh  — ships in distribution-exodus PR-A7
#                                   (aegis-distribution-sovereignty Wave 1).
#                                   When present, must contain every
#                                   CANONICAL line so operators reading the
#                                   bootstrap script before piping to bash
#                                   can cross-check the trust anchor against
#                                   the other four witnesses.
OPTIONAL_WITNESSES=(
  "scripts/installer/install.sh"
)

# --- Helpers -----------------------------------------------------------------

RED=''
GREEN=''
YELLOW=''
BOLD=''
RESET=''
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  RED=$'\033[31m'
  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  BOLD=$'\033[1m'
  RESET=$'\033[0m'
fi

log()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "${GREEN}" "${RESET}" "$*"; }
warn() { printf '%s!%s %s\n' "${YELLOW}" "${RESET}" "$*" >&2; }
err()  { printf '%s✗%s %s\n' "${RED}"   "${RESET}" "$*" >&2; }

# Return the first line in $2 that contains the needle $1 as a substring,
# or the empty string if no line matches.
nearest_match() {
  local needle="$1"
  local file="$2"
  local anchor
  # Anchor on the key portion (everything up to and including the first colon)
  # so a drifted value still surfaces in the diagnostic rather than a silent
  # empty result.
  anchor="${needle%%:*}:"
  grep -F -- "${anchor}" "${file}" 2>/dev/null | head -n 1 || true
}

# --- Preflight: every witness file must exist --------------------------------

missing_files=0
for witness in "${WITNESSES[@]}"; do
  if [ ! -f "${witness}" ]; then
    err "witness file missing: ${witness}"
    missing_files=1
  fi
done
if [ "${missing_files}" -ne 0 ]; then
  err "aborting — cannot assert pin against a missing witness"
  exit 2
fi

# --- Per-witness substring match --------------------------------------------

drift=0

# Build the active witness set: required + any optional witnesses that exist
# on disk. Missing optional witnesses are reported as warnings but do not
# cause the script to fail.
ACTIVE_WITNESSES=("${WITNESSES[@]}")
for opt in "${OPTIONAL_WITNESSES[@]}"; do
  if [ -f "${opt}" ]; then
    ACTIVE_WITNESSES+=("${opt}")
  else
    warn "optional witness not yet present: ${opt} (will become required when the file ships)"
  fi
done

log "${BOLD}check-fingerprint-pinning${RESET} — asserting signing-identity pin across ${#ACTIVE_WITNESSES[@]} witnesses"
log ""

for witness in "${ACTIVE_WITNESSES[@]}"; do
  log "${BOLD}${witness}${RESET}"
  for line in "${CANONICAL[@]}"; do
    if grep -qF -- "${line}" "${witness}"; then
      ok "contains: ${line}"
    else
      err "missing:  ${line}"
      nearest="$(nearest_match "${line}" "${witness}")"
      if [ -n "${nearest}" ]; then
        warn "nearest candidate in ${witness}: ${nearest}"
      else
        warn "no candidate line in ${witness} matched the key prefix — witness may not carry this pin at all"
      fi
      drift=1
    fi
  done
  log ""
done

# --- Result ------------------------------------------------------------------

if [ "${drift}" -ne 0 ]; then
  err "signing-identity pin has drifted across ${#ACTIVE_WITNESSES[@]} witnesses"
  err "rotation procedure: docs/security/key-rotation.md"
  err "escalation contact: privacidade@namastex.ai"
  exit 1
fi

ok "signing-identity pin is byte-identical across all ${#ACTIVE_WITNESSES[@]} witnesses"
exit 0
