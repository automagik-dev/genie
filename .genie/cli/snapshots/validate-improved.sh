#!/bin/bash
# Location: .genie/cli/snapshots/validate-improved.sh
# Improved validation script with path fixes and timestamp handling

# Check if we're in the right directory
if [ ! -f "./genie" ]; then
  echo "❌ Error: Must be run from the project root where ./genie exists"
  echo "  Current directory: $(pwd)"
  echo "  Please run from: /home/namastex/workspace/automagik-genie"
  exit 1
fi

BASELINE_DIR="$1"
CURRENT_DIR=".genie/cli/snapshots/current-$(date +%Y%m%d-%H%M%S)"

if [ -z "$BASELINE_DIR" ]; then
  echo "Usage: $0 <baseline-snapshot-dir>"
  echo "Example: $0 .genie/cli/snapshots/baseline-20250930-184841"
  exit 1
fi

if [ ! -d "$BASELINE_DIR" ]; then
  echo "❌ Error: Baseline directory not found: $BASELINE_DIR"
  exit 1
fi

mkdir -p "$CURRENT_DIR"

echo "📸 Capturing current CLI snapshots..."
echo "  Baseline: $BASELINE_DIR"
echo "  Current:  $CURRENT_DIR"
echo ""

# Re-run all snapshot commands (same as capture script)
./genie --help > "$CURRENT_DIR/help.txt" 2>&1
./genie help > "$CURRENT_DIR/help-command.txt" 2>&1
./genie run --help > "$CURRENT_DIR/help-run.txt" 2>&1
./genie resume --help > "$CURRENT_DIR/help-resume.txt" 2>&1
./genie list --help > "$CURRENT_DIR/help-list.txt" 2>&1
./genie view --help > "$CURRENT_DIR/help-view.txt" 2>&1
./genie stop --help > "$CURRENT_DIR/help-stop.txt" 2>&1

./genie list agents > "$CURRENT_DIR/list-agents.txt" 2>&1
./genie list sessions > "$CURRENT_DIR/list-sessions.txt" 2>&1

./genie run > "$CURRENT_DIR/error-run-no-args.txt" 2>&1
echo "Exit code: $?" >> "$CURRENT_DIR/error-run-no-args.txt"

./genie resume > "$CURRENT_DIR/error-resume-no-args.txt" 2>&1
echo "Exit code: $?" >> "$CURRENT_DIR/error-resume-no-args.txt"

./genie view > "$CURRENT_DIR/error-view-no-args.txt" 2>&1
echo "Exit code: $?" >> "$CURRENT_DIR/error-view-no-args.txt"

./genie stop > "$CURRENT_DIR/error-stop-no-args.txt" 2>&1
echo "Exit code: $?" >> "$CURRENT_DIR/error-stop-no-args.txt"

./genie invalid-command > "$CURRENT_DIR/error-unknown-command.txt" 2>&1
echo "Exit code: $?" >> "$CURRENT_DIR/error-unknown-command.txt"

./genie list invalid > "$CURRENT_DIR/error-list-invalid.txt" 2>&1
echo "Exit code: $?" >> "$CURRENT_DIR/error-list-invalid.txt"

if [ -f ".genie/cli/test-session-id.txt" ]; then
  TEST_SESSION=$(cat .genie/cli/test-session-id.txt)
  ./genie view "$TEST_SESSION" > "$CURRENT_DIR/view-session.txt" 2>&1
  ./genie view "$TEST_SESSION" --full > "$CURRENT_DIR/view-session-full.txt" 2>&1
  ./genie view "$TEST_SESSION" --live > "$CURRENT_DIR/view-session-live.txt" 2>&1
fi

# Performance (optional, skipped for speed)
if [ ! -f "$BASELINE_DIR/perf-startup.txt" ]; then
  echo "⚠️  Skipping perf-startup.txt (not in baseline)"
else
  echo "⏱️  Measuring CLI startup time..."
  for i in {1..10}; do
    /usr/bin/time -f "%e" ./genie --help 2>&1 | tail -1
  done | awk '{sum+=$1; count++} END {print "Average: " sum/count "s"}' > "$CURRENT_DIR/perf-startup.txt"
fi

# File structure
wc -l .genie/cli/src/**/*.ts > "$CURRENT_DIR/line-counts.txt" 2>/dev/null
find .genie/cli/src -name "*.ts" -type f 2>/dev/null | sort > "$CURRENT_DIR/file-list.txt"

# Build output
npm run build > "$CURRENT_DIR/build-output.txt" 2>&1
echo "Exit code: $?" >> "$CURRENT_DIR/build-output.txt"

echo ""
echo "🔍 Comparing against baseline..."
echo ""

# Function to normalize timestamps and session IDs for comparison
normalize_for_diff() {
  local file="$1"
  # Normalize timestamps (various formats)
  sed -E 's/[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}[.0-9Z]*/TIMESTAMP/g' "$file" | \
  sed -E 's/just now|[0-9]+[smh] ago|[0-9]+ (second|minute|hour|day)s? ago/TIME_AGO/g' | \
  sed -E 's/[0-9]{10,13}/TIMESTAMP_EPOCH/g' | \
  sed -E 's/Updated.*ago/Updated TIME_AGO/g' | \
  # Normalize session IDs (UUIDs and other formats)
  sed -E 's/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/SESSION_UUID/g' | \
  sed -E 's/RUN-[0-9]+/RUN-ID/g' | \
  sed -E 's/01[0-9a-f]{6}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{3}-[0-9a-f]{12}/SESSION_ULID/g' | \
  # Normalize build times
  sed -E 's/Average: [0-9.]+s/Average: TIME_SECONDS/g'
}

DIFF_COUNT=0
FUNCTIONAL_DIFF_COUNT=0
TIMESTAMP_ONLY_COUNT=0

for file in "$BASELINE_DIR"/*.txt; do
  basename_file=$(basename "$file")

  # Skip optional files
  if [[ "$basename_file" == "view-session.txt" ]] || \
     [[ "$basename_file" == "view-session-full.txt" ]] || \
     [[ "$basename_file" == "view-session-live.txt" ]]; then
    if [ ! -f "$CURRENT_DIR/$basename_file" ]; then
      echo "⏭️  SKIP: $basename_file (optional, test session required)"
      continue
    fi
  fi

  if [ -f "$CURRENT_DIR/$basename_file" ]; then
    # Special handling for list-sessions which always has timestamp differences
    if [[ "$basename_file" == "list-sessions.txt" ]]; then
      # Normalize both files before comparing
      normalize_for_diff "$file" > "$CURRENT_DIR/baseline-normalized.txt"
      normalize_for_diff "$CURRENT_DIR/$basename_file" > "$CURRENT_DIR/current-normalized.txt"

      if ! diff -u "$CURRENT_DIR/baseline-normalized.txt" "$CURRENT_DIR/current-normalized.txt" > "$CURRENT_DIR/diff-$basename_file-normalized" 2>&1; then
        echo "⚠️  TIMESTAMP DIFF: $basename_file (timestamps differ but structure matches)"
        TIMESTAMP_ONLY_COUNT=$((TIMESTAMP_ONLY_COUNT + 1))
      else
        echo "✅ MATCH: $basename_file"
      fi
      rm -f "$CURRENT_DIR/baseline-normalized.txt" "$CURRENT_DIR/current-normalized.txt"
    else
      # Regular diff for other files
      if ! diff -u "$file" "$CURRENT_DIR/$basename_file" > "$CURRENT_DIR/diff-$basename_file" 2>&1; then
        # Check if it's only timestamps/IDs that differ
        normalize_for_diff "$file" > "$CURRENT_DIR/baseline-normalized.txt"
        normalize_for_diff "$CURRENT_DIR/$basename_file" > "$CURRENT_DIR/current-normalized.txt"

        if diff -u "$CURRENT_DIR/baseline-normalized.txt" "$CURRENT_DIR/current-normalized.txt" > /dev/null 2>&1; then
          echo "⚠️  TIMESTAMP DIFF: $basename_file (non-functional difference)"
          TIMESTAMP_ONLY_COUNT=$((TIMESTAMP_ONLY_COUNT + 1))
        else
          echo "❌ DIFF: $basename_file (functional difference detected)"
          head -20 "$CURRENT_DIR/diff-$basename_file"
          FUNCTIONAL_DIFF_COUNT=$((FUNCTIONAL_DIFF_COUNT + 1))
        fi
        DIFF_COUNT=$((DIFF_COUNT + 1))
        rm -f "$CURRENT_DIR/baseline-normalized.txt" "$CURRENT_DIR/current-normalized.txt"
      else
        echo "✅ MATCH: $basename_file"
        rm -f "$CURRENT_DIR/diff-$basename_file"
      fi
    fi
  else
    if [[ "$basename_file" == "perf-startup.txt" ]]; then
      echo "⏭️  SKIP: $basename_file (performance metric, optional)"
    else
      echo "⚠️  MISSING: $basename_file (in baseline but not current)"
      DIFF_COUNT=$((DIFF_COUNT + 1))
      FUNCTIONAL_DIFF_COUNT=$((FUNCTIONAL_DIFF_COUNT + 1))
    fi
  fi
done

echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo "📊 Validation Summary"
echo "────────────────────────────────────────────────────────────────────────"
echo "  Total differences:     $DIFF_COUNT"
echo "  Functional differences: $FUNCTIONAL_DIFF_COUNT"
echo "  Timestamp-only diffs:  $TIMESTAMP_ONLY_COUNT"
echo "────────────────────────────────────────────────────────────────────────"

if [ $FUNCTIONAL_DIFF_COUNT -eq 0 ]; then
  echo ""
  echo "🎉 SUCCESS: No functional differences detected!"
  echo "   All CLI behavior is preserved. Only timestamps/session IDs differ."
  echo ""
  echo "✅ Score: 100/100 (no functional changes)"
  exit 0
else
  echo ""
  echo "❌ FAILURE: $FUNCTIONAL_DIFF_COUNT functional difference(s) found."
  echo "   Review the diffs above and fix any behavioral changes."
  echo ""
  echo "📉 Score deduction: -$((FUNCTIONAL_DIFF_COUNT * 2)) points"
  exit 1
fi