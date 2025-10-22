#!/bin/bash
# Group C Testing Script - Wish #120-A
# Tests Forge integration for Genie CLI

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test results
PASSED=0
FAILED=0
TOTAL=7

# Configuration
export FORGE_BASE_URL="http://localhost:3000"
export GENIE_PROJECT_ID="f8924071-fa8e-43ee-8fbc-96ec5b49b3da"  # automagik-genie project
GENIE_BIN="./dist/genie.js"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Group C: Forge Integration Testing${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "Environment:"
echo "  FORGE_BASE_URL: $FORGE_BASE_URL"
echo "  GENIE_PROJECT_ID: $GENIE_PROJECT_ID"
echo "  GENIE_BIN: $GENIE_BIN"
echo ""

# Helper functions
pass() {
    echo -e "${GREEN}✓ PASS${NC}: $1"
    ((PASSED++))
}

fail() {
    echo -e "${RED}✗ FAIL${NC}: $1"
    echo -e "  Error: $2"
    ((FAILED++))
}

test_header() {
    echo ""
    echo -e "${BLUE}──────────────────────────────────────${NC}"
    echo -e "${BLUE}Test $1: $2${NC}"
    echo -e "${BLUE}──────────────────────────────────────${NC}"
}

# Test 1: Session Creation
test_header 1 "Session Creation (Basic Forge Task)"

SESSION1_OUTPUT=$(node $GENIE_BIN run analyze "Test prompt 1" 2>&1 || true)
echo "$SESSION1_OUTPUT"

if echo "$SESSION1_OUTPUT" | grep -q "Creating Forge task"; then
    pass "Test 1: Forge task creation initiated"

    # Extract session ID from output
    SESSION1_ID=$(echo "$SESSION1_OUTPUT" | grep -oP "Task attempt created: \K[a-f0-9-]+")
    if [ ! -z "$SESSION1_ID" ]; then
        pass "Test 1: Session ID extracted: $SESSION1_ID"
        echo "  SESSION1_ID=$SESSION1_ID"
    else
        fail "Test 1: Failed to extract session ID" "$SESSION1_OUTPUT"
    fi
else
    fail "Test 1: Forge task creation failed" "$SESSION1_OUTPUT"
fi

# Small delay between tests
sleep 2

# Test 2: Session Resume
test_header 2 "Session Resume (Follow-up Prompt)"

if [ ! -z "$SESSION1_ID" ]; then
    RESUME_OUTPUT=$(node $GENIE_BIN resume "$SESSION1_ID" "Continue test" 2>&1 || true)
    echo "$RESUME_OUTPUT"

    if echo "$RESUME_OUTPUT" | grep -q "Resuming session"; then
        pass "Test 2: Session resume initiated"
    else
        fail "Test 2: Session resume failed" "$RESUME_OUTPUT"
    fi
else
    fail "Test 2: Skipped (no session from Test 1)" "SESSION1_ID not set"
fi

sleep 2

# Test 3: Session View
test_header 3 "Session View (Log Retrieval)"

if [ ! -z "$SESSION1_ID" ]; then
    VIEW_OUTPUT=$(node $GENIE_BIN view "$SESSION1_ID" 2>&1 || true)
    echo "$VIEW_OUTPUT"

    if echo "$VIEW_OUTPUT" | grep -qE "(Forge logs|CLI log)"; then
        pass "Test 3: Logs retrieved"
    else
        fail "Test 3: Log retrieval failed" "$VIEW_OUTPUT"
    fi
else
    fail "Test 3: Skipped (no session from Test 1)" "SESSION1_ID not set"
fi

sleep 1

# Test 4: Session Stop
test_header 4 "Session Stop (Graceful Termination)"

if [ ! -z "$SESSION1_ID" ]; then
    STOP_OUTPUT=$(node $GENIE_BIN stop "$SESSION1_ID" 2>&1 || true)
    echo "$STOP_OUTPUT"

    if echo "$STOP_OUTPUT" | grep -q "Stopping session"; then
        pass "Test 4: Session stop initiated"
    else
        fail "Test 4: Session stop failed" "$STOP_OUTPUT"
    fi
else
    fail "Test 4: Skipped (no session from Test 1)" "SESSION1_ID not set"
fi

sleep 2

# Test 5: Session List
test_header 5 "Session List (Unified Listing)"

# Create 2 Forge sessions
SESSION2_OUTPUT=$(node $GENIE_BIN run analyze "Test prompt 2" 2>&1 || true)
sleep 1
SESSION3_OUTPUT=$(node $GENIE_BIN run debug "Test prompt 3" 2>&1 || true)
sleep 2

LIST_OUTPUT=$(node $GENIE_BIN list sessions 2>&1 || true)
echo "$LIST_OUTPUT"

if echo "$LIST_OUTPUT" | grep -q "analyze"; then
    pass "Test 5: Session list includes Forge sessions"
else
    fail "Test 5: Session list failed" "$LIST_OUTPUT"
fi

sleep 1

# Test 6: Parallel Sessions
test_header 6 "Parallel Sessions (3 Concurrent)"

# Launch 3 sessions in parallel
node $GENIE_BIN run plan "Parallel test 1" 2>&1 &
PID1=$!
node $GENIE_BIN run plan "Parallel test 2" 2>&1 &
PID2=$!
node $GENIE_BIN run plan "Parallel test 3" 2>&1 &
PID3=$!

# Wait for all to complete
wait $PID1 $PID2 $PID3 2>/dev/null || true

sleep 3

# Check if all created successfully
PARALLEL_LIST=$(node $GENIE_BIN list sessions 2>&1 || true)
PARALLEL_COUNT=$(echo "$PARALLEL_LIST" | grep -c "plan" || true)

if [ "$PARALLEL_COUNT" -ge 3 ]; then
    pass "Test 6: Parallel sessions created successfully ($PARALLEL_COUNT sessions)"
else
    fail "Test 6: Parallel session creation incomplete" "Only $PARALLEL_COUNT sessions found"
fi

# Test 7: Error Handling
test_header 7 "Error Handling (Forge API Failures)"

# Set invalid Forge URL
export FORGE_BASE_URL="http://invalid-forge-url:9999"

ERROR_OUTPUT=$(node $GENIE_BIN run analyze "Test error handling" 2>&1 || true)
echo "$ERROR_OUTPUT"

# Restore valid URL
export FORGE_BASE_URL="http://localhost:3000"

if echo "$ERROR_OUTPUT" | grep -qE "(Failed to create Forge task|fallback|traditional)"; then
    pass "Test 7: Graceful error handling detected"
else
    # Check if it fell back to traditional launcher
    if echo "$ERROR_OUTPUT" | grep -q "Session started"; then
        pass "Test 7: Fallback to traditional launcher succeeded"
    else
        fail "Test 7: Error handling incomplete" "$ERROR_OUTPUT"
    fi
fi

# Summary
echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Test Summary${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "Total Tests: $TOTAL"
echo -e "${GREEN}Passed: $PASSED${NC}"
echo -e "${RED}Failed: $FAILED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}✗ Some tests failed${NC}"
    exit 1
fi
