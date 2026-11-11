#!/usr/bin/env bash
# Reads the two GitHub repository ids out of a release certificate.
#
# Source this file, then call `release_certificate_carries_pinned_ids <bundle>`
# AFTER cosign has verified that bundle. Run directly it checks one bundle:
#
#   scripts/release-certificate-ids.sh <tarball>.bundle     # exit 0 carries both ids, 1 refused, 2 usage
#
# install.sh carries the block between the two markers below byte for byte,
# because the installer is fetched as a single file and can source nothing.
# scripts/release-certificate-ids.test.ts fails when the two copies differ.

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

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  if [ "$#" -ne 1 ]; then
    printf 'usage: %s <cosign bundle>\n' "${0##*/}" >&2
    exit 2
  fi
  release_certificate_carries_pinned_ids "$1"
fi
