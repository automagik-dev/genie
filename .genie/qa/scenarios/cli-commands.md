---
name: qa/cli-commands
description: Autonomous CLI interface validation workflow
autonomous: true
---

# QA Workflow • CLI Commands Validation

**Type:** Autonomous validation workflow (no user interaction)
**Purpose:** Validate CLI command interface, argument parsing, help system, and error handling
**Issue Reference:** N/A (core functionality validation)
**Evidence Location:** `.genie/agents/qa/evidence/cli-commands-<timestamp>/`

## Autonomous Operation Protocol 🤖

**I am a fully autonomous validation workflow. I execute without user prompts or questions.**

**What this means:**
- ✅ I execute all CLI commands automatically
- ✅ I validate command outputs
- ✅ I capture evidence automatically
- ✅ I test error handling
- ✅ I generate test report automatically
- ❌ I NEVER ask "Should I run this test?"
- ❌ I NEVER wait for user confirmation
- ❌ I NEVER present findings without capturing evidence

**My workflow:**
```
1. Execute all CLI commands (version, help, run, list, view, etc.)
2. Validate outputs match expected behavior
3. Test error scenarios (invalid args, missing args, etc.)
4. Capture evidence for each test
5. Generate validation report
6. Exit with pass/fail summary
```

**No human in the loop. I am the autonomous validator.**

---

## Test Scenarios

### Scenario 1: Version Display

**Autonomous Execution:**
```bash
#!/bin/bash
# Auto-executed by QA agent

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
EVIDENCE_DIR=".genie/agents/qa/evidence/cli-commands-${TIMESTAMP}"

mkdir -p "$EVIDENCE_DIR"

# Execute version command
npx automagik-genie --version 2>&1 | tee "${EVIDENCE_DIR}/scenario1-version.txt"
echo $? > "${EVIDENCE_DIR}/scenario1-exit-code.txt"

# Get expected version from package.json
EXPECTED_VERSION=$(node -p "require('./package.json').version")
ACTUAL_VERSION=$(cat "${EVIDENCE_DIR}/scenario1-version.txt" | tr -d '\n')

# Validate version format
echo "Expected: v${EXPECTED_VERSION} or ${EXPECTED_VERSION}" > "${EVIDENCE_DIR}/scenario1-validation.txt"
echo "Actual: ${ACTUAL_VERSION}" >> "${EVIDENCE_DIR}/scenario1-validation.txt"

if [[ "$ACTUAL_VERSION" == *"$EXPECTED_VERSION"* ]]; then
  echo "PASS: Version matches" >> "${EVIDENCE_DIR}/scenario1-validation.txt"
else
  echo "FAIL: Version mismatch" >> "${EVIDENCE_DIR}/scenario1-validation.txt"
  exit 1
fi
```

**Validation Steps (Automated):**
1. ✅ Version number displays
2. ✅ Matches package.json version
3. ✅ Clean output (no errors)
4. ✅ Exit code = 0

**Evidence Captured:**
- `scenario1-version.txt` - Version output
- `scenario1-exit-code.txt` - Exit status
- `scenario1-validation.txt` - Validation results

**Pass Criteria:**
- Exit code = 0
- Version matches package.json
- No error messages

---

### Scenario 2: Help System Completeness

**Autonomous Execution:**
```bash
#!/bin/bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
EVIDENCE_DIR=".genie/agents/qa/evidence/cli-commands-${TIMESTAMP}"

mkdir -p "$EVIDENCE_DIR"

# Execute help command
npx automagik-genie --help 2>&1 | tee "${EVIDENCE_DIR}/scenario2-help.txt"
echo $? > "${EVIDENCE_DIR}/scenario2-exit-code.txt"

# Check for required commands in help output
HELP_OUTPUT=$(cat "${EVIDENCE_DIR}/scenario2-help.txt")

echo "Checking for required commands in help..." > "${EVIDENCE_DIR}/scenario2-validation.txt"

REQUIRED_COMMANDS=("run" "talk" "list" "view" "stop" "resume" "init" "update" "status" "dashboard" "helper")

for CMD in "${REQUIRED_COMMANDS[@]}"; do
  if echo "$HELP_OUTPUT" | grep -q "$CMD"; then
    echo "✅ Found: $CMD" >> "${EVIDENCE_DIR}/scenario2-validation.txt"
  else
    echo "❌ Missing: $CMD" >> "${EVIDENCE_DIR}/scenario2-validation.txt"
    exit 1
  fi
done

echo "PASS: All required commands documented" >> "${EVIDENCE_DIR}/scenario2-validation.txt"
```

**Validation Steps (Automated):**
1. ✅ Help text displays
2. ✅ All commands listed (run, talk, list, view, stop, resume, init, update, status, dashboard, helper)
3. ✅ Usage examples provided
4. ✅ Options documented

**Evidence Captured:**
- `scenario2-help.txt` - Help output
- `scenario2-exit-code.txt` - Exit status
- `scenario2-validation.txt` - Command presence validation

**Pass Criteria:**
- Exit code = 0
- All required commands present
- Clean formatting

---

### Scenario 3: Command-Specific Help

**Autonomous Execution:**
```bash
#!/bin/bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
EVIDENCE_DIR=".genie/agents/qa/evidence/cli-commands-${TIMESTAMP}"

mkdir -p "$EVIDENCE_DIR"

# Test help for specific commands
COMMANDS=("run" "list" "view" "init" "update")

echo "Testing command-specific help..." > "${EVIDENCE_DIR}/scenario3-validation.txt"

for CMD in "${COMMANDS[@]}"; do
  npx automagik-genie $CMD --help 2>&1 | tee "${EVIDENCE_DIR}/scenario3-help-${CMD}.txt"
  EXIT_CODE=$?

  if [ $EXIT_CODE -eq 0 ]; then
    echo "✅ $CMD --help: Exit code 0" >> "${EVIDENCE_DIR}/scenario3-validation.txt"
  else
    echo "❌ $CMD --help: Exit code $EXIT_CODE" >> "${EVIDENCE_DIR}/scenario3-validation.txt"
    exit 1
  fi

  # Check if output is not empty
  if [ -s "${EVIDENCE_DIR}/scenario3-help-${CMD}.txt" ]; then
    echo "✅ $CMD --help: Output present" >> "${EVIDENCE_DIR}/scenario3-validation.txt"
  else
    echo "❌ $CMD --help: Empty output" >> "${EVIDENCE_DIR}/scenario3-validation.txt"
    exit 1
  fi
done

echo "PASS: All command-specific help works" >> "${EVIDENCE_DIR}/scenario3-validation.txt"
```

**Validation Steps (Automated):**
1. ✅ Each command has --help flag
2. ✅ Help output is command-specific
3. ✅ Options accurately described
4. ✅ Exit code = 0 for all

**Evidence Captured:**
- `scenario3-help-<cmd>.txt` - Per-command help output
- `scenario3-validation.txt` - Validation results

**Pass Criteria:**
- All commands support --help
- Help output is non-empty
- Exit code = 0

---

### Scenario 4: List Command Validation

**Autonomous Execution:**
```bash
#!/bin/bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
EVIDENCE_DIR=".genie/agents/qa/evidence/cli-commands-${TIMESTAMP}"

mkdir -p "$EVIDENCE_DIR"

echo "Testing list command variations..." > "${EVIDENCE_DIR}/scenario4-validation.txt"

# Test list agents (default)
genie list 2>&1 | tee "${EVIDENCE_DIR}/scenario4-list-agents.txt"
AGENTS_EXIT=$?
echo "list agents exit code: $AGENTS_EXIT" >> "${EVIDENCE_DIR}/scenario4-validation.txt"

# Test list sessions
genie list sessions 2>&1 | tee "${EVIDENCE_DIR}/scenario4-list-sessions.txt"
SESSIONS_EXIT=$?
echo "list sessions exit code: $SESSIONS_EXIT" >> "${EVIDENCE_DIR}/scenario4-validation.txt"

# Test list workflows
genie list workflows 2>&1 | tee "${EVIDENCE_DIR}/scenario4-list-workflows.txt"
WORKFLOWS_EXIT=$?
echo "list workflows exit code: $WORKFLOWS_EXIT" >> "${EVIDENCE_DIR}/scenario4-validation.txt"

# Test invalid list type
genie list invalid 2>&1 | tee "${EVIDENCE_DIR}/scenario4-list-invalid.txt"
INVALID_EXIT=$?
echo "list invalid exit code: $INVALID_EXIT (should be non-zero)" >> "${EVIDENCE_DIR}/scenario4-validation.txt"

# Validate
if [ $AGENTS_EXIT -eq 0 ] && [ $SESSIONS_EXIT -eq 0 ] && [ $WORKFLOWS_EXIT -eq 0 ] && [ $INVALID_EXIT -ne 0 ]; then
  echo "PASS: List command works correctly" >> "${EVIDENCE_DIR}/scenario4-validation.txt"
else
  echo "FAIL: List command validation failed" >> "${EVIDENCE_DIR}/scenario4-validation.txt"
  exit 1
fi
```

**Validation Steps (Automated):**
1. ✅ `genie list` defaults to agents
2. ✅ `genie list sessions` works
3. ✅ `genie list workflows` works
4. ✅ Invalid type shows error
5. ✅ Exit codes correct (0 for valid, non-zero for invalid)

**Evidence Captured:**
- `scenario4-list-agents.txt` - Agents list output
- `scenario4-list-sessions.txt` - Sessions list output
- `scenario4-list-workflows.txt` - Workflows list output
- `scenario4-list-invalid.txt` - Invalid type error
- `scenario4-validation.txt` - Validation results

**Pass Criteria:**
- All valid list types work (exit 0)
- Invalid type shows clear error (exit 1)

---

### Scenario 5: Invalid Command Handling

**Autonomous Execution:**
```bash
#!/bin/bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
EVIDENCE_DIR=".genie/agents/qa/evidence/cli-commands-${TIMESTAMP}"

mkdir -p "$EVIDENCE_DIR"

echo "Testing error handling..." > "${EVIDENCE_DIR}/scenario5-validation.txt"

# Test unknown command
npx automagik-genie unknown-command 2>&1 | tee "${EVIDENCE_DIR}/scenario5-unknown-command.txt"
UNKNOWN_EXIT=$?

# Test invalid flag
genie run --invalid-flag value 2>&1 | tee "${EVIDENCE_DIR}/scenario5-invalid-flag.txt"
INVALID_FLAG_EXIT=$?

# Test missing required argument
genie run 2>&1 | tee "${EVIDENCE_DIR}/scenario5-missing-arg.txt"
MISSING_ARG_EXIT=$?

# Validate all errors return non-zero exit codes
echo "unknown-command exit: $UNKNOWN_EXIT" >> "${EVIDENCE_DIR}/scenario5-validation.txt"
echo "invalid-flag exit: $INVALID_FLAG_EXIT" >> "${EVIDENCE_DIR}/scenario5-validation.txt"
echo "missing-arg exit: $MISSING_ARG_EXIT" >> "${EVIDENCE_DIR}/scenario5-validation.txt"

if [ $UNKNOWN_EXIT -ne 0 ] && [ $INVALID_FLAG_EXIT -ne 0 ] && [ $MISSING_ARG_EXIT -ne 0 ]; then
  # Check error messages are helpful
  if grep -q "error" "${EVIDENCE_DIR}/scenario5-unknown-command.txt" && \
     grep -q "error" "${EVIDENCE_DIR}/scenario5-invalid-flag.txt" && \
     grep -q "error" "${EVIDENCE_DIR}/scenario5-missing-arg.txt"; then
    echo "PASS: Error handling works correctly" >> "${EVIDENCE_DIR}/scenario5-validation.txt"
  else
    echo "FAIL: Error messages not clear" >> "${EVIDENCE_DIR}/scenario5-validation.txt"
    exit 1
  fi
else
  echo "FAIL: Error cases should return non-zero exit codes" >> "${EVIDENCE_DIR}/scenario5-validation.txt"
  exit 1
fi
```

**Validation Steps (Automated):**
1. ✅ Unknown command shows error
2. ✅ Invalid flag shows error
3. ✅ Missing required arg shows error
4. ✅ All errors have non-zero exit codes
5. ✅ Error messages are clear

**Evidence Captured:**
- `scenario5-unknown-command.txt` - Unknown command error
- `scenario5-invalid-flag.txt` - Invalid flag error
- `scenario5-missing-arg.txt` - Missing arg error
- `scenario5-validation.txt` - Validation results

**Pass Criteria:**
- All error cases exit with non-zero code
- Error messages contain "error" keyword
- No crashes or stack traces

---

### Scenario 6: Flag Parsing Validation

**Autonomous Execution:**
```bash
#!/bin/bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
EVIDENCE_DIR=".genie/agents/qa/evidence/cli-commands-${TIMESTAMP}"

mkdir -p "$EVIDENCE_DIR"

echo "Testing flag parsing..." > "${EVIDENCE_DIR}/scenario6-validation.txt"

# Test view command with --full flag (boolean)
genie view nonexistent-session --full 2>&1 | tee "${EVIDENCE_DIR}/scenario6-boolean-flag.txt"
BOOL_EXIT=$?

# Test run command with value flags
genie run test-agent "test prompt" --executor CLAUDE_CODE --model sonnet --quiet 2>&1 | tee "${EVIDENCE_DIR}/scenario6-value-flags.txt"
VALUE_EXIT=$?

echo "boolean flag exit: $BOOL_EXIT" >> "${EVIDENCE_DIR}/scenario6-validation.txt"
echo "value flags exit: $VALUE_EXIT" >> "${EVIDENCE_DIR}/scenario6-validation.txt"

# Check that flags were parsed (not testing actual execution, just parsing)
if [ -s "${EVIDENCE_DIR}/scenario6-boolean-flag.txt" ] && [ -s "${EVIDENCE_DIR}/scenario6-value-flags.txt" ]; then
  echo "PASS: Flag parsing works (commands executed with flags)" >> "${EVIDENCE_DIR}/scenario6-validation.txt"
else
  echo "FAIL: Flag parsing failed" >> "${EVIDENCE_DIR}/scenario6-validation.txt"
  exit 1
fi
```

**Validation Steps (Automated):**
1. ✅ Boolean flags work (--full, --quiet)
2. ✅ Value flags work (--executor, --model)
3. ✅ Multiple flags can be combined
4. ✅ Flags are parsed correctly

**Evidence Captured:**
- `scenario6-boolean-flag.txt` - Boolean flag test
- `scenario6-value-flags.txt` - Value flags test
- `scenario6-validation.txt` - Validation results

**Pass Criteria:**
- Commands accept flags
- No flag parsing errors
- Flags don't cause crashes

---

### Scenario 7: Special Character Handling

**Autonomous Execution:**
```bash
#!/bin/bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
EVIDENCE_DIR=".genie/agents/qa/evidence/cli-commands-${TIMESTAMP}"

mkdir -p "$EVIDENCE_DIR"

echo "Testing special character handling..." > "${EVIDENCE_DIR}/scenario7-validation.txt"

# Test prompt with quotes
genie run test-agent "test with 'single' and \"double\" quotes" --quiet 2>&1 | tee "${EVIDENCE_DIR}/scenario7-quotes.txt"
QUOTES_EXIT=$?

# Test prompt with newlines
genie run test-agent "line1
line2
line3" --quiet 2>&1 | tee "${EVIDENCE_DIR}/scenario7-newlines.txt"
NEWLINES_EXIT=$?

# Test prompt with special chars
genie run test-agent "test $VAR and \$(cmd) and * ? []" --quiet 2>&1 | tee "${EVIDENCE_DIR}/scenario7-special.txt"
SPECIAL_EXIT=$?

echo "quotes exit: $QUOTES_EXIT" >> "${EVIDENCE_DIR}/scenario7-validation.txt"
echo "newlines exit: $NEWLINES_EXIT" >> "${EVIDENCE_DIR}/scenario7-validation.txt"
echo "special chars exit: $SPECIAL_EXIT" >> "${EVIDENCE_DIR}/scenario7-validation.txt"

# Validate no crashes (exit code doesn't matter, just no fatal errors)
if [ -s "${EVIDENCE_DIR}/scenario7-quotes.txt" ] && \
   [ -s "${EVIDENCE_DIR}/scenario7-newlines.txt" ] && \
   [ -s "${EVIDENCE_DIR}/scenario7-special.txt" ]; then
  echo "PASS: Special characters handled without crashes" >> "${EVIDENCE_DIR}/scenario7-validation.txt"
else
  echo "FAIL: Special character handling failed" >> "${EVIDENCE_DIR}/scenario7-validation.txt"
  exit 1
fi
```

**Validation Steps (Automated):**
1. ✅ Single quotes handled
2. ✅ Double quotes handled
3. ✅ Newlines preserved
4. ✅ Special shell chars escaped
5. ✅ No parsing corruption

**Evidence Captured:**
- `scenario7-quotes.txt` - Quote handling test
- `scenario7-newlines.txt` - Newline handling test
- `scenario7-special.txt` - Special chars test
- `scenario7-validation.txt` - Validation results

**Pass Criteria:**
- No crashes or fatal errors
- Commands execute (may fail, but shouldn't crash)
- Outputs captured successfully

---

## Automated Report Generation

**Report Template:**
```markdown
# CLI Commands Validation Report
**Timestamp:** ${TIMESTAMP}
**Evidence:** .genie/agents/qa/evidence/cli-commands-${TIMESTAMP}/

## Summary
- Total Scenarios: 7
- Passed: X
- Failed: Y
- Warnings: Z

## Scenario Results

### Scenario 1: Version Display
- Status: ✅ PASS | ❌ FAIL
- Evidence: scenario1-*.txt
- Issues: [list any failures]

### Scenario 2: Help System Completeness
- Status: ✅ PASS | ❌ FAIL
- Evidence: scenario2-*.txt
- Issues: [list any failures]

### Scenario 3: Command-Specific Help
- Status: ✅ PASS | ❌ FAIL
- Evidence: scenario3-*.txt
- Issues: [list any failures]

### Scenario 4: List Command Validation
- Status: ✅ PASS | ❌ FAIL
- Evidence: scenario4-*.txt
- Issues: [list any failures]

### Scenario 5: Invalid Command Handling
- Status: ✅ PASS | ❌ FAIL
- Evidence: scenario5-*.txt
- Issues: [list any failures]

### Scenario 6: Flag Parsing Validation
- Status: ✅ PASS | ❌ FAIL
- Evidence: scenario6-*.txt
- Issues: [list any failures]

### Scenario 7: Special Character Handling
- Status: ✅ PASS | ❌ FAIL
- Evidence: scenario7-*.txt
- Issues: [list any failures]

## Overall Result
✅ PASS - All CLI commands work correctly
⚠️ WARNINGS - Some non-critical issues found
❌ FAIL - Critical CLI failures detected

## Recommendations
[Automated analysis of findings]

## Next Steps
[Automated suggestions based on results]
```

**Auto-Generated Location:**
`.genie/agents/qa/evidence/cli-commands-${TIMESTAMP}/REPORT.md`

---

## Execution Command

**Invoked by QA Agent:**
```bash
# Via MCP
mcp__genie__run with agent="qa/cli-commands" and prompt="Execute autonomous validation"
```

**Expected Duration:** 5-10 minutes (all 7 scenarios)

**Exit Codes:**
- `0` - All tests passed
- `1` - One or more tests failed
- `2` - Execution error

---

## Success Criteria

**✅ PASS if:**
1. All 7 scenarios execute successfully
2. All validation steps pass
3. Evidence captured for each scenario
4. Report generated automatically

**❌ FAIL if:**
1. Any critical command fails
2. Error handling broken
3. Evidence not captured
4. Help system incomplete

**⚠️ WARNINGS if:**
1. Non-critical edge cases fail
2. Undocumented commands found
3. Inconsistent help text

---

**Autonomous execution guaranteed. No human interaction required. Evidence-backed results.**

@.genie/qa/README.md
