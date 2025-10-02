#!/bin/bash

# Performance measurement script for Genie CLI
# Measures startup time across multiple iterations

ITERATIONS=10
OUTPUT_FILE="/home/namastex/workspace/automagik-genie/.genie/cli/snapshots/evidence/performance-metrics.txt"

echo "Genie CLI Performance Metrics" > "$OUTPUT_FILE"
echo "=============================" >> "$OUTPUT_FILE"
echo "Date: $(date -u '+%Y-%m-%d %H:%M:%S UTC')" >> "$OUTPUT_FILE"
echo "Iterations: $ITERATIONS" >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"

# Array to store timings
declare -a timings

echo "Running $ITERATIONS iterations of './genie --help'..." >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"

for i in $(seq 1 $ITERATIONS); do
    # Measure time in milliseconds
    START=$(date +%s%N)
    /home/namastex/workspace/automagik-genie/genie --help > /dev/null 2>&1
    END=$(date +%s%N)

    # Calculate duration in milliseconds
    DURATION=$(((END - START) / 1000000))
    timings+=($DURATION)

    echo "Iteration $i: ${DURATION}ms" >> "$OUTPUT_FILE"
done

echo "" >> "$OUTPUT_FILE"
echo "Statistical Summary:" >> "$OUTPUT_FILE"
echo "-------------------" >> "$OUTPUT_FILE"

# Calculate statistics
SUM=0
MIN=${timings[0]}
MAX=${timings[0]}

for timing in "${timings[@]}"; do
    SUM=$((SUM + timing))
    if [ $timing -lt $MIN ]; then MIN=$timing; fi
    if [ $timing -gt $MAX ]; then MAX=$timing; fi
done

AVG=$((SUM / ITERATIONS))

echo "Average: ${AVG}ms" >> "$OUTPUT_FILE"
echo "Minimum: ${MIN}ms" >> "$OUTPUT_FILE"
echo "Maximum: ${MAX}ms" >> "$OUTPUT_FILE"

# Calculate standard deviation
VARIANCE_SUM=0
for timing in "${timings[@]}"; do
    DIFF=$((timing - AVG))
    VARIANCE_SUM=$((VARIANCE_SUM + DIFF * DIFF))
done
VARIANCE=$((VARIANCE_SUM / ITERATIONS))
# Approximate square root for bash (integer math)
STD_DEV=$(echo "sqrt($VARIANCE)" | bc -l 2>/dev/null || echo "N/A")

echo "Std Dev: ${STD_DEV}ms" >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"
echo "Performance Assessment:" >> "$OUTPUT_FILE"
echo "----------------------" >> "$OUTPUT_FILE"
if [ $AVG -lt 100 ]; then
    echo "✓ Excellent: Startup time < 100ms" >> "$OUTPUT_FILE"
elif [ $AVG -lt 200 ]; then
    echo "✓ Good: Startup time < 200ms" >> "$OUTPUT_FILE"
elif [ $AVG -lt 500 ]; then
    echo "⚠ Acceptable: Startup time < 500ms" >> "$OUTPUT_FILE"
else
    echo "✗ Needs improvement: Startup time > 500ms" >> "$OUTPUT_FILE"
fi

echo "Performance metrics captured successfully!"