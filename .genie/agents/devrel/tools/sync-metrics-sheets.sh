#!/bin/bash
# Sync daily metrics to Google Sheets — run after metrics-snapshot.sh
# Usage: ./sync-metrics-sheets.sh
#
# Reads the latest row from brain/Intelligence/metrics.csv
# and appends it to the Viralizador Google Sheet

set -euo pipefail

SHEET_ID="1UAHi6HVqF7EV6uFR_1_1alIXTQDQmrystx7SWYqiwQI"
ACCOUNT="felipe@namastex.ai"
METRICS_FILE="/home/genie/agents/namastexlabs/genie/brain/Intelligence/metrics.csv"

if [ ! -f "$METRICS_FILE" ]; then
  echo "No metrics file found. Run metrics-snapshot.sh first."
  exit 1
fi

# Get the latest row
LATEST=$(tail -1 "$METRICS_FILE")
DATE=$(echo "$LATEST" | cut -d',' -f1)

echo "Syncing $DATE metrics to Google Sheets..."

# Convert CSV row to JSON 2D array for proper column placement
JSON_ROW=$(echo "$LATEST" | python3 -c "
import sys,json
row = sys.stdin.read().strip().split(',')
# First value is date (string), rest are numbers
out = [row[0]] + [int(x) if x.isdigit() else x for x in row[1:]]
print(json.dumps([out]))
")

wk sheets append "$SHEET_ID" "A:K" \
  --values-json "$JSON_ROW" \
  -a "$ACCOUNT" 2>&1

echo "Synced to: https://docs.google.com/spreadsheets/d/$SHEET_ID"
