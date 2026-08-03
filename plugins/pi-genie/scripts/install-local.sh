#!/usr/bin/env bash
# Install the Genie pi plugin as $PI_CODING_AGENT_DIR/extensions/genie
# (or $PI_HOME/agent/extensions/genie via the legacy genie alias).
#
# Default mode symlinks the repo checkout (edits are live — tight dev loop);
# --copy makes a detached, release-style copy instead. A previous install (a
# symlink, or a dir that looks like this plugin) is replaced; anything else is
# refused unless --force, which also removes a stale standalone genie.ts file.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: install-local.sh [--copy] [--force]

Installs plugins/pi-genie into the pi extensions dir:
  $PI_CODING_AGENT_DIR/extensions   (pi's real relocation override)
  $PI_HOME/agent/extensions         (legacy genie alias; PI_HOME defaults to $HOME/.pi)

  (default)  symlink the repo checkout — edits are live
  --copy     copy the plugin files — detached, release-style install
  --force    replace a standalone ~/.pi/agent/extensions/genie.ts file
EOF
}

mode="symlink"
force=0
for arg in "$@"; do
  case "$arg" in
    --copy) mode="copy" ;;
    --force) force=1 ;;
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

# Resolve the plugin source dir from the script location: <repo>/plugins/pi-genie
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
plugin_src="$(cd "$script_dir/.." && pwd)"

# Resolve the pi agent dir the same way pi does: $PI_CODING_AGENT_DIR (real
# relocation override, tilde-expanded) or $PI_HOME/agent (legacy alias).
# An empty or whitespace-only override is treated as unset: it would otherwise
# resolve to a cwd-relative "extensions" path and mutate the wrong directory.
pi_agent_dir_trimmed="$(printf '%s' "${PI_CODING_AGENT_DIR:-}" | tr -d '[:space:]')"
pi_home_trimmed="$(printf '%s' "${PI_HOME:-}" | tr -d '[:space:]')"
if [ -n "$pi_agent_dir_trimmed" ]; then
  agent_dir="$PI_CODING_AGENT_DIR"
  case "$agent_dir" in
    "~") agent_dir="$HOME" ;;
    "~/"*) agent_dir="$HOME/${agent_dir#\~/}" ;;
  esac
else
  if [ -n "$pi_home_trimmed" ]; then
    pi_home="$PI_HOME"
  else
    pi_home="$HOME/.pi"
  fi
  agent_dir="$pi_home/agent"
fi
extensions_dir="$agent_dir/extensions"
target="$extensions_dir/genie"
stale_file="$extensions_dir/genie.ts"

mkdir -p "$extensions_dir"

# A stale standalone genie.ts (from a pre-plugin single-file install) would
# register the same tools twice next to the directory install — remove it,
# but only when it is ours (a symlink) or --force was given.
if [ -e "$stale_file" ] || [ -L "$stale_file" ]; then
  if [ -L "$stale_file" ]; then
    rm -f "$stale_file"
    echo "removed stale symlink: $stale_file"
  elif [ "$force" = "1" ]; then
    if grep -q 'Genie for pi' "$stale_file" 2>/dev/null; then
      rm -f "$stale_file"
      echo "removed stale standalone install (--force): $stale_file"
    else
      echo "refusing to remove $stale_file: does not look like the genie pi extension" >&2
      exit 1
    fi
  else
    echo "refusing to replace $stale_file: standalone genie.ts exists (use --force to remove it)" >&2
    exit 1
  fi
fi

if [ -e "$target" ] || [ -L "$target" ]; then
  if [ -L "$target" ] || [ -f "$target/package.json" ]; then
    rm -rf "$target"
  else
    echo "refusing to replace $target: exists but does not look like a genie pi plugin install" >&2
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

echo "run /reload inside pi (or start a new session) to load the extension."
