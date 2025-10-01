#!/bin/bash
# Location: .genie/cli/snapshots/capture-baseline.sh

SNAPSHOT_DIR=".genie/cli/snapshots/baseline-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$SNAPSHOT_DIR"

echo "📸 Capturing CLI baseline snapshots..."

# 1. Help text (all commands)
./genie --help > "$SNAPSHOT_DIR/help.txt" 2>&1
./genie help > "$SNAPSHOT_DIR/help-command.txt" 2>&1
./genie run --help > "$SNAPSHOT_DIR/help-run.txt" 2>&1
./genie resume --help > "$SNAPSHOT_DIR/help-resume.txt" 2>&1
./genie list --help > "$SNAPSHOT_DIR/help-list.txt" 2>&1
./genie view --help > "$SNAPSHOT_DIR/help-view.txt" 2>&1
./genie stop --help > "$SNAPSHOT_DIR/help-stop.txt" 2>&1

# 2. List commands
./genie list agents > "$SNAPSHOT_DIR/list-agents.txt" 2>&1
./genie list sessions > "$SNAPSHOT_DIR/list-sessions.txt" 2>&1

# 3. Error states (expected failures)
./genie run > "$SNAPSHOT_DIR/error-run-no-args.txt" 2>&1
echo "Exit code: $?" >> "$SNAPSHOT_DIR/error-run-no-args.txt"

./genie resume > "$SNAPSHOT_DIR/error-resume-no-args.txt" 2>&1
echo "Exit code: $?" >> "$SNAPSHOT_DIR/error-resume-no-args.txt"

./genie view > "$SNAPSHOT_DIR/error-view-no-args.txt" 2>&1
echo "Exit code: $?" >> "$SNAPSHOT_DIR/error-view-no-args.txt"

./genie stop > "$SNAPSHOT_DIR/error-stop-no-args.txt" 2>&1
echo "Exit code: $?" >> "$SNAPSHOT_DIR/error-stop-no-args.txt"

./genie invalid-command > "$SNAPSHOT_DIR/error-unknown-command.txt" 2>&1
echo "Exit code: $?" >> "$SNAPSHOT_DIR/error-unknown-command.txt"

./genie list invalid > "$SNAPSHOT_DIR/error-list-invalid.txt" 2>&1
echo "Exit code: $?" >> "$SNAPSHOT_DIR/error-list-invalid.txt"

# 4. View command (if test sessions exist)
if [ -f ".genie/cli/test-session-id.txt" ]; then
  TEST_SESSION=$(cat .genie/cli/test-session-id.txt)
  ./genie view "$TEST_SESSION" > "$SNAPSHOT_DIR/view-session.txt" 2>&1
  ./genie view "$TEST_SESSION" --full > "$SNAPSHOT_DIR/view-session-full.txt" 2>&1
  ./genie view "$TEST_SESSION" --live > "$SNAPSHOT_DIR/view-session-live.txt" 2>&1
fi

# 5. Performance baseline
echo "⏱️  Measuring CLI startup time..."
for i in {1..10}; do
  /usr/bin/time -f "%e" ./genie --help 2>&1 | tail -1
done | awk '{sum+=$1; count++} END {print "Average: " sum/count "s"}' > "$SNAPSHOT_DIR/perf-startup.txt"

# 6. File structure snapshot
wc -l .genie/cli/src/**/*.ts > "$SNAPSHOT_DIR/line-counts.txt" 2>/dev/null
find .genie/cli/src -name "*.ts" -type f 2>/dev/null | sort > "$SNAPSHOT_DIR/file-list.txt"

# 7. Build output
npm run build > "$SNAPSHOT_DIR/build-output.txt" 2>&1
echo "Exit code: $?" >> "$SNAPSHOT_DIR/build-output.txt"

echo "✅ Baseline snapshots captured at: $SNAPSHOT_DIR"
echo ""
echo "📋 Snapshot manifest:"
ls -lh "$SNAPSHOT_DIR"