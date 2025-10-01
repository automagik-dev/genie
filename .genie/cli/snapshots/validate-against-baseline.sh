#!/bin/bash
# Location: .genie/cli/snapshots/validate-against-baseline.sh

BASELINE_DIR="$1"
CURRENT_DIR=".genie/cli/snapshots/current-$(date +%Y%m%d-%H%M%S)"

if [ -z "$BASELINE_DIR" ]; then
  echo "Usage: $0 <baseline-snapshot-dir>"
  exit 1
fi

mkdir -p "$CURRENT_DIR"

echo "📸 Capturing current CLI snapshots..."

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

wc -l src/**/*.ts > "$CURRENT_DIR/line-counts.txt"
find src -name "*.ts" -type f | sort > "$CURRENT_DIR/file-list.txt"
npm run build > "$CURRENT_DIR/build-output.txt" 2>&1

echo ""
echo "🔍 Diffing against baseline..."
echo ""

DIFF_COUNT=0
for file in "$BASELINE_DIR"/*.txt; do
  basename_file=$(basename "$file")
  if [ -f "$CURRENT_DIR/$basename_file" ]; then
    if ! diff -u "$file" "$CURRENT_DIR/$basename_file" > "$CURRENT_DIR/diff-$basename_file" 2>&1; then
      echo "❌ DIFF: $basename_file"
      cat "$CURRENT_DIR/diff-$basename_file"
      DIFF_COUNT=$((DIFF_COUNT + 1))
    else
      echo "✅ MATCH: $basename_file"
      rm "$CURRENT_DIR/diff-$basename_file"
    fi
  else
    echo "⚠️  MISSING: $basename_file (in baseline but not current)"
    DIFF_COUNT=$((DIFF_COUNT + 1))
  fi
done

echo ""
if [ $DIFF_COUNT -eq 0 ]; then
  echo "🎉 All snapshots match! CLI behavior preserved."
  exit 0
else
  echo "❌ $DIFF_COUNT snapshot(s) differ. Review diffs above."
  exit 1
fi