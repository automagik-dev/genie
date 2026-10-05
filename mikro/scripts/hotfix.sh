#!/usr/bin/env bash
set -euo pipefail

# hotfix.sh — Hotfix workflow automation with 30min timeout
# Usage:
#   ./scripts/hotfix.sh start  <gap-id>   # stash, branch, start timer
#   ./scripts/hotfix.sh test   <gap-id>   # re-run original mikro query
#   ./scripts/hotfix.sh finish <gap-id>   # test, merge, pop stash, update gap

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GAPS_FILE="${REPO_ROOT}/gaps.jsonl"
HOTFIX_STATE_DIR="${REPO_ROOT}/.hotfix"
TIMEOUT_MINUTES=30

# --- Helpers ---

die() { echo "ERROR: $*" >&2; exit 1; }

require_gaps_file() {
  [[ -f "$GAPS_FILE" ]] || die "gaps.jsonl not found at $GAPS_FILE"
}

get_gap_field() {
  local gap_id="$1" field="$2"
  python3 -c "
import json, sys
gap_id, field = sys.argv[1], sys.argv[2]
with open(sys.argv[3]) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        entry = json.loads(line)
        if entry.get('id') == gap_id:
            print(entry.get(field, ''))
            sys.exit(0)
print('')
sys.exit(1)
" "$gap_id" "$field" "$GAPS_FILE"
}

update_gap_status() {
  local gap_id="$1" new_status="$2"
  python3 -c "
import json, sys
gap_id, new_status, filepath = sys.argv[1], sys.argv[2], sys.argv[3]
lines = []
with open(filepath) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        entry = json.loads(line)
        if entry.get('id') == gap_id:
            entry['status'] = new_status
        lines.append(json.dumps(entry, ensure_ascii=False))
with open(filepath, 'w') as f:
    for l in lines:
        f.write(l + '\n')
" "$gap_id" "$new_status" "$GAPS_FILE"
}

check_timeout() {
  local gap_id="$1"
  local state_file="${HOTFIX_STATE_DIR}/${gap_id}.state"
  if [[ ! -f "$state_file" ]]; then
    return 0
  fi
  local start_ts
  start_ts="$(grep '^start_time=' "$state_file" | cut -d= -f2)"
  if [[ -z "$start_ts" ]]; then
    return 0
  fi
  local now_ts
  now_ts="$(date +%s)"
  local elapsed=$(( now_ts - start_ts ))
  local timeout_secs=$(( TIMEOUT_MINUTES * 60 ))
  if [[ $elapsed -ge $timeout_secs ]]; then
    return 1
  fi
  return 0
}

# --- Subcommands ---

cmd_start() {
  local gap_id="$1"
  require_gaps_file

  # Verify gap exists
  get_gap_field "$gap_id" "id" > /dev/null || die "Gap '$gap_id' not found in gaps.jsonl"

  local branch_name="hotfix/mikro-${gap_id}"

  # Check branch doesn't already exist
  if git -C "$REPO_ROOT" rev-parse --verify "$branch_name" &>/dev/null; then
    die "Branch '$branch_name' already exists. Use 'finish' or delete it first."
  fi

  # Save current branch
  mkdir -p "$HOTFIX_STATE_DIR"
  local state_file="${HOTFIX_STATE_DIR}/${gap_id}.state"
  local current_branch
  current_branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"

  # Stash current work (if any changes)
  local stash_ref=""
  if ! git -C "$REPO_ROOT" diff --quiet HEAD 2>/dev/null || \
     ! git -C "$REPO_ROOT" diff --cached --quiet HEAD 2>/dev/null; then
    stash_ref="$(git -C "$REPO_ROOT" stash create)"
    if [[ -n "$stash_ref" ]]; then
      git -C "$REPO_ROOT" stash store -m "hotfix-${gap_id}: auto-stash" "$stash_ref"
      echo "Stashed current work (ref: $stash_ref)"
    fi
  fi

  # Record state
  cat > "$state_file" <<STATEEOF
original_branch=${current_branch}
stash_ref=${stash_ref}
start_time=$(date +%s)
gap_id=${gap_id}
STATEEOF

  # Create and switch to hotfix branch
  git -C "$REPO_ROOT" checkout -b "$branch_name"
  echo "Created branch '$branch_name' from '${current_branch}'"
  echo "Timer started: ${TIMEOUT_MINUTES}min limit"
  echo "Hotfix started for gap '$gap_id'"
}

cmd_test() {
  local gap_id="$1"
  require_gaps_file

  # Check timeout
  if ! check_timeout "$gap_id"; then
    echo "WARNING: 30min timeout exceeded for gap '$gap_id'" >&2
    echo "Run 'finish' to handle timeout gracefully." >&2
  fi

  # Read original query from gaps.jsonl
  local query
  query="$(get_gap_field "$gap_id" "mikro_query")" || die "Gap '$gap_id' not found in gaps.jsonl"
  if [[ -z "$query" ]]; then
    die "No query found for gap '$gap_id'"
  fi

  echo "=== Re-running mikro query for gap '$gap_id' ==="
  echo "Original query: $query"
  echo "---"

  # Re-run via mikro
  if command -v mikro &>/dev/null; then
    mikro "$query" || echo "mikro exited with code $?"
  elif [[ -x "${REPO_ROOT}/dist/src/cli.js" ]]; then
    node "${REPO_ROOT}/dist/src/cli.js" "$query" || echo "mikro exited with code $?"
  else
    echo "WARNING: mikro CLI not found. Build with 'npm run build' first." >&2
    echo "Would run: mikro \"$query\"" >&2
  fi
}

cmd_finish() {
  local gap_id="$1"
  require_gaps_file

  local state_file="${HOTFIX_STATE_DIR}/${gap_id}.state"
  [[ -f "$state_file" ]] || die "No hotfix state found for '$gap_id'. Did you run 'start' first?"

  local original_branch stash_ref start_ts
  original_branch="$(grep '^original_branch=' "$state_file" | cut -d= -f2)"
  stash_ref="$(grep '^stash_ref=' "$state_file" | cut -d= -f2)"
  start_ts="$(grep '^start_time=' "$state_file" | cut -d= -f2)"

  local branch_name="hotfix/mikro-${gap_id}"

  # Check timeout -- if exceeded, defer
  if ! check_timeout "$gap_id"; then
    echo "TIMEOUT: 30min exceeded for gap '$gap_id'. Marking as DEFERRED." >&2
    update_gap_status "$gap_id" "deferred"

    # Abort hotfix: switch back, pop stash
    git -C "$REPO_ROOT" checkout "$original_branch" 2>/dev/null || true
    if [[ -n "$stash_ref" ]]; then
      git -C "$REPO_ROOT" stash pop || git -C "$REPO_ROOT" stash pop --index 2>/dev/null || true
    fi
    # Clean up hotfix branch
    git -C "$REPO_ROOT" branch -D "$branch_name" 2>/dev/null || true
    rm -f "$state_file"
    echo "Hotfix aborted. Returned to '$original_branch'. Gap status: deferred"
    exit 0
  fi

  # Verify we're on the hotfix branch
  local current
  current="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
  if [[ "$current" != "$branch_name" ]]; then
    die "Expected to be on branch '$branch_name' but on '$current'. Switch manually or start over."
  fi

  # Run tests
  echo "Running npm test..."
  if ! (cd "$REPO_ROOT" && npm test); then
    echo "ERROR: Tests failed. Fix the issues before finishing the hotfix." >&2
    echo "Hotfix branch '$branch_name' preserved for further work." >&2
    exit 1
  fi
  echo "Tests passed."

  # Merge hotfix back (--no-ff)
  echo "Merging '$branch_name' into '$original_branch'..."
  git -C "$REPO_ROOT" checkout "$original_branch"
  git -C "$REPO_ROOT" merge --no-ff "$branch_name" -m "fix: hotfix for gap $gap_id"

  # Pop stash if we had one
  if [[ -n "$stash_ref" ]]; then
    echo "Restoring stashed work..."
    if ! git -C "$REPO_ROOT" stash pop; then
      echo "Stash pop had conflicts, trying --3way merge fallback..."
      # Try applying with 3-way merge
      git -C "$REPO_ROOT" checkout --theirs . 2>/dev/null || true
      if ! git -C "$REPO_ROOT" stash drop 2>/dev/null; then
        echo "WARNING: Could not cleanly restore stash. Manual resolution may be needed." >&2
      fi
    fi
  fi

  # Update gap status to fixed
  update_gap_status "$gap_id" "fixed"

  # Clean up hotfix branch and state
  git -C "$REPO_ROOT" branch -d "$branch_name" 2>/dev/null || true
  rm -f "$state_file"

  echo "Hotfix complete for gap '$gap_id'. Status updated to 'fixed'."
}

# --- Main ---

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 {start|test|finish} <gap-id>" >&2
  exit 1
fi

SUBCOMMAND="$1"
GAP_ID="$2"

case "$SUBCOMMAND" in
  start)  cmd_start "$GAP_ID" ;;
  test)   cmd_test "$GAP_ID" ;;
  finish) cmd_finish "$GAP_ID" ;;
  *)
    echo "ERROR: Unknown subcommand '$SUBCOMMAND'. Use: start, test, finish" >&2
    exit 1
    ;;
esac
