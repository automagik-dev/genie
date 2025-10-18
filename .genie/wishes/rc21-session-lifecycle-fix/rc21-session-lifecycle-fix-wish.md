# Wish: RC21 Session Lifecycle Fix

## Context Ledger
- **Problem:** Every MCP `run` creates TWO sessions with different UUIDs
- **Goal:** Fix session creation to create only ONE unique session per run
- **Impact:** Prevents session pollution and improves CLI reliability
- **Blocking Area:** background-launcher.ts

## Execution Groups
### Group A: Investigate Session Creation
- Verify current session creation logic in background-launcher.ts
- Identify exact line causing duplicate session generation
- Document current behavior

### Group B: Implement V2 Session Format Fix
- Update background-launcher.ts:70 to use V2 format (liveStore.sessions)
- Replace V1 lookup method (liveStore.agents?.[agentName])
- Ensure one unique session created per run

### Group C: QA Validation
- Create test cases to verify single session creation
- Test with various run scenarios (clean slate, post-rebuild)
- Verify unique UUID generation
- Validate background polling behavior

## Evidence Checklist
- [ ] Confirmed single session creation
- [ ] Unique UUIDs generated correctly
- [ ] V2 format implemented in background-launcher.ts
- [ ] All CLI validation tests pass
- [ ] QA Group B tests pass (see SESSION-STATE.md)

## Tracking
- Forge task: RC21-102
- GitHub Issue: https://github.com/namastexlabs/automagik-genie/issues/109

## Risks
- Potential side effects in other parts of session management
- Need to ensure V2 format doesn't break existing functionality

## Next Steps
- Create GitHub issue
- Create feature branch
- Implement fix
- Run comprehensive QA