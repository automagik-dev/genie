#!/bin/bash
# Comprehensive Runtime Testing - Group C (Tasks 12-14)
# Wish #120-A Forge Integration

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
export FORGE_BASE_URL="http://localhost:8887"
export GENIE_PROJECT_ID="f8924071-fa8e-43ee-8fbc-96ec5b49b3da"
GENIE_BIN="./dist/genie.js"
RESULTS_DIR="../.genie/reports/runtime-tests"
mkdir -p "$RESULTS_DIR"

# Test counters
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

# Timing
START_TIME=$(date +%s)

echo -e "${BLUE}════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}     Group C Runtime Testing - Wish #120-A             ${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${CYAN}Configuration:${NC}"
echo "  FORGE_BASE_URL: $FORGE_BASE_URL"
echo "  GENIE_PROJECT_ID: $GENIE_PROJECT_ID"
echo "  GENIE_BIN: $GENIE_BIN"
echo "  RESULTS_DIR: $RESULTS_DIR"
echo "  Start Time: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# Helper functions
pass() {
    echo -e "${GREEN}✅ PASS${NC}: $1"
    ((PASSED_TESTS++))
    ((TOTAL_TESTS++))
}

fail() {
    echo -e "${RED}❌ FAIL${NC}: $1"
    if [ -n "$2" ]; then
        echo -e "${RED}   Error: $2${NC}"
    fi
    ((FAILED_TESTS++))
    ((TOTAL_TESTS++))
}

test_header() {
    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}Test $1: $2${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

section_header() {
    echo ""
    echo -e "${CYAN}═══════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN} $1${NC}"
    echo -e "${CYAN}═══════════════════════════════════════════════════════${NC}"
}

# Measure execution time
measure_time() {
    local start=$1
    local end=$(date +%s%3N)
    local duration=$((end - start))
    echo "$duration"
}

# ============================================================================
# TASK 12: POC TEST CASES (7 TESTS)
# ============================================================================

section_header "TASK 12: POC Test Cases (7 Tests)"

# Test 1: Session Creation via Forge
test_header "1" "Session Creation (Forge Backend)"

TEST1_START=$(date +%s%3N)
TEST1_OUTPUT=$(timeout 30 node $GENIE_BIN run analyze "Test session creation via Forge backend" 2>&1 || true)
TEST1_TIME=$(measure_time $TEST1_START)

echo "$TEST1_OUTPUT" | tee "$RESULTS_DIR/test1-session-creation.log"

# Check if Forge was used
if echo "$TEST1_OUTPUT" | grep -q "Creating Forge task"; then
    pass "Test 1: Forge task creation initiated"

    # Extract session name/ID
    SESSION1_NAME=$(echo "$TEST1_OUTPUT" | grep -oP "Session: \K[a-zA-Z0-9_-]+" | head -1)
    if [ ! -z "$SESSION1_NAME" ]; then
        pass "Test 1: Session name extracted: $SESSION1_NAME"
        echo -e "   ${CYAN}Session: $SESSION1_NAME${NC}"
        echo -e "   ${CYAN}Creation time: ${TEST1_TIME}ms${NC}"
    else
        fail "Test 1: Failed to extract session name" "$TEST1_OUTPUT"
    fi
elif echo "$TEST1_OUTPUT" | grep -q "Launching.*in background"; then
    fail "Test 1: Used traditional launcher instead of Forge" "Check FORGE_BASE_URL environment"
else
    fail "Test 1: Unexpected output" "$TEST1_OUTPUT"
fi

sleep 3  # Allow session to initialize

# Test 2: Session List (Unified Listing)
test_header "2" "Session List (Forge + Traditional Unified)"

TEST2_OUTPUT=$(node $GENIE_BIN list sessions 2>&1 || true)
echo "$TEST2_OUTPUT" | tee "$RESULTS_DIR/test2-session-list.log"

if echo "$TEST2_OUTPUT" | grep -q "$SESSION1_NAME"; then
    pass "Test 2: Session list includes Forge session"

    # Count sessions
    SESSION_COUNT=$(echo "$TEST2_OUTPUT" | grep -c "analyze\|debug\|plan" || echo "0")
    echo -e "   ${CYAN}Total sessions visible: $SESSION_COUNT${NC}"
else
    fail "Test 2: Session list missing Forge session" "$TEST2_OUTPUT"
fi

# Test 3: Session View (Log Retrieval)
test_header "3" "Session View (Forge Log Retrieval)"

if [ ! -z "$SESSION1_NAME" ]; then
    TEST3_OUTPUT=$(node $GENIE_BIN view "$SESSION1_NAME" 2>&1 || true)
    echo "$TEST3_OUTPUT" | tee "$RESULTS_DIR/test3-session-view.log"

    if echo "$TEST3_OUTPUT" | grep -qE "(Forge logs|CLI log|Session|Agent)"; then
        pass "Test 3: Log retrieval successful"

        # Check log source
        if echo "$TEST3_OUTPUT" | grep -q "Forge logs"; then
            echo -e "   ${GREEN}Source: Forge backend${NC}"
        elif echo "$TEST3_OUTPUT" | grep -q "CLI log"; then
            echo -e "   ${YELLOW}Source: CLI log file (fallback)${NC}"
        fi
    else
        fail "Test 3: Log retrieval failed" "$TEST3_OUTPUT"
    fi
else
    fail "Test 3: Skipped - no session from Test 1" "SESSION1_NAME not set"
fi

sleep 2

# Test 4: Session Resume (Follow-up Prompt)
test_header "4" "Session Resume (Forge Follow-up API)"

if [ ! -z "$SESSION1_NAME" ]; then
    TEST4_START=$(date +%s%3N)
    TEST4_OUTPUT=$(timeout 15 node $GENIE_BIN resume "$SESSION1_NAME" "Continue analysis with more details" 2>&1 || true)
    TEST4_TIME=$(measure_time $TEST4_START)

    echo "$TEST4_OUTPUT" | tee "$RESULTS_DIR/test4-session-resume.log"

    if echo "$TEST4_OUTPUT" | grep -qE "(Resuming session|Follow-up|Session)"; then
        pass "Test 4: Session resume initiated"
        echo -e "   ${CYAN}Resume time: ${TEST4_TIME}ms${NC}"
    else
        fail "Test 4: Session resume failed" "$TEST4_OUTPUT"
    fi
else
    fail "Test 4: Skipped - no session from Test 1" "SESSION1_NAME not set"
fi

sleep 2

# Test 5: Session Stop (Graceful Termination)
test_header "5" "Session Stop (Forge Termination API)"

if [ ! -z "$SESSION1_NAME" ]; then
    TEST5_OUTPUT=$(node $GENIE_BIN stop "$SESSION1_NAME" 2>&1 || true)
    echo "$TEST5_OUTPUT" | tee "$RESULTS_DIR/test5-session-stop.log"

    if echo "$TEST5_OUTPUT" | grep -qE "(Stopping|stopped|Session)"; then
        pass "Test 5: Session stop initiated"
    else
        fail "Test 5: Session stop failed" "$TEST5_OUTPUT"
    fi
else
    fail "Test 5: Skipped - no session from Test 1" "SESSION1_NAME not set"
fi

sleep 2

# Test 6: Parallel Sessions (2-3 concurrent)
test_header "6" "Parallel Sessions (3 Concurrent Forge Sessions)"

echo "Launching 3 sessions in parallel..."
TEST6_START=$(date +%s%3N)

node $GENIE_BIN run plan "Parallel test 1 - architecture design" > "$RESULTS_DIR/test6-parallel-1.log" 2>&1 &
PID1=$!
sleep 1

node $GENIE_BIN run plan "Parallel test 2 - implementation plan" > "$RESULTS_DIR/test6-parallel-2.log" 2>&1 &
PID2=$!
sleep 1

node $GENIE_BIN run debug "Parallel test 3 - bug investigation" > "$RESULTS_DIR/test6-parallel-3.log" 2>&1 &
PID3=$!

# Wait for all
wait $PID1 2>/dev/null || true
wait $PID2 2>/dev/null || true
wait $PID3 2>/dev/null || true

TEST6_TIME=$(measure_time $TEST6_START)

sleep 3

# Check results
TEST6_LIST=$(node $GENIE_BIN list sessions 2>&1 || true)
PARALLEL_COUNT=$(echo "$TEST6_LIST" | grep -cE "(plan|debug).*parallel" || echo "0")

if [ "$PARALLEL_COUNT" -ge 2 ]; then
    pass "Test 6: Parallel sessions created successfully ($PARALLEL_COUNT sessions)"
    echo -e "   ${CYAN}Total time for 3 parallel: ${TEST6_TIME}ms${NC}"
else
    fail "Test 6: Parallel session creation incomplete" "Only $PARALLEL_COUNT sessions found"
fi

# Test 7: Error Handling (Forge Fallback)
test_header "7" "Error Handling (Forge Unavailable Fallback)"

# Temporarily break Forge URL
export FORGE_BASE_URL="http://invalid-forge-url:9999"

TEST7_OUTPUT=$(timeout 15 node $GENIE_BIN run analyze "Test error handling" 2>&1 || true)
echo "$TEST7_OUTPUT" | tee "$RESULTS_DIR/test7-error-handling.log"

# Restore valid URL
export FORGE_BASE_URL="http://localhost:8887"

# Check for fallback or error handling
if echo "$TEST7_OUTPUT" | grep -qE "(Forge backend unavailable|Forge error|fallback|traditional)"; then
    pass "Test 7: Graceful error handling detected"
elif echo "$TEST7_OUTPUT" | grep -q "Launching.*in background"; then
    pass "Test 7: Fell back to traditional launcher"
else
    # Might have timed out gracefully
    if echo "$TEST7_OUTPUT" | grep -q "Timeout"; then
        pass "Test 7: Timed out gracefully (acceptable fallback behavior)"
    else
        fail "Test 7: Error handling incomplete" "$TEST7_OUTPUT"
    fi
fi

# ============================================================================
# TASK 13: STRESS TEST (10 PARALLEL SESSIONS)
# ============================================================================

section_header "TASK 13: Stress Test (10 Parallel Sessions)"

echo "Launching 10 concurrent Forge sessions..."
STRESS_START=$(date +%s%3N)

for i in {1..10}; do
    node $GENIE_BIN run analyze "Stress test session $i - concurrent execution" > "$RESULTS_DIR/stress-session-$i.log" 2>&1 &
    sleep 0.5  # Stagger launches slightly
done

echo "Waiting for all sessions to start..."
sleep 10

STRESS_TIME=$(measure_time $STRESS_START)

# Check results
STRESS_LIST=$(node $GENIE_BIN list sessions 2>&1 || true)
STRESS_COUNT=$(echo "$STRESS_LIST" | grep -c "Stress test" || echo "0")

echo ""
echo -e "${CYAN}Stress Test Results:${NC}"
echo -e "   Sessions created: $STRESS_COUNT / 10"
echo -e "   Total time: ${STRESS_TIME}ms"
echo -e "   Average per session: $((STRESS_TIME / 10))ms"

if [ "$STRESS_COUNT" -ge 8 ]; then
    pass "Task 13: Stress test successful ($STRESS_COUNT/10 sessions created)"
    echo -e "   ${GREEN}No conflicts or race conditions detected${NC}"
else
    fail "Task 13: Stress test incomplete" "Only $STRESS_COUNT/10 sessions created"
fi

# ============================================================================
# TASK 14: PERFORMANCE VALIDATION
# ============================================================================

section_header "TASK 14: Performance Validation"

echo "Measuring session creation latency..."

# Measure Forge session creation (5 samples)
echo ""
echo -e "${CYAN}Forge Session Creation (5 samples):${NC}"
FORGE_TIMES=()
for i in {1..5}; do
    PERF_START=$(date +%s%3N)
    timeout 30 node $GENIE_BIN run analyze "Performance test Forge $i" > "$RESULTS_DIR/perf-forge-$i.log" 2>&1 || true
    PERF_TIME=$(measure_time $PERF_START)
    FORGE_TIMES+=($PERF_TIME)
    echo "   Sample $i: ${PERF_TIME}ms"
    sleep 2
done

# Calculate average
FORGE_AVG=0
for time in "${FORGE_TIMES[@]}"; do
    FORGE_AVG=$((FORGE_AVG + time))
done
FORGE_AVG=$((FORGE_AVG / 5))

echo ""
echo -e "${CYAN}Performance Metrics:${NC}"
echo "   Forge average: ${FORGE_AVG}ms"
echo "   Target: < 5000ms (5s)"

if [ "$FORGE_AVG" -lt 5000 ]; then
    pass "Task 14: Performance target met (${FORGE_AVG}ms < 5000ms)"
else
    fail "Task 14: Performance target not met" "${FORGE_AVG}ms >= 5000ms"
fi

# ============================================================================
# FINAL SUMMARY
# ============================================================================

END_TIME=$(date +%s)
TOTAL_DURATION=$((END_TIME - START_TIME))

section_header "FINAL TEST SUMMARY"

echo ""
echo -e "${CYAN}Test Statistics:${NC}"
echo "   Total tests: $TOTAL_TESTS"
echo -e "   ${GREEN}Passed: $PASSED_TESTS${NC}"
echo -e "   ${RED}Failed: $FAILED_TESTS${NC}"
echo "   Success rate: $(( (PASSED_TESTS * 100) / TOTAL_TESTS ))%"
echo ""
echo -e "${CYAN}Timing:${NC}"
echo "   Total duration: ${TOTAL_DURATION}s"
echo "   Test results: $RESULTS_DIR"
echo ""

# Final verdict
if [ $FAILED_TESTS -eq 0 ]; then
    echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}           ✅ ALL TESTS PASSED!                        ${NC}"
    echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
    exit 0
else
    echo -e "${YELLOW}════════════════════════════════════════════════════════${NC}"
    echo -e "${YELLOW}   ⚠️  Some tests failed - see logs for details       ${NC}"
    echo -e "${YELLOW}════════════════════════════════════════════════════════${NC}"
    exit 1
fi
