#!/usr/bin/env bash
set -euo pipefail

#
# Install genie-cli globally via npm/bun
# This script is included with the automagik-genie plugin
#

usage() {
  cat <<'EOF'
Usage:
  install-genie-cli.sh [--global | --local]

Installs genie-cli, the companion CLI for the automagik-genie plugin.

Options:
  --global    Install globally to ~/.local/bin (default)
  --local     Install to current directory's node_modules

The global install creates a symlink at ~/.local/bin/genie
that points to the installed genie-cli binary.
EOF
}

INSTALL_MODE="global"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --global)
      INSTALL_MODE="global"; shift ;;
    --local)
      INSTALL_MODE="local"; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      exit 2
      ;;
  esac
done

# Determine plugin root (relative to this script)
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GENIE_CLI_ROOT="$(cd "$PLUGIN_ROOT/.." && pwd)"

echo "Installing genie-cli from: $GENIE_CLI_ROOT"

# Check for package manager
if command -v bun &>/dev/null; then
  PKG_MGR="bun"
elif command -v npm &>/dev/null; then
  PKG_MGR="npm"
else
  echo "Error: Neither bun nor npm found. Install one first." >&2
  exit 1
fi

echo "Using package manager: $PKG_MGR"

if [[ "$INSTALL_MODE" == "global" ]]; then
  # Global install approach: link from ~/.local/bin
  mkdir -p ~/.local/bin

  # Install dependencies in genie-cli directory
  echo "Installing dependencies..."
  cd "$GENIE_CLI_ROOT"
  $PKG_MGR install

  # Create symlink
  GENIE_BIN="$GENIE_CLI_ROOT/src/cli.ts"
  if [[ -f "$GENIE_BIN" ]]; then
    # For bun, we can use the TypeScript directly
    if [[ "$PKG_MGR" == "bun" ]]; then
      # Create a wrapper script
      cat > ~/.local/bin/genie <<EOF
#!/usr/bin/env bash
exec bun "$GENIE_BIN" "\$@"
EOF
      chmod +x ~/.local/bin/genie
      echo "Created wrapper at ~/.local/bin/genie"
    else
      # For npm, need to build first
      echo "Building genie-cli..."
      $PKG_MGR run build 2>/dev/null || true
      if [[ -f "$GENIE_CLI_ROOT/dist/cli.js" ]]; then
        ln -sf "$GENIE_CLI_ROOT/dist/cli.js" ~/.local/bin/genie
        chmod +x ~/.local/bin/genie
        echo "Linked to ~/.local/bin/genie"
      else
        echo "Warning: Build failed, using TypeScript source with bun" >&2
        cat > ~/.local/bin/genie <<EOF
#!/usr/bin/env bash
exec bun "$GENIE_BIN" "\$@"
EOF
        chmod +x ~/.local/bin/genie
      fi
    fi
  else
    echo "Error: genie-cli binary not found at $GENIE_BIN" >&2
    exit 1
  fi

  echo ""
  echo "genie-cli installed successfully!"
  echo ""
  echo "Make sure ~/.local/bin is in your PATH:"
  echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
  echo ""
  echo "Then run: genie --help"

else
  # Local install
  echo "Installing genie-cli locally..."
  cd "$GENIE_CLI_ROOT"
  $PKG_MGR install
  echo ""
  echo "genie-cli installed locally."
  echo "Run with: $PKG_MGR run genie --help"
fi
