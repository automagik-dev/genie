#!/usr/bin/env bash
#
# build-binary.sh — Group 1 of genie-distribution-cutover.
#
# Local equivalent of one matrix leg of .github/workflows/build-tarballs.yml.
# Produces dist/genie-<version>-<platform>.tar.gz containing:
#   genie (bun --compile static executable),
#   plugins/, skills/, templates/, VERSION
#
# Size budget: each tarball ≤80 MB compressed; the script fails if exceeded.
# Platforms: linux-x64-glibc, linux-x64-musl, linux-arm64, darwin-arm64.
# (darwin-x64 / Intel Mac dropped — Apple ended Intel Mac sales in 2022.)
#
# Usage: scripts/build-binary.sh --platform <p> [--version <v>]
# Exit codes: 0 ok | 1 build failed | 2 invalid args | 3 size budget exceeded

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="${REPO_ROOT}/dist"
ENTRY_POINT="${REPO_ROOT}/src/genie.ts"
SIZE_BUDGET_MB=80

PLATFORMS=(linux-x64-glibc linux-x64-musl linux-arm64 darwin-arm64)

bun_target_for() {
  case "$1" in
    linux-x64-glibc) echo "bun-linux-x64" ;;
    linux-x64-musl)  echo "bun-linux-x64-musl" ;;
    linux-arm64)     echo "bun-linux-arm64" ;;
    darwin-arm64)    echo "bun-darwin-arm64" ;;
    *) return 1 ;;
  esac
}

usage() { echo "Usage: $0 --platform <p> [--version <v>]; platforms: ${PLATFORMS[*]}"; }

PLATFORM=""
VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) PLATFORM="$2"; shift 2 ;;
    --version)  VERSION="$2"; shift 2 ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

[[ -n "$PLATFORM" ]] || { echo "error: --platform is required" >&2; usage; exit 2; }
TARGET="$(bun_target_for "$PLATFORM")" || { echo "error: unsupported platform: $PLATFORM" >&2; exit 2; }
[[ -n "$VERSION" ]] || VERSION=$(node -p "require('${REPO_ROOT}/package.json').version")

STAGE="${DIST_DIR}/${PLATFORM}"
TARBALL="${DIST_DIR}/genie-${VERSION}-${PLATFORM}.tar.gz"
rm -rf "$STAGE" "$TARBALL"
mkdir -p "$STAGE"

echo "==> [${PLATFORM}] bun build --compile --target=${TARGET}  (v${VERSION})"
bun build --compile \
  --target="${TARGET}" \
  --external @khal-os/brain \
  --define GENIE_BUILD_VERSION="'${VERSION}'" \
  "${ENTRY_POINT}" \
  --outfile "${STAGE}/genie"

cp -RL "${REPO_ROOT}/plugins"   "${STAGE}/plugins"
cp -RL "${REPO_ROOT}/skills"    "${STAGE}/skills"
cp -RL "${REPO_ROOT}/templates" "${STAGE}/templates"
echo "${VERSION}" > "${STAGE}/VERSION"

tar czf "${TARBALL}" -C "${STAGE}" .

SIZE_MB=$(( $(stat -c '%s' "${TARBALL}" 2>/dev/null || stat -f '%z' "${TARBALL}") / 1024 / 1024 ))
echo "==> ${TARBALL}  (${SIZE_MB} MB)"
if (( SIZE_MB > SIZE_BUDGET_MB )); then
  echo "error: tarball ${SIZE_MB}MB exceeds ${SIZE_BUDGET_MB}MB budget" >&2
  exit 3
fi
