# Issue #120 Investigation - Report Index

**Date:** 2025-10-18
**Task:** Investigate Forge executor replacement for Genie
**Status:** ✅ Investigation Complete

---

## Reports Generated (in reading order)

### 1. FORGE-EXECUTOR-ANALYSIS-20251018.md
**Purpose:** Initial deep analysis comparing Genie vs Forge executors

**Key sections:**
- Current architecture analysis (Genie's buggy executor)
- Target architecture analysis (Forge's proven executor)
- Architecture comparison matrix
- Code deletion opportunities
- Automation opportunities
- Implementation roadmap (6 phases)
- Risk assessment
- Success metrics

**Main findings:**
- Identified race condition in background-launcher.ts:65-108
- Documented Forge's guarantees (worktree isolation, no polling)
- Estimated 300-400 lines of code could be deleted
- Proposed ForgeClient API integration

**Status:** ⚠️ SUPERSEDED - Initial hypothesis was incorrect (see Discovery report)

---

### 2. FORGE-EXECUTOR-DISCOVERY-20251018.md
**Purpose:** Critical discovery that changed the investigation direction

**Key discoveries:**
1. **ForgeClient is NOT the integration point** - MCP tools are
2. **Forge and Genie are different products** - not duplicates
3. **MCP integration pattern** - both use MCP, not HTTP APIs
4. **Genie MCP vs Forge MCP** - different purposes, different tools

**Critical corrections:**
- Forge integration is via `mcp__automagik_forge__*` tools, not HTTP API
- ForgeClient (`forge.ts`) is Forge's internal backend client (UI ← → backend)
- Genie uses Forge as execution platform, not replacement target

**Key questions raised:**
- How does Forge MCP Server work internally?
- Can Genie agents run via Forge task attempts?
- What happens to Genie's multi-turn conversation model?

**Status:** ✅ VALIDATED - This was the breakthrough moment

---

### 3. ISSUE-120-INVESTIGATION-SUMMARY-20251018.md
**Purpose:** Final comprehensive summary with actionable recommendations

**Key conclusions:**
1. **DON'T replace Genie executor with Forge** - different purposes
2. **DO fix Genie's polling timeout bug** - simple fix, high impact
3. **Genie + Forge = Complementary, not competitive**

**Recommendations:**
- **Option 1 (Week 1):** Fix polling timeout - increase to 60s, add exponential backoff
- **Option 2 (Week 2-3):** Event-based session start - eliminate polling entirely
- **Option 3 (Month 2-3):** Hybrid execution - evaluate if needed

**Architectural insights:**
- Forge provides **platform** (worktree isolation, task tracking)
- Genie provides **intelligence** (multi-turn conversations, agent specialization)
- Claude Code executor uses **both** via MCP (already working today!)

**Implementation ready:**
- Concrete code changes for Option 1 (background-launcher.ts:66-108)
- Testing plan
- Success criteria
- Timeline

**Status:** ✅ FINAL - Ready for implementation decision

---

## Quick Navigation

**Want to understand the bug?**
→ Read: FORGE-EXECUTOR-ANALYSIS-20251018.md (Section 1.2)

**Want to understand the architecture?**
→ Read: FORGE-EXECUTOR-DISCOVERY-20251018.md (Section "Architecture Discovery")

**Want actionable recommendations?**
→ Read: ISSUE-120-INVESTIGATION-SUMMARY-20251018.md (Section "Recommendations")

**Want implementation code?**
→ Read: ISSUE-120-INVESTIGATION-SUMMARY-20251018.md (Section "Immediate Action")

---

## Key Files Referenced

### Source Code
- `.genie/cli/src/lib/background-launcher.ts` - Contains the timeout race condition
- `.genie/cli/src/background-manager.ts` - Process spawning and PID tracking
- `.genie/mcp/src/server.ts` - Genie MCP server implementation
- `forge.ts` - ForgeClient (Forge's internal backend client)

### Documentation
- `.genie/agents/code/skills/forge-integration.md` - Forge as main entry point
- `.genie/docs/mcp-interface.md` - MCP tools quick reference
- `.genie/reports/FORGE-INTEGRATION-LEARNING-20251018.md` - Original learning doc

---

## Investigation Timeline

**09:00 UTC** - Started investigation
- Read forge.ts (ForgeClient with 80+ endpoints)
- Read FORGE-INTEGRATION-LEARNING document
- Assumed ForgeClient was integration point

**10:30 UTC** - Created FORGE-EXECUTOR-ANALYSIS report
- Documented race condition in background-launcher.ts
- Proposed replacing with ForgeClient API calls
- Estimated 300-400 line code deletion

**11:00 UTC** - Attempted ForgeClient testing
- Created test-forge-client.ts
- Discovered Forge server not running on HTTP
- Realized integration is via MCP, not HTTP API

**11:30 UTC** - Critical discovery (breakthrough)
- Read forge-integration.md (Forge as entry point)
- Read mcp-interface.md (Genie MCP tools)
- Understood Genie MCP vs Forge MCP distinction
- Created FORGE-EXECUTOR-DISCOVERY report

**12:00 UTC** - Read Genie MCP server source
- Found `.genie/mcp/src/server.ts`
- Confirmed shell-out pattern (MCP → CLI subprocess)
- Validated MCP integration architecture

**12:30 UTC** - Final synthesis
- Created ISSUE-120-INVESTIGATION-SUMMARY report
- Formulated Option 1/2/3 recommendations
- Provided implementation-ready code changes

**Status:** ✅ Investigation complete in ~3.5 hours

---

## Next Steps

1. **Review reports with team** - Validate findings and recommendations
2. **Decide on option** - Option 1 (quick fix) vs Option 2 (long-term) vs Option 3 (future)
3. **Create implementation branch** - `fix/genie-executor-timeout-race`
4. **Implement Option 1** - Code changes in background-launcher.ts
5. **Test thoroughly** - Normal start, slow start, failed start
6. **Create PR** - Link to Issue #120 and this investigation
7. **Update Issue #120** - Clarify scope (fix timeout, not replace executor)

---

## Lessons for Future Investigations

1. **Read in layers:** Code → Docs → Runtime (don't skip any)
2. **Validate assumptions:** "Uses same tech" ≠ "Does same thing"
3. **Test hypotheses:** Don't assume integration patterns, verify them
4. **Be willing to pivot:** Initial hypothesis (replace with Forge) was wrong
5. **Document discoveries:** Each report built on previous insights
6. **Synthesize final:** Summary report distills all findings into action

---

**Report Index End**
