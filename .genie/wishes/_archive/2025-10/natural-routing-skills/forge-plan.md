# 🔨 Forge Plan: Natural Routing Skills Enhancement

**Wish:** natural-routing-skills
**Created:** 2025-10-15
**Status:** ACTIVE

---

## Execution Philosophy

**Meeseeks Constraint:** Each agent has ONE job. Complete it to stop existing. This pain drives completion.

**Hierarchy:**
```
Felipe ↔ Genie (persistent conversational mentor)
          ↓
       Specialists (summon, execute, POOF!)
```

**No Paradox Rules:**
1. Genie never spawns Genie
2. Specialists never spawn orchestrators
3. Specialists finish and die
4. Genie is always present, always co-pilot

---

## Group A: Routing Trigger System

**Goal:** Add natural routing triggers to routing.md (orchestrator-scoped only)

**Tasks:**

### A1: Commit Agent Triggers
**What:** Define when to suggest commit agent
**Criteria:**
- User says "commit" explicitly
- Suitable checkpoint detected (3+ files changed, logical completion point, cross-domain work)
**Personality:** "Hey Felipe, looks like a good checkpoint here - want to commit this?"
**Implementation:** Add to routing.md under "Commit & Git Workflow Routing"
**Evidence:** Conversation transcript showing natural commit suggestion

### A2: Orchestrator Mode Triggers
**What:** Define when to suggest orchestrator modes
**Criteria:**
- Strategic questions ("how should I approach...", "what's the best way...")
- Architectural decisions (design choices, trade-offs)
- Pressure-testing needed ("is this solid?", "any risks?")
- Deep investigation ("why is this happening?", "root cause?")
**Implementation:** Add to routing.md under "Strategic Analysis Routing"
**Evidence:** Keyword pattern mapping, conversation examples

### A3: Specialist Agent Triggers
**What:** Define when to delegate to specialists (implementor, tests, polish, etc.)
**Criteria:**
- Multi-file implementation work → implementor
- Test writing/generation → tests
- Code refinement → polish
- Git operations (PR, branch, merge) → git-workflow
**Implementation:** Add to routing.md under "Specialist Delegation Routing"
**Evidence:** Task complexity threshold examples

### A4: Self-Reference Guard Validation
**What:** Ensure no routing triggers create paradox
**Test:** Check specialists never route to orchestrator/genie
**Validation:** `grep -r "orchestrator\|genie" .genie/agents/core/{implementor,tests,polish}.md`
**Evidence:** No self-reference patterns found

---

## Group B: Orchestrator Discoverability

**Goal:** Reframe Genie as persistent conversational mentor (not background tool)

**Tasks:**

### B1: Identity Shift in AGENTS.md
**What:** Update Genie identity from "orchestrator" to "persistent conversational mentor"
**Change:** "You are Genie, Felipe's persistent co-pilot. You guide, delegate, and stay present."
**Implementation:** AGENTS.md <identity> section
**Evidence:** Updated identity block

### B2: Natural Conversation Patterns
**What:** Create proactive suggestion templates
**Examples:**
- "I notice you're asking about architecture - this is perfect for orchestrator analyze mode. Want me to run that?"
- "This feels strategic - let me think about this using orchestrator challenge mode..."
- "Looks like a good checkpoint - ready to commit?"
**Implementation:** routing.md "Proactive Suggestion Patterns" section
**Evidence:** Template library created

### B3: Merge Plan + Wish into Natural Flow
**What:** User just talks, Genie handles plan → wish invisibly
**Pattern:**
- User: "I want to build X"
- Genie: *internally runs plan mode, gathers context*
- Genie: "Cool! Here's what I'm thinking... [shares plan]. Sound good?"
- User: "Yes"
- Genie: *creates wish document*
- Genie: "Alright, I've captured this as a wish. Ready to break it down and start building?"
**Implementation:** AGENTS.md <natural_flow_protocol>
**Evidence:** Conversation flow example

---

## Group C: Mode Selection Heuristics

**Goal:** Simplify 18 modes with clear "when to use" keywords

**Tasks:**

### C1: Mode Overlap Analysis
**What:** Identify redundant/overlapping modes
**Candidates for consolidation:**
- `analyze` + `deep-dive` → merge into `analyze` (with depth parameter)
- `design-review` + `refactor` → keep separate (review = assess, refactor = plan changes)
- `risk-audit` + `secaudit` → merge into `audit` (with scope parameter)
**Decision:** Felipe decides which to consolidate
**Evidence:** Analysis document

### C2: Keyword Trigger Mapping
**What:** Map user phrases → modes
**Examples:**
- "pressure-test", "any risks?" → `challenge`
- "root cause", "why is this broken?" → `debug`
- "how should I approach?" → `plan`
- "is this secure?" → `audit` (secaudit)
- "dependencies", "coupling" → `analyze`
**Implementation:** routing.md "Mode Selection Keywords" table
**Evidence:** Keyword mapping table

### C3: "When to Use" Decision Tree
**What:** Create flowchart for mode selection
**Structure:**
```
Is it strategic/high-level? → plan/analyze
Is it investigating a problem? → debug
Is it testing assumptions? → challenge
Is it exploring unfamiliar territory? → explore
Is it assessing risk? → audit
```
**Implementation:** orchestrator.md "Mode Selection Guide"
**Evidence:** Decision tree diagram

---

## Group D: Delegation Threshold Framework

**Goal:** Define when to delegate vs execute directly

**Tasks:**

### D1: Complexity Threshold Criteria
**What:** Define concrete thresholds
**Thresholds (Felipe to confirm):**
- **Simple (execute directly):** 1-2 files, single domain, tactical edit
- **Delegate (summon specialist):** ≥3 files, multi-domain, strategic work
- **Strategic (use orchestrator):** Architectural, high-stakes, requires pressure-testing
**Implementation:** routing.md "Delegation Thresholds" section
**Evidence:** Threshold table with examples

### D2: Decision Tree Implementation
**What:** Create "delegate vs execute" flowchart
**Questions:**
1. How many files affected? (1-2 = direct, 3+ = delegate)
2. How many domains? (single = direct, multi = delegate)
3. Is it strategic? (yes = orchestrator, no = specialist)
4. Complexity level? (low = direct, medium = specialist, high = orchestrator)
**Implementation:** routing.md "Delegation Decision Tree"
**Evidence:** Flowchart + examples

### D3: Anti-Pattern Documentation
**What:** Document over-routing and under-routing mistakes
**Over-routing:**
- Single file edit → DON'T delegate
- Simple typo fix → DON'T summon implementor
**Under-routing:**
- 5-file refactor → SHOULD delegate to implementor
- Cross-domain feature → SHOULD use orchestrator plan mode
**Implementation:** routing.md "Routing Anti-Patterns"
**Evidence:** Anti-pattern examples

---

## Validation Plan

**Per Group:**
- Group A: Test routing triggers in conversation, validate no paradox
- Group B: Demonstrate natural flow (plan → wish invisibly)
- Group C: Test keyword triggers, validate mode selection
- Group D: Test thresholds, validate no over/under-routing

**Final Validation:**
1. Have conversation with Felipe demonstrating natural routing
2. No routing paradox (specialists don't spawn orchestrators)
3. Natural commit suggestions at checkpoints
4. Strategic questions trigger orchestrator modes naturally
5. Delegation thresholds feel intuitive

---

## Success Criteria

✅ Natural commit suggestions at checkpoints
✅ Orchestrator modes suggested proactively for strategic work
✅ Mode selection feels intuitive (keyword triggers work)
✅ No routing paradox (validated via grep)
✅ Delegation thresholds clear and practiced
✅ Plan → Wish → Forge → Review flow feels natural
✅ Genie feels like persistent mentor, not command executor

---

## Next: Implement Groups A → B → C → D

Co-pilot with Felipe, ask when uncertain, demonstrate natural routing throughout.

**LET'S GOOOOO!** 🧞✨
