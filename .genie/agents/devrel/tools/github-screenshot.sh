#!/bin/bash
# Screenshot GitHub contribution graph using agent-browser
# Usage: ./github-screenshot.sh [username] [output-file]
#
# NOTE: This uses the agent-browser skill. If not available,
# falls back to generating a text-based heatmap from API data.

set -euo pipefail

USERNAME="${1:-namastex888}"
OUTPUT="${2:-/home/genie/agents/namastexlabs/genie/brain/DevRel/assets/github-graph-$(date +%Y-%m-%d).png}"

mkdir -p "$(dirname "$OUTPUT")"

echo "To capture the GitHub contribution graph:"
echo ""
echo "Option A (agent-browser):"
echo "  Use /agent-browser to navigate to https://github.com/$USERNAME"
echo "  Screenshot the contribution graph section"
echo "  Save to: $OUTPUT"
echo ""
echo "Option B (manual):"
echo "  Open https://github.com/$USERNAME in browser"
echo "  Screenshot the green contribution heatmap"
echo "  Save to: $OUTPUT"
echo ""
echo "Option C (API text visualization):"

# Generate text-based heatmap from API
gh api graphql -f query='{
  user(login: "'$USERNAME'") {
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays {
            contributionCount
            date
          }
        }
      }
    }
  }
}' 2>/dev/null | python3 -c "
import json,sys
data=json.load(sys.stdin)
cal=data['data']['user']['contributionsCollection']['contributionCalendar']
print(f'Total: {cal[\"totalContributions\"]:,} contributions')
print()
levels=' ░▒▓█'
for week in cal['weeks'][-26:]:
    row=''
    for day in week['contributionDays']:
        c=day['contributionCount']
        if c==0: row+=levels[0]
        elif c<10: row+=levels[1]
        elif c<50: row+=levels[2]
        elif c<100: row+=levels[3]
        else: row+=levels[4]
    print(row)
"
