# Group B QA – RC21 Session Lifecycle

Date: 2025-10-18

Scope:
- Validate one-session-per-run and background polling behavior
- Verify no legacy V1 lookups and corrected CLI hints

Results:
- Sessions created (unique): 5 plan + 1 qa = 6 total
- One-per-run: PASS (no duplicate session records)
- Polling latency: ~0.5s for Session ID print (PASS)
- MCP list_sessions count: 6 (PASS)
- CLI hints: use `npx automagik-genie` (PASS)
- Legacy lookup `liveStore.agents`: none in src (PASS)

Session IDs:
- 89278dd3-c311-4519-b2e7-182a5fb9e5b6 (plan)
- ca567b2a-3f2e-4a0b-b243-4f2b30dae4c7 (plan)
- 1fdae4f8-06c0-4735-9ace-7af9cc2044ff (plan)
- d56fc053-047e-4380-98a8-ad3c002df5ae (plan)
- 430ec40a-3b51-46b1-a35b-abcb6ecc8550 (plan)
- b3c7fb8c-258a-4a78-a009-99429dfa0a64 (qa/session-lifecycle)

Evidence:
- sessions.json snapshot – sessions.json
- No legacy lookup – grep-no-legacy.txt
- CLI hint proof – background-launcher-proof.md

Verdict: RC21 QA Group B – PASS

