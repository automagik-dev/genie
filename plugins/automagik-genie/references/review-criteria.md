# Review Criteria Reference

## Gap Severity Levels

Use these severity levels when categorizing findings in review:

| Severity | Meaning | Examples | Blocks Ship? |
|----------|---------|----------|--------------|
| CRITICAL | Security flaw, data loss, system crash | SQL injection, unencrypted secrets, null pointer crash | Yes |
| HIGH | Missing feature, major bug, test failure | Required functionality missing, test suite fails | Yes |
| MEDIUM | Missing edge case, incomplete docs | Edge case unhandled, missing error message | No |
| LOW | Style, naming, minor polish | Inconsistent naming, verbose code | No |

## Verdict Decision Matrix

| Condition | Verdict |
|-----------|---------|
| Zero CRITICAL + Zero HIGH + All validation passes | SHIP |
| Any HIGH (fixable) + No CRITICAL | FIX-FIRST |
| Any CRITICAL or unfixable architectural issues | BLOCKED |

## What Constitutes Evidence

For PASS criteria, evidence includes:
- Code exists that implements the feature
- Test exists that verifies the behavior
- Validation command succeeds with expected output
- Documentation is present (when required)
- Screenshot of working UI (for user-facing features)

## Quality Review Categories

### Security
- Input validation present
- Authentication/authorization correct
- No injection vulnerabilities (SQL, XSS, command)
- Secrets not hardcoded
- OWASP Top 10 addressed

### Maintainability
- Code is readable
- Appropriate abstraction level
- Follows existing conventions
- No dead code
- No unresolved TODOs

### Performance
- No obvious N+1 queries
- No unnecessary loops/allocations
- Resources cleaned up
- Appropriate data structures

### Correctness
- Edge cases handled
- Error handling appropriate
- Null/undefined safety
- Type safety (if applicable)

## Review Workflow Summary

```
/wish → creates plan
/plan-review → validates plan structure
/make → executes plan
/review → final validation → SHIP / FIX-FIRST / BLOCKED
```

## Fix Loop Limits

- Spec review fix loops: max 3
- Quality review fix loops: max 2
- After max loops: mark task BLOCKED and continue
