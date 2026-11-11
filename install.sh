#!/usr/bin/env bash
#
# Genie CLI installer — GitHub Releases consumer (post genie-distribution-cutover G4).
#
# Audit: curl -fsSL https://raw.githubusercontent.com/automagik-si/genie/main/install.sh > install.sh; less install.sh; bash install.sh
#
# Trust anchor (cosign keyless OIDC). There is no long-lived public key to pin.
# A release is installed only when its verified certificate carries the OIDC
# issuer below, the signing workflow at refs/heads/main under one of the two
# spellings of this repository's name, AND both of GitHub's numeric ids for this
# repository and for its owner. A rename changes the name and neither id.
# certificate-identity-regexp: ^https://github\.com/automagik-si/genie/\.github/workflows/sign-attest\.yml@refs/heads/main$
# certificate-identity-regexp (pre-rename releases): ^https://github\.com/automagik-dev/genie/\.github/workflows/sign-attest\.yml@refs/heads/main$
# certificate-oidc-issuer:     https://token.actions.githubusercontent.com
# provenance source-uri:       github.com/automagik-si/genie
# provenance source-uri (pre-rename releases): github.com/automagik-dev/genie
# source-repository-id:        1030039430
# source-repository-owner-id:  245047546
#
# Default flow (gh attestation verify, falls back to cosign verify-blob):
#   curl -fsSL https://raw.githubusercontent.com/automagik-si/genie/main/install.sh | bash
#
# INSECURE=1 (audit-logged bypass; SHA256 floor only — DO NOT USE in production):
#   INSECURE=1 curl -fsSL https://raw.githubusercontent.com/automagik-si/genie/main/install.sh | bash
#
# Exit codes: 0 ok | 1 generic | 2 unsupported platform | 3 missing prereq | 4 verification failed | 5 download failed
#
set -euo pipefail

REPO="automagik-si/genie"
# The name this repository carried until the 2026-11 rename. Every release
# published before it is signed under this spelling, so it stays an accepted
# spelling of the signing workflow. Nothing is fetched from it.
PRE_RENAME_REPO="automagik-dev/genie"
ACCEPTED_REPOS=("$REPO" "$PRE_RENAME_REPO")

# >>> release-certificate-ids (kept byte-identical in install.sh and scripts/release-certificate-ids.sh)
# GitHub's numeric ids for the release repository and for the organization that
# owns it. A rename changes neither. Fulcio copies both from the workflow's OIDC
# token into every certificate it issues, as two extensions:
#   1.3.6.1.4.1.57264.1.15  Source Repository Identifier
#   1.3.6.1.4.1.57264.1.17  Source Repository Owner Identifier
# each a DER UTF8String holding the decimal id.
EXPECTED_REPOSITORY_ID="1030039430"
EXPECTED_REPOSITORY_OWNER_ID="245047546"
FULCIO_REPOSITORY_ID_OID_HEX="2B0601040183BF30010F"
FULCIO_REPOSITORY_OWNER_ID_OID_HEX="2B0601040183BF300111"

certificate_ids_note() { printf '!! release certificate: %s\n' "$*" >&2; }

# Decode base64 from file $1 into file $2 (GNU, BusyBox and macOS spellings).
certificate_b64_decode() {
  base64 -d <"$1" >"$2" 2>/dev/null && return 0
  base64 -D <"$1" >"$2" 2>/dev/null && return 0
  base64 --decode <"$1" >"$2" 2>/dev/null
}

# Print the leaf certificate of a cosign bundle as uppercase DER hex. The bundle
# is the `cosign sign-blob --bundle` file: one "cert" member holding the base64
# of the PEM certificate. The file must name that member exactly once, in that
# exact spelling, and carry no escape sequence, so the certificate read here is
# the one any JSON reader takes from the same bytes.
certificate_der_hex_from_bundle() {
  local bundle="$1" work="$2" matches
  [ -s "$bundle" ] || return 1
  if grep -q '\\' "$bundle"; then return 1; fi
  [ "$(grep -oi '"cert"[[:space:]]*:' "$bundle" | wc -l | tr -d ' ')" = "1" ] || return 1
  matches="$(grep -o '"cert":"[A-Za-z0-9+/=]*"' "$bundle" 2>/dev/null)" || return 1
  [ "$(printf '%s\n' "$matches" | wc -l | tr -d ' ')" = "1" ] || return 1
  matches="${matches#\"cert\":\"}"
  printf '%s' "${matches%\"}" >"$work/cert.pem.b64"
  certificate_b64_decode "$work/cert.pem.b64" "$work/cert.pem" || return 1
  [ "$(grep -c -- '-----BEGIN CERTIFICATE-----' "$work/cert.pem")" = "1" ] || return 1
  grep -v -- '-----' "$work/cert.pem" | tr -d '\r\n' >"$work/cert.der.b64"
  certificate_b64_decode "$work/cert.der.b64" "$work/cert.der" || return 1
  [ -s "$work/cert.der" ] || return 1
  od -An -v -tx1 "$work/cert.der" | tr -d ' \n' | tr 'a-f' 'A-F'
}

# Read one DER element of hex string $1 at hex offset $2. Sets DER_TAG, DER_VALUE
# (hex offset of the content) and DER_END (hex offset just past it). Fails on a
# truncated element or a length that is not plain definite form.
der_element() {
  local hex="$1" pos="$2" first count
  [ $((pos + 4)) -le ${#hex} ] || return 1
  DER_TAG="${hex:pos:2}"
  first=$((16#${hex:pos+2:2}))
  pos=$((pos + 4))
  if [ "$first" -lt 128 ]; then
    count="$first"
  else
    first=$((first - 128))
    [ "$first" -ge 1 ] && [ "$first" -le 3 ] || return 1
    [ $((pos + 2 * first)) -le ${#hex} ] || return 1
    count=$((16#${hex:pos:2*first}))
    pos=$((pos + 2 * first))
  fi
  DER_VALUE="$pos"
  DER_END=$((pos + 2 * count))
  [ "$DER_END" -le ${#hex} ]
}

# Print the value (hex) of the extension whose OID content is $2, from the
# certificate DER hex $1. Walks Certificate -> tbsCertificate -> [3] extensions
# and fails unless the certificate carries that extension exactly once.
certificate_extension_value_hex() {
  local hex="$1" want="$2" tbs_end ext_end item_end pos oid found="" count=0
  der_element "$hex" 0 && [ "$DER_TAG" = "30" ] && [ "$DER_END" -eq ${#hex} ] || return 1
  der_element "$hex" "$DER_VALUE" && [ "$DER_TAG" = "30" ] || return 1
  pos="$DER_VALUE"; tbs_end="$DER_END"
  while :; do
    [ "$pos" -lt "$tbs_end" ] || return 1
    der_element "$hex" "$pos" && [ "$DER_END" -le "$tbs_end" ] || return 1
    [ "$DER_TAG" = "A3" ] && break
    pos="$DER_END"
  done
  der_element "$hex" "$DER_VALUE" && [ "$DER_TAG" = "30" ] || return 1
  pos="$DER_VALUE"; ext_end="$DER_END"
  while [ "$pos" -lt "$ext_end" ]; do
    der_element "$hex" "$pos" && [ "$DER_TAG" = "30" ] && [ "$DER_END" -le "$ext_end" ] || return 1
    item_end="$DER_END"
    der_element "$hex" "$DER_VALUE" && [ "$DER_TAG" = "06" ] && [ "$DER_END" -le "$item_end" ] || return 1
    oid="${hex:DER_VALUE:DER_END-DER_VALUE}"
    der_element "$hex" "$DER_END" && [ "$DER_END" -le "$item_end" ] || return 1
    if [ "$DER_TAG" = "01" ]; then
      der_element "$hex" "$DER_END" && [ "$DER_END" -le "$item_end" ] || return 1
    fi
    [ "$DER_TAG" = "04" ] && [ "$DER_END" -eq "$item_end" ] || return 1
    if [ "$oid" = "$want" ]; then
      count=$((count + 1))
      found="${hex:DER_VALUE:DER_END-DER_VALUE}"
    fi
    pos="$item_end"
  done
  [ "$pos" -eq "$ext_end" ] && [ "$count" -eq 1 ] || return 1
  printf '%s\n' "$found"
}

# The DER UTF8String (hex) of a decimal id: tag 0C, one length byte, the digits.
certificate_expected_id_hex() {
  local id="$1"
  case "$id" in ''|*[!0-9]*) return 1 ;; esac
  [ "${#id}" -le 127 ] || return 1
  printf '0C%02X%s\n' "${#id}" "$(printf '%s' "$id" | od -An -v -tx1 | tr -d ' \n' | tr 'a-f' 'A-F')"
}

# Succeeds only when the certificate in cosign bundle $1 carries BOTH pinned
# ids, each exactly once and each exactly the expected encoding. Call it only
# after cosign has verified that bundle: the ids are read from the certificate
# cosign just accepted, never from anything else. Any doubt is a refusal.
release_certificate_carries_pinned_ids() {
  local bundle="$1" work hex value expected status=1 tool
  for tool in base64 od tr grep wc mktemp; do
    command -v "$tool" >/dev/null 2>&1 || {
      certificate_ids_note "cannot check the repository ids without '$tool' on PATH — refusing"
      return 1
    }
  done
  work="$(umask 077; mktemp -d "${TMPDIR:-/tmp}/genie-certificate-ids.XXXXXX")" || return 1
  if ! hex="$(certificate_der_hex_from_bundle "$bundle" "$work")" || [ -z "$hex" ]; then
    certificate_ids_note "could not read the certificate from ${bundle##*/} — refusing"
  elif ! value="$(certificate_extension_value_hex "$hex" "$FULCIO_REPOSITORY_ID_OID_HEX")"; then
    certificate_ids_note "no single Source Repository Identifier (1.3.6.1.4.1.57264.1.15) — refusing"
  elif ! expected="$(certificate_expected_id_hex "$EXPECTED_REPOSITORY_ID")" || [ "$value" != "$expected" ]; then
    certificate_ids_note "Source Repository Identifier is not ${EXPECTED_REPOSITORY_ID} — refusing"
  elif ! value="$(certificate_extension_value_hex "$hex" "$FULCIO_REPOSITORY_OWNER_ID_OID_HEX")"; then
    certificate_ids_note "no single Source Repository Owner Identifier (1.3.6.1.4.1.57264.1.17) — refusing"
  elif ! expected="$(certificate_expected_id_hex "$EXPECTED_REPOSITORY_OWNER_ID")" || [ "$value" != "$expected" ]; then
    certificate_ids_note "Source Repository Owner Identifier is not ${EXPECTED_REPOSITORY_OWNER_ID} — refusing"
  else
    status=0
  fi
  rm -rf "$work"
  return "$status"
}
# <<< release-certificate-ids

# Per-channel manifest URL: stable → latest.json, others → <channel>.json, in
# .well-known/v2/. The pair one level up (.well-known/latest.json, dev.json) is
# what a genie released before the 2026-11 repository rename reads; it is frozen
# on the last releases such a genie can verify and is not read here.
# Resolved at runtime in resolve_manifest_url after the channel is known so
# `GENIE_CHANNEL=dev curl ... | bash` reads .well-known/v2/dev.json. See wish
# release-channel-dev (2026-05-11) for the producer-side wiring.
MANIFEST_BASE="https://raw.githubusercontent.com/${REPO}/main/.well-known/v2"
# The same manifest through the public, credential-free contents API. The CDN
# copy above caches for ~5 minutes, so a fresh install inside that window used to
# land the PREVIOUS release (issue #2950); the API copy is roughly a minute deep.
# The host is a pinned literal and the repository is addressed by its numeric id
# — never derived from manifest content.
MANIFEST_API_BASE="https://api.github.com/repositories/${EXPECTED_REPOSITORY_ID}/contents/.well-known/v2"
EXPECTED_COSIGN_ISSUER="https://token.actions.githubusercontent.com"

# The signing workflow's certificate identity under one spelling of the
# repository name, as an anchored regular expression.
cosign_identity_for_repo() {
  printf '^https://github\\.com/%s/\\.github/workflows/sign-attest\\.yml@refs/heads/main$\n' "$1"
}
EXPECTED_COSIGN_IDENTITY="$(cosign_identity_for_repo "$REPO")"

# sign-attest.yml registers the GitHub-native attestation under a CUSTOM
# predicate type (NOT https://slsa.dev/provenance/v1 — GitHub's persistence API
# runs SLSA validation for that URI and rejects our custom buildType). The
# verifier MUST pass the same --predicate-type or `gh attestation verify`
# defaults to slsa.dev/provenance/v1 and 404s the lookup. The type names the
# repository as it was spelled when the release was signed. Keep this in
# lockstep with scripts/release-native-predicate.sh + sign-attest.yml.
attestation_predicate_type_for_repo() {
  printf 'https://github.com/%s/release-tarballs/v1\n' "$1"
}
# What `gh attestation verify --format json` must show for EVERY attestation it
# verified: both pinned ids, read from the certificate gh just checked.
GH_ATTESTATION_IDS_JQ="if (length > 0) and all(.[]; .verificationResult.signature.certificate.sourceRepositoryIdentifier == \"${EXPECTED_REPOSITORY_ID}\" and .verificationResult.signature.certificate.sourceRepositoryOwnerIdentifier == \"${EXPECTED_REPOSITORY_OWNER_ID}\") then \"ok\" else \"refused\" end"
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
# The only exit-2 result that means "delivery committed; activation deferred".
# handoff_to_subcommand streams child stdout while capturing it privately and
# requires it to be the sole lifecycle result line, byte-exact, before projecting
# action-required.
INSTALL_ACTION_REQUIRED_TRAILER='{"schemaVersion":1,"code":"activation-pending","deliveryComplete":true,"retry":false,"nextAction":"retire tasks → genie setup --codex → /hooks → new task"}'

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

# Materialize GENIE_HOME (and every missing parent) before the lease is taken.
#
# A relocated GENIE_HOME whose directory chain does not exist yet is the
# ordinary first install on a fresh host, not an operator error: the installer
# owns that directory, and refusing it left `GENIE_HOME=$H/nested/.genie bash
# install.sh` dead with a message that named no remedy (dogfood r2 §3.3 #1).
# The chain is created at 0700 — the same mode every later genie run expects —
# and an existing directory is never re-chmodded.
#
# Creating it before `acquire_lifecycle_lock` does not weaken that guard's
# invariant: the only object written here is the installer's own home directory,
# empty and identical whichever installer wins the lease. The parent check
# inside `acquire_lifecycle_lock` stays as a fail-closed backstop for callers
# that source install.sh and skip this step.
ensure_genie_home_root() {
  local canonical_home
  canonical_home="$(logical_absolute_path "$GENIE_HOME")"
  [[ "$canonical_home" != "/" ]] ||
    die "GENIE_HOME must not be the filesystem root; set GENIE_HOME to a directory: $GENIE_HOME" 1
  if [[ -e "$canonical_home" || -L "$canonical_home" ]]; then
    [[ -d "$canonical_home" ]] ||
      die "GENIE_HOME exists and is not a directory; move it aside or point GENIE_HOME elsewhere: $canonical_home" 1
    return 0
  fi
  (umask 077; mkdir -p "$canonical_home") ||
    die "could not create GENIE_HOME; check write permission on its parent chain: $canonical_home" 1
  chmod 700 "$canonical_home" 2>/dev/null || true
  log "created GENIE_HOME: $canonical_home"
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
  [[ "$actual" == "$wanted" ]]
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
    # Canonical taxonomy: stable + dev. beta + canary + homolog retired.
    stable|dev) echo "$channel" ;;
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
      warn "GENIE_CHANNEL=$channel is retired; use GENIE_CHANNEL=dev (mapping to dev for this run)"
      echo "dev" ;;
    homolog)
      # Back-compat: homolog was the dev→homolog→stable middle tier from
      # 2026-05-12 until its removal on 2026-07-26. .well-known/homolog.json
      # no longer exists, so the pin cannot be honored. Fall back to STABLE,
      # not dev: homolog ranked above dev, so stable is the conservative
      # landing rather than silently downgrading trust.
      warn "GENIE_CHANNEL=homolog is retired; use GENIE_CHANNEL=stable or dev (mapping to stable for this run)"
      echo "stable" ;;
    *) die "unknown channel: $channel (valid: stable|dev)" 1 ;;
  esac
}

# Resolve the .well-known/v2 manifest URL for the given channel.
# stable → latest.json (kept for back-compat with the v1 manifest layout).
# Everything else → <channel>.json. The producer side
# (release-publish.yml) writes whichever filename matches the channel passed
# through from version.yml — see wish release-channel-dev.
manifest_file_for_channel() {
  if [ "$1" = "stable" ]; then echo "latest.json"; else echo "${1}.json"; fi
}

resolve_manifest_url() {
  echo "${MANIFEST_BASE}/$(manifest_file_for_channel "$1")"
}

# The same channel file through the contents API, pinned to main. Same
# channel→filename rule as resolve_manifest_url, by construction.
resolve_manifest_api_url() {
  echo "${MANIFEST_API_BASE}/$(manifest_file_for_channel "$1")?ref=main"
}

# True when $1 is strictly newer than $2, comparing each dotted component as a
# NUMBER. String ordering would rank 5.260918.10 below 5.260918.9. A component
# that is not a plain integer (or an empty version) fails closed as "not newer",
# which keeps the CDN payload.
version_is_newer() {
  local left="$1" right="$2" l r i count
  if [ -z "$left" ] || [ -z "$right" ]; then return 1; fi
  local IFS=.
  # shellcheck disable=SC2206 # deliberate split on IFS=. into version components
  local lparts=($left) rparts=($right)
  count=${#lparts[@]}
  if [ "${#rparts[@]}" -gt "$count" ]; then count=${#rparts[@]}; fi
  for ((i = 0; i < count; i++)); do
    l="${lparts[i]:-0}"
    r="${rparts[i]:-0}"
    case "$l" in ''|*[!0-9]*) return 1 ;; esac
    case "$r" in ''|*[!0-9]*) return 1 ;; esac
    if [ "$l" -gt "$r" ]; then return 0; fi
    if [ "$l" -lt "$r" ]; then return 1; fi
  done
  return 1
}

# Whether the second manifest source may be consulted at all. See fetch_latest:
# the no-jq path of manifest_get cannot tell a manifest from a body that merely
# contains the words, which only matters once two answers compete.
api_source_usable() {
  command -v jq >/dev/null 2>&1
}

# A manifest published before the rename names its release under the old
# spelling. The same release is served under the current name, and that is where
# it is fetched from. Any other base is returned unchanged.
current_name_tarball_base() {
  local base="$1" prefix="https://github.com/${PRE_RENAME_REPO}/"
  case "$base" in
    "$prefix"*) printf 'https://github.com/%s/%s\n' "$REPO" "${base#"$prefix"}" ;;
    *) printf '%s\n' "$base" ;;
  esac
}

# Read the channel manifest from BOTH published sources and return the NEWER
# answer. The raw CDN stays the authority: it is the only source that can fail
# the install, and a tie or an unparsable API version keeps its bytes. The API
# read is strictly optional — unreachable, timed out, rate-limited (403/429 under
# curl -f), empty or envelope-shaped answers all degrade silently to the CDN
# copy. Mirrors fetchLatestManifest in src/genie-commands/update.ts.
fetch_latest() {
  local channel="$1" url api_url payload api_payload="" cdn_version api_version
  url="$(resolve_manifest_url "$channel")"
  api_url="$(resolve_manifest_api_url "$channel")"
  log "manifest=${url##*/}"

  payload="$(curl -fsSL "$url")" || payload=""

  # `Accept: application/vnd.github.raw` asks the API for the file's own bytes
  # rather than the base64 JSON envelope; an envelope (or any other body) simply
  # fails manifest_channel_matches below and is discarded, so no base64/jq
  # decoder is needed and the prerequisite list is unchanged. --max-time bounds
  # this optional read so a hung API can never stall an install the CDN serves.
  #
  # Only where the answer can be validated STRICTLY, though: without jq,
  # manifest_get falls back to a `sed` line match that reads "channel" and
  # "version" from anywhere in the body — nested inside an error object, or out
  # of text that is not JSON at all. With one source that was harmless, because
  # there was nothing to out-rank; with two, a garbled or crafted second answer
  # out-ranks the real manifest. Verified against this file: on a jq-free host an
  # error body carrying a higher version and a foreign tarball_base won. The
  # second source is an optimisation, never a requirement, so a jq-free host
  # reads the CDN alone and keeps exactly its pre-#2950 behaviour.
  if api_source_usable; then
    api_payload="$(curl -fsSL --max-time 5 -H 'Accept: application/vnd.github.raw' "$api_url" 2>/dev/null)" || api_payload=""
  fi
  if [ -n "$api_payload" ] && ! manifest_channel_matches "$api_payload" "$channel"; then
    api_payload=""
  fi

  if [ -z "$payload" ]; then
    [ -n "$api_payload" ] || die "could not fetch $url" 5
    warn "manifest: the CDN did not answer; using api.github.com"
    printf '%s\n' "$api_payload"
    return 0
  fi

  manifest_channel_matches "$payload" "$channel" || die "manifest channel mismatch (wanted $channel)" 1

  if [ -n "$api_payload" ]; then
    cdn_version="$(manifest_get "$payload" version)"
    api_version="$(manifest_get "$api_payload" version)"
    if [ "$api_version" != "$cdn_version" ]; then
      if version_is_newer "$api_version" "$cdn_version"; then
        warn "manifest: api.github.com has ${api_version}; the CDN copy is still at ${cdn_version} (it caches for ~5 min)"
        printf '%s\n' "$api_payload"
        return 0
      fi
      warn "manifest: the CDN has ${cdn_version}; api.github.com is still at ${api_version}"
    fi
  fi

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
  local tarball="$1" platform="$2" repo answer
  ensure_gh_verifier "$platform" || return 1
  for repo in "${ACCEPTED_REPOS[@]}"; do
    log "verifying via gh attestation (repo=${repo}, identity and repository ids pinned)"
    answer="$("$GH_BIN" attestation verify "$tarball" \
      --repo "$repo" \
      --predicate-type "$(attestation_predicate_type_for_repo "$repo")" \
      --cert-identity-regex "$(cosign_identity_for_repo "$repo")" \
      --cert-oidc-issuer "$EXPECTED_COSIGN_ISSUER" \
      --format json --jq "$GH_ATTESTATION_IDS_JQ" 2>/dev/null)" || continue
    if [[ "$answer" == "ok" ]]; then
      return 0
    fi
    warn "gh attestation: the certificate under ${repo} does not carry the pinned repository ids"
  done
  return 1
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

# cosign verifies the signature, the certificate chain, the transparency-log
# entry, the OIDC issuer and the workflow identity; the two repository ids are
# then read from the certificate inside the bundle cosign just accepted. cosign
# has no flag for them, so the reading is done here with base64 and od — no
# further tool is downloaded, and a host missing either refuses the install.
verify_with_cosign() {
  local tarball="$1" bundle="$2" repo
  [[ -n "$COSIGN_BIN" ]] || return 1
  [[ -s "$bundle" ]] || return 1
  log "verifying via cosign verify-blob (bundle=${bundle##*/}, identity and repository ids pinned)"
  for repo in "${ACCEPTED_REPOS[@]}"; do
    if "$COSIGN_BIN" verify-blob \
      --bundle "$bundle" \
      --certificate-identity-regexp "$(cosign_identity_for_repo "$repo")" \
      --certificate-oidc-issuer "$EXPECTED_COSIGN_ISSUER" \
      "$tarball" >/dev/null 2>&1; then
      release_certificate_carries_pinned_ids "$bundle"
      return $?
    fi
  done
  return 1
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
        die "verification failed for ${fname} — refuse to install. Expected identity: ${EXPECTED_COSIGN_IDENTITY} with repository id ${EXPECTED_REPOSITORY_ID} and owner id ${EXPECTED_REPOSITORY_OWNER_ID}" 4
      fi
    fi
  else
    die "verification failed for ${fname} — refuse to install. Expected identity: ${EXPECTED_COSIGN_IDENTITY} with repository id ${EXPECTED_REPOSITORY_ID} and owner id ${EXPECTED_REPOSITORY_OWNER_ID}" 4
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
extract_and_link() {
  local tarball="$1" expected_version="$2" bin="$GENIE_HOME/bin"
  STAGING_DIR="${TMP_DIR}/release-payload"
  (umask 077; mkdir "$STAGING_DIR") ||
    die "could not create private external release staging" 1
  [[ -d "$STAGING_DIR" && ! -L "$STAGING_DIR" ]] ||
    die "install staging path is not a physical directory: $STAGING_DIR" 1
  validate_private_temp_root "$STAGING_DIR"
  log "extracting verified release in private temporary staging"
  # -p: as non-root, tar applies the caller umask to extracted members; under
  # umask 077 the archived 0755 binary would land as 0700 and the promoter's
  # mode-covering content digest would reject the admitted copy.
  tar -xzpf "$tarball" -C "$STAGING_DIR" ||
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

# Return success only for a whole-line JSON-object-shaped lifecycle result.
# Pure Bash matching keeps this classifier inside the authenticated installer:
# no eval and no parser executable selected from the ambient PATH. Key order,
# ordinary whitespace, schema generations, and future code values are
# intentionally irrelevant. A prose line containing a JSON example, or JSON
# without both lifecycle keys, remains ordinary human output.
is_lifecycle_result_line() {
  local line="$1"
  local object_re='^[[:space:]]*\{.*\}[[:space:]]*$'
  local schema_key_re='(^|[,{])[[:space:]]*"schemaVersion"[[:space:]]*:'
  local code_key_re='(^|[,{])[[:space:]]*"code"[[:space:]]*:'
  [[ "$line" =~ $object_re && "$line" =~ $schema_key_re && "$line" =~ $code_key_re ]]
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
  local delivery_channel="$1"
  shift
  log "handing off to: genie install (post-install finishing, channel=${delivery_channel})"
  [[ -n "$LIFECYCLE_LOCK" && -n "$LIFECYCLE_OWNER_RECORD" ]] ||
    die "lifecycle lease was lost before the post-install finisher" 1
  local finisher_status=0 finisher_path="$PATH" finisher_stdout finisher_line
  local -a finisher_pipeline_status=()
  if [[ -n "$GH_BIN" ]]; then
    [[ "$GH_BIN" == /* && "${GH_BIN##*/}" == "gh" && -x "$GH_BIN" ]] ||
      die "verified gh became unavailable before the post-install finisher" 1
    # The finisher's same-version delivery repair invokes `gh` by name. Keep the
    # exact verifier selected above first on its process-local PATH; TMP_DIR is
    # still owned by this shell and is removed only after the child returns.
    finisher_path="${GH_BIN%/*}:$PATH"
  fi
  finisher_stdout="$TMP_DIR/finisher-stdout"
  (umask 077; set -o noclobber; : > "$finisher_stdout") 2>/dev/null ||
    die "could not create private post-install result capture" 1
  [[ -f "$finisher_stdout" && ! -L "$finisher_stdout" ]] ||
    die "post-install result capture is not a physical file" 1
  # A pipeline is intentional: the builtin-only read/printf leg preserves the
  # child's live stdout while the private capture provides an exact, post-exit
  # line-classification record. Disable errexit only across this pipeline so
  # PIPESTATUS is available for both legs.
  set +e
  GENIE_LIFECYCLE_LEASE_PATH="$LIFECYCLE_LOCK" \
    GENIE_LIFECYCLE_LEASE_OWNER="$LIFECYCLE_OWNER_RECORD" \
    GENIE_INSTALL_DELIVERY_CHANNEL="$delivery_channel" \
    GH_BIN="$GH_BIN" \
    PATH="$finisher_path" \
    "$LOCAL_BIN/genie" install "$@" |
    while IFS= read -r finisher_line || [[ -n "$finisher_line" ]]; do
      printf '%s\n' "$finisher_line"
      printf '%s\n' "$finisher_line" >> "$finisher_stdout"
    done
  finisher_pipeline_status=("${PIPESTATUS[@]}")
  set -e
  finisher_status="${finisher_pipeline_status[0]:-1}"
  [[ "${finisher_pipeline_status[1]:-1}" -eq 0 ]] ||
    die "could not capture post-install result; installation remains incomplete and retryable" 1
  # Exit 2 from the finisher is delivered-but-action-required (installed
  # generation N ≠ delivered T): the signed binary/payload is installed, but the
  # Codex plugin generation was NOT activated. The finisher already printed the
  # single machine-readable result trailer over inherited stdout. Propagate it as
  # exit 2 with no all-green footer — never as a failure (die 1). Exit 2 is
  # disambiguated from busy/incomplete/unsupported-platform exit 2 only when the
  # byte-exact action-required trailer is the sole lifecycle result line.
  # Contradictory or duplicate lifecycle trailers remain visible in the stream
  # but are fatal to this installer invocation.
  if [[ "$finisher_status" -eq 2 ]]; then
    local action_required_count=0 lifecycle_result_count=0 captured_line
    while IFS= read -r captured_line || [[ -n "$captured_line" ]]; do
      is_lifecycle_result_line "$captured_line" &&
        lifecycle_result_count=$((lifecycle_result_count + 1))
      [[ "$captured_line" == "$INSTALL_ACTION_REQUIRED_TRAILER" ]] &&
        action_required_count=$((action_required_count + 1))
    done < "$finisher_stdout"
    if [[ "$action_required_count" -eq 1 && "$lifecycle_result_count" -eq 1 ]]; then
      DELIVERY_ACTION_REQUIRED=1
      return 0
    fi
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
  tarball_base="$(current_name_tarball_base "$tarball_base")"
  log "installing genie v${version}"
  # The home is materialized first so a relocated GENIE_HOME on a fresh host is
  # an ordinary install rather than a refusal (dogfood r2 §3.3 #1).
  ensure_genie_home_root
  # Acquire before download verification because INSECURE=1 records its audit
  # event under GENIE_HOME. Ownership then remains continuous through every
  # extraction, PATH, child-finisher, and final-verification mutation.
  acquire_lifecycle_lock
  tarball="$(download_and_verify "$version" "$platform" "$tarball_base")"
  extract_and_link "$tarball" "$version"
  detect_legacy_install
  ensure_path_wired
  handoff_to_subcommand "$channel" "$@"
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
