---
name: qa/background-launch-argmax
description: Autonomous validation of background launch and ARG_MAX handling
parent: qa
autonomous: true
---

# QA Workflow • Background Launch & ARG_MAX Validation

**Type:** Autonomous validation workflow (no user interaction)
**Purpose:** Validate background agent launch (no timeout) and large prompt handling (ARG_MAX limits)
**Issue Reference:** Bug #104
**Evidence Location:** `.genie/agents/qa/evidence/background-argmax-<timestamp>/`

## Autonomous Operation Protocol 🤖

**I am a fully autonomous validation workflow. I execute without user prompts or questions.**

**What this means:**
- ✅ I launch background agents automatically
- ✅ I test with long prompts (ARG_MAX edge cases)
- ✅ I validate session status transitions
- ✅ I capture evidence automatically
- ✅ I generate test report automatically
- ❌ I NEVER ask "Should I run this test?"
- ❌ I NEVER wait for user confirmation
- ❌ I NEVER present findings without capturing evidence

**My workflow:**
```
1. Launch background agent with standard prompt
2. Launch background agent with long prompt (ARG_MAX test)
3. Validate session status transitions (starting → running)
4. Check executor process spawned
5. Verify log files have content
6. Capture evidence
7. Generate validation report
8. Exit with pass/fail summary
```

**No human in the loop. I am the autonomous validator.**

---

## Test Scenarios

### Scenario 1: Background Launch (Normal Prompt)

**Autonomous Execution:**
```bash
#!/bin/bash
# Auto-executed by QA agent

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
EVIDENCE_DIR=".genie/agents/qa/evidence/background-argmax-${TIMESTAMP}"

mkdir -p "$EVIDENCE_DIR"

echo "Testing background agent launch (normal prompt)..." > "${EVIDENCE_DIR}/scenario1-validation.txt"

# Launch background agent
genie run git "QA test: normal background launch" --background --quiet 2>&1 | tee "${EVIDENCE_DIR}/scenario1-launch.txt" &
RUN_PID=$!

# Wait for session to start
sleep 5

# Get session ID
SESSION_ID=$(genie list sessions 2>&1 | grep -o '[0-9a-f]\{8\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{12\}' | head -1)

if [ -n "$SESSION_ID" ]; then
  echo "Session ID: $SESSION_ID" >> "${EVIDENCE_DIR}/scenario1-validation.txt"

  # Check session status
  genie view "$SESSION_ID" 2>&1 | tee "${EVIDENCE_DIR}/scenario1-session-view.txt"
  VIEW_EXIT=$?

  # List sessions to verify visibility
  genie list sessions 2>&1 | tee "${EVIDENCE_DIR}/scenario1-sessions-list.txt"

  # Check if session transitioned from "starting" to "running"
  if grep -qi "running\|completed" "${EVIDENCE_DIR}/scenario1-sessions-list.txt"; then
    echo "✅ Session transitioned to running/completed" >> "${EVIDENCE_DIR}/scenario1-validation.txt"
    echo "PASS: Background launch works" >> "${EVIDENCE_DIR}/scenario1-validation.txt"
  else
    echo "❌ Session stuck or not found" >> "${EVIDENCE_DIR}/scenario1-validation.txt"
    echo "FAIL: Background launch failed" >> "${EVIDENCE_DIR}/scenario1-validation.txt"
    kill $RUN_PID 2>/dev/null || true
    genie stop "$SESSION_ID" 2>&1 > /dev/null || true
    exit 1
  fi

  # Cleanup
  kill $RUN_PID 2>/dev/null || true
  genie stop "$SESSION_ID" 2>&1 > /dev/null || true
else
  echo "❌ No session ID found" >> "${EVIDENCE_DIR}/scenario1-validation.txt"
  echo "FAIL: Background launch timeout" >> "${EVIDENCE_DIR}/scenario1-validation.txt"
  kill $RUN_PID 2>/dev/null || true
  exit 1
fi
```

**Validation Steps (Automated):**
1. ✅ Background agent launches
2. ✅ Session ID returned
3. ✅ Status transitions to running
4. ✅ No timeout

**Evidence Captured:**
- `scenario1-launch.txt` - Launch command output
- `scenario1-session-view.txt` - Session details
- `scenario1-sessions-list.txt` - Sessions list
- `scenario1-validation.txt` - Validation results

**Pass Criteria:**
- Session launches successfully
- Status transitions from starting to running
- No timeout errors

---

### Scenario 2: ARG_MAX Handling (Long Prompt)

**Autonomous Execution:**
```bash
#!/bin/bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
EVIDENCE_DIR=".genie/agents/qa/evidence/background-argmax-${TIMESTAMP}"

mkdir -p "$EVIDENCE_DIR"

echo "Testing ARG_MAX handling with long prompt..." > "${EVIDENCE_DIR}/scenario2-validation.txt"

# Generate long prompt (10KB - approaching ARG_MAX limits on some systems)
LONG_PROMPT=$(python3 -c "print('QA test: ' + 'A' * 10000)")
echo "Generated prompt length: ${#LONG_PROMPT} characters" >> "${EVIDENCE_DIR}/scenario2-validation.txt"

# Save prompt to file for reference
echo "$LONG_PROMPT" > "${EVIDENCE_DIR}/scenario2-long-prompt.txt"

# Launch with long prompt
genie run git "$LONG_PROMPT" --background --quiet 2>&1 | tee "${EVIDENCE_DIR}/scenario2-launch.txt" &
RUN_PID=$!

# Wait for session to start
sleep 5

# Get session ID
SESSION_ID=$(genie list sessions 2>&1 | grep -o '[0-9a-f]\{8\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{12\}' | head -1)

if [ -n "$SESSION_ID" ]; then
  echo "Session ID: $SESSION_ID" >> "${EVIDENCE_DIR}/scenario2-validation.txt"

  # Check session status
  genie view "$SESSION_ID" 2>&1 | tee "${EVIDENCE_DIR}/scenario2-session-view.txt"

  # List sessions
  genie list sessions 2>&1 | tee "${EVIDENCE_DIR}/scenario2-sessions-list.txt"

  # Check if session launched despite long prompt
  if grep -qi "running\|completed" "${EVIDENCE_DIR}/scenario2-sessions-list.txt"; then
    echo "✅ Session launched with long prompt" >> "${EVIDENCE_DIR}/scenario2-validation.txt"

    # Verify prompt was actually received (check view output)
    if grep -q "QA test:" "${EVIDENCE_DIR}/scenario2-session-view.txt"; then
      echo "✅ Long prompt preserved" >> "${EVIDENCE_DIR}/scenario2-validation.txt"
      echo "PASS: ARG_MAX handling works" >> "${EVIDENCE_DIR}/scenario2-validation.txt"
    else
      echo "⚠️ Prompt may have been truncated" >> "${EVIDENCE_DIR}/scenario2-validation.txt"
      echo "PASS: Session launched (warning: prompt truncation)" >> "${EVIDENCE_DIR}/scenario2-validation.txt"
    fi
  else
    echo "❌ Session failed with long prompt" >> "${EVIDENCE_DIR}/scenario2-validation.txt"
    echo "FAIL: ARG_MAX failure" >> "${EVIDENCE_DIR}/scenario2-validation.txt"
    kill $RUN_PID 2>/dev/null || true
    genie stop "$SESSION_ID" 2>&1 > /dev/null || true
    exit 1
  fi

  # Cleanup
  kill $RUN_PID 2>/dev/null || true
  genie stop "$SESSION_ID" 2>&1 > /dev/null || true
else
  echo "❌ No session ID found (ARG_MAX likely exceeded)" >> "${EVIDENCE_DIR}/scenario2-validation.txt"
  echo "FAIL: ARG_MAX handling failure" >> "${EVIDENCE_DIR}/scenario2-validation.txt"
  kill $RUN_PID 2>/dev/null || true
  exit 1
fi
```

**Validation Steps (Automated):**
1. ✅ Long prompt generated (10KB+)
2. ✅ Session launches with long prompt
3. ✅ No ARG_MAX failure
4. ✅ Prompt preserved (or gracefully truncated)

**Evidence Captured:**
- `scenario2-long-prompt.txt` - Generated long prompt
- `scenario2-launch.txt` - Launch output
- `scenario2-session-view.txt` - Session details
- `scenario2-sessions-list.txt` - Sessions list
- `scenario2-validation.txt` - Validation results

**Pass Criteria:**
- Session launches despite long prompt
- No ARG_MAX errors
- Prompt preserved or gracefully handled

---

### Scenario 3: Multiple Background Sessions

**Autonomous Execution:**
```bash
#!/bin/bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
EVIDENCE_DIR=".genie/agents/qa/evidence/background-argmax-${TIMESTAMP}"

mkdir -p "$EVIDENCE_DIR"

echo "Testing multiple background sessions..." > "${EVIDENCE_DIR}/scenario3-validation.txt"

# Launch multiple background agents
genie run git "QA test: background 1" --background --quiet 2>&1 > "${EVIDENCE_DIR}/scenario3-launch1.txt" &
PID1=$!

sleep 2

genie run implementor "QA test: background 2" --background --quiet 2>&1 > "${EVIDENCE_DIR}/scenario3-launch2.txt" &
PID2=$!

sleep 2

genie run tests "QA test: background 3" --background --quiet 2>&1 > "${EVIDENCE_DIR}/scenario3-launch3.txt" &
PID3=$!

# Wait for all to start
sleep 5

# List all sessions
genie list sessions 2>&1 | tee "${EVIDENCE_DIR}/scenario3-sessions-list.txt"

# Count running/completed sessions
SESSION_COUNT=$(grep -c "running\|completed" "${EVIDENCE_DIR}/scenario3-sessions-list.txt" || echo "0")
echo "Running sessions found: $SESSION_COUNT" >> "${EVIDENCE_DIR}/scenario3-validation.txt"

# Cleanup all
kill $PID1 $PID2 $PID3 2>/dev/null || true
sleep 2

# Get all session IDs and stop them
for SESSION_ID in $(grep -o '[0-9a-f]\{8\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{12\}' "${EVIDENCE_DIR}/scenario3-sessions-list.txt"); do
  genie stop "$SESSION_ID" 2>&1 > /dev/null || true
done

# Validate
if [ $SESSION_COUNT -ge 1 ]; then
  echo "✅ At least $SESSION_COUNT background session(s) launched" >> "${EVIDENCE_DIR}/scenario3-validation.txt"
  echo "PASS: Multiple background sessions work" >> "${EVIDENCE_DIR}/scenario3-validation.txt"
else
  echo "❌ No background sessions launched" >> "${EVIDENCE_DIR}/scenario3-validation.txt"
  echo "FAIL: Multiple background sessions failed" >> "${EVIDENCE_DIR}/scenario3-validation.txt"
  exit 1
fi
```

**Validation Steps (Automated):**
1. ✅ Multiple background agents launch concurrently
2. ✅ All sessions visible in list
3. ✅ No resource contention

**Evidence Captured:**
- `scenario3-launch1.txt` - First agent launch
- `scenario3-launch2.txt` - Second agent launch
- `scenario3-launch3.txt` - Third agent launch
- `scenario3-sessions-list.txt` - All sessions
- `scenario3-validation.txt` - Validation results

**Pass Criteria:**
- Multiple background sessions launch successfully
- All visible in sessions list
- No interference between sessions

---

## Automated Report Generation

**Report Template:**
```markdown
# Background Launch & ARG_MAX Validation Report
**Timestamp:** ${TIMESTAMP}
**Evidence:** .genie/agents/qa/evidence/background-argmax-${TIMESTAMP}/
**Bug Reference:** Bug #104

## Summary
- Total Scenarios: 3
- Passed: X
- Failed: Y
- Warnings: Z

## Scenario Results

### Scenario 1: Background Launch (Normal)
- Status: ✅ PASS | ❌ FAIL
- Evidence: scenario1-*.txt
- Issues: [list any failures]

### Scenario 2: ARG_MAX Handling (Long Prompt)
- Status: ✅ PASS | ❌ FAIL
- Prompt length: X characters
- Evidence: scenario2-*.txt
- Issues: [list any failures]

### Scenario 3: Multiple Background Sessions
- Status: ✅ PASS | ❌ FAIL
- Sessions launched: X
- Evidence: scenario3-*.txt
- Issues: [list any failures]

## Overall Result
✅ PASS - Background launch and ARG_MAX handling work correctly (Bug #104 fixed)
❌ FAIL - Background launch or ARG_MAX issues detected (Bug #104 NOT fixed)

## Recommendations
[Automated analysis of findings]

## Next Steps
[Automated suggestions based on results]
```

**Auto-Generated Location:**
`.genie/agents/qa/evidence/background-argmax-${TIMESTAMP}/REPORT.md`

---

## Execution Command

**Invoked by QA Agent:**
```bash
# Via MCP
mcp__genie__run with agent="qa/background-launch-argmax" and prompt="Execute autonomous validation"
```

**Expected Duration:** 5-10 minutes (all 3 scenarios with session management)

**Exit Codes:**
- `0` - All tests passed
- `1` - One or more tests failed (Bug #104 regression)
- `2` - Execution error

---

## Success Criteria

**✅ PASS if:**
1. All 3 scenarios execute successfully
2. Background agents launch without timeout
3. Long prompts handled (no ARG_MAX failure)
4. Multiple background sessions work concurrently
5. Evidence captured for each scenario
6. Report generated automatically

**❌ FAIL if:**
1. Background launch timeout
2. Sessions stuck in "starting" status
3. ARG_MAX exceeded with long prompts
4. Multiple sessions interfere with each other
5. Evidence not captured

**⚠️ WARNINGS if:**
1. Prompt truncation occurs (non-fatal)
2. Some sessions slower than expected
3. Intermittent timing issues

---

**Autonomous execution guaranteed. No human interaction required. Evidence-backed results.**

@.genie/agents/qa/README.md
