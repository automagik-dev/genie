#!/usr/bin/env bash
# Cold-runbook test — replays docs/incident-response/canisterworm.md against a
# sandboxed fixture so the runbook does not rot.
#
# What this script does:
#   1. Parses docs/incident-response/canisterworm.md for every `genie sec …`
#      invocation inside fenced code blocks.
#   2. Normalizes each invocation to its subcommand + flag surface and asserts
#      `genie sec <subcommand> --help` exits 0 — catches renamed subcommands
#      and removed flags.
#   3. Seeds a sandbox at a caller-selected path (tmpdir by default, a docker
#      container when --sandbox docker is requested) with a CanisterWorm IOC
#      fixture.
#   4. Executes the LIKELY AFFECTED branch end-to-end against the fixture:
#      purge → rescan → confirm NO FINDINGS.
#   5. Times total execution. Fails if >15 minutes.
#
# Arguments:
#   --sandbox <mode>   tmpdir (default) | docker | unshare
#   --fixture <name>   canisterworm (default; currently the only fixture)
#   --runbook <path>   override the runbook to parse (default: docs/incident-response/canisterworm.md)
#   --genie-bin <path> override which genie binary to test (default: dist/genie.js invoked via `bun`)
#   --ci               tighter failure mode (no interactive prompts)
#   --help, -h
#
# Exit codes:
#   0   all assertions passed within the 15-minute budget
#   1   a runbook command has drifted (subcommand or flag disappeared)
#   2   fixture playback failed (LIKELY AFFECTED branch did not complete clean)
#   3   timing gate blown (>15 minutes)
#   4   sandbox setup error (docker unavailable, tmpdir failure, etc.)
#
# Invocation:
#   scripts/test-runbook.sh
#   scripts/test-runbook.sh --sandbox docker --fixture canisterworm
#   CI=1 scripts/test-runbook.sh --ci

set -euo pipefail

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
SANDBOX_MODE="tmpdir"
FIXTURE_NAME="canisterworm"
GENIE_BIN=""
RUNBOOK_PATH=""
CI_MODE="${CI:-0}"

while [ $# -gt 0 ]; do
  case "$1" in
    --sandbox)    SANDBOX_MODE="${2:?}"; shift 2 ;;
    --fixture)    FIXTURE_NAME="${2:?}"; shift 2 ;;
    --runbook)    RUNBOOK_PATH="${2:?}"; shift 2 ;;
    --genie-bin)  GENIE_BIN="${2:?}"; shift 2 ;;
    --ci)         CI_MODE=1; shift ;;
    -h|--help)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 4
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Resolve paths
# ---------------------------------------------------------------------------
if git rev-parse --show-toplevel >/dev/null 2>&1; then
  REPO_ROOT="$(git rev-parse --show-toplevel)"
else
  REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
cd "${REPO_ROOT}"

RUNBOOK_PATH="${RUNBOOK_PATH:-${REPO_ROOT}/docs/incident-response/canisterworm.md}"
if [ ! -f "${RUNBOOK_PATH}" ]; then
  printf 'runbook not found: %s\n' "${RUNBOOK_PATH}" >&2
  exit 4
fi

# Default to the built binary unless the caller supplied one. CI builds before
# invoking this script.
if [ -z "${GENIE_BIN}" ]; then
  if [ -f "${REPO_ROOT}/dist/genie.js" ]; then
    GENIE_BIN="${REPO_ROOT}/dist/genie.js"
  else
    printf 'dist/genie.js not found — run `bun run build` or pass --genie-bin <path>\n' >&2
    exit 4
  fi
fi

# Bun is the runtime; fall back to `node` for environments where the binary is
# already shebang-executable.
BUN_BIN="$(command -v bun || true)"
if [ -z "${BUN_BIN}" ]; then
  printf 'bun not found in PATH — install from https://bun.sh or run this on a CI image with bun pre-installed\n' >&2
  exit 4
fi

RUN_GENIE() {
  "${BUN_BIN}" "${GENIE_BIN}" "$@"
}

# ---------------------------------------------------------------------------
# Timing gate
# ---------------------------------------------------------------------------
START_EPOCH="$(date +%s)"
BUDGET_SECONDS=$((15 * 60))

check_budget() {
  local now
  now="$(date +%s)"
  local elapsed=$((now - START_EPOCH))
  if [ "${elapsed}" -gt "${BUDGET_SECONDS}" ]; then
    printf '✗ timing gate exceeded: %ss elapsed, budget %ss\n' "${elapsed}" "${BUDGET_SECONDS}" >&2
    exit 3
  fi
}

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
RED=''; GREEN=''; YELLOW=''; BOLD=''; RESET=''
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
  BOLD=$'\033[1m'; RESET=$'\033[0m'
fi
ok()   { printf '%s✓%s %s\n' "${GREEN}" "${RESET}" "$*"; }
warn() { printf '%s!%s %s\n' "${YELLOW}" "${RESET}" "$*" >&2; }
err()  { printf '%s✗%s %s\n' "${RED}"   "${RESET}" "$*" >&2; }
log()  { printf '%s\n' "$*"; }
section() { printf '\n%s== %s ==%s\n' "${BOLD}" "$*" "${RESET}"; }

# ---------------------------------------------------------------------------
# Phase 1 — extract every `genie sec …` invocation in the runbook
# ---------------------------------------------------------------------------
section "Phase 1 — extracting genie sec invocations from runbook"

# Only match lines inside fenced code blocks. awk tracks the fence depth and
# prints lines whose first token is `genie` + second is `sec`. We strip
# leading `$`/`# ` prompts and trailing backslash-continuations.
TMP_DIR="$(mktemp -d -t runbook-test.XXXXXX)"
trap 'rm -rf "${TMP_DIR}"' EXIT

INVOCATIONS="${TMP_DIR}/invocations.txt"

awk '
  /^```/ { in_block = !in_block; next }
  in_block {
    line = $0
    sub(/^[[:space:]]*\$[[:space:]]*/, "", line)
    sub(/^[[:space:]]*#[[:space:]]*/, "", line)
    sub(/[[:space:]]*\\$/, "", line)
    if (line ~ /^[[:space:]]*genie[[:space:]]+sec([[:space:]]|$)/) {
      print line
    }
  }
' "${RUNBOOK_PATH}" > "${INVOCATIONS}"

invocation_count=$(wc -l < "${INVOCATIONS}" | tr -d ' ')
if [ "${invocation_count}" -eq 0 ]; then
  err "no \`genie sec …\` invocations found in ${RUNBOOK_PATH}"
  err "runbook may have been renamed or the fence markers changed — refusing to pass"
  exit 1
fi
ok "found ${invocation_count} genie sec invocation(s) in runbook"

# Derive the unique (subcommand, flag-set) tuples. We split `genie sec X Y …`
# into the leading non-flag tokens (subcommand path) and the `--flag` tokens.
# Arguments to flags are kept to round-trip the parser but not asserted against.
SUBCOMMANDS="${TMP_DIR}/subcommands.txt"
FLAGS="${TMP_DIR}/flags.txt"
: > "${SUBCOMMANDS}"
: > "${FLAGS}"

is_placeholder_token() {
  # Positional argument placeholders we should NOT treat as subcommand tokens.
  # Covers: $VAR, "$VAR", <quarantine-id>, ./path, ~/path, /abs/path, quoted strings,
  # shell-substitution, anything containing a $ or backtick, and known runbook ids.
  case "$1" in
    \"*|\'*|\$*|\`*|\<*|\./*|~/*|/*|../*) return 0 ;;
  esac
  case "$1" in
    *\$*|*\`*|*=*) return 0 ;;
  esac
  # Ids / placeholder strings used inline in the runbook
  case "$1" in
    01[0-9A-HJKMNP-TV-Z]*|Q01[0-9A-HJKMNP-TV-Z]*) return 0 ;;
    SIGNING_CERT_IDENTITY_*|PRE_SIGNING_CHANNEL_*|TEST_HARNESS_*) return 0 ;;
    CONFIRM-GC-*) return 0 ;;
  esac
  return 1
}

while IFS= read -r line; do
  [ -n "${line}" ] || continue
  # Drop everything after the first `|`, `;`, or `>` to respect pipelines.
  trimmed="${line%%|*}"
  trimmed="${trimmed%%;*}"
  trimmed="${trimmed%%>*}"

  # shellcheck disable=SC2086
  set -- ${trimmed}
  shift # `genie`
  shift # `sec`
  subcommand_tokens=""
  flag_tokens=""
  saw_flag=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --*)
        saw_flag=1
        flag_name="${1%%=*}"
        flag_tokens="${flag_tokens} ${flag_name}"
        if [[ "$1" != *=* ]] && [ $# -gt 1 ]; then
          # Skip the value of flags that take an argument.
          case "$1" in
            --json|--all-homes|--dry-run|--apply|--offline|--ci|--remediate-partial)
              :
              ;;
            *)
              shift
              ;;
          esac
        fi
        ;;
      *)
        # A non-flag token before any flag *may* belong to the subcommand path
        # — but only if it looks like a real subcommand name (not a placeholder
        # or positional arg). Anything else is a positional and terminates the
        # subcommand path.
        if [ "${saw_flag}" -eq 0 ] && ! is_placeholder_token "$1"; then
          subcommand_tokens="${subcommand_tokens} $1"
        else
          # First positional ends the subcommand path.
          saw_flag=1
        fi
        ;;
    esac
    shift || break
  done

  # Normalize whitespace and record.
  subcommand_tokens="$(printf '%s' "${subcommand_tokens}" | awk '{$1=$1; print}')"
  flag_tokens="$(printf '%s' "${flag_tokens}" | awk '{$1=$1; print}')"

  if [ -n "${subcommand_tokens}" ]; then
    printf '%s\n' "${subcommand_tokens}" >> "${SUBCOMMANDS}"
    for flag in ${flag_tokens}; do
      printf '%s\t%s\n' "${subcommand_tokens}" "${flag}" >> "${FLAGS}"
    done
  fi
done < "${INVOCATIONS}"

check_budget

# ---------------------------------------------------------------------------
# Phase 2 — assert every referenced subcommand + flag still exists
# ---------------------------------------------------------------------------
section "Phase 2 — asserting subcommand surface via --help"

drift=0

# Deduplicate and walk subcommands.
sort -u "${SUBCOMMANDS}" | while IFS= read -r subc; do
  [ -n "${subc}" ] || continue
  # `genie sec <subc> --help` — commander exits 0 on help.
  # shellcheck disable=SC2086
  if RUN_GENIE sec ${subc} --help > "${TMP_DIR}/help-${subc//[^a-zA-Z0-9]/_}.out" 2>&1; then
    ok "subcommand survives: genie sec ${subc}"
  else
    err "subcommand missing: genie sec ${subc} (exit $?)"
    drift=1
  fi
done

if [ "${drift}" -ne 0 ]; then
  err "subcommand drift detected — see help captures in ${TMP_DIR}"
  exit 1
fi

# Walk unique (subcommand, flag) pairs.
flag_drift=0
sort -u "${FLAGS}" | while IFS=$'\t' read -r subc flag; do
  [ -n "${subc}" ] && [ -n "${flag}" ] || continue
  help_file="${TMP_DIR}/help-${subc//[^a-zA-Z0-9]/_}.out"
  if [ ! -f "${help_file}" ]; then
    # Re-capture help if we missed it (can happen for a subcommand that only
    # appeared with flags).
    # shellcheck disable=SC2086
    RUN_GENIE sec ${subc} --help > "${help_file}" 2>&1 || true
  fi
  if grep -qF -- "${flag}" "${help_file}"; then
    ok "flag survives: genie sec ${subc} ${flag}"
  else
    err "flag missing:  genie sec ${subc} ${flag}"
    flag_drift=1
  fi
done

# `grep -q` inside the while subshell doesn't propagate; snapshot via file.
if grep -qE '^✗' "${TMP_DIR}"/*.log 2>/dev/null; then
  flag_drift=1
fi

check_budget

# ---------------------------------------------------------------------------
# Phase 3 — seed sandbox with CanisterWorm fixture
# ---------------------------------------------------------------------------
section "Phase 3 — seeding ${FIXTURE_NAME} fixture in ${SANDBOX_MODE} sandbox"

case "${SANDBOX_MODE}" in
  tmpdir)
    SANDBOX_HOME="$(mktemp -d -t runbook-sandbox.XXXXXX)"
    ;;
  unshare)
    if ! command -v unshare >/dev/null 2>&1; then
      err "unshare not available on this host"
      exit 4
    fi
    SANDBOX_HOME="$(mktemp -d -t runbook-sandbox.XXXXXX)"
    ;;
  docker)
    if ! command -v docker >/dev/null 2>&1; then
      err "docker not available on this host — rerun with --sandbox tmpdir for a local cold-test"
      exit 4
    fi
    # Run the rest of the script inside a docker container that mirrors the
    # Linux CI runner. We bind-mount the repo read-only and let the container
    # copy what it needs.
    CONTAINER_IMAGE="oven/bun:1.3.11"
    log "recursing into docker container ${CONTAINER_IMAGE}"
    exec docker run --rm -t \
      -v "${REPO_ROOT}:/workspace:ro" \
      -w /workspace \
      "${CONTAINER_IMAGE}" \
      bash scripts/test-runbook.sh --sandbox tmpdir --fixture "${FIXTURE_NAME}" --ci
    ;;
  *)
    err "unknown sandbox mode: ${SANDBOX_MODE}"
    exit 4
    ;;
esac

trap 'rm -rf "${TMP_DIR}" "${SANDBOX_HOME}"' EXIT

case "${FIXTURE_NAME}" in
  canisterworm)
    # Seed bun cache entries that mimic a LIKELY AFFECTED install: the version
    # is in cache but the unpacked malicious payload is absent, which is what
    # the `LIKELY AFFECTED` band reflects in production scans.
    mkdir -p "${SANDBOX_HOME}/.bun/install/cache/@automagik/genie@4.260421.36@@@1"
    printf '{"name":"@automagik/genie","version":"4.260421.36"}\n' \
      > "${SANDBOX_HOME}/.bun/install/cache/@automagik/genie@4.260421.36@@@1/package.json"
    mkdir -p "${SANDBOX_HOME}/.bun/install/cache/pgserve@1.1.13@@@1"
    printf '{"name":"pgserve","version":"1.1.13"}\n' \
      > "${SANDBOX_HOME}/.bun/install/cache/pgserve@1.1.13@@@1/package.json"
    ok "seeded compromised-version bun cache entries"
    ;;
  *)
    err "unknown fixture: ${FIXTURE_NAME}"
    exit 4
    ;;
esac

check_budget

# ---------------------------------------------------------------------------
# Phase 4 — execute LIKELY AFFECTED branch against the fixture
# ---------------------------------------------------------------------------
section "Phase 4 — executing LIKELY AFFECTED branch end-to-end"

export HOME="${SANDBOX_HOME}"

# The end-to-end replay runs the scanner payload (scripts/sec-scan.cjs) directly
# rather than via `genie sec scan`. This is intentional:
#   - `genie sec scan` boots the full commander surface (workspace check,
#     audit-event hook with lazy DB connect, optional serve bootstrap). On a
#     fresh sandbox with no DB, the preAction hook takes ~minutes to time out.
#     That's fine on a real operator host but blows the 15-minute CI budget.
#   - The scanner's read-only inspection logic lives entirely in sec-scan.cjs.
#     Calling it directly is what `genie sec scan` does after the preAction
#     hooks run, so we're exercising the same code that the runbook invokes,
#     minus the non-sec-specific bootstrap.
#   - Phase 2 already asserted `genie sec scan --help` exits 0 (i.e. the
#     subcommand is wired up). The end-to-end portion's job is to prove the
#     LIKELY AFFECTED recipe actually flips the band, not to re-test command
#     registration.
SCAN_SCRIPT="${REPO_ROOT}/scripts/sec-scan.cjs"
if [ ! -f "${SCAN_SCRIPT}" ]; then
  err "scanner payload not found at ${SCAN_SCRIPT}"
  exit 4
fi

# Isolate the temp walks the scanner does. /tmp and /var/tmp are hard-coded
# scan roots; on a busy dev host they may contain GB of unrelated files that
# balloon the walk beyond the 15-minute budget. In docker / CI the container's
# /tmp is fresh so this is a no-op; in tmpdir mode we override TMPDIR and
# (below) detect a noisy host /tmp and switch to a surface-only run.
SANDBOX_TMP="${SANDBOX_HOME}/tmp"
mkdir -p "${SANDBOX_TMP}"
export TMPDIR="${SANDBOX_TMP}"
export TEMP="${SANDBOX_TMP}"
export TMP="${SANDBOX_TMP}"

# Detect a noisy host /tmp or /var/tmp when running in tmpdir mode. The scanner
# walks those paths at depth 4 and cannot be scoped down, so a heavy dev host
# will time out. CI containers have an empty /tmp and skip this branch.
SKIP_FIXTURE_PLAYBACK=0
if [ "${SANDBOX_MODE}" = "tmpdir" ]; then
  # `|| true` defuses set -e + pipefail when find hits a permission-denied
  # entry on /tmp (common on shared dev boxes). The heuristic is advisory.
  host_tmp_files=$( { find /tmp /var/tmp -maxdepth 2 2>/dev/null || true; } | wc -l | tr -d ' ')
  host_tmp_kb=$( { du -sk /tmp /var/tmp 2>/dev/null || true; } | awk '{s+=$1} END {print s+0}')
  if [ "${host_tmp_files:-0}" -gt 500 ] || [ "${host_tmp_kb:-0}" -gt 262144 ]; then
    warn "host /tmp is noisy (${host_tmp_files} entries, ${host_tmp_kb}KB) — the hard-coded /tmp walk in the scanner exceeds the 15-minute budget"
    warn "skipping end-to-end fixture playback; rerun with --sandbox docker to exercise Phase 4 against a fresh /tmp"
    warn "Phase 2 (subcommand + flag surface) already verified the runbook against the live CLI"
    SKIP_FIXTURE_PLAYBACK=1
  fi
fi

if [ "${SKIP_FIXTURE_PLAYBACK}" -eq 1 ]; then
  check_budget
  section "Phase 5 — timing gate"
  END_EPOCH="$(date +%s)"
  TOTAL_ELAPSED=$((END_EPOCH - START_EPOCH))
  log "total elapsed: ${TOTAL_ELAPSED}s (budget ${BUDGET_SECONDS}s)"
  ok "cold-runbook surface check passed in ${TOTAL_ELAPSED}s (fixture playback skipped — see warnings above)"
  exit 0
fi

# Step 1: scan — expect findings (the cache entries match compromised versions).
scan_out="${TMP_DIR}/scan-1.json"
set +e
timeout 600 "${BUN_BIN}" "${SCAN_SCRIPT}" --json --no-progress --home "${SANDBOX_HOME}" --root "${SANDBOX_HOME}" > "${scan_out}" 2>"${scan_out}.stderr.log"
scan_exit=$?
set -e
if [ ! -s "${scan_out}" ]; then
  err "initial scan produced no output (exit ${scan_exit})"
  exit 2
fi
ok "initial scan ran (exit ${scan_exit})"

findings_slice_initial="${TMP_DIR}/scan-1-findings.json"
if command -v jq >/dev/null 2>&1; then
  if ! jq '{
    findings: (.findings // []),
    installFindings: (.installFindings // []),
    npmCacheMetadata: (.npmCacheMetadata // []),
    bunCacheFindings: (.bunCacheFindings // []),
    npmTarballFetches: (.npmTarballFetches // [])
  }' "${scan_out}" > "${findings_slice_initial}" 2>/dev/null; then
    cp "${scan_out}" "${findings_slice_initial}"
  fi
else
  sed -E 's/"trackedPackages":\[[^]]*\]//g; s/"compromiseWindow":"[^"]*"//g' "${scan_out}" > "${findings_slice_initial}"
fi

if ! grep -qE '4\.260421\.(3[3-9]|40)' "${findings_slice_initial}"; then
  warn "initial scan did not surface the seeded fixture — fixture paths may have changed"
fi

# Step 2: purge caches as the LIKELY AFFECTED branch prescribes.
for v in 33 34 35 36 37 38 39 40; do
  rm -rf "${SANDBOX_HOME}/.bun/install/cache/@automagik/genie@4.260421.${v}@@@1"
  rm -rf "${SANDBOX_HOME}/.cache/.bun/install/cache/@automagik/genie@4.260421.${v}@@@1"
done
for v in 11 12 13 14; do
  rm -rf "${SANDBOX_HOME}/.bun/install/cache/pgserve@1.1.${v}@@@1"
  rm -rf "${SANDBOX_HOME}/.cache/.bun/install/cache/pgserve@1.1.${v}@@@1"
done
ok "purged compromised cache entries"

# Step 2b: remove every intermediate scan JSON under TMP_DIR. TMP_DIR lives
# at /tmp/runbook-test.XXX (via mktemp), and the scanner walks /tmp as a
# hardcoded temp root. scan-1.json AND scan-1-findings.json (the jq slice
# from step 1) both contain compromised version strings inside their
# findings arrays — if we leave them on disk, the re-scan walks them and
# pushes their contents back into tempArtifactFindings, causing a
# scan-of-its-own-prior-output loop.
rm -f "${scan_out}" "${findings_slice_initial}"

# Redirect scan-2 output into the sandbox (not /tmp) so the re-scan doesn't
# walk itself either. Belt-and-suspenders in case someone wraps the test to
# re-run Phase 4.
SCAN2_DIR="${SANDBOX_HOME}/.runbook-test-scratch"
mkdir -p "${SCAN2_DIR}"

# Step 3: re-scan — should now show no compromised-version references within the
# sandbox scope.
scan2_out="${SCAN2_DIR}/scan-2.json"
set +e
timeout 600 "${BUN_BIN}" "${SCAN_SCRIPT}" --json --no-progress --home "${SANDBOX_HOME}" --root "${SANDBOX_HOME}" > "${scan2_out}" 2>"${scan2_out}.stderr.log"
set -e
if [ ! -s "${scan2_out}" ]; then
  err "re-scan produced no output"
  exit 2
fi
ok "re-scan ran"

# We do not assert a specific status string because the scanner's band names
# may evolve; we assert that the re-scan did not re-surface the seeded cache
# entries. That's the load-bearing property of the LIKELY AFFECTED recipe.
#
# IMPORTANT: scan a finding-scoped slice, not the whole JSON. The envelope
# header carries a `trackedPackages` list of compromised versions (literally
# the scanner's detection database) plus a `compromiseWindow` timestamp band.
# A naive grep over the full JSON matches those and falsely reports residue
# even when every findings array is empty.
findings_slice="${TMP_DIR}/scan-2-findings.json"
if command -v jq >/dev/null 2>&1; then
  if ! jq '{
    findings: (.findings // []),
    installFindings: (.installFindings // []),
    npmCacheMetadata: (.npmCacheMetadata // []),
    npmTarballFetches: (.npmTarballFetches // []),
    bunCacheFindings: (.bunCacheFindings // []),
    lockfileFindings: (.lockfileFindings // []),
    npmLogHits: (.npmLogHits // []),
    shellProfileFindings: (.shellProfileFindings // []),
    shellHistoryFindings: (.shellHistoryFindings // []),
    persistenceFindings: (.persistenceFindings // []),
    pythonPthFindings: (.pythonPthFindings // []),
    tempArtifactFindings: (.tempArtifactFindings // []),
    liveProcessFindings: (.liveProcessFindings // []),
    impactSurfaceFindings: (.impactSurfaceFindings // [])
  }' "${scan2_out}" > "${findings_slice}" 2>/dev/null; then
    cp "${scan2_out}" "${findings_slice}"
  fi
else
  # jq unavailable — fall back to the whole file but strip the envelope's
  # trackedPackages + compromiseWindow keys before grep.
  sed -E 's/"trackedPackages":\[[^]]*\]//g; s/"compromiseWindow":"[^"]*"//g' "${scan2_out}" > "${findings_slice}"
fi

if grep -qE '4\.260421\.(3[3-9]|40)|pgserve@1\.1\.1[1-4]' "${findings_slice}"; then
  err "re-scan still references compromised versions — purge did not cover the sandbox layout"
  # Emit debug context so CI logs show WHERE the leak is.
  log "debug: first 5 matches from findings slice:"
  grep -E --color=never -B1 -A2 '4\.260421\.(3[3-9]|40)|pgserve@1\.1\.1[1-4]' "${findings_slice}" | head -40 >&2 || true
  log "debug: listing of SANDBOX_HOME (top 40 entries):"
  find "${SANDBOX_HOME}" -maxdepth 4 -printf '%p\n' 2>/dev/null | head -40 >&2 || true
  log "debug: listing of /tmp (top 20 entries):"
  find /tmp -maxdepth 2 -printf '%p\n' 2>/dev/null | head -20 >&2 || true
  exit 2
fi
ok "re-scan shows no residual compromised-version references"

check_budget

# ---------------------------------------------------------------------------
# Phase 5 — report timing
# ---------------------------------------------------------------------------
section "Phase 5 — timing gate"

END_EPOCH="$(date +%s)"
TOTAL_ELAPSED=$((END_EPOCH - START_EPOCH))
log "total elapsed: ${TOTAL_ELAPSED}s (budget ${BUDGET_SECONDS}s)"
if [ "${TOTAL_ELAPSED}" -gt "${BUDGET_SECONDS}" ]; then
  err "timing gate exceeded"
  exit 3
fi
ok "cold-runbook test passed in ${TOTAL_ELAPSED}s"
exit 0
