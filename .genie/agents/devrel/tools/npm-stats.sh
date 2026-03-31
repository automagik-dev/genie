#!/bin/bash
# Fetch npm download stats for @automagik/genie
# Usage: ./npm-stats.sh [period]
#   period: last-day, last-week, last-month (default: last-month)

set -euo pipefail

PERIOD="${1:-last-month}"
PKG="@automagik/genie"

echo "=== npm downloads: $PKG ($PERIOD) ==="

curl -s "https://api.npmjs.org/downloads/range/$PERIOD/$PKG" | python3 -c "
import json,sys
data=json.load(sys.stdin)
downloads=data.get('downloads',[])
total=sum(d['downloads'] for d in downloads)
if downloads:
    peak=max(downloads, key=lambda d: d['downloads'])
    last7=sum(d['downloads'] for d in downloads[-7:])
    print(f'Period: {data[\"start\"]} to {data[\"end\"]}')
    print(f'Total: {total:,}')
    print(f'Peak: {peak[\"day\"]} ({peak[\"downloads\"]:,})')
    print(f'Daily avg: {total//max(len(downloads),1):,}')
    print(f'Last 7 days: {last7:,}')
    print()
    print('Daily breakdown:')
    for d in downloads[-14:]:
        bar = '█' * (d['downloads'] // 50)
        print(f'  {d[\"day\"]}: {d[\"downloads\"]:>5,} {bar}')
else:
    print('No data')
"
