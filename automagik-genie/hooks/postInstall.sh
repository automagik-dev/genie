#!/bin/bash
# Post-install hook for automagik-genie
# Runs smart-install.js to set up dependencies and CLI symlinks

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"

# Run smart-install.js with CLAUDE_PLUGIN_ROOT set
export CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT"
node "$PLUGIN_ROOT/scripts/smart-install.js"
