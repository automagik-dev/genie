#!/usr/bin/env bash
#
# build-binary.sh — Group 1 of genie-distribution-cutover.
#
# Local equivalent of one matrix leg of .github/workflows/build-tarballs.yml.
# Produces dist/genie-<version>-<platform>.tar.gz containing:
#   genie (bun --compile static executable),
#   plugins/, skills/, templates/, runtime marketplaces, VERSION
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
[[ "$VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$ ]] \
  || { echo "error: invalid release version: ${VERSION}" >&2; exit 2; }

# The committed plugin mirror is a release input, not a symlink that the
# packager silently repairs. Fail before compiling if source and mirror drift.
bun "${REPO_ROOT}/scripts/sync-plugin-skills.ts" --check
bun "${REPO_ROOT}/scripts/fresh-install-smoke.ts"
bun "${REPO_ROOT}/scripts/hook-bundle-parity.ts" --check
bun "${REPO_ROOT}/scripts/hook-content-binding.ts" --check
bun "${REPO_ROOT}/scripts/plugin-executables-check.ts"
bun "${REPO_ROOT}/scripts/release-payload-version.ts" --verify-source "${REPO_ROOT}"

STAGE="${DIST_DIR}/${PLATFORM}"
TARBALL="${DIST_DIR}/genie-${VERSION}-${PLATFORM}.tar.gz"
rm -rf "$STAGE" "$TARBALL"
mkdir -p "$STAGE"

echo "==> [${PLATFORM}] bun build --compile --target=${TARGET}  (v${VERSION})"
bun build --compile \
  --target="${TARGET}" \
  "${ENTRY_POINT}" \
  --outfile "${STAGE}/genie"

cp -R "${REPO_ROOT}/plugins"   "${STAGE}/plugins"
cp -R "${REPO_ROOT}/skills"    "${STAGE}/skills"
cp -R "${REPO_ROOT}/templates" "${STAGE}/templates"
cp "${REPO_ROOT}/LICENSE"       "${STAGE}/LICENSE"

# Tests validate the source checkout; no language's test sources or discovery
# directories belong in the runtime archive. Keep deletion and assertion
# separate so a newly introduced convention fails closed.
prune_release_tests() {
  local root="$1"
  find "${root}" -type d \( \
    -iname test -o -iname tests -o -iname __test__ -o -iname __tests__ -o \
    -iname spec -o -iname specs \
  \) -prune -exec rm -rf {} +
  find "${root}" -type f \( \
    -iname '*.test.*' -o -iname '*.spec.*' -o \
    -iname 'test_*.*' -o -iname '*_test.*' -o \
    -iname 'spec_*.*' -o -iname '*_spec.*' -o \
    -iname 'test.*' -o -iname 'spec.*' \
  \) -delete
}

assert_no_release_tests() {
  local root="$1"
  local found
  found="$(find "${root}" \( \
    \( -type d \( \
      -iname test -o -iname tests -o -iname __test__ -o -iname __tests__ -o \
      -iname spec -o -iname specs \
    \) \) -o \
    \( -type f \( \
      -iname '*.test.*' -o -iname '*.spec.*' -o \
      -iname 'test_*.*' -o -iname '*_test.*' -o \
      -iname 'spec_*.*' -o -iname '*_spec.*' -o \
      -iname 'test.*' -o -iname 'spec.*' \
    \) \) \
    \) -print -quit)"
  [[ -z "${found}" ]] || { echo "error: release payload contains test source ${found#"${root}/"}" >&2; return 1; }
}

prune_release_tests "${STAGE}"
assert_no_release_tests "${STAGE}"
mkdir -p "${STAGE}/.agents/plugins" "${STAGE}/.claude-plugin"
cp "${REPO_ROOT}/.agents/plugins/marketplace.json" "${STAGE}/.agents/plugins/marketplace.json"
cp "${REPO_ROOT}/.claude-plugin/marketplace.json" "${STAGE}/.claude-plugin/marketplace.json"

# A workflow --version override applies to the staged artifact only. Stamp and
# then independently verify every version-bearing copy so VERSION, plugin
# package/manifests, and marketplace metadata cannot disagree after extract.
bun "${REPO_ROOT}/scripts/release-payload-version.ts" --stamp "${STAGE}" "${VERSION}"

for required in \
  "LICENSE" \
  ".agents/plugins/marketplace.json" \
  ".claude-plugin/marketplace.json" \
  "plugins/genie/.codex-plugin/plugin.json" \
  "plugins/genie/.mcp.json" \
  "plugins/genie/scripts/mcp-launcher.cjs" \
  "plugins/genie/.claude-plugin/plugin.json" \
  "plugins/genie/hooks/hooks.json" \
  "plugins/genie/hooks/codex-hooks.json"; do
  [[ -f "${STAGE}/${required}" ]] || { echo "error: release payload missing ${required}" >&2; exit 1; }
done

for skill_dir in "${REPO_ROOT}"/skills/*; do
  [[ -f "${skill_dir}/SKILL.md" ]] || continue
  skill="$(basename "${skill_dir}")"
  [[ -f "${STAGE}/plugins/genie/skills/${skill}/SKILL.md" ]] \
    || { echo "error: release plugin missing skill ${skill}" >&2; exit 1; }
  [[ -f "${STAGE}/plugins/genie/skills/${skill}/agents/openai.yaml" ]] \
    || { echo "error: release plugin missing Codex metadata for ${skill}" >&2; exit 1; }
done

bun "${REPO_ROOT}/scripts/fresh-install-smoke.ts" \
  --skills-dir "${STAGE}/skills" \
  --plugin-root "${STAGE}/plugins/genie"
bun "${REPO_ROOT}/scripts/release-payload-version.ts" --verify "${STAGE}" "${VERSION}"

# Defense-in-depth for the consumer's exact-0700 staging-root assertion: `tar`
# records the archived root "./" entry's mode, and `tar -x` restores that mode
# onto the extraction directory. STAGE was created 0755 (build-host umask), so
# without this the published tarball carries a 0755 root entry that clobbers
# the private 0700 staging root install.sh / `genie update` extract into. Lock
# the root entry to 0700 here so a fresh tarball needs no consumer relock. (The
# consumer-side relock stays mandatory for already-published 0755 tarballs.)
chmod 700 "${STAGE}"

tar czf "${TARBALL}" -C "${STAGE}" .

# Archive boundaries can lose files, modes, or paths even when the staging
# tree was valid. Extract the produced artifact and rerun the release payload
# contract before size checks or upload.
VERIFY_ROOT="$(mktemp -d "${DIST_DIR}/.verify-${PLATFORM}.XXXXXX")"
trap 'rm -rf "${VERIFY_ROOT}"' EXIT
tar -xzf "${TARBALL}" -C "${VERIFY_ROOT}"
assert_no_release_tests "${VERIFY_ROOT}"

assert_release_tree_equal() {
  local source_root="$1"
  local extracted_root="$2"
  if find "${source_root}" "${extracted_root}" -type l -print -quit | grep -q .; then
    echo "error: release staging/extracted trees must not contain symlinks" >&2
    return 1
  fi
  if find "${source_root}" "${extracted_root}" ! -type f ! -type d -print -quit | grep -q .; then
    echo "error: release staging/extracted trees contain an unsupported entry type" >&2
    return 1
  fi
  assert_tree_direction() {
    local expected_root="$1"
    local actual_root="$2"
    local direction="$3"
    while IFS= read -r -d '' expected_entry; do
      local rel="${expected_entry#"${expected_root}/"}"
      local actual_entry="${actual_root}/${rel}"
      local kind
      if [[ -f "${expected_entry}" ]]; then
        kind="file"
        [[ -f "${actual_entry}" ]] \
          || { echo "error: ${direction} release missing file ${rel}" >&2; return 1; }
        cmp -- "${expected_entry}" "${actual_entry}" \
          || { echo "error: ${direction} release content differs for ${rel}" >&2; return 1; }
      else
        kind="directory"
        [[ -d "${actual_entry}" ]] \
          || { echo "error: ${direction} release missing directory ${rel}" >&2; return 1; }
      fi
      local expected_mode actual_mode
      expected_mode="$(stat -c '%a' "${expected_entry}" 2>/dev/null || stat -f '%Lp' "${expected_entry}")"
      actual_mode="$(stat -c '%a' "${actual_entry}" 2>/dev/null || stat -f '%Lp' "${actual_entry}")"
      [[ "${expected_mode}" == "${actual_mode}" ]] \
        || { echo "error: ${direction} release ${kind} mode differs for ${rel}: ${expected_mode} != ${actual_mode}" >&2; return 1; }
    done < <(find "${expected_root}" -mindepth 1 -print0)
  }
  assert_tree_direction "${source_root}" "${extracted_root}" "extracted"
  assert_tree_direction "${extracted_root}" "${source_root}" "staging"
}

assert_release_tree_equal "${STAGE}" "${VERIFY_ROOT}"
bun "${REPO_ROOT}/scripts/fresh-install-smoke.ts" \
  --skills-dir "${VERIFY_ROOT}/skills" \
  --plugin-root "${VERIFY_ROOT}/plugins/genie"
bun "${REPO_ROOT}/scripts/release-payload-version.ts" --verify "${VERIFY_ROOT}" "${VERSION}"
rm -rf "${VERIFY_ROOT}"
trap - EXIT

SIZE_MB=$(( $(stat -c '%s' "${TARBALL}" 2>/dev/null || stat -f '%z' "${TARBALL}") / 1024 / 1024 ))
echo "==> ${TARBALL}  (${SIZE_MB} MB)"
if (( SIZE_MB > SIZE_BUDGET_MB )); then
  echo "error: tarball ${SIZE_MB}MB exceeds ${SIZE_BUDGET_MB}MB budget" >&2
  exit 3
fi
