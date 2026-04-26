#!/usr/bin/env bash
# Regenerate scripts/tmux/.generated.theme.conf from packages/genie-tokens.
#
# Usage:   bash scripts/tmux/generate-theme.sh
# CI lint: bash scripts/tmux/generate-theme.sh && git diff --exit-code scripts/tmux/.generated.theme.conf
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is required to regenerate the tmux theme (https://bun.sh)" >&2
  exit 1
fi

cd "$repo_root"
bun run "$here/generate-theme.ts"
