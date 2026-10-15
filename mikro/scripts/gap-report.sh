#!/usr/bin/env bash
set -euo pipefail

# gap-report.sh — Generate gap summary from gaps.jsonl
# Usage: ./scripts/gap-report.sh

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GAPS_FILE="${REPO_ROOT}/gaps.jsonl"

if [[ ! -f "$GAPS_FILE" ]]; then
  echo "No gaps.jsonl found at $GAPS_FILE"
  exit 0
fi

# Count total lines (non-empty)
TOTAL=$(python3 -c "
import sys
count = 0
with open(sys.argv[1]) as f:
    for line in f:
        if line.strip():
            count += 1
print(count)
" "$GAPS_FILE")

if [[ "$TOTAL" -eq 0 ]]; then
  echo "=== Gap Report ==="
  echo "No gaps recorded yet."
  exit 0
fi

python3 -c "
import json, sys
from collections import Counter

filepath = sys.argv[1]

entries = []
with open(filepath) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        entries.append(json.loads(line))

total = len(entries)
if total == 0:
    print('=== Gap Report ===')
    print('No gaps recorded yet.')
    sys.exit(0)

# Count by status
status_counts = Counter(e.get('status', 'unknown') for e in entries)

# Count by type
type_counts = Counter(e.get('gap_type', 'unknown') for e in entries)

# Count by severity
severity_counts = Counter(e.get('severity', 'unknown') for e in entries)

# Fix rate
fixed = status_counts.get('fixed', 0)
fix_rate = (fixed / total * 100) if total > 0 else 0

print('=== Gap Report ===')
print()
print(f'Total gaps: {total}')
print(f'Fix rate:   {fix_rate:.1f}% ({fixed}/{total})')
print()

print('--- By Status ---')
for status in ['open', 'fixed', 'deferred']:
    count = status_counts.get(status, 0)
    if count > 0:
        print(f'  {status:<12} {count}')
# Print any other statuses
for status, count in sorted(status_counts.items()):
    if status not in ('open', 'fixed', 'deferred'):
        print(f'  {status:<12} {count}')
print()

print('--- By Type ---')
for gap_type in ['precision', 'recall', 'speed', 'hallucination', 'scope', 'format']:
    count = type_counts.get(gap_type, 0)
    if count > 0:
        print(f'  {gap_type:<16} {count}')
print()

print('--- By Severity ---')
for sev in ['critical', 'high', 'medium', 'low']:
    count = severity_counts.get(sev, 0)
    if count > 0:
        print(f'  {sev:<12} {count}')
print()
" "$GAPS_FILE"
