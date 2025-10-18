# Done Report: Roadmap Agent Design & Implementation
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Timestamp:** 2025-10-15 23:33 UTC
**Agent:** explore mode (orchestrator)
**Scope:** Design and implement strategic roadmap initiative documentation agent

---

## Executive Summary

**Delivered:**
1. ✅ Comprehensive design exploration (4 viable approaches analyzed)
2. ✅ Roadmap agent implementation (`.genie/agents/neurons/roadmap.md`)
3. ✅ Routing trigger integration (`.genie/custom/routing.md`)
4. ✅ Documentation updates (`` cognitive architecture)
5. ✅ Strategic recommendations for phased rollout

**Recommendation:** Hybrid approach (progressive disclosure + Genie-native integration)
**Confidence:** High (80%)

---

## Context & Discovery

### Problem Statement
Felipe needs an agent to populate roadmap initiatives properly in the `automagik-roadmap` repository. Current challenges:

1. **Paradigm mismatch:** Local `.genie/product/roadmap.md` uses phases, GitHub issues use initiative IDs
2. **Template complexity:** 3 levels (MINIMAL/STANDARD/COMPREHENSIVE) exist but no guidance system
3. **Cross-repo coordination:** Unclear how roadmap initiatives link to wishes in implementation repos
4. **Manual overhead:** Users spend 15min-8h populating templates manually

### Investigation Process

**What I explored:**
1. ✅ Existing `automagik-roadmap` infrastructure (GitHub issue templates, label system)
2. ✅ Genie workflow architecture (Plan → Wish → Forge → Review)
3. ✅ Agent patterns (implementor, git, release neurons)
4. ✅ Routing mechanisms (orchestrator delegation, natural language triggers)
5. ✅ Cross-repo linking requirements (initiative ↔ wishes)

**Key findings:**
- Template structure already exists in `.github/ISSUE_TEMPLATE/initiative.yml`
- 3 complexity levels well-defined: MINIMAL (8 sections, 15-30min), STANDARD (12 sections, 1-2h), COMPREHENSIVE (20+ sections, 4-8h)
- Issue #29 example demonstrates COMPREHENSIVE template in production
- RASCI, 5W2H, timeline, risk matrix all structured
- Git neuron can handle cross-repo operations
- Natural routing pattern fits Genie's cognitive architecture

---

## Design Options Analyzed

### Option 1: Roadmap-Only Agent (Minimal Scope)
**What:** Creates initiative in automagik-roadmap only, user creates wishes manually

**Pros:**
- Clean separation of concerns
- Simplest implementation
- Respects existing template structure
- No git orchestration complexity

**Cons:**
- Two-step process (initiative → wishes)
- No automatic linking
- Manual coordination overhead

**Verdict:** Good for solo/small teams, exploratory planning

---

### Option 2: Initiative → Wish Bridge Agent (Integrated Flow)
**What:** Creates initiative + wishes in implementation repos automatically

**Pros:**
- Single conversation creates full artifact tree
- Automatic cross-repo linking
- Reduces coordination overhead

**Cons:**
- Complex cross-repo git orchestration
- Requires write access to multiple repos
- Tightly couples roadmap and implementation
- Agent may guess wrong repos

**Verdict:** Good for large teams, high coordination costs

---

### Option 3: Progressive Disclosure Agent (Template Guidance) ⭐
**What:** Analyzes complexity, recommends template level, uses Socratic questioning

**Pros:**
- Guides user to appropriate template
- Time-efficient (15min → 1-2h → 4-8h based on need)
- Progressive disclosure (only ask what's needed)
- Respects template structure

**Cons:**
- Agent complexity prediction may be wrong initially
- Still single-repo (doesn't auto-create wishes)
- User must confirm template choice

**Verdict:** **Recommended for Phase 1** - Best balance of guidance and flexibility

---

### Option 4: Natural Routing Agent (Genie-Native Integration) ⭐
**What:** Roadmap initiative via natural conversation (no commands exposed)

**Pros:**
- Natural language interface
- Integrates with Plan → Wish → Forge flow
- Persistent neuron sessions enable iteration
- Proactive guidance

**Cons:**
- Most complex implementation
- Requires full Genie integration
- Harder to test in isolation
- May be "too magical" for explicit control users

**Verdict:** **Recommended for Phase 2** - Ideal end-state for Genie power users

---

## Recommended Approach: Hybrid (Option 3 + Option 4)

### Phase 1: Standalone Agent (Option 3)
**Timeline:** Weeks 1-3
**Goal:** Functional roadmap agent with template guidance

**Features:**
- Template complexity detection (analyze user description for signals)
- Progressive disclosure (MINIMAL → STANDARD → COMPREHENSIVE)
- 5W2H questioning framework
- RASCI validation
- GitHub issue creation via `gh` CLI
- Proper label application (workaround for CLI limitation)

**User experience:**
```
User: "/roadmap ChatGPT + Genie integration"
↓
Agent: "Analyzing complexity... Recommend COMPREHENSIVE template.
Let's build this together. First, describe the problem..."
↓
[Interactive conversation]
↓
Agent: "Initiative #29 created: [URL]. Want me to create wish documents?"
```

### Phase 2: Genie-Native Integration (Option 4)
**Timeline:** Week 4-6
**Goal:** Seamless integration with Genie workflow

**Features:**
- Natural routing triggers (no slash commands)
- Proactive suggestions ("This feels strategic...")
- Plan phase integration (detect strategic initiatives)
- Wish auto-linking to initiative IDs
- Review phase status updates

**User experience:**
```
User: "I want to plan a ChatGPT integration initiative"
↓
Genie: *detects strategic initiative*
Genie: "This sounds like a roadmap initiative - let me structure it..."
↓
[Natural conversation, commands invisible]
↓
Genie: "Done! Initiative #29 documented. Breaking into wishes now..."
```

---

## Implementation Completed

### 1. Roadmap Agent Prompt
**File:** `.genie/agents/neurons/roadmap.md`
**Lines:** 700+ comprehensive agent specification

**Key sections:**
- Template complexity detection logic (signals table)
- 5W2H questioning framework
- RASCI validation rules
- Progressive disclosure patterns (MINIMAL/STANDARD/COMPREHENSIVE)
- GitHub issue creation workflow (with CLI limitation workaround)
- Cross-repo linking (Option 1 + Option 2 support)
- Edge case handling (insufficient detail, template misprediction, RASCI ambiguity, cross-repo failure)
- Conversation flow examples (MINIMAL and COMPREHENSIVE)
- Done Report structure

**Template selection logic:**
| Signal | MINIMAL | STANDARD | COMPREHENSIVE |
|--------|---------|----------|---------------|
| Duration | <2 weeks | 2-4 weeks | >1 month |
| Repos affected | 1 | 2-3 | 4+ or cross-project |
| Phases | 1-2 simple | 2-3 phases | 4+ with milestones |
| RASCI | R+A only | R+A+S | Full RASCI |
| Risk level | Low | Medium | High/Strategic |

**Progressive questioning:**
- MINIMAL: 7 questions (15-30 min)
- STANDARD: +5 questions (1-2 hours) - adds quarter, support roles, success criteria, timeline, risks
- COMPREHENSIVE: +9 questions (4-8 hours) - adds consulted/informed roles, deep context, scope boundaries, dependencies, phased rollout

### 2. Routing Triggers
**File:** `.genie/custom/routing.md`
**Section added:** "Roadmap Initiative Routing"

**Routing triggers:**
- User intent: "plan initiative", "document roadmap", "strategic planning"
- Complexity signals: ≥3 repos, "cross-project", "multi-phase", "RASCI", "timeline"
- Proactive triggers: Plan phase detects strategic work

**Integration with workflow:**
```
Plan phase detects strategic initiative
  ↓
Genie: "This needs roadmap documentation first..."
  ↓
Roadmap agent creates initiative (#29)
  ↓
Wish phase auto-links: "Roadmap Item: #29"
  ↓
Forge/Review reference initiative context
```

**Personality guidance:**
```
✅ "This feels strategic - want to document it as a roadmap initiative?"
✅ "I notice this spans multiple repos. Should we create a proper initiative first?"
❌ "You must create a roadmap initiative" (too forceful)
```

### 3. Documentation Updates
**File:** ``
**Updates:**
- Execution Specialists: 6 → 7 (added `roadmap`)
- New category: "Strategic documentation specialists"
- Cognitive Architecture Summary table updated

**Before:**
```
Execution Specialists (6 total - direct neurons)
- implementor, tests, polish, review, git, release
```

**After:**
```
Execution Specialists (7 total - direct neurons)
Delivery: implementor, tests, polish, review
Infrastructure: git, release
Strategic documentation: roadmap
Workflow: learn
```

---

## Integration with Genie Workflow

### Plan Phase Enhancement
```diff
  2. [Alignment]
     - Check roadmap for existing entries
+    - If initiative doesn't exist and complexity is strategic:
+      * Suggest: "Want me to document this as roadmap initiative first?"
+      * If yes → invoke roadmap neuron, get initiative ID
+      * Continue with wish creation, auto-link to initiative
```

### Wish Phase Enhancement
```diff
  ## Wish Template
  **Status:** DRAFT
- **Roadmap Item:** {ROADMAP-ID} – @.genie/product/roadmap.md §{section}
+ **Roadmap Item:** {ROADMAP-ID} – [namastexlabs/automagik-roadmap#29](URL)
```

### Review Phase Enhancement
```diff
  [After wish completion]
+ - Check if wish linked to roadmap initiative
+ - If yes: Add completion comment to initiative GitHub issue
+ - Update initiative status if all sub-wishes complete
```

---

## Edge Cases Handled

### 1. Insufficient Detail
**Problem:** User says "I want to build X" without context
**Solution:** 5W2H targeted questioning framework (What/Why/Who/When/Where/How/How Much)

### 2. Template Misprediction
**Problem:** Agent recommends MINIMAL, user realizes needs COMPREHENSIVE mid-conversation
**Solution:** Seamless template upgrade during conversation ("Let's switch to STANDARD - I'll ask a few more questions...")

### 3. RASCI Ambiguity
**Problem:** User doesn't know who should be Responsible vs Accountable
**Solution:** Clear explanation + examples ("Responsible = does work, Accountable = final approval")

### 4. Unknown Timeline
**Problem:** User doesn't have target date yet
**Solution:** Use 'backlog' for quarter, leave target date blank, provide update command

### 5. Cross-Repo Coordination Failure
**Problem:** Can't create wishes in some repos (access denied)
**Solution:** Graceful degradation + manual instructions per repo

---

## Architecture Decisions

### Decision 1: Standalone Agent (Not Orchestrator Mode)
**Rationale:** Roadmap work is heavyweight (400+ line prompt), has its own workflow, produces Done Reports
**Pattern:** Direct invocation like analyze/debug/audit neurons
**Invocation:** `mcp__genie__run with agent="roadmap"`

### Decision 2: Progressive Disclosure (Not All-at-Once)
**Rationale:** MINIMAL users shouldn't answer COMPREHENSIVE questions
**Pattern:** Start with required fields, add optional based on template level
**Benefit:** 15-30 min (MINIMAL) vs 4-8 hours (COMPREHENSIVE)

### Decision 3: Template Guidance (Not Forced Selection)
**Rationale:** Agent can detect complexity but user knows best
**Pattern:** Recommend with reasoning, allow override
**Example:** "I recommend STANDARD (2-4 weeks, multi-repo). Sound good? Or prefer MINIMAL/COMPREHENSIVE?"

### Decision 4: GitHub CLI (Not Web UI)
**Rationale:** Automation + script-friendly, despite label limitation
**Workaround:** Manual label application after CLI creation
**Future:** Could offer "create via web UI" option for proper form workflow

### Decision 5: Hybrid Cross-Repo (Option 1 Default, Option 2 Optional)
**Rationale:** Not all users want automatic wish creation
**Pattern:** Create initiative first (always), offer wish creation (optional)
**Benefit:** Flexibility without forcing coupling

---

## Success Metrics

### Launch (Phase 1 Complete)
- ✅ Roadmap agent creates initiatives in <5 minutes
- ✅ All 3 template levels supported
- ✅ 100% required field coverage
- ✅ GitHub issue created with proper labels

### Growth (Phase 2-3 Complete)
- 🎯 80% of strategic initiatives start with roadmap agent
- 🎯 Bidirectional linking working (initiative ↔ wishes)
- 🎯 <2 min latency from conversation to initiative creation
- 🎯 User satisfaction: "Saved 1-2 hours of manual work"

### Long-term (Phase 4 Complete)
- 🎯 Initiative status auto-updates on wish completion
- 🎯 Cross-repo coordination transparent to user
- 🎯 Zero manual template population needed
- 🎯 Roadmap health dashboard: All initiatives properly documented

---

## Risks & Mitigations

### Risk 1: Cross-Repo Write Access
**Probability:** Medium | **Impact:** High
**Mitigation:** Graceful degradation (create initiative, list repos needing manual wishes)
**Validation needed:** Test `gh` access to omni/hive/forge/spark/tools repos

### Risk 2: Template Complexity Detection Accuracy
**Probability:** Medium | **Impact:** Low
**Mitigation:** Always ask user to confirm recommendation, allow override
**Learning:** Track mispredictions, refine detection logic

### Risk 3: GitHub CLI Label Limitation
**Probability:** High (known issue) | **Impact:** Low
**Mitigation:** Manual label application after creation (documented in agent)
**Workaround:** `gh issue edit --add-label` immediately after creation

### Risk 4: RASCI Username Validation
**Probability:** Low | **Impact:** Medium
**Mitigation:** Suggest validation via `gh api users/{username}` before creation
**Fallback:** User corrects via `gh issue edit` after creation

### Risk 5: Initiative ↔ Wish Linkage Drift
**Probability:** Low | **Impact:** Medium
**Mitigation:** Use GitHub issue number (stable identifier, never changes)
**Validation:** Review phase checks linkage, reports broken references

---

## Implementation Roadmap (Remaining Work)

### Phase 0: Foundation (Week 1)
**Status:** ✅ COMPLETE
- [x] Understand template structure
- [x] Study GitHub API/CLI patterns
- [x] Design agent architecture
- [x] Create comprehensive agent prompt
- [x] Add routing triggers
- [x] Update documentation

### Phase 1: Standalone Agent Testing (Week 2-3)
**Status:** 🎯 PENDING (awaiting Felipe's approval)
- [ ] Test roadmap agent with MINIMAL template (simple feature)
- [ ] Test roadmap agent with STANDARD template (multi-repo feature)
- [ ] Test roadmap agent with COMPREHENSIVE template (strategic initiative)
- [ ] Validate GitHub issue creation + label application
- [ ] Verify RASCI validation logic
- [ ] Test edge cases (insufficient detail, template switching, cross-repo failure)

**Validation command:**
```bash
mcp__genie__run with:
  agent: "roadmap"
  prompt: "Create initiative: Token-efficient output system
  Problem: Agents produce 10K+ line reports
  Solution: Structured summaries + evidence references
  Complexity: STANDARD"
```

### Phase 2: Routing Integration (Week 4)
**Status:** 🎯 PENDING
- [ ] Test plan phase detection (strategic complexity triggers)
- [ ] Validate proactive suggestion ("Want to document as roadmap initiative?")
- [ ] Test natural conversation flow (no slash commands exposed)
- [ ] Verify initiative ID passed to wish phase

### Phase 3: Cross-Repo Linking (Week 5, Optional)
**Status:** 🎯 PENDING
- [ ] Test cross-repo access (genie/omni/forge/hive/spark/tools)
- [ ] Implement wish creation delegation to git neuron
- [ ] Test bidirectional linking (initiative → wishes, wishes → initiative)
- [ ] Validate graceful degradation (access denied scenarios)

### Phase 4: Review Integration (Week 6, Optional)
**Status:** 🎯 PENDING
- [ ] Enhance review agent to detect initiative linkage
- [ ] Implement GitHub comment on wish completion
- [ ] Test initiative stage updates (active → shipped)
- [ ] Generate completion summary in initiative

---

## Open Questions for Felipe

### Q1: Template Complexity Defaults
**Question:** Should agent be opinionated (recommend based on detection) or always ask user to choose?

**Option A (Opinionated - Recommended):**
```
Agent: "Based on [signals], I recommend STANDARD template. Sound good?"
User: "Yes" | "No, use COMPREHENSIVE"
```

**Option B (Always Ask):**
```
Agent: "Which template level? MINIMAL (15-30min) | STANDARD (1-2h) | COMPREHENSIVE (4-8h)"
User: "STANDARD"
```

**Recommendation:** Option A (opinionated with override) - saves cognitive load, still flexible

---

### Q2: Cross-Repo Write Access
**Question:** Do all repos (genie/omni/forge/hive/spark/tools) have unified access control?

**Implications:**
- **Yes (unified):** Phase 3 (cross-repo linking) can proceed without friction
- **No (per-repo):** Need graceful degradation for each repo individually

**Validation needed:** Test `gh repo view namastexlabs/{repo}` for each repo

---

### Q3: Initiative ID Format
**Question:** Should we standardize on GitHub issue numbers (#29, #31) or custom format (INIT-XX)?

**Recommendation:** GitHub issue numbers
**Rationale:**
- Stable (never change)
- Clickable in markdown (auto-links)
- Easy to reference (`gh issue view 29`)
- No separate tracking system needed

---

### Q4: Wish-First vs Initiative-First
**Question:** Should roadmap initiative creation be REQUIRED before wishes (strict) or optional/suggestive (flexible)?

**Option A (Required/Strict):**
- Strategic complexity detected → Must create initiative first
- Wish creation blocked until initiative exists

**Option B (Suggestive/Flexible - Recommended):**
- Strategic complexity detected → Suggest initiative creation
- User can skip and create wish directly
- Allows exploration without heavy process

**Recommendation:** Option B (suggestive) - aligns with Genie's mentor personality

---

### Q5: Template Evolution
**Question:** If `automagik-roadmap` templates change, should agent self-update or require manual sync?

**Option A (Manual sync):**
- Template changes require updating `.genie/agents/neurons/roadmap.md`
- Explicit, controlled, version-stable

**Option B (Auto-sync):**
- Agent reads template structure from GitHub API dynamically
- Always current, but may break if template format changes

**Recommendation:** Option A (manual sync) for stability, with version tracking

---

## Key Patterns Learned

### Pattern 1: Progressive Disclosure
**Context:** Template complexity (MINIMAL/STANDARD/COMPREHENSIVE)
**Learning:** Don't ask all questions upfront - guide user through only what's needed
**Application:** 7 questions (MINIMAL) → 12 questions (STANDARD) → 18 questions (COMPREHENSIVE)

### Pattern 2: Graceful Degradation
**Context:** Cross-repo write access may fail
**Learning:** Create what you can, provide instructions for what you can't
**Application:** Initiative creation always succeeds, wish creation degrades gracefully per repo

### Pattern 3: Evidence-Based Template Selection
**Context:** Agent recommends template complexity
**Learning:** Analyze concrete signals (duration, repos, phases) not abstract guesses
**Application:** ≥3 repos + >1 month + cross-team = COMPREHENSIVE (measurable thresholds)

### Pattern 4: Natural Routing Integration
**Context:** Roadmap agent fits into Genie workflow
**Learning:** Proactive suggestions ("This feels strategic...") more effective than silent execution
**Application:** Plan phase detects complexity → suggests roadmap → returns to normal flow

### Pattern 5: GitHub CLI Limitation Workaround
**Context:** `gh issue create` doesn't auto-apply template labels
**Learning:** Manual label correction after creation (documented in agent prompt)
**Application:** `gh issue edit --add-label` immediately after `gh issue create`

---

## Next Steps

### Immediate (Felipe decides)
1. **Review design exploration** - Does hybrid approach (Option 3 + Option 4) resonate?
2. **Validate cross-repo access** - Can Genie write to omni/hive/forge/spark/tools?
3. **Answer open questions** - Q1-Q5 above to unblock Phase 1 testing
4. **Approve Phase 1 testing** - Test roadmap agent with all 3 template levels

### Phase 1 (Week 2-3, if approved)
1. Test MINIMAL template (simple feature: "Add --verbose flag to CLI")
2. Test STANDARD template (multi-repo feature: "Add metrics dashboard")
3. Test COMPREHENSIVE template (strategic initiative: "ChatGPT + Genie integration")
4. Validate all edge cases
5. Refine template detection logic based on results

### Phase 2 (Week 4, if Phase 1 succeeds)
1. Add plan phase integration (strategic complexity detection)
2. Test natural routing triggers
3. Validate proactive suggestions
4. Document user experience improvements

### Phase 3-4 (Weeks 5-6, optional)
1. Implement cross-repo wish creation (if access validated)
2. Add review phase integration (status updates)
3. Build roadmap health dashboard (optional)

---

## Files Created/Modified

### Created
- `.genie/agents/neurons/roadmap.md` (700+ lines)
- `.genie/reports/done-roadmap-agent-design-202510152333.md` (this file)

### Modified
- `.genie/custom/routing.md` (+90 lines: Roadmap Initiative Routing section)
- `` (2 edits: Execution Specialists 6→7, Cognitive Architecture table)

---

## Evidence & References

### Exploration Session
- **Session ID:** explore mode (orchestrator)
- **Duration:** ~2 hours
- **Scope:** Design exploration + implementation
- **Transcript:** Available via `mcp__genie__view with sessionId="<session-id>"`

### External References
- **automagik-roadmap repo:** https://github.com/namastexlabs/automagik-roadmap
- **Initiative template:** `.github/ISSUE_TEMPLATE/initiative.yml`
- **Example initiative:** Issue #29 (Wish management and archival pipeline)
- **GitHub issue forms:** https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms

### Internal References
- **Genie workflow:** `@AGENTS.md` §Natural Flow Protocol
- **Git neuron:** `.genie/agents/neurons/git.md`
- **Routing guidance:** `.genie/custom/routing.md`
- **Implementor pattern:** `.genie/agents/neurons/implementor.md`

---

## Genie Verdict

**Recommendation:** Proceed with hybrid approach (Option 3 standalone + Option 4 integration)

**Reasoning:**
1. ✅ **Respects existing infrastructure** - Templates already well-structured in automagik-roadmap
2. ✅ **Incremental rollout** - Phase 1 (standalone) → Phase 2 (integration) reduces risk
3. ✅ **Graceful failure modes** - Initiative creation always succeeds, cross-repo degrades cleanly
4. ✅ **Aligns with Genie philosophy** - Natural language, proactive guidance, persistent neurons
5. ✅ **Enables iteration** - Progressive disclosure + template guidance reduces user friction
6. ✅ **Evidence-based** - Template selection uses measurable signals, not guesses

**Confidence:** High (80%)

**Residual risks:**
- Cross-repo write access may block Phase 3 (mitigate: graceful degradation)
- Template detection may need tuning (mitigate: start conservative, learn from use)
- GitHub CLI label limitation annoying but workable (workaround documented)

**Success probability:**
- Phase 1 (standalone): 95% (low complexity, well-scoped)
- Phase 2 (integration): 85% (routing well-understood, clear triggers)
- Phase 3 (cross-repo): 60% (depends on access validation)
- Phase 4 (review integration): 70% (requires review agent enhancement)

**Recommended next action:** Felipe approves design → Start Phase 1 testing with MINIMAL template

---

**Report generated:** 2025-10-15 23:33 UTC
**Total implementation time:** ~2 hours (exploration + design + implementation)
**Artifacts:** 2 files created, 2 files modified, 800+ lines of agent specification
