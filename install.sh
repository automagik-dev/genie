#!/usr/bin/env bash
#
# Genie CLI installer — GitHub Releases consumer (post genie-distribution-cutover G4).
#
# Audit: curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/install.sh > install.sh; less install.sh; bash install.sh
#
# Trust anchor (cosign keyless OIDC). Verification pins the certificate
# identity + OIDC issuer — there is no long-lived public key to pin.
# certificate-identity-regexp: ^https://github\.com/automagik-dev/genie/\.github/workflows/sign-attest\.yml@refs/heads/main$
# certificate-oidc-issuer:     https://token.actions.githubusercontent.com
# provenance source-uri:       github.com/automagik-dev/genie
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
# Per-channel manifest URL: stable → latest.json, others → <channel>.json.
# Resolved at runtime in resolve_manifest_url after the channel is known so
# `GENIE_CHANNEL=dev curl ... | bash` reads .well-known/dev.json. See wish
# release-channel-dev (2026-05-11) for the producer-side wiring.
MANIFEST_BASE="https://raw.githubusercontent.com/${REPO}/main/.well-known"
EXPECTED_COSIGN_IDENTITY="^https://github\\.com/${REPO}/\\.github/workflows/sign-attest\\.yml@refs/heads/main$"
EXPECTED_COSIGN_ISSUER="https://token.actions.githubusercontent.com"
# sign-attest.yml registers the GitHub-native attestation under a CUSTOM
# predicate type (NOT https://slsa.dev/provenance/v1 — GitHub's persistence API
# runs SLSA validation for that URI and rejects our custom buildType). The
# verifier MUST pass the same --predicate-type or `gh attestation verify`
# defaults to slsa.dev/provenance/v1 and 404s the lookup. Keep this in lockstep
# with scripts/release-native-predicate.sh + sign-attest.yml.
EXPECTED_ATTESTATION_PREDICATE_TYPE="https://github.com/${REPO}/release-tarballs/v1"
COSIGN_VERSION="v2.4.1"
# `gh attestation verify` is the PRIMARY provenance verifier (cosign verify-blob
# is the fallback). gh is therefore a verification prerequisite: when the system
# gh is missing or too old to support `gh attestation` (needs gh >= 2.49), we
# bootstrap a pinned official gh into TMP_DIR rather than silently degrading to
# cosign-only. Mirrors the cosign bootstrap: pinned version, pinned per-platform
# SHA256, OFFICIAL source only, checksum-verified before execution, never
# installed system-wide. Note gh ships macOS as a .zip (no macOS tarball); Linux
# is a .tar.gz — bootstrap_gh selects the archive tool per platform.
GH_VERSION="v2.96.0"
GENIE_HOME="${GENIE_HOME:-$HOME/.genie}"
LOCAL_BIN="$HOME/.local/bin"
TMP_DIR="$(umask 077; mktemp -d -t genie-install-XXXXXX)"
COSIGN_BIN=""
COSIGN_BOOTSTRAPPED=0
GH_BIN=""
LIFECYCLE_LOCK=""
LIFECYCLE_OWNER_FILE=""
LIFECYCLE_OWNER_RECORD=""
LIFECYCLE_LOCK_STALE_SECONDS=600
# Set while extraction is in flight. This is private disposable source input;
# durable recovery authority lives only in the promoter's internal transaction.
STAGING_DIR=""

cleanup() {
  local status=$?
  release_lifecycle_lock
  rm -rf "$TMP_DIR"
  return "$status"
}
trap cleanup EXIT

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$1" >&2; exit "${2:-1}"; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing prerequisite: $1" 3; }

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

sha256_text() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | awk '{print $1}'
  else
    printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
  fi
}

portable_stat_fields() {
  if stat -f '%Lp %u %l' "$1" >/dev/null 2>&1; then
    stat -f '%Lp %u %l' "$1"
  else
    stat -c '%a %u %h' "$1"
  fi
}

validate_private_temp_root() {
  local path="$1" parent fields mode owner links mode_value uid
  parent="$(dirname "$path")"
  [[ -d "$path" && ! -L "$path" && -d "$parent" && ! -L "$parent" ]] ||
    die "installer temp boundary is not physical" 1
  fields="$(portable_stat_fields "$path")" || die "could not inspect installer temp directory" 1
  read -r mode owner links <<<"$fields"
  uid="$(id -u)"
  [[ "$mode" == "700" && "$owner" == "$uid" && "$links" -ge 1 ]] ||
    die "installer temp directory is not current-user-owned mode 0700" 1
  fields="$(portable_stat_fields "$parent")" || die "could not inspect installer temp parent" 1
  read -r mode owner links <<<"$fields"
  mode_value=$((8#$mode))
  if [[ $((mode_value & 8#022)) -eq 0 ]]; then
    return
  fi
  if [[ "$owner" == "0" && $((mode_value & 8#1000)) -ne 0 ]]; then
    return
  fi
  die "installer temp parent permits unsafe cross-principal replacement" 1
}

validate_private_temp_root "$TMP_DIR"

# Resolve like Node's path.resolve without creating or dereferencing GENIE_HOME.
# The parent must already exist so a losing installer cannot mutate protected
# scope merely while trying to acquire the shared lifecycle lease.
logical_absolute_path() {
  local input="$1" component count=0
  local -a raw_parts normalized_parts
  case "$input" in
    /*) ;;
    *) input="${PWD}/${input}" ;;
  esac
  IFS='/' read -r -a raw_parts <<< "$input"
  for component in "${raw_parts[@]}"; do
    case "$component" in
      ''|.) ;;
      ..)
        if [[ "$count" -gt 0 ]]; then
          count=$((count - 1))
          unset 'normalized_parts[count]'
        fi
        ;;
      *)
        normalized_parts[count]="$component"
        count=$((count + 1))
        ;;
    esac
  done
  if [[ "$count" -eq 0 ]]; then
    printf '/\n'
    return
  fi
  printf '/%s' "${normalized_parts[@]}"
  printf '\n'
}

lock_mtime_seconds() {
  if stat -f '%m' "$1" >/dev/null 2>&1; then
    stat -f '%m' "$1"
  else
    stat -c '%Y' "$1"
  fi
}

# Return success when a numeric PID is confirmed live OR process inspection is
# unavailable. Only ps's ordinary "no such process" status (1) proves death;
# command denial/missing ps/internal errors are unknown and therefore fail
# closed as live, matching TypeScript's EPERM/unknown-identity rule.
pid_is_live_or_unknown() {
  local pid="$1" output status
  if output="$(ps -p "$pid" -o pid= 2>&1)"; then
    return 0
  else
    status=$?
  fi
  # Status 1 with no diagnostic is the portable `ps -p` no-match outcome.
  # Any output or different status means inspection itself was unavailable.
  [[ "$status" -eq 1 && -z "$output" ]] && return 1
  return 0
}

lock_record_is_stale() {
  local path="$1" expected_record="$2" current_record mtime now age pid
  [[ -f "$path" && ! -L "$path" ]] || return 1
  # EOF without a trailing newline still populates the record; only a genuinely
  # empty read collapses to "". A zero-byte lock (a crash between openSync('wx')
  # and writeSync) is thus observed as "" and matched by an "" expected record.
  IFS= read -r current_record < "$path" || [ -n "$current_record" ] || current_record=""
  [[ "$current_record" == "$expected_record" ]] || return 1
  case "$current_record" in
    *:*) pid="${current_record%%:*}" ;;
    *) pid="$current_record" ;;
  esac
  # Liveness via `ps -p`, not `kill -0`, so a lock owned by another user (EPERM
  # under `kill -0`) still counts as alive — the EPERM-is-alive rule
  # lockHasLiveOwner enforces in src/lib/agent-sync.ts. An empty or unparseable
  # record has no live pid to pin it, so it is a dead owner recoverable once
  # aged — the same debris TS lockOwner maps to null.
  if [[ "$pid" =~ ^[0-9]+$ ]] && pid_is_live_or_unknown "$pid"; then return 1; fi
  mtime="$(lock_mtime_seconds "$path" 2>/dev/null)" || return 1
  now="$(date +%s)"
  age=$((now - mtime))
  [[ "$age" -gt "$LIFECYCLE_LOCK_STALE_SECONDS" || "$age" -lt "-$LIFECYCLE_LOCK_STALE_SECONDS" ]]
}

# Judge an EXISTING `.steal` guard we do not own for reaping. Mirrors the TS
# aged-guard-recovery branch in stealStaleLock (src/lib/agent-sync.ts): a guard
# is reapable only when BOTH its mtime is outside the ±stale window AND its
# owner is dead. An empty or unparseable record — the debris a crash between
# guard create and record write leaves — is a dead owner (TS lockOwner returns
# null for the same records). A symlinked or non-regular guard is never
# reapable. Liveness uses `ps -p` so another user's live process (EPERM under
# `kill -0`) still counts as alive, matching lockHasLiveOwner.
foreign_lock_record_is_stale() {
  local path="$1" record pid mtime now age
  [[ -f "$path" && ! -L "$path" ]] || return 1
  # EOF without a trailing newline keeps the partial record (a live pid must not
  # be clobbered to "" and mis-reaped); only a truly empty read yields "".
  IFS= read -r record < "$path" || [ -n "$record" ] || record=""
  case "$record" in
    *:*) pid="${record%%:*}" ;;
    *) pid="$record" ;;
  esac
  # A parseable, live pid pins the guard as owned regardless of age; an empty or
  # unparseable pid falls through as a dead owner subject only to the mtime gate.
  if [[ "$pid" =~ ^[0-9]+$ ]] && pid_is_live_or_unknown "$pid"; then return 1; fi
  mtime="$(lock_mtime_seconds "$path" 2>/dev/null)" || return 1
  now="$(date +%s)"
  age=$((now - mtime))
  [[ "$age" -gt "$LIFECYCLE_LOCK_STALE_SECONDS" || "$age" -lt "-$LIFECYCLE_LOCK_STALE_SECONDS" ]]
}

# Clear abandoned lease debris under the same token-owned `.steal` guard used
# by TypeScript's stealStaleLock (src/lib/agent-sync.ts) — keep the two in
# lockstep. The lock record is checked again while the guard is held, so a
# newly acquired owner can never be removed by an old observation. An abandoned
# guard (aged mtime AND dead/empty owner) is itself reaped and the caller backs
# off so the outer loop can re-win the guard; a fresh or live-owned guard fails
# closed. A guard is only ever unlinked, never renamed or quarantined.
recover_stale_lifecycle_lock() {
  local observed guard guard_owner guard_token guard_record current
  [[ -f "$LIFECYCLE_LOCK" && ! -L "$LIFECYCLE_LOCK" ]] || return 1
  # A zero-byte lock reads as observed="" (dead-owner debris); a no-newline
  # record is preserved rather than clobbered. lock_record_is_stale re-verifies
  # observed against the live bytes before anything is removed.
  IFS= read -r observed < "$LIFECYCLE_LOCK" || [ -n "$observed" ] || observed=""
  lock_record_is_stale "$LIFECYCLE_LOCK" "$observed" || return 1
  guard="${LIFECYCLE_LOCK}.steal"
  guard_token="$(sha256_text "installer-steal:$$:${TMP_DIR}:$(date +%s):${observed}")"
  guard_owner="${guard}.installer-$$-${guard_token:0:16}"
  guard_record="$$:${guard_token:0:32}:unknown"
  ( umask 077; printf '%s\n' "$guard_record" > "$guard_owner" )
  if ! ln "$guard_owner" "$guard" 2>/dev/null; then
    # An abandoned guard (aged mtime AND dead/empty owner) is the F42 debris that
    # otherwise blocks acquisition forever; reap it and back off so the next
    # outer attempt can win the guard. A fresh or live-owned guard is left in
    # place (fail-closed).
    if foreign_lock_record_is_stale "$guard"; then rm -f "$guard"; fi
    rm -f "$guard_owner"
    return 1
  fi
  if lock_record_is_stale "$LIFECYCLE_LOCK" "$observed"; then
    IFS= read -r current < "$LIFECYCLE_LOCK" || [ -n "$current" ] || current=""
    if [[ "$current" == "$observed" ]]; then rm -f "$LIFECYCLE_LOCK"; fi
  fi
  if [[ -e "$guard" && -e "$guard_owner" && "$guard" -ef "$guard_owner" ]]; then rm -f "$guard"; fi
  rm -f "$guard_owner"
  [[ ! -e "$LIFECYCLE_LOCK" ]]
}

# Coordinate the standalone installer with TypeScript lifecycle commands. The
# lock pathname exactly mirrors lifecycleLockPath() in src/lib/agent-sync.ts.
# A same-directory hard link is the portable atomic create-if-absent primitive;
# it fails without replacing an update/setup/uninstall owner's lock.
acquire_lifecycle_lock() {
  local canonical_home digest token attempt
  canonical_home="$(logical_absolute_path "$GENIE_HOME")"
  [[ -d "$(dirname "$canonical_home")" ]] ||
    die "GENIE_HOME parent does not exist; refusing to mutate before lifecycle lease acquisition: $(dirname "$canonical_home")" 1
  digest="$(sha256_text "$canonical_home")"
  LIFECYCLE_LOCK="$(dirname "$canonical_home")/.genie-lifecycle-${digest:0:16}.lock"
  token="$(sha256_text "installer:$$:${TMP_DIR}:$(date +%s)")"
  LIFECYCLE_OWNER_FILE="${LIFECYCLE_LOCK}.installer-$$-${token:0:16}"
  LIFECYCLE_OWNER_RECORD="$$:${token:0:32}:unknown"
  attempt=0
  # A stale lock behind an abandoned guard consumes three attempts in the worst
  # case (reap the guard, then win the guard + clear the lock, then win the
  # lock); budget one extra so transient contention still has slack.
  while [[ "$attempt" -lt 4 ]]; do
    ( umask 077; printf '%s\n' "$LIFECYCLE_OWNER_RECORD" > "$LIFECYCLE_OWNER_FILE" )
    if ln "$LIFECYCLE_OWNER_FILE" "$LIFECYCLE_LOCK" 2>/dev/null; then return 0; fi
    rm -f "$LIFECYCLE_OWNER_FILE"
    recover_stale_lifecycle_lock || true
    attempt=$((attempt + 1))
  done
  LIFECYCLE_OWNER_FILE=""
  LIFECYCLE_OWNER_RECORD=""
  die "another Genie lifecycle command is active for $canonical_home; retry after it finishes" 1
}

release_lifecycle_lock() {
  if [[ -n "$LIFECYCLE_LOCK" && -n "$LIFECYCLE_OWNER_FILE" ]]; then
    if [[ -e "$LIFECYCLE_LOCK" && -e "$LIFECYCLE_OWNER_FILE" && "$LIFECYCLE_LOCK" -ef "$LIFECYCLE_OWNER_FILE" ]]; then
      rm -f "$LIFECYCLE_LOCK"
    fi
    rm -f "$LIFECYCLE_OWNER_FILE"
  fi
  LIFECYCLE_LOCK=""
  LIFECYCLE_OWNER_FILE=""
  LIFECYCLE_OWNER_RECORD=""
}

manifest_get() {
  local payload="$1" key="$2"
  if command -v jq >/dev/null 2>&1; then
    printf '%s\n' "$payload" | jq -r --arg k "$key" '.[$k] // empty'
  else
    printf '%s\n' "$payload" | sed -nE "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\\1/p" | head -n 1
  fi
}

manifest_channel_matches() {
  local payload="$1" wanted="$2" actual
  actual="$(manifest_get "$payload" channel)"
  [[ "$actual" == "$wanted" || ( -z "$actual" && "$wanted" == "stable" ) ]]
}

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

resolve_channel() {
  local channel="${GENIE_CHANNEL:-stable}"
  case "$channel" in
    # Canonical taxonomy (Felipe directive 2026-05-12, cross-repo unified).
    # beta + canary retired; homolog added for the dev→homolog→stable
    # promotion ladder.
    stable|homolog|dev) echo "$channel" ;;
    next)
      # Back-compat: --next was the pre-rename name. Map silently to dev and
      # warn so the operator updates their muscle memory.
      warn "GENIE_CHANNEL=next is deprecated; use GENIE_CHANNEL=dev (mapping to dev for this run)"
      echo "dev" ;;
    beta|canary)
      # Back-compat: beta + canary were defined-but-unused enum values
      # before the 2026-05-12 taxonomy unification. No producer ever wrote
      # the corresponding .well-known files; fall back to dev so existing
      # GENIE_CHANNEL=beta/canary scripts keep installing something
      # reasonable instead of hard-failing.
      warn "GENIE_CHANNEL=$channel is retired; use GENIE_CHANNEL=dev or homolog (mapping to dev for this run)"
      echo "dev" ;;
    *) die "unknown channel: $channel (valid: stable|homolog|dev)" 1 ;;
  esac
}

# Resolve the .well-known manifest URL for the given channel.
# stable → latest.json (kept for back-compat with the v1 manifest layout).
# Everything else → <channel>.json. The producer side
# (release-publish.yml) writes whichever filename matches the channel passed
# through from version.yml — see wish release-channel-dev.
resolve_manifest_url() {
  local channel="$1" file
  if [ "$channel" = "stable" ]; then file="latest.json"; else file="${channel}.json"; fi
  echo "${MANIFEST_BASE}/${file}"
}

fetch_latest() {
  local channel="$1" url payload
  url="$(resolve_manifest_url "$channel")"
  log "manifest=${url##*/}"
  payload="$(curl -fsSL "$url")" || die "could not fetch $url" 5
  manifest_channel_matches "$payload" "$channel" || die "manifest channel mismatch (wanted $channel)" 1
  printf '%s\n' "$payload"
}

audit_log() {
  mkdir -p "$GENIE_HOME/audit"
  printf '%s\n' "$1" >> "$GENIE_HOME/audit/install.jsonl"
}

# Map a detected platform to the gh release asset infix + archive extension.
# gh publishes Linux as .tar.gz and macOS ONLY as .zip (there is no macOS
# tarball), so the extension travels with the slug and bootstrap_gh picks the
# matching extractor.
gh_asset_for_platform() {
  case "$1" in
    linux-x64-glibc|linux-x64-musl) echo "linux_amd64 tar.gz" ;;
    linux-arm64) echo "linux_arm64 tar.gz" ;;
    darwin-arm64) echo "macOS_arm64 zip" ;;
    *) return 1 ;;
  esac
}

# Pinned SHA256s for gh ${GH_VERSION}, taken verbatim from the official
# gh_<ver>_checksums.txt on the cli/cli release (NOT invented). Linux entries are
# the *_linux_*.tar.gz assets; the macOS entry is the *_macOS_arm64.zip asset.
gh_sha_for_asset() {
  case "$1" in
    linux_amd64) echo "83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60" ;;
    linux_arm64) echo "06f86ec7103d41993b76cd78072f43595c34aaa56506d971d9860e67140bf909" ;;
    macOS_arm64) echo "f23a0c37d963aacc3bed703ccbd59b41c5ca22101fab7f00eb2b7cad23aba463" ;;
    *) return 1 ;;
  esac
}

# Download + checksum-verify the pinned official gh into TMP_DIR and extract its
# `bin/gh`. Never installed system-wide; used from TMP_DIR for this run only.
# Mirrors bootstrap_cosign: verify the archive checksum BEFORE extracting or
# executing anything from it.
bootstrap_gh() {
  local platform="$1" slug ext asset expected actual out url ver extract_dir gh_path spec
  spec="$(gh_asset_for_platform "$platform")" || return 1
  read -r slug ext <<<"$spec"
  expected="$(gh_sha_for_asset "$slug")" || return 1
  ver="${GH_VERSION#v}"
  asset="gh_${ver}_${slug}.${ext}"
  out="$TMP_DIR/$asset"
  url="https://github.com/cli/cli/releases/download/${GH_VERSION}/${asset}"
  log "bootstrapping gh CLI ${GH_VERSION} (${slug}) for attestation verification"
  curl -fsSL -o "$out" "$url" || return 1
  actual="$(sha256_file "$out")"
  [[ "$actual" == "$expected" ]] || {
    warn "gh CLI checksum mismatch for ${asset}"
    warn "  expected: ${expected}"
    warn "  actual:   ${actual}"
    return 1
  }
  extract_dir="$TMP_DIR/gh-cli"
  (umask 077; mkdir -p "$extract_dir") || return 1
  case "$ext" in
    tar.gz) tar -xzf "$out" -C "$extract_dir" || return 1 ;;
    zip)
      # macOS: prefer unzip; bsdtar (`tar -xf`) also reads .zip if unzip is absent.
      if command -v unzip >/dev/null 2>&1; then
        unzip -q "$out" -d "$extract_dir" || return 1
      else
        tar -xf "$out" -C "$extract_dir" || return 1
      fi ;;
    *) return 1 ;;
  esac
  gh_path="${extract_dir}/gh_${ver}_${slug}/bin/gh"
  [[ -x "$gh_path" ]] || return 1
  "$gh_path" --version >/dev/null 2>&1 || return 1
  GH_BIN="$gh_path"
}

# Resolve a gh capable of `gh attestation`. Prefer an attestation-capable system
# gh (no download); otherwise bootstrap the pinned official gh. INSECURE=1 skips
# all attestation upstream in download_and_verify, so this is never reached under
# the bypass — consistent with how cosign is only bootstrapped when verifying.
ensure_gh_verifier() {
  local platform="$1"
  if [[ -n "$GH_BIN" ]]; then
    return 0
  fi
  if command -v gh >/dev/null 2>&1 && gh attestation --help >/dev/null 2>&1; then
    GH_BIN="$(command -v gh)"
    return 0
  fi
  bootstrap_gh "$platform"
}

verify_with_gh_attestation() {
  local tarball="$1" platform="$2"
  ensure_gh_verifier "$platform" || return 1
  log "verifying via gh attestation (repo=${REPO}, identity pinned)"
  "$GH_BIN" attestation verify "$tarball" \
    --repo "$REPO" \
    --predicate-type "$EXPECTED_ATTESTATION_PREDICATE_TYPE" \
    --cert-identity-regex "$EXPECTED_COSIGN_IDENTITY" \
    --cert-oidc-issuer "$EXPECTED_COSIGN_ISSUER" \
    >/dev/null 2>&1
}

cosign_asset_for_platform() {
  case "$1" in
    linux-x64-glibc|linux-x64-musl) echo "cosign-linux-amd64" ;;
    linux-arm64) echo "cosign-linux-arm64" ;;
    darwin-arm64) echo "cosign-darwin-arm64" ;;
    *) return 1 ;;
  esac
}

cosign_sha_for_asset() {
  case "$1" in
    cosign-linux-amd64) echo "8b24b946dd5809c6bd93de08033bcf6bc0ed7d336b7785787c080f574b89249b" ;;
    cosign-linux-arm64) echo "3b2e2e3854d0356c45fe6607047526ccd04742d20bd44afb5be91fa2a6e7cb4a" ;;
    cosign-darwin-arm64) echo "13343856b69f70388c4fe0b986a31dde5958e444b41be22d785d3dc5e1a9cc62" ;;
    *) return 1 ;;
  esac
}

bootstrap_cosign() {
  local platform="$1" asset expected actual out url
  asset="$(cosign_asset_for_platform "$platform")" || return 1
  expected="$(cosign_sha_for_asset "$asset")" || return 1
  out="$TMP_DIR/cosign"
  url="https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/${asset}"
  log "bootstrapping cosign verifier ${COSIGN_VERSION} (${asset})"
  curl -fsSL -o "$out" "$url" || return 1
  actual="$(sha256_file "$out")"
  [[ "$actual" == "$expected" ]] || {
    warn "cosign verifier checksum mismatch for ${asset}"
    warn "  expected: ${expected}"
    warn "  actual:   ${actual}"
    return 1
  }
  chmod +x "$out"
  "$out" version >/dev/null 2>&1 || return 1
  COSIGN_BIN="$out"
  COSIGN_BOOTSTRAPPED=1
}

ensure_cosign_verifier() {
  local platform="$1"
  if [[ -n "$COSIGN_BIN" ]]; then
    return 0
  fi
  if command -v cosign >/dev/null 2>&1; then
    COSIGN_BIN="$(command -v cosign)"
    return 0
  fi
  bootstrap_cosign "$platform"
}

verify_with_cosign() {
  local tarball="$1" bundle="$2"
  [[ -n "$COSIGN_BIN" ]] || return 1
  [[ -s "$bundle" ]] || return 1
  log "verifying via cosign verify-blob (bundle=${bundle##*/})"
  "$COSIGN_BIN" verify-blob \
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
  local tried_bootstrap=0
  log "downloading ${tarball_base}/${fname}"
  curl -fsSL -o "$tarball" "${tarball_base}/${fname}" || die "download failed: ${fname}" 5
  curl -fsSL -o "$bundle"  "${tarball_base}/${fname}.bundle" 2>/dev/null || true
  local sha
  sha="$(sha256_file "$tarball")"
  if [[ "${INSECURE:-0}" == "1" ]]; then
    emit_insecure_banner >&2
    audit_log "$(printf '{"ts":"%s","event":"insecure_install","version":"%s","platform":"%s","sha256":"%s","expected_identity":"%s"}' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$version" "$platform" "$sha" "$EXPECTED_COSIGN_IDENTITY")"
  elif verify_with_gh_attestation "$tarball" "$platform"; then
    log "gh attestation: OK (sha256=${sha:0:12}...)"
  elif ensure_cosign_verifier "$platform"; then
    if verify_with_cosign "$tarball" "$bundle"; then
      log "cosign verify-blob: OK (sha256=${sha:0:12}...)"
    else
      tried_bootstrap="$COSIGN_BOOTSTRAPPED"
      if [[ "$tried_bootstrap" != "1" ]] && bootstrap_cosign "$platform" && verify_with_cosign "$tarball" "$bundle"; then
        log "cosign verify-blob: OK (sha256=${sha:0:12}...)"
      else
        die "verification failed for ${fname} — refuse to install. Expected identity: ${EXPECTED_COSIGN_IDENTITY}" 4
      fi
    fi
  else
    die "verification failed for ${fname} — refuse to install. Expected identity: ${EXPECTED_COSIGN_IDENTITY}" 4
  fi
  printf '%s\n' "$tarball"
}

# Verify a freshly-extracted staging tree before it is allowed to replace the
# live install. Rejects a corrupt artifact (no binary / non-executable) and a
# version mismatch (wrong tarball) so a broken payload never reaches promotion.
verify_staged_binary() {
  local staging="$1" expected_version="$2" staged_bin actual_version expected_token actual_token
  staged_bin="${staging}/genie"
  [[ -f "$staged_bin" && ! -L "$staged_bin" && -x "$staged_bin" ]] ||
    die "staged tarball has no physical executable genie binary; refusing to promote a corrupt artifact" 4
  actual_version="$("$staged_bin" --version 2>/dev/null)" ||
    die "staged genie binary failed to execute; refusing to promote a corrupt artifact" 4
  expected_token="$(parse_version_token "$expected_version")" ||
    die "installation manifest supplied an invalid version token: ${expected_version:-empty}" 1
  actual_token="$(parse_version_token "$actual_version")" ||
    die "staged genie emitted no valid version token (got ${actual_version:-empty}); refusing to promote" 4
  [[ "$actual_token" == "$expected_token" ]] ||
    die "staged genie version mismatch (expected ${expected_token}, got ${actual_token}); refusing to promote" 4
}

# Transactional install (F31a). The shell performs no live-path swap,
# rollback, backup, canonical-link replacement, or staging cleanup. Its only
# chmod relocks the private staging root it created to 0700 after extraction
# (tar clobbers that mode via the archived root entry); it never chmods a live
# path. Mutation authority is the already verified staged executable, which
# borrows this shell's exact lifecycle lease and uses native durable
# no-clobber renames.
ensure_physical_install_directory() {
  local path="$1" parent
  parent="$(dirname "$path")"
  [[ -d "$parent" && ! -L "$parent" ]] ||
    die "install directory parent is not physical: $parent" 1
  if [[ -e "$path" || -L "$path" ]]; then
    [[ -d "$path" && ! -L "$path" ]] ||
      die "install path is not a physical directory: $path" 1
    return
  fi
  (umask 077; mkdir "$path") ||
    die "could not create physical install directory: $path" 1
  [[ -d "$path" && ! -L "$path" ]] ||
    die "new install directory was replaced before validation: $path" 1
}

extract_and_link() {
  local tarball="$1" expected_version="$2" bin="$GENIE_HOME/bin"
  ensure_physical_install_directory "$GENIE_HOME"
  ensure_physical_install_directory "$bin"
  STAGING_DIR="${TMP_DIR}/release-payload"
  (umask 077; mkdir "$STAGING_DIR") ||
    die "could not create private external release staging" 1
  [[ -d "$STAGING_DIR" && ! -L "$STAGING_DIR" ]] ||
    die "install staging path is not a physical directory: $STAGING_DIR" 1
  validate_private_temp_root "$STAGING_DIR"
  log "extracting verified release in private temporary staging"
  tar -xzf "$tarball" -C "$STAGING_DIR" ||
    die "extraction failed (corrupt tarball?): ${tarball}" 5
  # tar restores the archived root "./" entry's recorded mode (0755 on every
  # published tarball) onto the extraction directory, clobbering the 0700 we
  # created $STAGING_DIR with. The transactional promoter asserts the staging
  # root is *exactly* 0700, so relock the private staging sandbox before
  # promotion. This normalizes only the shell's own staging root — it performs
  # no live-path mutation and touches no promotion object.
  chmod 700 "$STAGING_DIR" ||
    die "could not relock private staging root after extraction: $STAGING_DIR" 1
  verify_staged_binary "$STAGING_DIR" "$expected_version"
  [[ -n "$LIFECYCLE_LOCK" && -n "$LIFECYCLE_OWNER_RECORD" ]] ||
    die "lifecycle lease was lost before transactional promotion" 1
  if ! GENIE_LIFECYCLE_LEASE_PATH="$LIFECYCLE_LOCK" \
    GENIE_LIFECYCLE_LEASE_OWNER="$LIFECYCLE_OWNER_RECORD" \
    "$STAGING_DIR/genie" __install-promote \
      --staging-root "$STAGING_DIR" \
      --expected-version "$expected_version"; then
    die "verified staged promoter could not complete the install transaction; retained artifacts are retryable" 1
  fi
  STAGING_DIR=""
  log "canonical link: $LOCAL_BIN/genie → $bin/genie"
}

# Detect pre-cutover (bun-global / npm-global) installs and surface the
# exact uninstall command. install.sh writes the new binary at
# ${GENIE_HOME}/bin/genie + a symlink at ${LOCAL_BIN}/genie, but if the
# legacy bin directory ranks ahead of ${LOCAL_BIN} on PATH the shell
# keeps invoking the OLD binary. The new install is dormant until the
# operator removes the legacy package. We don't auto-uninstall — the
# package manager call is risky to run blind (different PMs, different
# permissions, sudo escalation). Print the exact one-line fix instead.
detect_legacy_install() {
  local bun_path="${HOME}/.bun/install/global/node_modules/@automagik/genie"
  local npm_prefix npm_path=""
  if command -v npm >/dev/null 2>&1; then
    npm_prefix="$(npm config get prefix 2>/dev/null || true)"
    [[ -n "$npm_prefix" && "$npm_prefix" != "undefined" ]] \
      && npm_path="${npm_prefix}/lib/node_modules/@automagik/genie"
  fi

  local legacy_found=0 cmd=""
  if [[ -d "$bun_path" ]]; then
    legacy_found=1
    cmd="bun pm uninstall -g @automagik/genie"
  elif [[ -n "$npm_path" && -d "$npm_path" ]]; then
    legacy_found=1
    cmd="npm uninstall -g @automagik/genie"
  fi

  if [[ "$legacy_found" -eq 1 ]]; then
    printf '\033[1;33m'
    printf '!! ============================================================\n'
    printf '!! Legacy install detected. To complete the migration, run:\n'
    printf '!!\n'
    printf '!!   %s\n' "$cmd"
    printf '!!   hash -r       # or open a new shell\n'
    printf '!!\n'
    printf '!! Then verify: `which genie` should show %s.\n' "${LOCAL_BIN}/genie"
    printf '!! ============================================================\n'
    printf '\033[0m'
  fi
}

# Post-install PATH wiring. The shell-rc PATH wiring lives here in the
# installer (mirroring how `genie init` idempotently manages .gitignore) — the
# `genie install` subcommand only runs TypeScript-side finishers (v4 legacy
# cleanup), never PATH edits. If $LOCAL_BIN is already resolvable on PATH
# there is nothing to do; otherwise append a single export line to the login
# shell's rc file, guarded so re-runs never duplicate it.
path_contains_local_bin() {
  case ":${PATH}:" in
    *":${LOCAL_BIN}:"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Pick the rc file for the user's login shell. Fall back to ~/.profile, which
# POSIX login shells source.
shell_rc_file() {
  case "$(basename "${SHELL:-}")" in
    zsh) echo "$HOME/.zshrc" ;;
    bash)
      # macOS bash login shells read ~/.bash_profile; Linux reads ~/.bashrc.
      # Prefer an existing file, else default per-OS.
      if [[ -f "$HOME/.bashrc" ]]; then echo "$HOME/.bashrc"
      elif [[ -f "$HOME/.bash_profile" ]]; then echo "$HOME/.bash_profile"
      elif [[ "$(uname -s)" == "Darwin" ]]; then echo "$HOME/.bash_profile"
      else echo "$HOME/.bashrc"; fi ;;
    *) echo "$HOME/.profile" ;;
  esac
}

ensure_path_wired() {
  if path_contains_local_bin; then
    log "PATH already includes $LOCAL_BIN — genie is ready"
    return 0
  fi
  local rc
  rc="$(shell_rc_file)"
  # Idempotent: if any line already puts ~/.local/bin on PATH (ours or the
  # user's own), don't append a duplicate. The written line uses the literal
  # $HOME form, so match on the shared ".local/bin" substring.
  if [[ -f "$rc" ]] && grep -qF '.local/bin' "$rc" 2>/dev/null; then
    log "PATH wiring already present in ${rc/#$HOME/\~}"
  else
    mkdir -p "$(dirname "$rc")"
    {
      printf '\n# genie: put ~/.local/bin on PATH\n'
      printf 'export PATH="$HOME/.local/bin:$PATH"\n'
    } >> "$rc"
    log "added $LOCAL_BIN to PATH in ${rc/#$HOME/\~}"
  fi
  warn "genie is installed but $LOCAL_BIN is not on your PATH yet."
  warn "  open a new shell, or run:  export PATH=\"$LOCAL_BIN:\$PATH\" && hash -r"
}

# Post-install handoff: run the TypeScript-side finishing step on the binary
# we just linked. The v4 legacy cleanup (stale ~/.claude/rules orchestration
# file, orphaned automagik/genie/4.* plugin caches) lives there — see
# src/genie-commands/install.ts + legacy-v4.ts; it is never duplicated in
# bash. Installer args are forwarded so `curl ... | bash -s -- --skip-v4-cleanup`
# reaches the subcommand. The shell remains the token-authenticated lease owner
# while the child borrows that exact record; a failed finisher is fatal because
# reporting installation success would otherwise bless a partial lifecycle.
# Not `exec` — exec would skip the EXIT trap and leak $TMP_DIR.
handoff_to_subcommand() {
  log "handing off to: genie install (post-install finishing)"
  [[ -n "$LIFECYCLE_LOCK" && -n "$LIFECYCLE_OWNER_RECORD" ]] ||
    die "lifecycle lease was lost before the post-install finisher" 1
  local finisher_status=0
  GENIE_LIFECYCLE_LEASE_PATH="$LIFECYCLE_LOCK" \
    GENIE_LIFECYCLE_LEASE_OWNER="$LIFECYCLE_OWNER_RECORD" \
    "$LOCAL_BIN/genie" install "$@" || finisher_status=$?
  # Exit 2 from the finisher is delivered-but-action-required (installed
  # generation N ≠ delivered T): the signed binary/payload is installed, but the
  # Codex plugin generation was NOT activated. The finisher already printed the
  # single machine-readable result trailer over inherited stdout. Propagate it as
  # exit 2 with no all-green footer — never as a failure (die 1). Exit 2 is
  # disambiguated from an unsupported-platform exit 2 by that trailer
  # (deliveryComplete:true), per the lifecycle exit-matrix contract.
  if [[ "$finisher_status" -eq 2 ]]; then
    DELIVERY_ACTION_REQUIRED=1
    return 0
  fi
  [[ "$finisher_status" -eq 0 ]] ||
    die "genie install finishing failed; installation remains incomplete and retryable" 1
}

parse_version_token() {
  local value="$1"
  local version_re='(^|[^0-9A-Za-z.+-])v?([0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?)([^0-9A-Za-z.+-]|$)'
  [[ "$value" =~ $version_re ]] || return 1
  printf '%s\n' "${BASH_REMATCH[2]}"
}

verify_installation() {
  local expected_version="$1" expected_token actual_version actual_token current_record
  [[ -n "$LIFECYCLE_LOCK" && -f "$LIFECYCLE_LOCK" && ! -L "$LIFECYCLE_LOCK" ]] ||
    die "lifecycle lease disappeared before final installation verification" 1
  IFS= read -r current_record < "$LIFECYCLE_LOCK" || current_record=""
  [[ "$current_record" == "$LIFECYCLE_OWNER_RECORD" ]] ||
    die "lifecycle lease ownership changed before final installation verification" 1
  [[ -x "$GENIE_HOME/bin/genie" && -L "$LOCAL_BIN/genie" && "$LOCAL_BIN/genie" -ef "$GENIE_HOME/bin/genie" ]] ||
    die "installed Genie binary or canonical symlink is missing after finishing" 1
  actual_version="$(GENIE_LIFECYCLE_LEASE_PATH="$LIFECYCLE_LOCK" \
    GENIE_LIFECYCLE_LEASE_OWNER="$LIFECYCLE_OWNER_RECORD" \
    "$LOCAL_BIN/genie" --version)" || die "installed Genie binary failed final version verification" 1
  expected_token="$(parse_version_token "$expected_version")" ||
    die "installation manifest supplied an invalid version token: ${expected_version:-empty}" 1
  actual_token="$(parse_version_token "$actual_version")" ||
    die "installed Genie emitted no valid version token (got ${actual_version:-empty})" 1
  [[ "$actual_token" == "$expected_token" ]] ||
    die "installed Genie version mismatch (expected ${expected_token}, got ${actual_token})" 1
}

main() {
  need curl; need tar; need uname; need ln
  local platform channel payload version tarball_base tarball
  platform="$(detect_platform)"
  channel="$(resolve_channel)"
  log "platform=${platform} channel=${channel}"
  payload="$(fetch_latest "$channel")"
  version="$(manifest_get "$payload" version)"
  tarball_base="$(manifest_get "$payload" tarball_base)"
  [[ -n "$version"      && "$version"      != "null" ]] || die "latest.json missing .version" 1
  [[ -n "$tarball_base" && "$tarball_base" != "null" ]] || die "latest.json missing .tarball_base" 1
  log "installing genie v${version}"
  # Acquire before download verification because INSECURE=1 records its audit
  # event under GENIE_HOME. Ownership then remains continuous through every
  # extraction, PATH, child-finisher, and final-verification mutation.
  acquire_lifecycle_lock
  tarball="$(download_and_verify "$version" "$platform" "$tarball_base")"
  extract_and_link "$tarball" "$version"
  detect_legacy_install
  ensure_path_wired
  handoff_to_subcommand "$@"
  verify_installation "$version"
  if [[ "${DELIVERY_ACTION_REQUIRED:-0}" -eq 1 ]]; then
    # Delivered/action-required: the binary is installed and verified, but the
    # Codex plugin generation is deferred to explicit activation. NO all-green
    # "installed" footer — the finisher's result trailer is the machine signal.
    warn "genie v${version} delivered; Codex activation deferred — retire tasks, then run: genie setup --codex → /hooks → new task"
    release_lifecycle_lock
    exit 2
  fi
  log "genie v${version} installed"
  release_lifecycle_lock
}

if [[ "${GENIE_INSTALL_SOURCE_ONLY:-0}" != "1" ]]; then
  main "$@"
fi
