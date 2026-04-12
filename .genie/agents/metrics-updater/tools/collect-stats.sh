#!/usr/bin/env bash
# collect-stats.sh — Extract daily metrics from git history across all branches.
#
# Usage:
#   collect-stats.sh --date YYYY-MM-DD   Output JSON for a single day
#   collect-stats.sh --cumulative         Output all-time cumulative JSON
#
# Output schema (daily):
# {
#   "date": "YYYY-MM-DD",
#   "commits": <int>,
#   "loc_added": <int>,
#   "loc_removed": <int>,
#   "releases": <int>,
#   "contributors": ["name1", "name2", ...]
# }
#
# Output schema (cumulative):
# {
#   "total_commits": <int>,
#   "total_tags": <int>,
#   "first_commit_date": "YYYY-MM-DD",
#   "total_contributors": <int>
# }

set -euo pipefail

# Navigate to repo root
cd "$(git rev-parse --show-toplevel)"

MODE=""
TARGET_DATE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --date)
      MODE="daily"
      TARGET_DATE="$2"
      shift 2
      ;;
    --cumulative)
      MODE="cumulative"
      shift
      ;;
    *)
      echo "Usage: $0 --date YYYY-MM-DD | --cumulative" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$MODE" ]]; then
  echo "Usage: $0 --date YYYY-MM-DD | --cumulative" >&2
  exit 1
fi

if [[ "$MODE" == "cumulative" ]]; then
  total_commits=$(git log --all --oneline | wc -l)
  total_tags=$(git tag -l "v4.*" | wc -l)
  first_commit_date=$(git log --all --reverse --format='%aI' -- | head -1 | cut -d'T' -f1 || true)
  total_contributors=$(git log --all --format='%aN' | sort -u | wc -l)

  printf '{"total_commits":%d,"total_tags":%d,"first_commit_date":"%s","total_contributors":%d}\n' \
    "$total_commits" "$total_tags" "$first_commit_date" "$total_contributors"
  exit 0
fi

# Daily mode
AFTER="${TARGET_DATE} 00:00:00"
BEFORE="${TARGET_DATE} 23:59:59"

# Commits count (all branches, deduplicated)
commits=$(git log --all --after="$AFTER" --before="$BEFORE" --oneline | wc -l)

# LoC added/removed via shortstat
loc_stats=$(git log --all --after="$AFTER" --before="$BEFORE" --shortstat --format="" | \
  awk '
    /insertion/ {
      for (i=1; i<=NF; i++) {
        if ($(i+1) ~ /insertion/) added += $i
        if ($(i+1) ~ /deletion/) removed += $i
      }
    }
    END { printf "%d %d", added+0, removed+0 }
  ')
loc_added=$(echo "$loc_stats" | awk '{print $1}')
loc_removed=$(echo "$loc_stats" | awk '{print $2}')

# Release count: tags matching v4.YYMMDD.* for this date
# Convert YYYY-MM-DD to YYMMDD for tag pattern
tag_date=$(date -d "$TARGET_DATE" +%y%m%d 2>/dev/null || date -j -f "%Y-%m-%d" "$TARGET_DATE" +%y%m%d 2>/dev/null)
releases=$(git tag -l "v4.${tag_date}.*" | wc -l)

# Contributors (unique author names)
contributors_json=$(git log --all --after="$AFTER" --before="$BEFORE" --format='%aN' | sort -u | \
  awk 'BEGIN { printf "[" }
       NR>1 { printf "," }
       { gsub(/"/, "\\\""); printf "\"%s\"", $0 }
       END { printf "]" }')

# Handle empty contributors
if [[ "$contributors_json" == "[]" ]] || [[ -z "$contributors_json" ]]; then
  contributors_json="[]"
fi

printf '{"date":"%s","commits":%d,"loc_added":%d,"loc_removed":%d,"releases":%d,"contributors":%s}\n' \
  "$TARGET_DATE" "$commits" "$loc_added" "$loc_removed" "$releases" "$contributors_json"
