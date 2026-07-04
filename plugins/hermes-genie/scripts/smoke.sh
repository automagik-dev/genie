#!/usr/bin/env bash
# Smoke-test the installed Genie Hermes plugin.
set -euo pipefail

# Authoritative check: the plugin is visible to Hermes.
hermes plugins list | grep -i genie

# Best-effort probe: chat visibility of plugin slash commands may vary by
# Hermes build (some builds do not expose plugin commands through
# non-interactive chat), so this probe never fails the smoke.
hermes chat -q '/genie help' || true
