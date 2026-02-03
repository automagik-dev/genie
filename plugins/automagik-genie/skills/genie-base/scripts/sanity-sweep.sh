#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  sanity-sweep.sh --dest <workspace-path>

Greps for common stale paths / conventions that should not persist after migration.
Exits 0 always, but prints matches for manual cleanup.
EOF
}

DEST=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest)
      DEST="$2"; shift 2 ;;
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

PATTERNS=(
  "/home/genie/.genie/workspace"
  "/home/genie/.genie/chief-of-khal/khal"
  "/Users/"
)

echo "Sanity sweep in: $DEST"

for p in "${PATTERNS[@]}"; do
  echo
  echo "=== Searching for: $p"
  grep -RIn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=.next --exclude-dir=.cache -F "$p" "$DEST" || true
  
  # Also check for broken symlinks under .claude/plugins (common migration pitfall)
  if [[ -d "$DEST/khal/.claude/plugins" ]]; then
    echo
    echo "--- Symlink check: $DEST/khal/.claude/plugins"
    find "$DEST/khal/.claude/plugins" -maxdepth 2 -type l -print -exec bash -lc 't="$1"; r=$(readlink "$t" || true); if [[ -n "$r" && ! -e "$t" ]]; then echo "BROKEN: $t -> $r"; fi' bash {} \; || true
  fi

done

echo
echo "Done. If any matches printed above, update them to canonical paths:"
echo "- /home/genie/workspace"
echo "- /home/genie/workspace/khal"
