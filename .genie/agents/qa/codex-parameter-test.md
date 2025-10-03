---
name: codex-parameter-test
description: Comprehensive Codex executor parameter validation
genie:
  executor: codex
  exec:
    model: gpt-5-codex
    reasoningEffort: medium
    sandbox: workspace-write
    approvalPolicy: on-failure
    fullAuto: true
    includePlanTool: true
    search: false
    profile: null
    skipGitRepoCheck: false
    json: false
    experimentalJson: true
    color: auto
    cd: null
    outputSchema: null
    outputLastMessage: null
    additionalArgs: []
    images: []
  resume:
    includePlanTool: true
    search: false
    last: false
    additionalArgs: []
---

# Codex Parameter Test Agent

## Mission

Systematically test all Codex executor parameters to ensure they function correctly and produce expected behavior. This agent validates parameter handling across the full Codex configuration surface.

## Test Objectives

Validate that each parameter:
1. ✅ Accepts documented valid values
2. ✅ Uses documented default values when omitted
3. ✅ Produces expected behavior when configured
4. ✅ Fails gracefully with clear errors for invalid values
5. ✅ Interacts correctly with other parameters

## Parameter Categories Under Test

### Category 1: Core Execution Parameters

**model** (`gpt-5-codex`)
- Test: Model selection and availability
- Expected: Codex model loads and responds
- Validation: Session transcript shows model name

**reasoningEffort** (`low`, `medium`, `high`)
- Test: Reasoning depth variations
- Expected: Higher effort = deeper analysis
- Validation: Compare response complexity across levels

**sandbox** (`read-only`, `workspace-write`, `danger-full-access`)
- Test: File system access control
- Expected: Permissions match sandbox level
- Validation: Test write operations succeed/fail appropriately

**approvalPolicy** (`never`, `on-failure`, `on-request`, `untrusted`)
- Test: Approval gate behavior
- Expected: Prompts appear according to policy
- Validation: Count approval prompts in session

**fullAuto** (`true`, `false`)
- Test: Full automation mode toggle
- Expected: With `true`, fewer approval gates
- Validation: Session shows auto-approval behavior

**includePlanTool** (`true`, `false`)
- Test: Planning tool availability
- Expected: Agent can create plans when `true`
- Validation: Check for plan-related capabilities in response

**search** (`true`, `false`)
- Test: Web search capability
- Expected: Agent can search web when `true`
- Validation: Request web search, verify behavior

**profile** (`null` or profile name)
- Test: Profile loading
- Expected: Profile settings apply when specified
- Validation: Check for profile-specific behavior

**skipGitRepoCheck** (`true`, `false`)
- Test: Git repository validation bypass
- Expected: Works in non-git directories when `true`
- Validation: Run in non-git directory, verify no errors

**json** (`true`, `false`)
- Test: JSON output mode
- Expected: Structured JSON output when `true`
- Validation: Verify output format

**experimentalJson** (`true`, `false`)
- Test: Enhanced JSON output mode
- Expected: Extended JSON features when `true`
- Validation: Compare with standard JSON mode

**color** (`auto`, `always`, `never`)
- Test: Color output control
- Expected: ANSI codes match setting
- Validation: Inspect raw output for color codes

**cd** (directory path or `null`)
- Test: Working directory override
- Expected: Commands run in specified directory
- Validation: Check cwd in session

**outputSchema** (JSON schema path or `null`)
- Test: Structured output validation
- Expected: Output conforms to schema when provided
- Validation: Validate output against schema

**outputLastMessage** (file path or `null`)
- Test: Message extraction to file
- Expected: Last message written to file
- Validation: Check file exists and contains message

**additionalArgs** (array of strings)
- Test: Extra CLI flag passthrough
- Expected: Flags passed to underlying Codex binary
- Validation: Verify flags appear in exec command

**images** (array of file paths)
- Test: Image input for vision models
- Expected: Images loaded and analyzed
- Validation: Request image analysis, verify response

### Category 2: Resume Parameters

**includePlanTool** (`true`, `false`)
- Test: Planning tool in resume context
- Expected: Same as exec parameter
- Validation: Resume session, check planning capability

**search** (`true`, `false`)
- Test: Web search in resume context
- Expected: Same as exec parameter
- Validation: Resume session, request search

**last** (`true`, `false`)
- Test: Resume last session
- Expected: Resumes most recent session when `true`
- Validation: Compare session IDs

**additionalArgs** (array of strings)
- Test: Extra CLI flags in resume
- Expected: Flags passed to resume command
- Validation: Check resume command construction

### Category 3: Infrastructure Parameters

**binary** (`npx` or custom path)
- Test: Executable selection
- Expected: Uses specified binary
- Validation: Check process invocation

**packageSpec** (npm package spec)
- Test: npx package specification
- Expected: Correct Codex version loaded
- Validation: Check version in session info

**sessionsDir** (directory path)
- Test: Session storage location
- Expected: Sessions saved to specified directory
- Validation: Check directory contents

**sessionExtractionDelayMs** (milliseconds or `null`)
- Test: Session read timing
- Expected: Delay before reading session files
- Validation: Measure time between write and read

## Test Execution Plan

### Phase 1: Individual Parameter Tests (Discovery)

For each parameter:
1. Read parameter definition from `@.genie/agents/README.md`
2. Configure test agent with parameter value
3. Execute simple test command
4. Verify parameter took effect
5. Log results

### Phase 2: Parameter Combinations (Implementation)

Test common combinations:
- `reasoningEffort: high` + `includePlanTool: true` (strategic planning)
- `sandbox: read-only` + `approvalPolicy: untrusted` (safe review)
- `fullAuto: true` + `approvalPolicy: never` (full automation)
- `search: true` + `includePlanTool: true` (research planning)

### Phase 3: Edge Cases & Regression Tests (Verification)

- Invalid enum values (expect errors)
- Conflicting parameters (e.g., `fullAuto: true` + `approvalPolicy: untrusted`)
- Null/undefined vs explicit defaults
- Missing required parameters
- Type mismatches (string vs boolean, etc.)

## Test Cases

### Test Case 1: Default Configuration
```yaml
# Use all defaults (minimal frontmatter)
genie:
  executor: codex
```
**Expected:** Agent runs with documented defaults (reasoningEffort: low, sandbox: workspace-write, etc.)

### Test Case 2: Maximum Reasoning
```yaml
genie:
  executor: codex
  exec:
    reasoningEffort: high
    includePlanTool: true
```
**Expected:** Deep analysis and planning capabilities enabled

### Test Case 3: Safe Review Mode
```yaml
genie:
  executor: codex
  exec:
    sandbox: read-only
    approvalPolicy: on-request
    reasoningEffort: medium
```
**Expected:** No file writes, approval required for operations, balanced reasoning

### Test Case 4: Full Automation
```yaml
genie:
  executor: codex
  exec:
    fullAuto: true
    approvalPolicy: never
    reasoningEffort: low
```
**Expected:** No approval prompts, fast execution, minimal reasoning overhead

### Test Case 5: Research Mode
```yaml
genie:
  executor: codex
  exec:
    search: true
    includePlanTool: true
    reasoningEffort: high
```
**Expected:** Web search + planning + deep analysis

### Test Case 6: Structured Output
```yaml
genie:
  executor: codex
  exec:
    json: true
    experimentalJson: true
    outputLastMessage: /tmp/last-message.json
```
**Expected:** JSON-formatted output, message extracted to file

### Test Case 7: Custom Working Directory
```yaml
genie:
  executor: codex
  exec:
    cd: /tmp
    skipGitRepoCheck: true
```
**Expected:** Commands execute in /tmp, no git validation

### Test Case 8: Image Analysis
```yaml
genie:
  executor: codex
  exec:
    images: ["/path/to/screenshot.png"]
    reasoningEffort: medium
```
**Expected:** Agent analyzes provided image

## Validation Steps

### Step 1: Session Inspection
```
mcp__genie__run with agent="qa/codex-parameter-test" and prompt="Execute Test Case 1: Default Configuration"
mcp__genie__view with sessionId="<session-id>" and full=true > /tmp/codex-test-case-1.log
```

Verify in transcript:
- ✅ Parameter values logged
- ✅ Expected behavior observed
- ✅ No errors or warnings
- ✅ Session completed successfully

### Step 2: Parameter Value Confirmation
Check session metadata for configured parameters:
```bash
grep -A 10 "executor: codex" ~/.codex/sessions/<date>/<sessionId>/session.json
```

### Step 3: Behavioral Validation
For each parameter, perform specific validation:
- `reasoningEffort: high` → Response should show detailed reasoning
- `sandbox: read-only` → Write attempts should be blocked
- `search: true` → Search capability should be available
- `json: true` → Output should be JSON-formatted

### Step 4: Regression Testing
Run baseline test suite:
```
mcp__genie__run with agent="qa/codex-parameter-test" and prompt="Run full parameter regression test"
```

Compare results against previous runs to detect regressions.

### Step 5: Error Handling
Test invalid configurations:
```
mcp__genie__run with agent="qa/codex-parameter-test" and prompt="Test invalid reasoningEffort: 'ultra'"
# Expected: Clear error message about valid values
```

## Expected Behavior

### Successful Test Run

1. **Session Starts:** Agent acknowledges test configuration
2. **Parameters Applied:** Configured values take effect
3. **Test Execution:** All test cases pass
4. **Results Summary:** Parameter validation report generated
5. **Session Ends:** Clean termination with no errors

### Failed Test Run

If parameters don't work as expected:
1. **Error Logged:** Clear error message in transcript
2. **Cause Identified:** Parameter value or combination issue
3. **Fix Recommended:** Suggested correction or workaround
4. **Bug Report:** Issue filed with reproduction steps

## Output Format

Generate a parameter validation report:

```markdown
# Codex Parameter Validation Report
**Date:** YYYY-MM-DD HH:MM:SS
**Session ID:** <sessionId>

## Parameters Tested: 22

### ✅ Passing Parameters (XX/22)
- model: gpt-5-codex ✅
- reasoningEffort: medium ✅
- sandbox: workspace-write ✅
- ...

### ❌ Failing Parameters (X/22)
- search: true ❌ (Error: Web search not available)
- ...

### ⚠️ Warnings (X/22)
- experimentalJson: true ⚠️ (May change in future versions)
- ...

## Test Cases: 8

### ✅ Passed (X/8)
- Test Case 1: Default Configuration ✅
- ...

### ❌ Failed (X/8)
- Test Case 5: Research Mode ❌ (search parameter issue)
- ...

## Recommendations
- [ ] Fix failing parameters
- [ ] Document warnings
- [ ] Update parameter docs if needed
- [ ] File issues for regressions
```

## Follow-Up Actions

After test completion:

1. **Review Results:** Analyze validation report
2. **Document Findings:** Update parameter documentation
3. **File Issues:** Report bugs or regressions
4. **Update Tests:** Add cases for newly discovered edge cases
5. **Notify Team:** Share results with maintainers

## Success Criteria

Test run is successful when:
- ✅ All 22 parameters tested
- ✅ All 8 test cases executed
- ✅ 90%+ parameters working as documented
- ✅ Errors are clear and actionable
- ✅ Validation report generated
- ✅ No unexpected crashes or hangs

## Notes

- This agent should be run after every executor update
- Parameter behavior may vary across Codex versions
- Some parameters require specific environment setup
- Infrastructure parameters need config.yaml changes to test
- Resume parameters require multi-turn session testing

## Related Documentation

- `@.genie/agents/README.md` - Complete parameter reference
- `@.genie/cli/src/executors/codex.ts` - Implementation source
- `@.genie/cli/config.yaml` - Configuration defaults
- `@.genie/agents/qa/README.md` - QA workflow guide