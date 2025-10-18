#!/bin/bash
# UUID Reuse Reproducibility Test
# Tests whether UUIDs are properly unique across sequential runs

set -e

echo "=== UUID Reuse Investigation Test ==="
echo "Date: $(date -u)"
echo ""

# Clean state
echo "1. Cleaning session state..."
rm -rf .genie/state/agents/sessions.json .genie/state/agents/logs/* 2>/dev/null || true
echo "   ✓ State cleaned"
echo ""

# Test 1: Sequential runs without rebuild
echo "2. Test 1: Sequential runs WITHOUT rebuild"
echo "   Creating 3 sessions in sequence..."

for i in 1 2 3; do
  echo "   Run $i..."
  npx automagik-genie run neurons/plan "UUID Test $i" --background 2>&1 | grep -E "Session ID:|session_id" || true
  sleep 2
done

echo ""
echo "   Checking session count..."
SESSION_COUNT=$(jq '.sessions | length' .genie/state/agents/sessions.json 2>/dev/null || echo "0")
UNIQUE_KEYS=$(jq -r '.sessions | keys[]' .genie/state/agents/sessions.json 2>/dev/null | sort | uniq | wc -l)

echo "   Sessions created: $SESSION_COUNT"
echo "   Unique UUIDs: $UNIQUE_KEYS"

if [ "$SESSION_COUNT" -eq 3 ] && [ "$UNIQUE_KEYS" -eq 3 ]; then
  echo "   ✓ PASS: 3 unique sessions created"
  TEST1_RESULT="PASS"
else
  echo "   ✗ FAIL: Expected 3 unique sessions, got $SESSION_COUNT sessions with $UNIQUE_KEYS unique UUIDs"
  TEST1_RESULT="FAIL"
fi

echo ""
echo "   UUIDs generated:"
jq -r '.sessions | keys[]' .genie/state/agents/sessions.json 2>/dev/null | while read uuid; do
  echo "   - $uuid"
done

echo ""

# Clean for test 2
echo "3. Test 2: Sequential runs AFTER rebuild"
echo "   Rebuilding TypeScript..."
pnpm run build:genie > /dev/null 2>&1
echo "   ✓ Build complete"
echo ""

echo "   Cleaning state again..."
rm -rf .genie/state/agents/sessions.json .genie/state/agents/logs/* 2>/dev/null || true
echo ""

echo "   Creating 3 sessions after rebuild..."
for i in 1 2 3; do
  echo "   Run $i..."
  npx automagik-genie run neurons/plan "Post-rebuild Test $i" --background 2>&1 | grep -E "Session ID:|session_id" || true
  sleep 2
done

echo ""
echo "   Checking session count..."
SESSION_COUNT2=$(jq '.sessions | length' .genie/state/agents/sessions.json 2>/dev/null || echo "0")
UNIQUE_KEYS2=$(jq -r '.sessions | keys[]' .genie/state/agents/sessions.json 2>/dev/null | sort | uniq | wc -l)

echo "   Sessions created: $SESSION_COUNT2"
echo "   Unique UUIDs: $UNIQUE_KEYS2"

if [ "$SESSION_COUNT2" -eq 3 ] && [ "$UNIQUE_KEYS2" -eq 3 ]; then
  echo "   ✓ PASS: 3 unique sessions created"
  TEST2_RESULT="PASS"
else
  echo "   ✗ FAIL: Expected 3 unique sessions, got $SESSION_COUNT2 sessions with $UNIQUE_KEYS2 unique UUIDs"
  TEST2_RESULT="FAIL"
fi

echo ""
echo "   UUIDs generated:"
jq -r '.sessions | keys[]' .genie/state/agents/sessions.json 2>/dev/null | while read uuid; do
  echo "   - $uuid"
done

echo ""
echo "=== Test Summary ==="
echo "Test 1 (without rebuild): $TEST1_RESULT"
echo "Test 2 (with rebuild): $TEST2_RESULT"
echo ""

if [ "$TEST1_RESULT" = "FAIL" ] && [ "$TEST2_RESULT" = "PASS" ]; then
  echo "CONCLUSION: UUID reuse issue CONFIRMED"
  echo "Root cause: Stale build artifacts require rebuild after source changes"
  exit 1
elif [ "$TEST1_RESULT" = "PASS" ] && [ "$TEST2_RESULT" = "PASS" ]; then
  echo "CONCLUSION: No UUID reuse issue detected"
  exit 0
else
  echo "CONCLUSION: Inconsistent results, further investigation needed"
  exit 2
fi
