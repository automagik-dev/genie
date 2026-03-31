#!/bin/bash
# Capture daily metrics snapshot — append one row to metrics CSV
# Usage: ./metrics-snapshot.sh
# Output: brain/Intelligence/metrics.csv

set -euo pipefail

METRICS_FILE="/home/genie/agents/namastexlabs/genie/brain/Intelligence/metrics.csv"
DATE=$(date +%Y-%m-%d)

# Create header if file doesn't exist
if [ ! -f "$METRICS_FILE" ]; then
  echo "date,genie_stars,genie_forks,forge_stars,omni_stars,total_stars,npm_downloads_30d,npm_downloads_today,open_issues,merged_prs_7d,releases_total" > "$METRICS_FILE"
fi

# Skip if today already recorded
if grep -q "^$DATE," "$METRICS_FILE" 2>/dev/null; then
  echo "Already recorded for $DATE"
  cat "$METRICS_FILE" | tail -1
  exit 0
fi

echo "Collecting metrics for $DATE..."

# GitHub stats
GENIE=$(gh api repos/automagik-dev/genie -q '{s: .stargazers_count, f: .forks_count, i: .open_issues_count}' 2>/dev/null)
GENIE_STARS=$(echo "$GENIE" | python3 -c "import json,sys; print(json.load(sys.stdin)['s'])")
GENIE_FORKS=$(echo "$GENIE" | python3 -c "import json,sys; print(json.load(sys.stdin)['f'])")
OPEN_ISSUES=$(echo "$GENIE" | python3 -c "import json,sys; print(json.load(sys.stdin)['i'])")
FORGE_STARS=$(gh api repos/automagik-dev/forge -q '.stargazers_count' 2>/dev/null || echo 0)
OMNI_STARS=$(gh api repos/automagik-dev/omni -q '.stargazers_count' 2>/dev/null || echo 0)
TOTAL_STARS=$((GENIE_STARS + FORGE_STARS + OMNI_STARS))

# npm stats
NPM_30D=$(curl -s "https://api.npmjs.org/downloads/point/last-month/@automagik/genie" | python3 -c "import json,sys; print(json.load(sys.stdin).get('downloads',0))" 2>/dev/null || echo 0)
NPM_TODAY=$(curl -s "https://api.npmjs.org/downloads/point/last-day/@automagik/genie" | python3 -c "import json,sys; print(json.load(sys.stdin).get('downloads',0))" 2>/dev/null || echo 0)

# PR stats (last 7 days)
MERGED_7D=$(gh pr list --repo automagik-dev/genie --state merged --json mergedAt --limit 200 2>/dev/null | python3 -c "
import json,sys
from datetime import datetime,timedelta
data=json.load(sys.stdin)
cutoff=datetime.now()-timedelta(days=7)
print(sum(1 for pr in data if datetime.fromisoformat(pr['mergedAt'].replace('Z','+00:00')).replace(tzinfo=None)>cutoff))
" 2>/dev/null || echo 0)

# Release count
RELEASES=$(gh release list --repo automagik-dev/genie --limit 1000 2>/dev/null | wc -l || echo 0)

# Append row
echo "$DATE,$GENIE_STARS,$GENIE_FORKS,$FORGE_STARS,$OMNI_STARS,$TOTAL_STARS,$NPM_30D,$NPM_TODAY,$OPEN_ISSUES,$MERGED_7D,$RELEASES" >> "$METRICS_FILE"

echo "Recorded:"
echo "  Stars: genie=$GENIE_STARS forge=$FORGE_STARS omni=$OMNI_STARS (total=$TOTAL_STARS)"
echo "  npm: 30d=$NPM_30D today=$NPM_TODAY"
echo "  PRs merged (7d): $MERGED_7D"
echo "  Releases: $RELEASES"
echo "  Open issues: $OPEN_ISSUES"
