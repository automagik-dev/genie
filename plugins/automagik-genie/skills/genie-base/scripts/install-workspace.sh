#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  install-workspace.sh --dest <workspace-path> [--force]

Copies the Genie base workspace template from this skill into the destination.

- If a file already exists and --force is not set, it will be left untouched.
- If --force is set, existing files will be backed up then overwritten.

EOF
}

DEST=""
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest)
      DEST="$2"; shift 2 ;;
    --force)
      FORCE=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$DEST" ]]; then
  echo "--dest is required" >&2
  usage
  exit 2
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/assets/workspace"

if [[ ! -d "$SRC_DIR" ]]; then
  echo "Missing template dir: $SRC_DIR" >&2
  exit 1
fi

mkdir -p "$DEST"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$DEST/.genie-base-backup/$TS"

backup_and_copy() {
  local rel="$1"
  local src="$SRC_DIR/$rel"
  local dst="$DEST/$rel"

  if [[ -d "$src" ]]; then
    # directory copy
    if [[ -e "$dst" && $FORCE -eq 0 ]]; then
      return 0
    fi
    if [[ -e "$dst" && $FORCE -eq 1 ]]; then
      mkdir -p "$BACKUP_DIR/$(dirname "$rel")"
      mv "$dst" "$BACKUP_DIR/$rel"
    fi
    mkdir -p "$(dirname "$dst")"
    cp -a "$src" "$dst"
    return 0
  fi

  # file copy
  if [[ -e "$dst" && $FORCE -eq 0 ]]; then
    return 0
  fi
  if [[ -e "$dst" && $FORCE -eq 1 ]]; then
    mkdir -p "$BACKUP_DIR/$(dirname "$rel")"
    cp -a "$dst" "$BACKUP_DIR/$rel"
  fi
  mkdir -p "$(dirname "$dst")"
  cp -a "$src" "$dst"
}

# Core workspace files
FILES=(
  "AGENTS.md"
  "SOUL.md"
  "USER.md"
  "TOOLS.md"
  "MEMORY.md"
  "HEARTBEAT.md"
  "IDENTITY.md"
  "ROLE.md"
  "ENVIRONMENT.md"
  "memory"
)

for f in "${FILES[@]}"; do
  backup_and_copy "$f"
done

if [[ -d "$BACKUP_DIR" ]]; then
  echo "Backup (if any overwrites): $BACKUP_DIR"
fi

echo "Installed Genie base workspace template into: $DEST"
