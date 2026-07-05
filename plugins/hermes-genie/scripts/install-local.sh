#!/usr/bin/env bash
# Install the Genie Hermes plugin as $HERMES_HOME/plugins/genie.
#
# Default mode symlinks the repo checkout (edits are live — tight dev loop);
# --copy makes a detached, release-style copy instead. When the Hermes host
# runs a sticky profile ($HERMES_HOME/active_profile), plugins load from the
# profile's own plugins/ dir, so the plugin is installed there as well.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: install-local.sh [--copy] [--no-profile]

Installs plugins/hermes-genie as $HERMES_HOME/plugins/genie.

  (default)     symlink the repo checkout — edits are live
  --copy        copy the plugin files — detached, release-style install
  --no-profile  skip the active-profile install (default installs to
                $HERMES_HOME/profiles/<active>/plugins/genie too)

HERMES_HOME defaults to $HOME/.hermes.
EOF
}

mode="symlink"
profile_install=1
for arg in "$@"; do
  case "$arg" in
    --copy) mode="copy" ;;
    --no-profile) profile_install=0 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "install-local.sh: unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# Resolve the plugin source dir from the script location: <repo>/plugins/hermes-genie
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
plugin_src="$(cd "$script_dir/.." && pwd)"

hermes_home="${HERMES_HOME:-$HOME/.hermes}"

# Install one copy/symlink of the plugin at $1/genie, replacing only a
# previous install (a symlink, or a dir that looks like this plugin) —
# refuse to wipe unrelated content. Without a trailing slash the rm removes
# a stale symlink itself, never the checkout it points to.
install_into() {
  local plugins_dir="$1"
  local target="$plugins_dir/genie"

  mkdir -p "$plugins_dir"
  if [ -e "$target" ] || [ -L "$target" ]; then
    if [ -L "$target" ] || [ -f "$target/plugin.yaml" ]; then
      rm -rf "$target"
    else
      echo "refusing to replace $target: exists but does not look like a genie plugin install (no plugin.yaml)" >&2
      exit 1
    fi
  fi

  if [ "$mode" = "copy" ]; then
    cp -R "$plugin_src" "$target"
    echo "installed (copy): $target (from $plugin_src)"
  else
    ln -s "$plugin_src" "$target"
    echo "installed (symlink): $target -> $plugin_src"
  fi
}

install_into "$hermes_home/plugins"

# Profile-based hosts: a sticky active profile loads plugins from its own dir.
if [ "$profile_install" = "1" ] && [ -f "$hermes_home/active_profile" ]; then
  active_profile="$(head -n1 "$hermes_home/active_profile" | tr -d '[:space:]')"
  if [ -n "$active_profile" ] && [ -d "$hermes_home/profiles/$active_profile" ]; then
    install_into "$hermes_home/profiles/$active_profile/plugins"
  fi
fi
