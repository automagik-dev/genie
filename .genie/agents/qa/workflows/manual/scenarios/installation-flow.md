---
name: qa/installation-flow
description: Autonomous end-to-end installation validation workflow
parent: qa
autonomous: true
---

# QA Workflow • Installation Flow Validation

**Type:** Autonomous validation workflow (no user interaction)
**Purpose:** Validate complete installation experience from `curl | bash` to install agent execution
**Issue Reference:** #201
**Evidence Location:** `.genie/agents/qa/evidence/installation-flow-<timestamp>/`

## Autonomous Operation Protocol 🤖

**I am a fully autonomous validation workflow. I execute without user prompts or questions.**

**What this means:**
- ✅ I create test environments automatically
- ✅ I execute installation commands
- ✅ I capture evidence automatically
- ✅ I validate expected behavior
- ✅ I generate test report automatically
- ❌ I NEVER ask "Should I run this test?"
- ❌ I NEVER wait for user confirmation
- ❌ I NEVER present findings without capturing evidence

**My workflow:**
```
1. Create isolated test environments (5 scenarios)
2. Execute installation sequences
3. Validate expected behavior at each step
4. Capture evidence (logs, screenshots, timing)
5. Generate validation report
6. Exit with pass/fail summary
```

**No human in the loop. I am the autonomous validator.**

---

## Test Scenarios

### Scenario 1: Fresh Installation via curl | bash

**Autonomous Execution:**
```bash
#!/bin/bash
# Auto-executed by QA agent

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
TEST_DIR="/tmp/qa-install-fresh-${TIMESTAMP}"
EVIDENCE_DIR=".genie/agents/qa/evidence/installation-flow-${TIMESTAMP}"

mkdir -p "$TEST_DIR" "$EVIDENCE_DIR"
cd "$TEST_DIR"

# Execute installation
bash -c "$(curl -fsSL https://install.namastex.ai/start.sh)" 2>&1 | tee "${EVIDENCE_DIR}/scenario1-fresh-install.log"

# Capture exit code
echo $? > "${EVIDENCE_DIR}/scenario1-exit-code.txt"

# Validate installation
genie --version > "${EVIDENCE_DIR}/scenario1-version.txt" 2>&1
ls -la .genie/ > "${EVIDENCE_DIR}/scenario1-structure.txt" 2>&1
cat .genie/state/version.json > "${EVIDENCE_DIR}/scenario1-version-state.json" 2>&1
```

**Validation Steps (Automated):**
1. ✅ Detects operating system correctly
2. ✅ Installs missing dependencies (git, gh, Node.js, pnpm)
3. ✅ Runs `genie init` successfully
4. ✅ Shows Forge startup message
5. ✅ Install agent starts automatically
6. ✅ Forge task URL displayed
7. ✅ User remains in agent session (script doesn't exit prematurely)
8. ✅ MCP configuration created
9. ✅ Template files copied
10. ✅ State files created

**Evidence Captured:**
- `scenario1-fresh-install.log` - Full installation output
- `scenario1-exit-code.txt` - Exit status
- `scenario1-version.txt` - Genie version output
- `scenario1-structure.txt` - Directory structure
- `scenario1-version-state.json` - Version tracking state

**Pass Criteria:**
- Exit code = 0
- `.genie/` directory exists
- `version.json` exists and contains valid version
- MCP config files created
- No error messages in log

---

### Scenario 2: Fresh Installation via npx

**Autonomous Execution:**
```bash
#!/bin/bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
TEST_DIR="/tmp/qa-install-npx-${TIMESTAMP}"
EVIDENCE_DIR=".genie/agents/qa/evidence/installation-flow-${TIMESTAMP}"

mkdir -p "$TEST_DIR" "$EVIDENCE_DIR"
cd "$TEST_DIR"

# Execute via npx
npx automagik-genie@next 2>&1 | tee "${EVIDENCE_DIR}/scenario2-npx-install.log"

echo $? > "${EVIDENCE_DIR}/scenario2-exit-code.txt"
genie --version > "${EVIDENCE_DIR}/scenario2-version.txt" 2>&1
ls -la .genie/ > "${EVIDENCE_DIR}/scenario2-structure.txt" 2>&1
```

**Validation Steps (Automated):**
1. ✅ npx downloads and runs latest version
2. ✅ Init wizard starts
3. ✅ Template selection works
4. ✅ Forge starts automatically
5. ✅ Install agent executes

**Evidence Captured:**
- `scenario2-npx-install.log` - Full npx output
- `scenario2-exit-code.txt` - Exit status
- `scenario2-version.txt` - Version verification
- `scenario2-structure.txt` - Directory structure

**Pass Criteria:**
- Exit code = 0
- Same validation as Scenario 1

---

### Scenario 3: Existing Installation (Upgrade)

**Autonomous Execution:**
```bash
#!/bin/bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
TEST_DIR="/tmp/qa-install-upgrade-${TIMESTAMP}"
EVIDENCE_DIR=".genie/agents/qa/evidence/installation-flow-${TIMESTAMP}"

mkdir -p "$TEST_DIR" "$EVIDENCE_DIR"
cd "$TEST_DIR"

# Install old version first
git init -b main
npx automagik-genie@next init code --yes 2>&1 | tee "${EVIDENCE_DIR}/scenario3-initial-install.log"

# Capture initial version
cat .genie/state/version.json > "${EVIDENCE_DIR}/scenario3-version-before.json"

# Run upgrade
bash -c "$(curl -fsSL https://install.namastex.ai/start.sh)" 2>&1 | tee "${EVIDENCE_DIR}/scenario3-upgrade.log"

# Capture upgraded version
cat .genie/state/version.json > "${EVIDENCE_DIR}/scenario3-version-after.json"
echo $? > "${EVIDENCE_DIR}/scenario3-exit-code.txt"
```

**Validation Steps (Automated):**
1. ✅ Detects existing installation
2. ✅ Shows version comparison
3. ✅ Updates to latest version
4. ✅ Preserves user customizations
5. ✅ MCP reconfigured
6. ✅ Forge restarts with new version

**Evidence Captured:**
- `scenario3-initial-install.log` - First installation
- `scenario3-version-before.json` - Original version
- `scenario3-upgrade.log` - Upgrade process
- `scenario3-version-after.json` - New version
- `scenario3-exit-code.txt` - Exit status

**Pass Criteria:**
- Exit code = 0
- Version upgraded successfully
- No data loss
- Templates updated

---

### Scenario 4: Forge Server Visibility

**Autonomous Execution:**
```bash
#!/bin/bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
TEST_DIR="/tmp/qa-install-forge-${TIMESTAMP}"
EVIDENCE_DIR=".genie/agents/qa/evidence/installation-flow-${TIMESTAMP}"

mkdir -p "$TEST_DIR" "$EVIDENCE_DIR"
cd "$TEST_DIR"

# Install and watch for Forge messages
npx automagik-genie@next init code 2>&1 | tee "${EVIDENCE_DIR}/scenario4-forge-visibility.log"

# Check Forge process
ps aux | grep forge | grep -v grep > "${EVIDENCE_DIR}/scenario4-forge-process.txt"
curl -s http://localhost:8887/health > "${EVIDENCE_DIR}/scenario4-forge-health.json" 2>&1
```

**Validation Steps (Automated):**
1. ✅ "Starting Forge server" message appears
2. ✅ Forge URL displayed
3. ✅ Task creation output visible
4. ✅ Continue instructions clear
5. ✅ Forge actually running (health check passes)

**Evidence Captured:**
- `scenario4-forge-visibility.log` - Installation output with Forge messages
- `scenario4-forge-process.txt` - Forge process confirmation
- `scenario4-forge-health.json` - Health check response

**Pass Criteria:**
- Log contains "Starting Forge server"
- Log contains "http://localhost:8887"
- Forge process running
- Health endpoint responds

---

### Scenario 5: Error Handling

**Autonomous Execution:**
```bash
#!/bin/bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
TEST_DIR="/tmp/qa-install-errors-${TIMESTAMP}"
EVIDENCE_DIR=".genie/agents/qa/evidence/installation-flow-${TIMESTAMP}"

mkdir -p "$TEST_DIR" "$EVIDENCE_DIR"
cd "$TEST_DIR"

# Test 5a: Invalid Forge port
FORGE_PORT=9999 npx automagik-genie@next init code 2>&1 | tee "${EVIDENCE_DIR}/scenario5a-invalid-port.log"
echo $? > "${EVIDENCE_DIR}/scenario5a-exit-code.txt"

# Test 5b: Network issue simulation
export FORGE_BASE_URL="http://invalid-host:8887"
npx automagik-genie@next init code 2>&1 | tee "${EVIDENCE_DIR}/scenario5b-network-error.log"
echo $? > "${EVIDENCE_DIR}/scenario5b-exit-code.txt"
unset FORGE_BASE_URL
```

**Validation Steps (Automated):**
1. ✅ Clear error message for invalid Forge port
2. ✅ Clear error message for network issues
3. ✅ Actionable guidance provided
4. ✅ Graceful degradation (no crashes)

**Evidence Captured:**
- `scenario5a-invalid-port.log` - Invalid port error handling
- `scenario5a-exit-code.txt` - Exit status
- `scenario5b-network-error.log` - Network error handling
- `scenario5b-exit-code.txt` - Exit status

**Pass Criteria:**
- Error messages are clear (not generic)
- Guidance provided for fixing
- No stack traces exposed to user
- Non-zero exit codes for failures

---

## Regression Validation

**Autonomous Execution:**
```bash
#!/bin/bash
EVIDENCE_DIR=".genie/agents/qa/evidence/installation-flow-${TIMESTAMP}"

# Check core commands
genie --version > "${EVIDENCE_DIR}/regression-version.txt" 2>&1
genie --help > "${EVIDENCE_DIR}/regression-help.txt" 2>&1

# Validate MCP config
cat .mcp.json > "${EVIDENCE_DIR}/regression-mcp-config.json" 2>&1
cat ~/.codex/config.toml > "${EVIDENCE_DIR}/regression-codex-config.toml" 2>&1

# Check template files
ls -R .genie/ > "${EVIDENCE_DIR}/regression-template-files.txt"

# Validate backup system
ls -la .genie/backups/ > "${EVIDENCE_DIR}/regression-backups.txt" 2>&1

# Check state files
cat .genie/state/version.json > "${EVIDENCE_DIR}/regression-version-state.json" 2>&1
cat .genie/state/provider-status.json > "${EVIDENCE_DIR}/regression-provider-status.json" 2>&1
```

**Validation Steps (Automated):**
1. ✅ `genie --version` works
2. ✅ `genie --help` displays help
3. ✅ MCP config files exist
4. ✅ Template files copied
5. ✅ Backup system functional
6. ✅ State files valid JSON

**Evidence Captured:**
- `regression-*.txt` - Command outputs
- `regression-*.json` - Config/state files

**Pass Criteria:**
- All commands execute successfully
- All config files valid
- No missing files

---

## Automated Report Generation

**Report Template:**
```markdown
# Installation Flow Validation Report
**Timestamp:** ${TIMESTAMP}
**Evidence:** .genie/agents/qa/evidence/installation-flow-${TIMESTAMP}/

## Summary
- Total Scenarios: 5
- Passed: X
- Failed: Y
- Warnings: Z

## Scenario Results

### Scenario 1: Fresh Installation via curl
- Status: ✅ PASS | ❌ FAIL
- Evidence: scenario1-*.{log,txt,json}
- Issues: [list any failures]

### Scenario 2: Fresh Installation via npx
- Status: ✅ PASS | ❌ FAIL
- Evidence: scenario2-*.{log,txt}
- Issues: [list any failures]

### Scenario 3: Existing Installation (Upgrade)
- Status: ✅ PASS | ❌ FAIL
- Evidence: scenario3-*.{log,json,txt}
- Issues: [list any failures]

### Scenario 4: Forge Server Visibility
- Status: ✅ PASS | ❌ FAIL
- Evidence: scenario4-*.{log,txt,json}
- Issues: [list any failures]

### Scenario 5: Error Handling
- Status: ✅ PASS | ❌ FAIL
- Evidence: scenario5a-*.{log,txt}, scenario5b-*.{log,txt}
- Issues: [list any failures]

## Regression Tests
- Status: ✅ PASS | ❌ FAIL
- Evidence: regression-*.{txt,json,toml}
- Issues: [list any failures]

## Overall Result
✅ PASS - All scenarios passed, ready for release
⚠️ WARNINGS - Some non-critical issues found
❌ FAIL - Critical issues detected, DO NOT RELEASE

## Recommendations
[Automated analysis of findings]

## Next Steps
[Automated suggestions based on results]
```

**Auto-Generated Location:**
`.genie/agents/qa/evidence/installation-flow-${TIMESTAMP}/REPORT.md`

---

## Execution Command

**Invoked by QA Agent:**
```bash
# QA agent runs this workflow autonomously
cd /path/to/workspace
.genie/agents/qa/workflows/manual/scenarios/installation-flow.md

# Or via MCP
mcp__genie__run with agent="qa/installation-flow" and prompt="Execute autonomous validation"
```

**Expected Duration:** 15-20 minutes (all 5 scenarios + regression)

**Exit Codes:**
- `0` - All tests passed
- `1` - One or more tests failed
- `2` - Execution error (couldn't run tests)

---

## Session Management

**Session ID:** `qa-installation-flow-${TIMESTAMP}`
**Resume:** Not needed (autonomous, runs to completion)
**Evidence:** Persisted in `.genie/agents/qa/evidence/installation-flow-${TIMESTAMP}/`

---

## Success Criteria

**✅ PASS if:**
1. All 5 scenarios execute successfully
2. All validation steps pass
3. Evidence captured for each scenario
4. Regression tests pass
5. Report generated automatically

**❌ FAIL if:**
1. Any scenario fails critical validation
2. Installation process crashes
3. Evidence not captured
4. Regression detected

**⚠️ WARNINGS if:**
1. Non-critical issues found
2. Performance degradation detected
3. Documentation mismatches

---

**Autonomous execution guaranteed. No human interaction required. Evidence-backed results.**

@.genie/agents/qa/README.md
