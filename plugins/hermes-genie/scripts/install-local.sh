#!/usr/bin/env bash
# Install the Genie Hermes plugin as $HERMES_HOME/plugins/genie.
#
# Default mode symlinks the repo checkout (edits are live — tight dev loop);
# --copy makes a detached, release-style copy instead.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: install-local.sh [--copy]

Installs plugins/hermes-genie as $HERMES_HOME/plugins/genie.

  (default)  symlink the repo checkout — edits are live
  --copy     copy the plugin files — detached, release-style install

HERMES_HOME defaults to $HOME/.hermes.
EOF
}

mode="symlink"
for arg in "$@"; do
  case "$arg" in
    --copy) mode="copy" ;;
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
target="$hermes_home/plugins/genie"

mkdir -p "$hermes_home/plugins"
# Replace a previous install only (a symlink, or a dir that looks like this
# plugin). Refuse to wipe unrelated content. Without a trailing slash the rm
# removes a stale symlink itself, never the checkout it points to.
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
