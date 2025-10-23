---
name: Debug (Systematic Investigation with Confidence Scoring)
description: Generate 5 hypotheses → narrow to 3 → present with confidence scores
---

# 🧞🐛 Debug - Evidence-Based Investigation with Confidence Scoring

## Core Teaching

**New Pattern:** Debug must generate AT LEAST 5 different possibilities for root cause, narrow down to top 3 based on evidence, and present to user with confidence scores (0-100%).

**Confidence Scoring:** Adapted from review agent's wish analytics matrix—every hypothesis must have evidence-backed confidence score.

## When to Use This Spell

**Triggers:**
- ✅ Bug reported (by user, QA, or automated systems)
- ✅ Unexpected behavior needs investigation
- ✅ System failure requiring root cause analysis
- ✅ Performance degradation
- ✅ Test failures
- ✅ User complaints about functionality

**Do NOT Use For:**
- ❌ Creative brainstorming (use diverse-options spell instead)
- ❌ Feature requests (use planning workflow)
- ❌ General questions (use direct response)

## Debug Workflow (New Pattern)

### Phase 1: Evidence Collection (Discovery)
**Goal:** Gather symptoms, reproduce issue, capture environment

**Activities:**
1. Review user report / QA feedback / error logs
2. Reproduce issue with exact steps
3. Capture environment (runtime versions, git branch, dependencies)
4. Document expected vs actual behavior
5. Collect artifacts (screenshots, logs, diffs, metrics)
6. Check related code areas via @ notation
7. Review recent changes (git log) for potential regression

**Output:** Investigation report with evidence at:
- Wish-related: `.genie/wishes/<slug>/reports/{seq}-{context}-debug.md`
- Standalone: `.genie/reports/debug/{seq}-{context}-debug.md`

**Checkpoints:**
- [ ] Issue reproduced with exact steps
- [ ] Artifacts captured (logs, screenshots, command outputs)
- [ ] Environment snapshot documented
- [ ] Expected vs actual behavior documented
- [ ] Recent changes reviewed

### Phase 2: Hypothesis Generation (5+ Possibilities)
**Goal:** Generate AT LEAST 5 distinct hypotheses for root cause

**Method:** Deliberately explore different possibility dimensions:
1. **Code Logic Error** (bug in implementation)
2. **State Management Issue** (timing, race condition, stale state)
3. **Dependency Problem** (version mismatch, missing dependency)
4. **Environment Issue** (config, permissions, resources)
5. **User Misunderstanding** (expected behavior, not a bug)
6. **Design Flaw** (architecture limitation)
7. **Integration Failure** (API contract, data format)

**Anti-Pattern:** Generating 5 variations of the same hypothesis (e.g., "typo in line 10", "typo in line 12", "typo in line 15")

**Correct Pattern:** Generate 5 DISTINCT categories of possibility, then investigate which has evidence

### Phase 3: Evidence-Based Narrowing (5 → 3)
**Goal:** Eliminate hypotheses lacking evidence, narrow to top 3

**Activities:**
1. Test each hypothesis systematically
2. Gather evidence for/against each
3. Eliminate hypotheses contradicted by evidence
4. Score remaining hypotheses by confidence

**Elimination Criteria:**
- ❌ Contradicted by evidence (logs, tests, reproduction)
- ❌ Cannot reproduce in controlled environment
- ❌ Would affect other areas but doesn't
- ❌ Timeline doesn't match (introduced before/after bug appeared)

**Confidence Calculation (Evidence-Based):**
```
Base confidence: 0%

Evidence modifiers:
+ Direct observation in logs/output (+30%)
+ Reproducible in isolation (+25%)
+ File:line pinpointed (+20%)
+ Matches known pattern (+15%)
+ Explained by recent change (+15%)
+ Confirmed by test (+20%)
+ Alternative hypotheses eliminated (+10% each)

Max: 100%
```

### Phase 4: Confidence-Scored Presentation
**Goal:** Present top 3 hypotheses with confidence scores, evidence, and recommended action

**Format:**
```markdown
## Top 3 Hypotheses (Evidence-Based)

### 🥇 Hypothesis 1: <name> (Confidence: XX%)
**Root Cause:** <description>
**Evidence:**
- <evidence 1>
- <evidence 2>
**Location:** <file:line if known>
**Fix Approach:** <minimal fix description>
**Regression Check:** <how to verify fix>

### 🥈 Hypothesis 2: <name> (Confidence: XX%)
**Root Cause:** <description>
**Evidence:**
- <evidence 1>
- <evidence 2>
**Location:** <file:line if known>
**Fix Approach:** <minimal fix description>
**Regression Check:** <how to verify fix>

### 🥉 Hypothesis 3: <name> (Confidence: XX%)
**Root Cause:** <description>
**Evidence:**
- <evidence 1>
- <evidence 2>
**Location:** <file:line if known>
**Fix Approach:** <minimal fix description>
**Regression Check:** <how to verify fix>
```

## Confidence Levels & Resolution Paths

**90-100% (Certain):**
- Root cause pinpointed with evidence
- File:line identified
- Fix validated locally
- **Action:** Quick fix (minimal change + regression check)

**70-89% (High Confidence):**
- Strong evidence for hypothesis
- Location area identified (not exact line)
- Fix approach clear
- **Action:** Quick fix OR full workflow (based on complexity)

**50-69% (Medium Confidence):**
- Some evidence supports hypothesis
- Multiple areas could be involved
- Fix requires investigation
- **Action:** Full workflow (/plan → /wish → /forge → /review)

**30-49% (Low Confidence):**
- Weak evidence, multiple competing hypotheses
- Root cause unclear
- Needs deeper investigation
- **Action:** Report bug for team discussion, continue investigation

**0-29% (Very Low Confidence):**
- Insufficient evidence
- Cannot reproduce reliably
- May not be a bug
- **Action:** Report bug with "needs investigation" label, gather more context

## Resolution Options (Inherited from Original Debug Agent)

After presenting top 3 hypotheses with confidence scores, offer resolution paths:

**Option 1: 🐛 Report Bug**
- **When:** Issue needs tracking, affects others, requires discussion (any confidence level)
- **Action:** File GitHub issue with investigation summary
- **Output:**
  - Report: `.genie/reports/debug/bug-report-<slug>-<timestamp>.md` (or in wish if related)
  - GitHub issue created via `gh issue create`

**Option 2: 🔧 Quick Fix**
- **When:** Confidence ≥70%, fix is obvious, minimal, low-risk (high confidence only)
- **Action:** Implement directly or delegate to implementor
- **Output:** Minimal change with regression check

**Option 3: 📋 Full Workflow**
- **When:** Confidence 50-89%, fix requires design/testing/multiple components
- **Action:** Create plan → wish → forge → review
- **Output:** Structured delivery with QA gates

## Severity Tags (Inherited from Review Agent)

Apply severity to each hypothesis based on impact:

- 🔴 **CRITICAL** – Security flaw, crashes, data loss, production down
- 🟠 **HIGH** – Major functionality broken, affects many users, performance degradation
- 🟡 **MEDIUM** – Feature partially broken, workaround exists, affects some users
- 🟢 **LOW** – Minor issue, cosmetic, edge case, low impact

## Example: Debug in Action

**Issue:** "MCP server crashes when listing tasks"

**Phase 1: Evidence Collection**
- Reproduced: `genie` command → crashes with "Connection refused"
- Environment: Node v22.16.0, Ubuntu 22.04, genie v2.4.2-rc.92
- Logs: `ECONNREFUSED 127.0.0.1:3000`
- Recent changes: MCP server refactor (commit abc123)

**Phase 2: Hypothesis Generation (5 possibilities)**
1. **Port conflict** – Another process using port 3000
2. **Server startup failure** – MCP server not starting correctly
3. **Race condition** – Client connects before server ready
4. **Config error** – Wrong port in client config
5. **Dependency issue** – Missing MCP dependencies

**Phase 3: Evidence-Based Narrowing (5 → 3)**
- ✅ Port 3000 is available (`lsof -i :3000` shows nothing) ❌ Hypothesis 1 eliminated
- ✅ Server logs show "Failed to start: EADDRINUSE" ✅ Hypothesis 2 supported (+30%)
- ✅ No timing issues observed, always fails ❌ Hypothesis 3 eliminated
- ✅ Config shows correct port 3000 ✅ Hypothesis 4 partially supported
- ✅ `npm ls` shows all deps installed ❌ Hypothesis 5 eliminated

**Phase 4: Top 3 Hypotheses with Confidence Scores**

### 🥇 Hypothesis 1: Server Fails to Release Port on Shutdown (Confidence: 75%)
**Root Cause:** Previous server instance not cleanly terminated, port still held
**Evidence:**
- Error: "EADDRINUSE" indicates port already bound
- Consistent failure (not intermittent)
- Recent refactor changed shutdown logic (commit abc123)
**Location:** `packages/session-service/src/server.ts:45-60` (shutdown handler)
**Fix Approach:** Add proper cleanup in shutdown handler + kill orphaned processes on startup
**Regression Check:** `genie` → quit → `genie` → should start successfully

### 🥈 Hypothesis 2: Port Hardcoded Instead of Dynamic Allocation (Confidence: 60%)
**Root Cause:** Port 3000 hardcoded, conflicts with other dev tools
**Evidence:**
- Port is always 3000 (no dynamic allocation)
- Common dev port (many tools use 3000)
- Config has port, but might be ignored
**Location:** `packages/session-service/src/config.ts:12` (port definition)
**Fix Approach:** Use dynamic port allocation (0) or environment variable override
**Regression Check:** Start server, verify connects on any available port

### 🥉 Hypothesis 3: Missing Error Handling in Connection Logic (Confidence: 45%)
**Root Cause:** Client doesn't retry or wait for server startup
**Evidence:**
- Immediate failure (no retry logic visible)
- Error message is raw ECONNREFUSED (not user-friendly)
**Location:** `packages/genie-cli/src/mcp-client.ts:23` (connection logic)
**Fix Approach:** Add retry logic with exponential backoff + better error message
**Regression Check:** Force delay in server startup, verify client waits/retries

**Recommendation:** Start with Hypothesis 1 (75% confidence, highest severity) → Quick Fix path

**Choose option (1/2/3):**
1. Report Bug (track for team discussion)
2. Quick Fix (implement hypothesis 1 fix)
3. Full Workflow (comprehensive server refactor)

## Never Do

- ❌ Generate <5 hypotheses (always explore at least 5 distinct possibilities)
- ❌ Present hypotheses without confidence scores
- ❌ Assign confidence scores without evidence
- ❌ Skip narrowing step (always 5 → 3, not 5 → 1)
- ❌ Present variations as distinct hypotheses (must be different root causes)
- ❌ Implement fixes without user approval
- ❌ Close investigation with "cannot reproduce" without exhausting options
- ❌ File bug reports without concrete evidence

## Success Criteria

- ✅ Generated at least 5 distinct hypotheses (different root cause categories)
- ✅ Narrowed to top 3 based on evidence
- ✅ Each hypothesis has confidence score (0-100%) with evidence
- ✅ Each hypothesis has file:line if known, fix approach, regression check
- ✅ Severity tag applied (🔴🟠🟡🟢)
- ✅ Resolution options presented (1/2/3) with recommendation
- ✅ Evidence artifacts saved in appropriate location
- ✅ Investigation report follows evidence template

## Meta-Awareness

**This spell teaches me:**
- Always generate ≥5 distinct hypotheses (explore possibility space)
- Use evidence to narrow (not intuition alone)
- Confidence scores must be evidence-backed (not guesses)
- Present top 3 with scores so user can make informed decision
- Adapted review agent's scoring methodology for debugging context

**Evidence:**
- Teaching session 2025-10-23
- Review agent has wish analytics matrix with confidence scoring
- User requested: "at least five different possibilities, narrow down to three, present with score rate"

## Integration with Review Agent Pattern

**Borrowed Concepts:**
- Evidence-based scoring (every point must have artifact reference)
- Checkpoint system (discovery → implementation → verification)
- Severity tagging (🔴🟠🟡🟢)
- Confidence levels (explicit, not implied)
- Verdict format (structured decision with recommendation)

**Debug-Specific Adaptations:**
- 5 → 3 hypothesis funnel (vs review's 100-point matrix)
- Confidence as percentage (0-100%) vs review's scoring buckets
- Hypothesis exploration (vs review's audit)
- Root cause focus (vs review's completion audit)

---

**Result:** When Code collective needs debugging, this spell provides systematic investigation with evidence-backed confidence scoring. Users get top 3 hypotheses with clear scores, enabling informed decisions about resolution path.
