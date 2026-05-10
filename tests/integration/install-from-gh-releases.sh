#!/usr/bin/env bash
#
# G7 smoke test for install.sh (genie-distribution-cutover wave 3).
#
# Strategy: build a self-contained fixture (fake genie binary + tarball +
# latest.json), copy install.sh into a tmpdir with LATEST_URL rewritten to a
# local file:// URL, and run it under an isolated $HOME so the user's real
# ~/.genie/ is never touched.
#
# Modes:
#   default            — INSECURE=1 positive path. Asserts:
#                          • exit 0
#                          • banner printed to stderr
#                          • $HOME/.local/bin/genie symlink exists & resolves
#                          • $HOME/.genie/audit/install.jsonl entry written
#                          • extracted genie binary present in $HOME/.genie/bin
#   --tamper           — runs WITHOUT INSECURE. The fake tarball has no
#                        cosign attestation in Sigstore Rekor and no .bundle
#                        file is provided, so both verifiers must reject.
#                        Asserts: exit 4 + "verification failed" on stderr.
#   --platform <triple> — sanity check that the requested platform matches
#                         what install.sh would autodetect on this host.
#                         install.sh detects its OWN platform from uname/ldd,
#                         so the fixture must match. Test running
#                         linux-x64-musl belongs in an alpine container, etc.
#                         darwin-arm64 is documented as manual-only and
#                         no-ops with a skip message.
#
# Usage:
#   bash tests/integration/install-from-gh-releases.sh
#   bash tests/integration/install-from-gh-releases.sh --platform linux-x64-glibc
#   bash tests/integration/install-from-gh-releases.sh --platform linux-x64-musl --tamper
#   bash tests/integration/install-from-gh-releases.sh --platform darwin-arm64   # skip

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL_SH="$REPO_ROOT/install.sh"
[[ -r "$INSTALL_SH" ]] || { echo "FAIL: install.sh not found at $INSTALL_SH" >&2; exit 1; }

PLATFORM=""
TAMPER=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) PLATFORM="${2:-}"; shift 2 ;;
    --tamper)   TAMPER=1; shift ;;
    -h|--help)
      sed -n '2,/^set -euo/p' "$0" | sed -n '/^#/p' | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Mirror install.sh detect_platform — must agree byte-for-byte with the names
# install.sh emits ("linux-x64-glibc", "linux-x64-musl", "linux-arm64",
# "darwin-arm64") so the test fixture filename matches what install.sh fetches.
detect_install_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Linux)
      case "$arch" in
        x86_64|amd64)
          if ldd --version 2>&1 | grep -qi musl; then echo "linux-x64-musl"
          else echo "linux-x64-glibc"; fi ;;
        aarch64|arm64) echo "linux-arm64" ;;
        *) return 2 ;;
      esac ;;
    Darwin)
      case "$arch" in
        arm64) echo "darwin-arm64" ;;
        *) return 2 ;;
      esac ;;
    *) return 2 ;;
  esac
}

# darwin-arm64 has no Apple Silicon CI runner — flag as manual + no-op.
if [[ "$PLATFORM" == "darwin-arm64" ]]; then
  echo "[skip] platform=darwin-arm64 — macOS arm64 runner unavailable in CI; run this script manually on an Apple Silicon Mac."
  exit 0
fi

DETECTED="$(detect_install_platform || true)"
if [[ -z "$DETECTED" ]]; then
  echo "FAIL: cannot detect host platform via uname/ldd — install.sh would refuse here too" >&2
  exit 2
fi
if [[ -n "$PLATFORM" && "$PLATFORM" != "$DETECTED" ]]; then
  echo "FAIL: --platform=$PLATFORM but host autodetects $DETECTED" >&2
  echo "      install.sh autodetects its own platform; run this test on a host or" >&2
  echo "      container whose uname/ldd output matches the requested triple." >&2
  exit 2
fi
PLATFORM="$DETECTED"

WORK="$(mktemp -d -t genie-g7-XXXXXX)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

FAKE_HOME="$WORK/home"
RELEASES="$WORK/releases"
PAYLOAD="$WORK/payload"
mkdir -p "$FAKE_HOME/.local/bin" "$RELEASES" "$PAYLOAD"

VERSION="0.0.0-g7-test"
TARBALL_NAME="genie-${VERSION}-${PLATFORM}.tar.gz"

# Fake genie binary: bash script that supports the three subcommands install.sh
# touches during its hand-off (`install` is called via exec; `--version` is
# documented as the smoke check; default prints a marker so we can assert
# extraction succeeded).
cat > "$PAYLOAD/genie" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  --version|-v) echo "0.0.0-g7-test (fake)"; exit 0 ;;
  install)      exit 0 ;;
  *)            echo "fake-genie:${1:-}"; exit 0 ;;
esac
EOF
chmod +x "$PAYLOAD/genie"
tar -czf "$RELEASES/$TARBALL_NAME" -C "$PAYLOAD" genie

# Mock latest.json — schema mirrors release-publish.yml's emitter exactly.
cat > "$WORK/latest.json" <<EOF
{
  "schema_version": 1,
  "channel": "stable",
  "version": "${VERSION}",
  "released_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "tarball_base": "file://${RELEASES}",
  "platforms": ["linux-x64-glibc", "linux-x64-musl", "linux-arm64", "darwin-arm64"]
}
EOF

# Acceptance criterion: enumerate platforms dynamically from latest.json.
# Bail loudly if our autodetected platform isn't in the manifest's list.
jq -e --arg p "$PLATFORM" '.platforms | index($p)' "$WORK/latest.json" >/dev/null \
  || { echo "FAIL: platform $PLATFORM missing from latest.json.platforms (drift)" >&2; exit 1; }

# Copy install.sh and rewrite LATEST_URL to file://. Production install.sh is
# never modified; the test owns its mutated copy under $WORK.
sed \
  -e "s|^LATEST_URL=.*|LATEST_URL=\"file://${WORK}/latest.json\"|" \
  "$INSTALL_SH" > "$WORK/install.sh"
chmod +x "$WORK/install.sh"
grep -q "^LATEST_URL=\"file://" "$WORK/install.sh" \
  || { echo "FAIL: LATEST_URL rewrite did not stick" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Tamper case: no INSECURE, no .bundle, no Sigstore attestation. install.sh
# must fall through both verifiers and die with exit 4 + "verification failed".
# ---------------------------------------------------------------------------
if [[ "$TAMPER" == "1" ]]; then
  echo "==> running tamper case (expect exit 4)"
  set +e
  output="$(env -i \
    HOME="$FAKE_HOME" \
    PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    bash "$WORK/install.sh" 2>&1)"
  rc=$?
  set -e
  printf '%s\n' "$output"
  [[ "$rc" -eq 4 ]] \
    || { echo "FAIL: tamper expected exit 4, got $rc" >&2; exit 1; }
  printf '%s\n' "$output" | grep -qi "verification failed" \
    || { echo "FAIL: stderr did not name verification failure" >&2; exit 1; }
  echo "PASS: tamper rejection (exit 4, verification-failed message)"
  exit 0
fi

# ---------------------------------------------------------------------------
# Default case: INSECURE=1 positive. SHA256 floor only; install.sh must
# extract, symlink, and emit the audit-log + red banner.
# ---------------------------------------------------------------------------
echo "==> running insecure positive case (expect exit 0)"
set +e
output="$(env -i \
  HOME="$FAKE_HOME" \
  INSECURE=1 \
  PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  bash "$WORK/install.sh" 2>&1)"
rc=$?
set -e
printf '%s\n' "$output"

[[ "$rc" -eq 0 ]] \
  || { echo "FAIL: positive install rc=$rc (expected 0)" >&2; exit 1; }
printf '%s\n' "$output" | grep -q "INSECURE=1" \
  || { echo "FAIL: missing INSECURE banner" >&2; exit 1; }
[[ -L "$FAKE_HOME/.local/bin/genie" ]] \
  || { echo "FAIL: $FAKE_HOME/.local/bin/genie symlink missing" >&2; exit 1; }
[[ -x "$FAKE_HOME/.genie/bin/genie" ]] \
  || { echo "FAIL: extracted genie binary not in $FAKE_HOME/.genie/bin" >&2; exit 1; }
target="$(readlink "$FAKE_HOME/.local/bin/genie")"
[[ "$target" == "$FAKE_HOME/.genie/bin/genie" ]] \
  || { echo "FAIL: symlink resolves to '$target', expected $FAKE_HOME/.genie/bin/genie" >&2; exit 1; }
[[ -f "$FAKE_HOME/.genie/audit/install.jsonl" ]] \
  || { echo "FAIL: audit log missing" >&2; exit 1; }
grep -q '"event":"insecure_install"' "$FAKE_HOME/.genie/audit/install.jsonl" \
  || { echo "FAIL: audit log entry missing insecure_install event" >&2; exit 1; }
grep -q "\"version\":\"${VERSION}\"" "$FAKE_HOME/.genie/audit/install.jsonl" \
  || { echo "FAIL: audit log entry missing version field" >&2; exit 1; }
grep -q "\"platform\":\"${PLATFORM}\"" "$FAKE_HOME/.genie/audit/install.jsonl" \
  || { echo "FAIL: audit log entry missing platform field" >&2; exit 1; }

# Sanity: the symlinked fake genie actually executes.
"$FAKE_HOME/.local/bin/genie" --version >/dev/null \
  || { echo "FAIL: symlinked genie did not run --version" >&2; exit 1; }

echo "PASS: insecure positive (rc=0, symlink, audit log, banner all present)"
