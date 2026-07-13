#!/usr/bin/env bash
# Smoke-test the homogeneous Genie <-> Hermes integration end-to-end against an
# ISOLATED environment. It converges a throwaway GENIE_HOME -> HERMES_HOME pair
# exactly as `genie install`/`genie update` would, then verifies every leg of
# the homogeneous contract:
#
#   1. plugin link converged + plugin.yaml version == genie release version
#   2. mcp_servers.genie present with an absolute, existing, executable command
#   3. skills.external_dirs holds the product skills root (or a managed copy)
#   4. no khaw-bridge skill in the payload; pre_llm_call hook, not post_tool_call
#   5. `genie doctor` reports every hermes leg green
#
# Usage:
#   GENIE_HOME=<tmp> HERMES_HOME=<tmp> bash plugins/hermes-genie/scripts/smoke.sh
#
# GENIE_HOME must be pre-populated the way install/update leave it (this is what
# the qa/ dogfood harness does — see the wish qa/ evidence):
#   $GENIE_HOME/plugins/genie      $GENIE_HOME/plugins/hermes-genie
#   $GENIE_HOME/skills             $GENIE_HOME/bin/genie   (executable)
# HERMES_HOME must be an existing throwaway Hermes home.
#
# SAFETY: this converges (writes) into GENIE_HOME/HERMES_HOME and never anywhere
# else. It hard-refuses to run against the real ~/.genie or ~/.hermes, and it
# redirects Claude/Codex sync into throwaway dirs so no real client home is
# touched. Exits non-zero if any check fails.

set -uo pipefail

fail_count=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail_count=$((fail_count + 1)); }
die()  { printf 'smoke: %s\n' "$1" >&2; exit 2; }

# ---------------------------------------------------------------------------
# Preconditions + safety guards
# ---------------------------------------------------------------------------
[ -n "${GENIE_HOME:-}" ]  || die "GENIE_HOME must be set to a throwaway dir (never the real ~/.genie)"
[ -n "${HERMES_HOME:-}" ] || die "HERMES_HOME must be set to a throwaway dir (never the real ~/.hermes)"

# realpath a path even when it does not yet exist (resolve it when present).
canon() {
  local p="$1"
  if [ -e "$p" ]; then (cd "$p" 2>/dev/null && pwd -P) || printf '%s' "$p"; else printf '%s' "$p"; fi
}
real_genie="$(canon "${HOME:-/nonexistent}/.genie")"
real_hermes="$(canon "${HOME:-/nonexistent}/.hermes")"
[ "$(canon "$GENIE_HOME")"  != "$real_genie" ]  || die "refusing to run against the real GENIE_HOME ($GENIE_HOME)"
[ "$(canon "$HERMES_HOME")" != "$real_hermes" ] || die "refusing to run against the real HERMES_HOME ($HERMES_HOME)"

GENIE="$GENIE_HOME/bin/genie"
[ -d "$GENIE_HOME/plugins/genie" ]        || die "GENIE_HOME/plugins/genie missing — populate GENIE_HOME from the repo plugins/ first"
[ -d "$GENIE_HOME/plugins/hermes-genie" ] || die "GENIE_HOME/plugins/hermes-genie missing — populate GENIE_HOME from the repo plugins/ first"
[ -d "$GENIE_HOME/skills" ]               || die "GENIE_HOME/skills missing — populate GENIE_HOME from the repo skills/ first"
[ -x "$GENIE" ]                           || die "GENIE_HOME/bin/genie missing or not executable — copy the built dist/genie.js there (chmod +x) first"
[ -d "$HERMES_HOME" ]                     || die "HERMES_HOME must exist"

# Redirect Claude/Codex/agents sync into throwaway dirs unless the caller already
# isolated them, so the auto-selected convergence never touches a real client home.
_work="$(mktemp -d "${TMPDIR:-/tmp}/genie-smoke.XXXXXX")"
trap 'rm -rf "$_work"' EXIT
export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$_work/claude}"
export CODEX_HOME="${CODEX_HOME:-$_work/codex}"
export GENIE_AGENTS_SKILLS_DIR="${GENIE_AGENTS_SKILLS_DIR:-$_work/agents-skills}"

printf '== genie<->hermes homogeneous smoke ==\n'
printf 'GENIE_HOME=%s\nHERMES_HOME=%s\n\n' "$GENIE_HOME" "$HERMES_HOME"

# ---------------------------------------------------------------------------
# Converge the isolated env exactly as install/update would (no network, no
# binary swap — --sync-only only runs the agent-sync convergence).
# ---------------------------------------------------------------------------
printf -- '-- converging (genie update --sync-only) --\n'
if "$GENIE" update --sync-only 2>&1; then
  pass "convergence (genie update --sync-only) exited 0"
else
  fail "convergence (genie update --sync-only) exited non-zero"
fi
printf '\n'

# Resolve the live-profile config.yaml the way agent-sync/doctor do.
resolve_config() {
  local home="$1" active=""
  [ -f "$home/active_profile" ] && active="$(tr -d '[:space:]' < "$home/active_profile")"
  if [ -n "$active" ] && printf '%s' "$active" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' \
     && [ "$active" != "." ] && [ "$active" != ".." ]; then
    printf '%s/profiles/%s/config.yaml' "$home" "$active"
  else
    printf '%s/config.yaml' "$home"
  fi
}
CONFIG="$(resolve_config "$HERMES_HOME")"
LINK="$HERMES_HOME/plugins/genie"
PLUGIN_YAML="$LINK/plugin.yaml"

# Resolve the product skills root via the same fallback chain the helper uses.
skills_root() {
  local c
  for c in "$GENIE_HOME/skills" "$GENIE_HOME/plugins/genie/skills"; do
    if compgen -G "$c/*/SKILL.md" >/dev/null 2>&1; then printf '%s' "$c"; return 0; fi
  done
  return 1
}

printf -- '-- checks --\n'

# ---------------------------------------------------------------------------
# 1) plugin link converged + plugin.yaml version == genie release version
# ---------------------------------------------------------------------------
if [ -L "$LINK" ] && [ -e "$PLUGIN_YAML" ]; then
  plugin_version="$(sed -n 's/^version:[[:space:]]*//p' "$PLUGIN_YAML" | head -1 | tr -d '[:space:]')"
  genie_version="$("$GENIE" --version 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$plugin_version" ] && [ "$plugin_version" = "$genie_version" ]; then
    pass "plugin link converged; plugin.yaml version == genie release ($genie_version)"
  else
    fail "version mismatch: plugin.yaml=$plugin_version genie=$genie_version"
  fi
else
  fail "plugin link not converged: $LINK is not a resolvable symlink"
fi

# ---------------------------------------------------------------------------
# 2) mcp_servers.genie present with an absolute, existing, executable command
# ---------------------------------------------------------------------------
if [ -f "$CONFIG" ]; then
  mcp_cmd="$(awk '/genie:managed:mcp_servers.genie/{f=1} f&&/^[[:space:]]*command:/{print;exit}' "$CONFIG" \
            | sed -E 's/.*command:[[:space:]]*"?([^"]*)"?[[:space:]]*$/\1/')"
  if [ -z "$mcp_cmd" ]; then
    # Fall back to an unmarked genie entry if the managed marker block is absent.
    mcp_cmd="$(awk '/^mcp_servers:/{m=1} m&&/^[[:space:]]+genie:/{g=1} g&&/^[[:space:]]*command:/{print;exit}' "$CONFIG" \
              | sed -E 's/.*command:[[:space:]]*"?([^"]*)"?[[:space:]]*$/\1/')"
  fi
  if [ -z "$mcp_cmd" ]; then
    fail "mcp_servers.genie.command absent in $CONFIG"
  elif [ "${mcp_cmd#/}" = "$mcp_cmd" ]; then
    fail "mcp_servers.genie.command not absolute ($mcp_cmd)"
  elif [ ! -x "$mcp_cmd" ]; then
    fail "mcp_servers.genie.command missing or not executable ($mcp_cmd)"
  else
    pass "mcp_servers.genie -> $mcp_cmd (absolute, executable)"
  fi
else
  fail "isolated Hermes config absent: $CONFIG"
fi

# ---------------------------------------------------------------------------
# 3) skills.external_dirs holds the product skills root (or a managed copy)
# ---------------------------------------------------------------------------
product_count="$(compgen -G "$GENIE_HOME/plugins/genie/skills/*/SKILL.md" 2>/dev/null | wc -l | tr -d '[:space:]')"
if root="$(skills_root)" && [ -f "$CONFIG" ] \
   && grep -F 'genie:managed:skills.external_dirs' "$CONFIG" | grep -Fq "$root"; then
  pass "skills.external_dirs -> $root"
else
  copy_dir="$(dirname "$CONFIG")/skills"
  copy_count="$(compgen -G "$copy_dir/*/SKILL.md" 2>/dev/null | wc -l | tr -d '[:space:]')"
  if [ "${product_count:-0}" -gt 0 ] && [ "${copy_count:-0}" -ge "${product_count:-0}" ]; then
    pass "managed skills copy $copy_count/$product_count ($copy_dir)"
  else
    fail "skills leg unproven: external_dirs missing root and managed copy $copy_count/$product_count"
  fi
fi

# ---------------------------------------------------------------------------
# 4) no khaw-bridge skill in the payload; pre_llm_call hook, not post_tool_call
# ---------------------------------------------------------------------------
khaw_ok=1
[ -e "$LINK/skills/genie-khaw-bridge" ] && khaw_ok=0
grep -rq 'genie-khaw-bridge' "$PLUGIN_YAML" 2>/dev/null && khaw_ok=0
if [ "$khaw_ok" -eq 1 ]; then
  pass "no khaw-bridge skill in the payload (ownership moved to the KHAW plugin)"
else
  fail "khaw-bridge still present in the Hermes payload"
fi

if grep -q 'pre_llm_call' "$PLUGIN_YAML" 2>/dev/null && ! grep -q 'post_tool_call' "$PLUGIN_YAML" 2>/dev/null; then
  pass "provides_hooks has pre_llm_call, not post_tool_call"
else
  fail "provides_hooks contract wrong (need pre_llm_call, must not have post_tool_call)"
fi

# ---------------------------------------------------------------------------
# 5) `genie doctor` reports every hermes leg green
# ---------------------------------------------------------------------------
doctor_out="$("$GENIE" doctor 2>&1 || true)"
hermes_lines="$(printf '%s\n' "$doctor_out" | grep 'agent sync: hermes' || true)"
if [ -z "$hermes_lines" ]; then
  fail "genie doctor reported no hermes legs"
else
  bad="$(printf '%s\n' "$hermes_lines" | grep -Fv '✔' || true)"
  n_legs="$(printf '%s\n' "$hermes_lines" | grep -c .)"
  if [ -z "$bad" ]; then
    pass "genie doctor: all $n_legs hermes legs green"
  else
    fail "genie doctor: hermes leg(s) not green:"
    printf '%s\n' "$bad" | sed 's/^/          /'
  fi
fi

printf '\n-- genie doctor hermes legs --\n'
printf '%s\n' "$hermes_lines"

printf '\n== result ==\n'
if [ "$fail_count" -eq 0 ]; then
  printf 'smoke: all checks passed\n'
  exit 0
fi
printf 'smoke: %d check(s) failed\n' "$fail_count"
exit 1
