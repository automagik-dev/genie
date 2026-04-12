#!/usr/bin/env bash
# backfill.sh — Run collect-stats.sh for the last 30 days, write daily-stats.jsonl.
#
# Usage:
#   backfill.sh [--days N]   Backfill N days (default: 30)
#
# Output: daily-stats.jsonl in the metrics-updater agent directory.
#
# daily-stats.jsonl schema (one JSON object per line):
# {
#   "date": "YYYY-MM-DD",        // Calendar date
#   "commits": <int>,            // Commit count across all branches
#   "loc_added": <int>,          // Lines of code added
#   "loc_removed": <int>,        // Lines of code removed
#   "releases": <int>,           // Release tags (v4.YYMMDD.*) for this date
#   "contributors": [<string>]   // Unique author names for this date
# }

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

DAYS=30
while [[ $# -gt 0 ]]; do
  case "$1" in
    --days)
      DAYS="$2"
      shift 2
      ;;
    *)
      echo "Usage: $0 [--days N]" >&2
      exit 1
      ;;
  esac
done

AGENT_DIR=".genie/agents/metrics-updater"
TOOLS_DIR="$AGENT_DIR/tools"
OUTPUT="$AGENT_DIR/daily-stats.jsonl"

# Clear existing file
> "$OUTPUT"

echo "Backfilling $DAYS days of stats..." >&2

for i in $(seq "$DAYS" -1 0); do
  target_date=$(date -d "today - ${i} days" +%Y-%m-%d 2>/dev/null || date -v-${i}d +%Y-%m-%d 2>/dev/null)
  result=$(bash "$TOOLS_DIR/collect-stats.sh" --date "$target_date")
  echo "$result" >> "$OUTPUT"
  echo "  $target_date: done" >&2
done

lines=$(wc -l < "$OUTPUT")
echo "Backfill complete: $lines entries in $OUTPUT" >&2
