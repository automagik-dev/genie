# 🧞 RC21 Session Lifecycle Fix WISH
**Status:** ✅ COMPLETE
**Roadmap Item:** release/rc21 – @.genie/product/roadmap.md §Releases
**Mission Link:** @.genie/product/mission.md §Reliability
**Completion Score:** 100/100 (all groups complete)

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

## <spec_contract>
- Scope: Fix session duplication/polling; align CLI hints; validate; prep RC21
- Out of scope: Broader refactors; unrelated bugs
- Success metrics: 0 duplicates; 0 timeouts; QA checklist passes
- External tasks: None
- Dependencies: Node >= 18
</spec_contract>

## Status Log
- [2025-10-18T11:15Z] ✅ **WISH COMPLETE** - PR #119 merged, issue #109 closed, RC21 published
- [2025-10-18T04:35Z] ✅ Group B (QA) PASS – evidence in qa/group-b, report created
- [2025-10-18T04:39Z] 🚀 Group D (Release) – v2.4.0-rc.21 tagged + published to `next`
- [2025-10-18T04:20Z] ✅ QA Pass 2 complete - Core fix verified (see .genie/reports/rc21-qa2-results-20251018.md)
- [2025-10-18T04:12Z] 🔧 Implemented fixes to background-launcher.ts, background-manager.ts, run.ts
- [2025-10-18T03:13Z] Wish created
