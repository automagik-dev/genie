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
# Per-channel manifest URL: stable → latest.json, others → <channel>.json.
# Resolved at runtime in resolve_manifest_url after the channel is known so
# `GENIE_CHANNEL=dev curl ... | bash` reads .well-known/dev.json. See wish
# release-channel-dev (2026-05-11) for the producer-side wiring.
MANIFEST_BASE="https://raw.githubusercontent.com/${REPO}/main/.well-known"
EXPECTED_COSIGN_IDENTITY="^https://github.com/${REPO}/.github/workflows/sign-attest.yml@"
EXPECTED_COSIGN_ISSUER="https://token.actions.githubusercontent.com"
COSIGN_VERSION="v2.4.1"
GENIE_HOME="${GENIE_HOME:-$HOME/.genie}"
LOCAL_BIN="$HOME/.local/bin"
TMP_DIR="$(mktemp -d -t genie-install-XXXXXX)"
COSIGN_BIN=""
COSIGN_BOOTSTRAPPED=0
LIFECYCLE_LOCK=""
LIFECYCLE_OWNER_FILE=""
LIFECYCLE_OWNER_RECORD=""
LIFECYCLE_LOCK_STALE_SECONDS=600

cleanup() {
  release_lifecycle_lock
  rm -rf "$TMP_DIR"
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

lock_record_is_stale() {
  local path="$1" expected_record="$2" current_record mtime now age pid
  [[ -f "$path" && ! -L "$path" ]] || return 1
  IFS= read -r current_record < "$path" || return 1
  [[ "$current_record" == "$expected_record" ]] || return 1
  case "$current_record" in
    [1-9][0-9]*:*) pid="${current_record%%:*}" ;;
    *) return 1 ;;
  esac
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  if kill -0 "$pid" 2>/dev/null; then return 1; fi
  mtime="$(lock_mtime_seconds "$path" 2>/dev/null)" || return 1
  now="$(date +%s)"
  age=$((now - mtime))
  [[ "$age" -gt "$LIFECYCLE_LOCK_STALE_SECONDS" || "$age" -lt "-$LIFECYCLE_LOCK_STALE_SECONDS" ]]
}

# Clear abandoned lease debris under the same token-owned `.steal` guard used
# by TypeScript. The lock record is checked again while the guard is held, so a
# newly acquired owner can never be removed by an old observation.
recover_stale_lifecycle_lock() {
  local observed guard guard_owner guard_token guard_record current
  [[ -f "$LIFECYCLE_LOCK" && ! -L "$LIFECYCLE_LOCK" ]] || return 1
  IFS= read -r observed < "$LIFECYCLE_LOCK" || return 1
  lock_record_is_stale "$LIFECYCLE_LOCK" "$observed" || return 1
  guard="${LIFECYCLE_LOCK}.steal"
  guard_token="$(sha256_text "installer-steal:$$:${TMP_DIR}:$(date +%s):${observed}")"
  guard_owner="${guard}.installer-$$-${guard_token:0:16}"
  guard_record="$$:${guard_token:0:32}:unknown"
  ( umask 077; printf '%s\n' "$guard_record" > "$guard_owner" )
  if ! ln "$guard_owner" "$guard" 2>/dev/null; then
    rm -f "$guard_owner"
    return 1
  fi
  if lock_record_is_stale "$LIFECYCLE_LOCK" "$observed"; then
    IFS= read -r current < "$LIFECYCLE_LOCK" || current=""
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
  while [[ "$attempt" -lt 3 ]]; do
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

gh_attestation_available() {
  command -v gh >/dev/null 2>&1 || return 1
  gh attestation verify --help >/dev/null 2>&1
}

verify_with_gh_attestation() {
  gh_attestation_available || return 1
  log "verifying via gh attestation (repo=${REPO}, identity pinned)"
  gh attestation verify "$1" \
    --repo "$REPO" \
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
  elif verify_with_gh_attestation "$tarball"; then
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

extract_and_link() {
  local tarball="$1"
  mkdir -p "$GENIE_HOME/bin" "$LOCAL_BIN"
  log "extracting to $GENIE_HOME/bin"
  tar -xzf "$tarball" -C "$GENIE_HOME/bin"
  chmod +x "$GENIE_HOME/bin/genie"
  ln -sfn "$GENIE_HOME/bin/genie" "$LOCAL_BIN/genie"
  log "symlink: $LOCAL_BIN/genie → $GENIE_HOME/bin/genie"
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
  if ! GENIE_LIFECYCLE_LEASE_PATH="$LIFECYCLE_LOCK" \
    GENIE_LIFECYCLE_LEASE_OWNER="$LIFECYCLE_OWNER_RECORD" \
    "$LOCAL_BIN/genie" install "$@"; then
    die "genie install finishing failed; installation remains incomplete and retryable" 1
  fi
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
  need curl; need tar; need uname
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
  extract_and_link "$tarball"
  detect_legacy_install
  ensure_path_wired
  handoff_to_subcommand "$@"
  verify_installation "$version"
  log "genie v${version} installed"
  release_lifecycle_lock
}

if [[ "${GENIE_INSTALL_SOURCE_ONLY:-0}" != "1" ]]; then
  main "$@"
fi
