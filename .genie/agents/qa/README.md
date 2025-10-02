# Executor Parameter QA Test Agents

This directory contains test agents that verify all executor parameters work correctly. These agents are designed for systematic parameter testing and validation workflows.

## Purpose

- **Validate parameter coverage**: Ensure all documented parameters are functional
- **Test parameter combinations**: Verify parameters work together correctly
- **Catch regressions**: Detect when executor changes break parameter handling
- **Document behavior**: Provide working examples of every parameter

## Test Agents

### codex-parameter-test.md
Tests all Codex executor parameters including:
- Core execution parameters (model, reasoningEffort, sandbox, etc.)
- Resume parameters (includePlanTool, search, last, etc.)
- Advanced features (search, profiles, output control, etc.)
- Infrastructure parameters (binary, packageSpec, sessionExtractionDelayMs)

### claude-parameter-test.md
Tests all Claude executor parameters including:
- Core execution parameters (model, permissionMode, outputFormat)
- Tool filtering (allowedTools, disallowedTools)
- Resume parameters
- Infrastructure parameters

## Running QA Tests

### Full Parameter Test (Codex)
```bash
./genie run qa/codex-parameter-test "Test all Codex parameters"
./genie view <sessionId> --full
```

### Full Parameter Test (Claude)
```bash
./genie run qa/claude-parameter-test "Test all Claude parameters"
./genie view <sessionId> --full
```

### Targeted Parameter Tests
```bash
# Test specific parameter category
./genie run qa/codex-parameter-test "Test only reasoningEffort: low, medium, high"
./genie run qa/claude-parameter-test "Test only permissionMode variations"
```

## Expected Outcomes

Each test agent should:
1. ✅ Execute without errors
2. ✅ Demonstrate parameter takes effect
3. ✅ Log parameter values in session transcript
4. ✅ Validate parameter constraints (e.g., enum values)
5. ✅ Report any parameter failures or unexpected behavior

## QA Workflow Integration

### Pre-Release Checklist
1. Run both parameter test agents
2. Review session transcripts for warnings/errors
3. Verify new parameters are tested
4. Update test agents when parameters change

### Post-Executor Update
1. Run parameter tests against updated executor
2. Compare behavior with previous version
3. Document any breaking changes
4. Update parameter documentation if needed

### Adding New Parameters
When executors gain new parameters:
1. Add parameter to appropriate test agent
2. Add test case demonstrating usage
3. Update `.genie/agents/README.md` parameter tables
4. Run full QA test suite
5. Document results in session transcript

## Test Agent Structure

Each test agent follows this pattern:

```yaml
---
name: qa-test-name
description: Test description
genie:
  executor: codex  # or claude
  # Parameters under test configured here
---

# Test Agent Name

## Test Objectives
[What parameters are being tested]

## Test Cases
[Specific test scenarios]

## Expected Behavior
[What should happen]

## Validation Steps
[How to verify success]
```

## Maintenance

- Review test agents quarterly
- Update when executor source changes
- Add tests for newly discovered edge cases
- Keep synchronized with `.genie/agents/README.md` parameter documentation

## Related Documentation

- `@.genie/agents/README.md` - Complete parameter reference
- `@.genie/cli/src/executors/codex.ts` - Codex implementation
- `@.genie/cli/src/executors/claude.ts` - Claude implementation
- `@.genie/cli/src/executors/types.ts` - Type definitions