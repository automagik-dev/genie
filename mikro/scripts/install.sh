#!/usr/bin/env bash
set -euo pipefail

MIKRO_REPO_URL="${MIKRO_REPO_URL:-https://github.com/automagik-dev/mikro.git}"
# Pre-rename location of the repository. Used only when MIKRO_REPO_URL does not
# resolve, so installs keep working until the GitHub rename lands.
MIKRO_FALLBACK_REPO_URL="${MIKRO_FALLBACK_REPO_URL:-https://github.com/automagik-dev/rlmx.git}"
MIKRO_BRANCH="${MIKRO_BRANCH:-main}"
MIKRO_INSTALL_DIR="${MIKRO_INSTALL_DIR:-$HOME/.mikro/mikro}"
MIKRO_BIN_DIR="${MIKRO_BIN_DIR:-$HOME/.local/bin}"

# Refuse this legacy-only default-prefix case before coordination creates the
# new parent. Automatic migration must not silently become a fresh install.
# Moving an active legacy checkout needs a separate migration protocol.
if [ "${MIKRO_INSTALL_DIR%/}" = "$HOME/.mikro/mikro" ] && [ -d "$HOME/.rlmx" ] && [ ! -e "$HOME/.mikro" ]; then
  cat >&2 <<'MIGRATION'
error: legacy ~/.rlmx installation found; automatic migration is deferred.
No installation data or launcher symlinks have been changed.
Stop all mikro, updater, npm and build processes using the legacy checkout.
Then migrate explicitly, only while the destination is absent:
  test ! -e "$HOME/.mikro" && mv "$HOME/.rlmx" "$HOME/.mikro"
  if [ -d "$HOME/.mikro/rlmx" ] && [ ! -e "$HOME/.mikro/mikro" ]; then
    mv "$HOME/.mikro/rlmx" "$HOME/.mikro/mikro"
  fi
Rerun this installer to refresh the checkout and recreate the mikro launcher.
MIGRATION
  exit 1
fi

if ! GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code "$MIKRO_REPO_URL" HEAD >/dev/null 2>&1; then
  if GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code "$MIKRO_FALLBACK_REPO_URL" HEAD >/dev/null 2>&1; then
    echo "==> $MIKRO_REPO_URL is not reachable; using $MIKRO_FALLBACK_REPO_URL"
    MIKRO_REPO_URL="$MIKRO_FALLBACK_REPO_URL"
  fi
fi

# curl | bash has no local companion module yet. Obtain a temporary checkout
# before touching the destination; its dependency-free coordinator then owns
# selection, cleanup, installation and build in the destination checkout.
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
if [ -z "$SCRIPT_DIR" ] || [ ! -f "$SCRIPT_DIR/../bin/install-state.mjs" ]; then
  BOOTSTRAP_DIR="$(mktemp -d)"
  trap 'rm -rf "$BOOTSTRAP_DIR"' EXIT
  git clone --depth 1 --branch "$MIKRO_BRANCH" "$MIKRO_REPO_URL" "$BOOTSTRAP_DIR/checkout"
  if [ ! -f "$BOOTSTRAP_DIR/checkout/bin/install-state.mjs" ]; then
    echo "error: selected checkout lacks the coordinated installer" >&2
    exit 1
  fi
  export MIKRO_REPO_URL MIKRO_FALLBACK_REPO_URL MIKRO_BRANCH MIKRO_INSTALL_DIR MIKRO_BIN_DIR
  bash "$BOOTSTRAP_DIR/checkout/scripts/install.sh"
  exit $?
fi

# The mutex and recovery journal survive checkout reset/clean.
mkdir -p "$(dirname "$MIKRO_INSTALL_DIR")"
if [ "${1:-}" != "--under-install-lock" ] || [ -z "${MIKRO_INSTALL_TOKEN:-}" ]; then
  exec node "$SCRIPT_DIR/../bin/install-state.mjs" installer "$MIKRO_INSTALL_DIR" "$SCRIPT_DIR/install.sh"
fi
node "$SCRIPT_DIR/../bin/install-state.mjs" verify "$MIKRO_INSTALL_DIR"

echo "==> Installing mikro"
echo "repo:   $MIKRO_REPO_URL"
echo "branch: $MIKRO_BRANCH"
echo "dir:    $MIKRO_INSTALL_DIR"
echo "bin:    $MIKRO_BIN_DIR"

mkdir -p "$MIKRO_BIN_DIR" "$(dirname "$MIKRO_INSTALL_DIR")"

if [ -d "$MIKRO_INSTALL_DIR/.git" ]; then
  echo "==> Existing checkout found; refreshing"
  git -C "$MIKRO_INSTALL_DIR" remote set-url origin "$MIKRO_REPO_URL"
  git -C "$MIKRO_INSTALL_DIR" fetch origin "$MIKRO_BRANCH" --tags
  # FETCH_HEAD, not origin/<branch>: works for any branch and for checkouts
  # whose fetch refspec does not track remote branches.
  git -C "$MIKRO_INSTALL_DIR" checkout -f -B "$MIKRO_BRANCH" FETCH_HEAD
  git -C "$MIKRO_INSTALL_DIR" clean -fd -e node_modules.prev/
else
  if [ -e "$MIKRO_INSTALL_DIR" ]; then
    echo "error: $MIKRO_INSTALL_DIR exists but is not a git checkout" >&2
    exit 1
  fi
  echo "==> Cloning"
  git clone --branch "$MIKRO_BRANCH" "$MIKRO_REPO_URL" "$MIKRO_INSTALL_DIR"
fi

cd "$MIKRO_INSTALL_DIR"

# Validate the selected checkout under the existing transaction before either
# legacy rename can relocate dependencies. Repair repeats this check.
node scripts/check-npm-authority.mjs

LEGACY_HOME="$HOME/.rlmx"
if [ -d "$LEGACY_HOME" ] && [ ! -e "$HOME/.mikro" ]; then
  echo "==> Migrating legacy $LEGACY_HOME -> $HOME/.mikro"
  mv "$LEGACY_HOME" "$HOME/.mikro"
  if [ -d "$HOME/.mikro/rlmx" ] && [ ! -e "$HOME/.mikro/mikro" ]; then
    mv "$HOME/.mikro/rlmx" "$HOME/.mikro/mikro"
  fi
fi
# The pre-rebrand symlink is either dangling or points at a legacy checkout;
# either way it is dead once mikro is installed.
if [ -L "$MIKRO_BIN_DIR/rlmx" ]; then
  echo "==> Removing legacy $MIKRO_BIN_DIR/rlmx symlink"
  rm -f "$MIKRO_BIN_DIR/rlmx"
fi

# The inherited token is checked against the live owner before any recovery.
node "$SCRIPT_DIR/../bin/install-state.mjs" finish "$MIKRO_INSTALL_DIR"

# The launcher is dependency-free and repairs a half-installed node_modules
# before loading the CLI, so a failed `mikro update` never strands the binary.
ln -sfn "$MIKRO_INSTALL_DIR/bin/mikro.mjs" "$MIKRO_BIN_DIR/mikro"
chmod +x "$MIKRO_INSTALL_DIR/bin/mikro.mjs" "$MIKRO_INSTALL_DIR/dist/src/cli.js"

echo "==> Installed"
node -p "'mikro v' + require('./package.json').version"
