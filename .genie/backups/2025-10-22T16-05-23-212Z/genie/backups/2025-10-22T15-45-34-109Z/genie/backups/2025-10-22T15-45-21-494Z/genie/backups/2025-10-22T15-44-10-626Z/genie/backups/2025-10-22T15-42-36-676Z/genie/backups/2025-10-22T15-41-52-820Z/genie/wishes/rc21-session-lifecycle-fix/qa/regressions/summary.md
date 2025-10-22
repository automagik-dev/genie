# RC21 Regression QA – Bug 66/90/92
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
Date: 2025-10-18

Scope:
- Bug #66: Session disappears after resume
- Bug #90: full=true returns truncated checkpoints
- Bug #92: Zombie sessions stuck in running status
- MCP operations end-to-end smoke

Sessions:
- bug-66: ae835e5f-937b-4090-a75e-3352705c2298 (completed)
- bug-90: 6c0dab4c-71ca-48db-a383-b46c9ace22a9 (completed)
- bug-90 (earlier): 24261735-a664-461c-9e5d-edbeb6e34257 (stopped/removed from list)
- bug-92: c984d847-5cd3-430e-a41f-8756d9c4d1cf (completed)
- mcp-ops: 53ba524d-47e9-4f15-91f7-03fb3d2b2b13 (completed)
- lifecycle: 278fb632-14dd-4fd8-964e-9741bbd460e7 (completed)

Findings:
- Bug #66: PASS – resume did not drop session; sessions list retained entries
- Bug #90: PASS – `view full=true` returns full transcript (4 messages), `full=false` returns summary/lastMessage as expected; no truncation observed
- Bug #92: PASS – no lingering zombies; a running entry was stopped/cleaned and no longer listed
- MCP Ops: PASS (launch + view + stop flows validated; gating prompts observed)

Notes:
- Permission prompts within QA agents are expected in non-interactive runs; background launch + polling validated (≈0.5s)
- Underlying session store shows V2 format and stable updates

Verdict: Overall regression suite – PASS (Bug 66, 90, 92).
