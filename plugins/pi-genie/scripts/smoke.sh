#!/usr/bin/env bash
# Smoke-test the Genie <-> pi integration.
#
#  1. extension installed at $PI_HOME/agent/extensions/genie (symlink or copy)
#  2. package.json pi.extensions entry resolves to an existing extension.ts
#  3. canonical genie binary ($GENIE_HOME/bin/genie or ~/.genie/bin/genie)
#     exists, is a regular non-symlink file, and is executable
#  4. extension transpiles (bun build --no-bundle) when bun is available
#  5. version stamp in package.json matches the genie release version
#  6. pure helper unit tests pass (bun test) when bun is available
#
# SAFETY: read-only. Never writes to the pi home or genie home. Exits non-zero
# if any check fails.
#
# Usage:
#   PI_HOME=<tmp> bash plugins/pi-genie/scripts/smoke.sh

set -uo pipefail

fail_count=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail_count=$((fail_count + 1)); }
die()  { printf 'smoke: %s\n' "$1" >&2; exit 2; }

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------
[ -n "${PI_HOME:-}" ] || die "PI_HOME must be set to a throwaway pi home (never the real ~/.pi)"

real_pi="$(cd "$HOME/.pi" 2>/dev/null && pwd -P || printf '%s' "$HOME/.pi")"
[ "$(cd "$PI_HOME" 2>/dev/null && pwd -P || printf '%s' "$PI_HOME")" != "$real_pi" ] \
  || die "refusing to run against the real PI_HOME ($PI_HOME)"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
plugin_dir="$(cd "$script_dir/.." && pwd)"
target="$PI_HOME/agent/extensions/genie"
ext="$plugin_dir/extension.ts"
manifest="$plugin_dir/package.json"

printf '== genie<->pi smoke ==\n'
printf 'PI_HOME=%s\nplugin=%s\n\n' "$PI_HOME" "$plugin_dir"

# ---------------------------------------------------------------------------
# 1) extension installed (symlink or copy) at the pi agent extensions dir
# ---------------------------------------------------------------------------
if [ -e "$target" ] && [ -f "$target/extension.ts" ]; then
  if [ -L "$target" ]; then
    pass "extension installed as symlink -> $(readlink "$target")"
  else
    pass "extension installed as directory copy"
  fi
else
  fail "extension not installed: $target/extension.ts missing (run scripts/install-local.sh)"
fi

# ---------------------------------------------------------------------------
# 2) package.json pi.extensions entry resolves to an existing extension.ts
# ---------------------------------------------------------------------------
if [ -f "$manifest" ]; then
  entry="$(sed -n 's/.*"extensions"[[:space:]]*:[[:space:]]*\[.*"\([^"]*\)".*/\1/p' "$manifest" | head -1)"
  if [ -n "$entry" ] && [ -f "$plugin_dir/$entry" ]; then
    pass "pi.extensions -> $entry (exists)"
  else
    fail "pi.extensions entry missing or unresolvable in $manifest (got: ${entry:-<none>})"
  fi
else
  fail "package.json missing: $manifest"
fi

# ---------------------------------------------------------------------------
# 3) canonical genie binary present, regular, non-symlink, executable
# ---------------------------------------------------------------------------
genie_home="${GENIE_HOME:-$HOME/.genie}"
[ "${genie_home#/}" != "$genie_home" ] || fail "GENIE_HOME must be absolute ($genie_home)"
genie_bin="$genie_home/bin/genie"
if [ -f "$genie_bin" ] && [ ! -L "$genie_bin" ] && [ -x "$genie_bin" ]; then
  pass "genie binary: $genie_bin (regular, executable)"
else
  fail "genie binary missing or not executable: $genie_bin"
fi

# ---------------------------------------------------------------------------
# 4) extension transpiles (bun build --no-bundle)
# ---------------------------------------------------------------------------
if command -v bun >/dev/null 2>&1; then
  if (cd "$plugin_dir" && bun build --no-bundle extension.ts >/dev/null 2>&1); then
    pass "extension.ts transpiles (bun build --no-bundle)"
  else
    fail "extension.ts failed to transpile"
  fi
else
  printf '  \033[33mSKIP\033[0m  bun not available — skipping transpile check\n'
fi

# ---------------------------------------------------------------------------
# 5) version stamp matches the genie release version
# ---------------------------------------------------------------------------
if [ -x "$genie_bin" ]; then
  manifest_version="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | head -1)"
  genie_version="$("$genie_bin" --version 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$manifest_version" ] && [ "$manifest_version" = "$genie_version" ]; then
    pass "version stamp matches genie release ($genie_version)"
  else
    fail "version mismatch: package.json=$manifest_version genie=$genie_version"
    printf '          (expected between releases when dev is ahead of the installed binary)\n'
  fi
fi

# ---------------------------------------------------------------------------
# 6) pure helper unit tests
# ---------------------------------------------------------------------------
if command -v bun >/dev/null 2>&1; then
  test_out="$(cd "$plugin_dir" && bun test tests/ 2>&1)"
  if printf '%s\n' "$test_out" | grep -Eq '^[[:space:]]*0 fail'; then
    pass "unit tests (bun test tests/)"
  else
    fail "unit tests failed"
    printf '%s\n' "$test_out" | tail -20 | sed 's/^/          /'
  fi
else
  printf '  \033[33mSKIP\033[0m  bun not available — skipping unit tests\n'
fi

printf '\n== result ==\n'
if [ "$fail_count" -eq 0 ]; then
  printf 'smoke: all checks passed\n'
  exit 0
fi
printf 'smoke: %d check(s) failed\n' "$fail_count"
exit 1
