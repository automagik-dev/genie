#!/usr/bin/env bash
# install-notesmd.sh — Idempotent notesmd-cli installer + brain vault provisioner
# Usage: bash install-notesmd.sh [--vault <path>] [--name <vault-name>] [--help]
set -euo pipefail

VAULT_PATH="${VAULT_PATH:-./brain}"
VAULT_NAME="${VAULT_NAME:-brain}"
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OBSIDIAN_CONFIG="$HOME/.config/obsidian/obsidian.json"

print_help() {
  cat <<EOF
install-notesmd.sh — notesmd-cli installer + brain vault setup

Usage:
  bash install-notesmd.sh [options]

Options:
  --vault <path>   Absolute or relative path for the brain vault (default: ./brain)
  --name <name>    Vault name to register (default: brain)
  --help           Show this help

Environment:
  VAULT_PATH       Alternative to --vault flag
  VAULT_NAME       Alternative to --name flag

What it does:
  1. Checks if notesmd-cli is installed; installs via Homebrew if not
  2. Registers vault in Obsidian config (~/.config/obsidian/obsidian.json)
  3. Sets the default vault via notesmd-cli preferences
  4. Creates standard vault folder structure
  5. Copies seed templates from the brain skill
EOF
}

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --vault) VAULT_PATH="$2"; shift 2 ;;
    --name)  VAULT_NAME="$2"; shift 2 ;;
    --help|-h) print_help; exit 0 ;;
    *) echo "Unknown argument: $1"; print_help; exit 1 ;;
  esac
done

# Resolve absolute path
VAULT_ABS="$(realpath -m "$VAULT_PATH" 2>/dev/null || readlink -f "$VAULT_PATH" 2>/dev/null || echo "$(pwd)/$VAULT_PATH")"

echo "🧠 Brain Setup — notesmd-cli installer"
echo "======================================="
echo "  Vault name: $VAULT_NAME"
echo "  Vault path: $VAULT_ABS"
echo ""

# ── Step 1: Check / install notesmd-cli ──────────────────────────────────────
if command -v notesmd-cli &>/dev/null; then
  VERSION=$(notesmd-cli --version 2>/dev/null || echo "unknown")
  echo "✅ notesmd-cli already installed: $VERSION"
else
  echo "📦 notesmd-cli not found. Installing..."

  if ! command -v brew &>/dev/null; then
    echo ""
    echo "❌ Homebrew not found. Cannot auto-install notesmd-cli."
    echo ""
    echo "Manual install options:"
    echo "  1. Install Homebrew: https://brew.sh"
    echo "     Then re-run this script."
    echo ""
    echo "  2. Download binary directly:"
    echo "     https://github.com/Yakitrak/notesmd-cli/releases"
    echo "     Place in /usr/local/bin/notesmd-cli and chmod +x"
    echo ""
    exit 1
  fi

  brew install yakitrak/yakitrak/notesmd-cli
  echo "✅ notesmd-cli installed: $(notesmd-cli --version)"
fi

# ── Step 2: Register vault in Obsidian config ─────────────────────────────────
echo ""
echo "📁 Registering vault in Obsidian config..."
mkdir -p "$(dirname "$OBSIDIAN_CONFIG")"

# Generate a timestamp for the vault entry
TS=$(date +%s)000

# Create or update obsidian.json using python3 (portable JSON manipulation)
python3 - <<PYEOF
import json, os, sys

config_path = "$OBSIDIAN_CONFIG"
vault_name = "$VAULT_NAME"
vault_path = "$VAULT_ABS"
ts = $TS

# Load existing config or start fresh
if os.path.exists(config_path):
    with open(config_path) as f:
        config = json.load(f)
else:
    config = {}

if "vaults" not in config:
    config["vaults"] = {}

# Check if vault already registered at this path
for k, v in config["vaults"].items():
    if v.get("path") == vault_path:
        print(f"  Vault already registered as '{k}' at {vault_path}")
        sys.exit(0)

# Register vault under the given name (handle name conflicts)
name = vault_name
suffix = 1
while name in config["vaults"]:
    name = f"{vault_name}-{suffix}"
    suffix += 1

config["vaults"][name] = {"path": vault_path, "ts": ts, "open": True}

with open(config_path, "w") as f:
    json.dump(config, f, indent=2)

print(f"  Registered vault '{name}' -> {vault_path}")
PYEOF

echo "✅ Vault registered"

# ── Step 3: Set notesmd-cli default ──────────────────────────────────────────
echo ""
echo "⚙️  Setting notesmd-cli default vault..."
PREFS_FILE="$HOME/.config/notesmd-cli/preferences.json"
mkdir -p "$(dirname "$PREFS_FILE")"
python3 - <<PYEOF
import json, os

prefs_path = "$PREFS_FILE"
vault_name = "$VAULT_NAME"

if os.path.exists(prefs_path):
    with open(prefs_path) as f:
        prefs = json.load(f)
else:
    prefs = {}

prefs["default_vault_name"] = vault_name
if "default_open_type" not in prefs:
    prefs["default_open_type"] = "editor"

with open(prefs_path, "w") as f:
    json.dump(prefs, f, indent=2)

print(f"  Default vault set to: {vault_name}")
PYEOF
echo "✅ Default vault configured"

# ── Step 4: Create vault folder structure ─────────────────────────────────────
echo ""
echo "📂 Creating vault structure in $VAULT_ABS..."
mkdir -p "$VAULT_ABS/_Templates"
mkdir -p "$VAULT_ABS/Company"
mkdir -p "$VAULT_ABS/Daily"
mkdir -p "$VAULT_ABS/Domains"
mkdir -p "$VAULT_ABS/Intelligence"
mkdir -p "$VAULT_ABS/Playbooks"
echo "✅ Folders created:"
ls "$VAULT_ABS"

# ── Step 5: Copy seed templates ───────────────────────────────────────────────
TEMPLATES_SRC="$SKILL_DIR/templates"
if [[ -d "$TEMPLATES_SRC" ]] && ls "$TEMPLATES_SRC"/*.md &>/dev/null; then
  echo ""
  echo "📄 Copying seed templates..."
  cp "$TEMPLATES_SRC"/*.md "$VAULT_ABS/_Templates/"
  echo "✅ Templates copied:"
  ls "$VAULT_ABS/_Templates/"
else
  echo "⚠️  No templates found at $TEMPLATES_SRC (skipping)"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "🎉 Brain setup complete!"
echo ""
echo "Verify:"
echo "  notesmd-cli print-default"
echo "  notesmd-cli list"
echo ""
echo "Next steps:"
echo "  1. Copy the CLAUDE.md template block from brain SKILL.md into your agent's CLAUDE.md"
echo "  2. Add the AGENTS.md protocol snippet to your agent's startup section"
echo "  3. (Optional) Set up brain → GitHub sync: see SKILL.md inotifywait pattern"
