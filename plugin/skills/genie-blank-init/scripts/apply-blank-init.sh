#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  apply-blank-init.sh --dest <workspace-path> [--force]

Applies a "blank first-activation" overlay to an existing workspace:
- Adds BOOTSTRAP.md (one-time onboarding; to be deleted after verification)
- Resets MEMORY.md and memory/ daily notes (fresh)
- Writes a neutral, user-centric ROLE.md
- Leaves ENVIRONMENT.md and TOOLS.md untouched (keeps OS competence)

If --force is not set, existing persona files are left as-is.
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

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p "$DEST"

copy_if_needed() {
  local src="$1"
  local dst="$2"

  if [[ -e "$dst" && $FORCE -eq 0 ]]; then
    return 0
  fi

  if [[ -e "$dst" && $FORCE -eq 1 ]]; then
    local ts
    ts="$(date -u +%Y%m%dT%H%M%SZ)"
    mkdir -p "$DEST/.genie-blank-init-backup/$ts"
    cp -a "$dst" "$DEST/.genie-blank-init-backup/$ts/$(basename "$dst")"
  fi

  cp -a "$src" "$dst"
}

# 1) BOOTSTRAP trigger
copy_if_needed "$BASE_DIR/assets/BOOTSTRAP.md" "$DEST/BOOTSTRAP.md"

# 1b) Blank persona stubs (keep OS competence elsewhere)
copy_if_needed "$BASE_DIR/assets/SOUL.md" "$DEST/SOUL.md"
copy_if_needed "$BASE_DIR/assets/IDENTITY.md" "$DEST/IDENTITY.md"
copy_if_needed "$BASE_DIR/assets/USER.md" "$DEST/USER.md"

# 2) Neutral user-centric ROLE
ROLE_TMP="$DEST/ROLE.md"
if [[ ! -e "$ROLE_TMP" || $FORCE -eq 1 ]]; then
  cat > "$ROLE_TMP" <<'EOF'
# ROLE.md

## Current role
User-centric Genie (blank first activation)

## Mission
- Help the user with whatever they need.
- Ask clarifying questions; do not assume project context.
- Do not take on the Khal mission unless explicitly asked.

## Notes
- This workspace is intentionally "fresh". BOOTSTRAP.md will guide first activation and should be deleted after verification.
EOF
fi

# 3) Reset long-term memory file
MEM="$DEST/MEMORY.md"
if [[ ! -e "$MEM" || $FORCE -eq 1 ]]; then
  cat > "$MEM" <<'EOF'
# MEMORY.md

(Blank — first activation. Add only enduring preferences/decisions.)
EOF
fi

# 4) Reset daily notes directory
mkdir -p "$DEST/memory"
if [[ $FORCE -eq 1 ]]; then
  # keep backups, but empty the folder contents
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$DEST/.genie-blank-init-backup/$ts/memory"
  shopt -s nullglob
  for f in "$DEST/memory"/*; do
    cp -a "$f" "$DEST/.genie-blank-init-backup/$ts/memory/" || true
    rm -f "$f" || true
  done
fi

echo "Applied blank-init overlay to: $DEST"
echo "Next: start the agent in that workspace; it should follow BOOTSTRAP.md then delete it once verified."
