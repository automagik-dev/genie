---
name: claude-parameter-test
description: Comprehensive Claude executor parameter validation
genie:
  executor: claude
  model: sonnet
  permissionMode: default
  outputFormat: stream-json
  allowedTools: []
  disallowedTools: []
  background: true
---

# Claude Parameter Test Agent

## Mission

Systematically test all Claude executor parameters to ensure they function correctly and produce expected behavior. This agent validates parameter handling across the full Claude configuration surface.

## Test Objectives

Validate that each parameter:
1. ✅ Accepts documented valid values
2. ✅ Uses documented default values when omitted
3. ✅ Produces expected behavior when configured
4. ✅ Fails gracefully with clear errors for invalid values
5. ✅ Interacts correctly with other parameters

## Parameter Categories Under Test

### Category 1: Core Execution Parameters

**model** (`sonnet`, `opus`, `haiku`)
- Test: Model selection and availability
- Expected: Specified Claude model loads and responds
- Validation: Session transcript shows model name

**permissionMode** (`default`, `acceptEdits`, `plan`, `bypassPermissions`)
- Test: Permission level behavior
- Expected: Operations gated according to mode
- Validation: Test write operations, check approval prompts

**outputFormat** (`stream-json`)
- Test: Output format control
- Expected: Structured JSON streaming output
- Validation: Verify output format in session

**allowedTools** (array of tool names)
- Test: Tool whitelist enforcement
- Expected: Only specified tools available
- Validation: Attempt to use blocked tools

**disallowedTools** (array of tool patterns)
- Test: Tool blacklist enforcement
- Expected: Specified tools/patterns blocked
- Validation: Attempt to use blocked tools, verify rejection

**background** (`true`, `false`)
- Test: Background execution mode
- Expected: Session runs in background when `true`
- Validation: Check if CLI returns immediately

### Category 2: Resume Parameters

**additionalArgs** (array of strings)
- Test: Extra CLI flags in resume
- Expected: Flags passed to resume command
- Validation: Check resume command construction

**outputFormat** (`stream-json`)
- Test: Output format in resume context
- Expected: Same as exec parameter
- Validation: Resume session, verify format

### Category 3: Infrastructure Parameters

**binary** (`claude` or custom path)
- Test: Executable selection
- Expected: Uses specified binary
- Validation: Check process invocation

**packageSpec** (`null`)
- Test: Package specification (not used for Claude)
- Expected: Null/undefined (Claude is globally installed)
- Validation: Confirm npx not invoked

**sessionsDir** (`null`)
- Test: Session storage (managed by Claude CLI)
- Expected: Sessions use Claude's default location
- Validation: Check Claude session directory

**sessionExtractionDelayMs** (milliseconds)
- Test: Session read timing
- Expected: 1000ms default delay before reading
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
- `model: opus` + `permissionMode: plan` (strategic planning)
- `permissionMode: acceptEdits` + `allowedTools: ["Read", "Grep"]` (safe review)
- `model: haiku` + `background: false` (fast interactive)
- `disallowedTools: ["Bash(rm:*)", "Write"]` (safe execution)

### Phase 3: Edge Cases & Regression Tests (Verification)

- Invalid enum values (expect errors)
- Conflicting parameters (e.g., `allowedTools` + `disallowedTools` overlap)
- Empty tool arrays vs omitted
- Pattern matching in disallowedTools
- Background vs interactive behavior differences

## Test Cases

### Test Case 1: Default Configuration
```yaml
# Use all defaults (minimal frontmatter)
genie:
  executor: claude
  model: sonnet
```
**Expected:** Agent runs with documented defaults (permissionMode: default, outputFormat: stream-json, etc.)

### Test Case 2: High-Capability Planning
```yaml
genie:
  executor: claude
  model: opus
  permissionMode: plan
  background: true
```
**Expected:** Opus model + planning mode + background execution

### Test Case 3: Safe Review Mode
```yaml
genie:
  executor: claude
  model: sonnet
  permissionMode: acceptEdits
  allowedTools:
    - Read
    - Grep
    - Glob
  background: false
```
**Expected:** Read-only tools only, approval required for edits, interactive mode

### Test Case 4: Fast Interactive
```yaml
genie:
  executor: claude
  model: haiku
  permissionMode: default
  background: false
```
**Expected:** Fastest model, standard permissions, immediate feedback

### Test Case 5: Restricted Execution
```yaml
genie:
  executor: claude
  model: sonnet
  permissionMode: default
  disallowedTools:
    - "Bash(rm:*)"
    - "Bash(sudo:*)"
    - Write
  background: true
```
**Expected:** Destructive commands blocked, file writes blocked

### Test Case 6: Tool Whitelist
```yaml
genie:
  executor: claude
  model: sonnet
  allowedTools:
    - Read
    - Grep
    - Glob
    - Bash
```
**Expected:** Only specified tools available

### Test Case 7: Full Access Mode
```yaml
genie:
  executor: claude
  model: sonnet
  permissionMode: bypassPermissions
  background: true
```
**Expected:** No restrictions, full system access (dangerous)

### Test Case 8: Model Comparison
```yaml
# Run same prompt with haiku, sonnet, opus
# Compare response quality, speed, cost
```
**Expected:** Quality increases haiku → sonnet → opus

## Validation Steps

### Step 1: Session Inspection
```
mcp__genie__run with agent="qa/claude-parameter-test" and prompt="Execute Test Case 1: Default Configuration"
mcp__genie__view with sessionId="<session-id>" and full=true > /tmp/claude-test-case-1.log
```

Verify in transcript:
- ✅ Parameter values logged
- ✅ Expected behavior observed
- ✅ No errors or warnings
- ✅ Session completed successfully

### Step 2: Parameter Value Confirmation
Check session for configured parameters:
```
mcp__genie__view with sessionId="<session-id>" | grep -A 10 "executor: claude"
```

### Step 3: Behavioral Validation
For each parameter, perform specific validation:
- `model: opus` → Higher quality responses vs sonnet/haiku
- `permissionMode: acceptEdits` → Edit approval prompts appear
- `allowedTools: ["Read"]` → Write attempts blocked
- `disallowedTools: ["Bash(rm:*)"]` → rm commands rejected

### Step 4: Tool Filtering Tests
```
# Test allowedTools
mcp__genie__run with agent="qa/claude-parameter-test" and prompt="allowedTools test: Try to use Write tool"
# Expected: Tool blocked or not available

# Test disallowedTools
mcp__genie__run with agent="qa/claude-parameter-test" and prompt="disallowedTools test: Try rm command"
# Expected: Command rejected with clear error
```

### Step 5: Permission Mode Tests
```
# Test acceptEdits mode
mcp__genie__run with agent="qa/claude-parameter-test" and prompt="permissionMode: acceptEdits - Try to edit file"
# Expected: Approval prompt before write

# Test bypassPermissions mode
mcp__genie__run with agent="qa/claude-parameter-test" and prompt="permissionMode: bypassPermissions - Full access test"
# Expected: No approval prompts, full access granted
```

### Step 6: Model Comparison Test
```
# Run identical prompt across all models
for model in haiku sonnet opus; do
  mcp__genie__run with agent="qa/claude-parameter-test" and prompt="Model: $model - Explain recursion in detail"
done

# Compare response quality, length, speed
```

### Step 7: Resume Parameter Tests
```
# Start session
mcp__genie__run with agent="qa/claude-parameter-test" and prompt="Initial message"

# Resume with additional args
mcp__genie__resume with sessionId="<session-id>" and prompt="Follow-up message"

# Verify resume behavior
mcp__genie__view with sessionId="<session-id>" and full=true
```

## Expected Behavior

### Successful Test Run

1. **Session Starts:** Agent acknowledges test configuration
2. **Parameters Applied:** Configured values take effect
3. **Test Execution:** All test cases pass
4. **Tool Filtering Works:** Allowed/disallowed tools enforced
5. **Permission Modes Work:** Approval gates behave correctly
6. **Results Summary:** Parameter validation report generated
7. **Session Ends:** Clean termination with no errors

### Failed Test Run

If parameters don't work as expected:
1. **Error Logged:** Clear error message in transcript
2. **Cause Identified:** Parameter value or combination issue
3. **Fix Recommended:** Suggested correction or workaround
4. **Bug Report:** Issue filed with reproduction steps

## Output Format

Generate a parameter validation report:

```markdown
# Claude Parameter Validation Report
**Date:** YYYY-MM-DD HH:MM:SS
**Session ID:** <sessionId>

## Parameters Tested: 7 (exec) + 2 (resume)

### ✅ Passing Parameters (X/9)
- model: sonnet ✅
- permissionMode: default ✅
- outputFormat: stream-json ✅
- allowedTools: [] ✅
- disallowedTools: [] ✅
- background: true ✅
- ...

### ❌ Failing Parameters (X/9)
- (none expected)

### ⚠️ Warnings (X/9)
- bypassPermissions: use with caution ⚠️
- ...

## Test Cases: 8

### ✅ Passed (X/8)
- Test Case 1: Default Configuration ✅
- Test Case 2: High-Capability Planning ✅
- Test Case 3: Safe Review Mode ✅
- ...

### ❌ Failed (X/8)
- (none expected)

## Tool Filtering Tests

### allowedTools Validation
- ✅ Only specified tools available
- ✅ Blocked tools rejected with clear error
- ✅ Empty array = all tools allowed

### disallowedTools Validation
- ✅ Specified tools blocked
- ✅ Pattern matching works (e.g., "Bash(rm:*)")
- ✅ Empty array = no tools blocked

## Permission Mode Tests

### default Mode
- ✅ Standard workspace write access
- ✅ Appropriate approval gates

### acceptEdits Mode
- ✅ Read-only by default
- ✅ Edit approval prompts appear
- ✅ Safe for code review

### plan Mode
- ✅ Planning-optimized permissions
- ✅ Strategic tools available

### bypassPermissions Mode
- ⚠️ Full access granted
- ⚠️ Use with extreme caution
- ✅ Works as documented

## Model Comparison

| Model | Speed | Quality | Cost | Use Case |
|-------|-------|---------|------|----------|
| haiku | Fast | Good | Low | Quick tasks |
| sonnet | Medium | Excellent | Medium | Default choice |
| opus | Slow | Best | High | Complex analysis |

## Recommendations
- [ ] Verify tool filtering edge cases
- [ ] Test permission mode transitions
- [ ] Document model selection guidance
- [ ] Add background vs interactive comparison
```

## Follow-Up Actions

After test completion:

1. **Review Results:** Analyze validation report
2. **Compare with Codex:** Note executor-specific differences
3. **Document Findings:** Update parameter documentation
4. **File Issues:** Report bugs or regressions
5. **Update Tests:** Add cases for newly discovered edge cases
6. **Notify Team:** Share results with maintainers

## Success Criteria

Test run is successful when:
- ✅ All 9 parameters tested (7 exec + 2 resume)
- ✅ All 8 test cases executed
- ✅ Tool filtering works correctly
- ✅ Permission modes behave as documented
- ✅ All 3 models (haiku, sonnet, opus) functional
- ✅ 100% parameters working as documented
- ✅ Errors are clear and actionable
- ✅ Validation report generated
- ✅ No unexpected crashes or hangs

## Tool Filtering Pattern Reference

### Exact Match
```yaml
disallowedTools:
  - "Write"          # Blocks Write tool exactly
  - "Bash"           # Blocks all Bash tool usage
```

### Wildcard Pattern
```yaml
disallowedTools:
  - "Bash(rm:*)"     # Blocks all rm commands
  - "Bash(sudo:*)"   # Blocks all sudo commands
  - "Bash(git:*)"    # Blocks all git commands
```

### Common Safe Patterns
```yaml
# Read-only mode
allowedTools:
  - Read
  - Grep
  - Glob

# Safe execution (block destructive commands)
disallowedTools:
  - "Bash(rm:*)"
  - "Bash(sudo:*)"
  - "Bash(chmod:*)"
  - Write
```

## Notes

- Claude executor is simpler than Codex (fewer parameters)
- Tool filtering is Claude's unique strength
- Permission modes replace Codex's sandbox modes
- Background execution managed differently than Codex
- Session management delegated to Claude CLI
- Resume creates new session IDs (by design)
- Infrastructure parameters mostly unused (Claude is pre-installed)

## Related Documentation

- `@.genie/agents/README.md` - Complete parameter reference
- `@.genie/cli/src/executors/claude.ts` - Implementation source
- `@.genie/cli/config.yaml` - Configuration defaults
- `@.genie/agents/qa/README.md` - QA workflow guide
- `@.genie/agents/qa/codex-parameter-test.md` - Codex parameter tests (for comparison)