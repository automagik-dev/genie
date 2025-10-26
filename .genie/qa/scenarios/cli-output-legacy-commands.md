---
name: qa/cli-output-legacy
description: Autonomous validation that CLI output references MCP tools, not legacy ./genie commands
autonomous: true
---

# QA Workflow • CLI Output Legacy Commands Validation

**Type:** Autonomous validation workflow (no user interaction)
**Purpose:** Ensure session output references MCP tools, not legacy `./genie` commands (Bug #88/#89 fix)
**Issue Reference:** Bug #88, Bug #89
**Evidence Location:** `.genie/agents/qa/evidence/cli-output-legacy-<timestamp>/`

## Autonomous Operation Protocol 🤖

**I am a fully autonomous validation workflow. I execute without user prompts or questions.**

**What this means:**
- ✅ I execute CLI commands automatically
- ✅ I capture output and scan for legacy references
- ✅ I validate against success criteria
- ✅ I capture evidence automatically
- ✅ I generate test report automatically
- ❌ I NEVER ask "Should I run this test?"
- ❌ I NEVER wait for user confirmation
- ❌ I NEVER present findings without capturing evidence

**My workflow:**
```
1. Execute test commands (genie run, list, view, etc.)
2. Capture all output from each command
3. Scan output for legacy ./genie references
4. Validate preferred references (MCP tools, npx automagik-genie)
5. Generate validation report
6. Exit with pass/fail summary
```

**No human in the loop. I am the autonomous validator.**

---

## Test Scenarios

### Scenario 1: Run Command Output

**Autonomous Execution:**
```bash
#!/bin/bash
# Auto-executed by QA agent

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
EVIDENCE_DIR=".genie/agents/qa/evidence/cli-output-legacy-${TIMESTAMP}"

mkdir -p "$EVIDENCE_DIR"

echo "Testing genie run output for legacy references..." > "${EVIDENCE_DIR}/scenario1-validation.txt"

# Run a test agent and capture output
genie run genie "QA test: check output format" --quiet 2>&1 | tee "${EVIDENCE_DIR}/scenario1-run-output.txt" &
RUN_PID=$!

# Wait briefly
sleep 3

# Kill test session
kill $RUN_PID 2>/dev/null || true

# Scan for legacy references
LEGACY_COUNT=$(grep -c "\./genie" "${EVIDENCE_DIR}/scenario1-run-output.txt" || echo "0")
echo "Legacy ./genie references found: $LEGACY_COUNT" >> "${EVIDENCE_DIR}/scenario1-validation.txt"

# Scan for preferred references
MCP_COUNT=$(grep -c "mcp__genie__" "${EVIDENCE_DIR}/scenario1-run-output.txt" || echo "0")
NPX_COUNT=$(grep -c "npx automagik-genie" "${EVIDENCE_DIR}/scenario1-run-output.txt" || echo "0")
GENIE_CMD_COUNT=$(grep -c "genie " "${EVIDENCE_DIR}/scenario1-run-output.txt" || echo "0")

echo "MCP tool references: $MCP_COUNT" >> "${EVIDENCE_DIR}/scenario1-validation.txt"
echo "npx automagik-genie references: $NPX_COUNT" >> "${EVIDENCE_DIR}/scenario1-validation.txt"
echo "genie command references: $GENIE_CMD_COUNT" >> "${EVIDENCE_DIR}/scenario1-validation.txt"

# Validate
if [ $LEGACY_COUNT -eq 0 ]; then
  echo "✅ No legacy ./genie references found" >> "${EVIDENCE_DIR}/scenario1-validation.txt"
  echo "PASS: Run command output clean" >> "${EVIDENCE_DIR}/scenario1-validation.txt"
else
  echo "❌ Found $LEGACY_COUNT legacy ./genie references" >> "${EVIDENCE_DIR}/scenario1-validation.txt"
  grep "\./genie" "${EVIDENCE_DIR}/scenario1-run-output.txt" >> "${EVIDENCE_DIR}/scenario1-validation.txt" || true
  echo "FAIL: Legacy references present" >> "${EVIDENCE_DIR}/scenario1-validation.txt"
  exit 1
fi
```

**Validation Steps (Automated):**
1. ✅ Run command executed
2. ✅ Output captured
3. ✅ No `./genie` references found
4. ✅ Preferred references used (MCP tools or `genie` command)

**Evidence Captured:**
- `scenario1-run-output.txt` - Command output
- `scenario1-validation.txt` - Validation results

**Pass Criteria:**
- Zero occurrences of `./genie` in output
- MCP tools or `genie` command referenced instead

---

### Scenario 2: List Command Output

**Autonomous Execution:**
```bash
#!/bin/bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
EVIDENCE_DIR=".genie/agents/qa/evidence/cli-output-legacy-${TIMESTAMP}"

mkdir -p "$EVIDENCE_DIR"

echo "Testing genie list output for legacy references..." > "${EVIDENCE_DIR}/scenario2-validation.txt"

# List agents and sessions
genie list agents 2>&1 | tee "${EVIDENCE_DIR}/scenario2-list-agents-output.txt"
genie list sessions 2>&1 | tee "${EVIDENCE_DIR}/scenario2-list-sessions-output.txt"

# Scan for legacy references in both outputs
LEGACY_AGENTS=$(grep -c "\./genie" "${EVIDENCE_DIR}/scenario2-list-agents-output.txt" || echo "0")
LEGACY_SESSIONS=$(grep -c "\./genie" "${EVIDENCE_DIR}/scenario2-list-sessions-output.txt" || echo "0")
TOTAL_LEGACY=$((LEGACY_AGENTS + LEGACY_SESSIONS))

echo "Legacy references in list agents: $LEGACY_AGENTS" >> "${EVIDENCE_DIR}/scenario2-validation.txt"
echo "Legacy references in list sessions: $LEGACY_SESSIONS" >> "${EVIDENCE_DIR}/scenario2-validation.txt"
echo "Total legacy references: $TOTAL_LEGACY" >> "${EVIDENCE_DIR}/scenario2-validation.txt"

# Validate
if [ $TOTAL_LEGACY -eq 0 ]; then
  echo "✅ No legacy ./genie references in list outputs" >> "${EVIDENCE_DIR}/scenario2-validation.txt"
  echo "PASS: List command outputs clean" >> "${EVIDENCE_DIR}/scenario2-validation.txt"
else
  echo "❌ Found $TOTAL_LEGACY legacy ./genie references" >> "${EVIDENCE_DIR}/scenario2-validation.txt"
  echo "FAIL: Legacy references present" >> "${EVIDENCE_DIR}/scenario2-validation.txt"
  exit 1
fi
```

**Validation Steps (Automated):**
1. ✅ List commands executed
2. ✅ Outputs captured
3. ✅ No `./genie` references found

**Evidence Captured:**
- `scenario2-list-agents-output.txt` - List agents output
- `scenario2-list-sessions-output.txt` - List sessions output
- `scenario2-validation.txt` - Validation results

**Pass Criteria:**
- Zero occurrences of `./genie` in list outputs

---

### Scenario 3: Help Command Output

**Autonomous Execution:**
```bash
#!/bin/bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
EVIDENCE_DIR=".genie/agents/qa/evidence/cli-output-legacy-${TIMESTAMP}"

mkdir -p "$EVIDENCE_DIR"

echo "Testing help output for legacy references..." > "${EVIDENCE_DIR}/scenario3-validation.txt"

# Get help output
genie --help 2>&1 | tee "${EVIDENCE_DIR}/scenario3-help-output.txt"
genie run --help 2>&1 | tee "${EVIDENCE_DIR}/scenario3-run-help-output.txt"
genie list --help 2>&1 | tee "${EVIDENCE_DIR}/scenario3-list-help-output.txt"

# Scan for legacy references
LEGACY_MAIN=$(grep -c "\./genie" "${EVIDENCE_DIR}/scenario3-help-output.txt" || echo "0")
LEGACY_RUN=$(grep -c "\./genie" "${EVIDENCE_DIR}/scenario3-run-help-output.txt" || echo "0")
LEGACY_LIST=$(grep -c "\./genie" "${EVIDENCE_DIR}/scenario3-list-help-output.txt" || echo "0")
TOTAL_LEGACY=$((LEGACY_MAIN + LEGACY_RUN + LEGACY_LIST))

echo "Legacy references in main help: $LEGACY_MAIN" >> "${EVIDENCE_DIR}/scenario3-validation.txt"
echo "Legacy references in run help: $LEGACY_RUN" >> "${EVIDENCE_DIR}/scenario3-validation.txt"
echo "Legacy references in list help: $LEGACY_LIST" >> "${EVIDENCE_DIR}/scenario3-validation.txt"
echo "Total legacy references: $TOTAL_LEGACY" >> "${EVIDENCE_DIR}/scenario3-validation.txt"

# Validate
if [ $TOTAL_LEGACY -eq 0 ]; then
  echo "✅ No legacy ./genie references in help text" >> "${EVIDENCE_DIR}/scenario3-validation.txt"
  echo "PASS: Help outputs clean" >> "${EVIDENCE_DIR}/scenario3-validation.txt"
else
  echo "❌ Found $TOTAL_LEGACY legacy ./genie references in help text" >> "${EVIDENCE_DIR}/scenario3-validation.txt"
  echo "FAIL: Legacy references in help" >> "${EVIDENCE_DIR}/scenario3-validation.txt"
  exit 1
fi
```

**Validation Steps (Automated):**
1. ✅ Help commands executed
2. ✅ Outputs captured
3. ✅ No `./genie` references found in help text

**Evidence Captured:**
- `scenario3-help-output.txt` - Main help
- `scenario3-run-help-output.txt` - Run command help
- `scenario3-list-help-output.txt` - List command help
- `scenario3-validation.txt` - Validation results

**Pass Criteria:**
- Zero occurrences of `./genie` in help outputs
- Documentation uses `genie` command or `npx automagik-genie`

---

### Scenario 4: Error Messages

**Autonomous Execution:**
```bash
#!/bin/bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
EVIDENCE_DIR=".genie/agents/qa/evidence/cli-output-legacy-${TIMESTAMP}"

mkdir -p "$EVIDENCE_DIR"

echo "Testing error messages for legacy references..." > "${EVIDENCE_DIR}/scenario4-validation.txt"

# Trigger errors to check error messages
genie run nonexistent "test" --quiet 2>&1 | tee "${EVIDENCE_DIR}/scenario4-error-invalid-agent.txt"
genie view invalid-session-id 2>&1 | tee "${EVIDENCE_DIR}/scenario4-error-invalid-session.txt"

# Scan for legacy references
LEGACY_AGENT_ERR=$(grep -c "\./genie" "${EVIDENCE_DIR}/scenario4-error-invalid-agent.txt" || echo "0")
LEGACY_SESSION_ERR=$(grep -c "\./genie" "${EVIDENCE_DIR}/scenario4-error-invalid-session.txt" || echo "0")
TOTAL_LEGACY=$((LEGACY_AGENT_ERR + LEGACY_SESSION_ERR))

echo "Legacy references in agent error: $LEGACY_AGENT_ERR" >> "${EVIDENCE_DIR}/scenario4-validation.txt"
echo "Legacy references in session error: $LEGACY_SESSION_ERR" >> "${EVIDENCE_DIR}/scenario4-validation.txt"
echo "Total legacy references: $TOTAL_LEGACY" >> "${EVIDENCE_DIR}/scenario4-validation.txt"

# Validate
if [ $TOTAL_LEGACY -eq 0 ]; then
  echo "✅ No legacy ./genie references in error messages" >> "${EVIDENCE_DIR}/scenario4-validation.txt"
  echo "PASS: Error messages clean" >> "${EVIDENCE_DIR}/scenario4-validation.txt"
else
  echo "❌ Found $TOTAL_LEGACY legacy ./genie references in errors" >> "${EVIDENCE_DIR}/scenario4-validation.txt"
  echo "FAIL: Legacy references in error messages" >> "${EVIDENCE_DIR}/scenario4-validation.txt"
  exit 1
fi
```

**Validation Steps (Automated):**
1. ✅ Error scenarios triggered
2. ✅ Error messages captured
3. ✅ No `./genie` references found in error messages

**Evidence Captured:**
- `scenario4-error-invalid-agent.txt` - Agent error message
- `scenario4-error-invalid-session.txt` - Session error message
- `scenario4-validation.txt` - Validation results

**Pass Criteria:**
- Zero occurrences of `./genie` in error messages
- Errors reference proper commands (MCP tools or `genie` CLI)

---

## Automated Report Generation

**Report Template:**
```markdown
# CLI Output Legacy Commands Validation Report
**Timestamp:** ${TIMESTAMP}
**Evidence:** .genie/agents/qa/evidence/cli-output-legacy-${TIMESTAMP}/

## Bug References
- Bug #88: CLI output references ./genie instead of MCP tools
- Bug #89: Legacy command references in user-facing output

## Summary
- Total Scenarios: 4
- Passed: X
- Failed: Y
- Legacy References Found: Z

## Scenario Results

### Scenario 1: Run Command Output
- Status: ✅ PASS | ❌ FAIL
- Legacy references: X
- Evidence: scenario1-*.txt

### Scenario 2: List Command Output
- Status: ✅ PASS | ❌ FAIL
- Legacy references: X
- Evidence: scenario2-*.txt

### Scenario 3: Help Command Output
- Status: ✅ PASS | ❌ FAIL
- Legacy references: X
- Evidence: scenario3-*.txt

### Scenario 4: Error Messages
- Status: ✅ PASS | ❌ FAIL
- Legacy references: X
- Evidence: scenario4-*.txt

## Overall Result
✅ PASS - No legacy ./genie references found (Bug #88/#89 fixed)
❌ FAIL - Legacy references still present (Bug #88/#89 NOT fixed)

## Legacy References Found
[List all instances of ./genie found in outputs]

## Recommendations
[Automated analysis based on results]
```

**Auto-Generated Location:**
`.genie/agents/qa/evidence/cli-output-legacy-${TIMESTAMP}/REPORT.md`

---

## Execution Command

**Invoked by QA Agent:**
```bash
# Via MCP
mcp__genie__run with agent="qa/cli-output-legacy" and prompt="Execute autonomous validation"
```

**Expected Duration:** 3-5 minutes (all 4 scenarios)

**Exit Codes:**
- `0` - All tests passed (no legacy references)
- `1` - One or more legacy references found (Bug #88/#89 regression)
- `2` - Execution error

---

## Success Criteria

**✅ PASS if:**
1. All 4 scenarios execute successfully
2. Zero occurrences of `./genie` in any output
3. Evidence captured for each scenario
4. Report generated automatically

**❌ FAIL if:**
1. Any legacy `./genie` references found
2. Bug #88/#89 regression detected
3. Evidence not captured

**⚠️ WARNINGS if:**
1. Non-critical legacy references in comments or documentation
2. References in explicitly backward-compatible contexts

---

## Preferred Reference Patterns

**✅ GOOD:**
- `mcp__genie__run with agent="X" and prompt="Y"`
- `mcp__genie__view with sessionId="<id>"`
- `mcp__genie__list_sessions`
- `genie run X "Y"`
- `npx automagik-genie run X "Y"`

**❌ BAD (Legacy):**
- `./genie run X "Y"`
- `./genie view <id>`
- `./genie list`
- Any reference to `./genie`

---

**Autonomous execution guaranteed. No human interaction required. Evidence-backed results.**

@.genie/qa/README.md
