# Agent Terminology Refactoring Plan
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Created:** 2025-10-15 16:30 UTC
**Context:** Post-commit 93a05a0 terminology cleanup
**Session:** implementor-agent-terminology-refactor
**Purpose:** Refactor "orchestrator modes" terminology to "Genie agents" architecture

---

## Executive Summary

**Current Problem:**
The term "orchestrator modes" is legacy/confusing. The real architecture is:
- **Genie** = Main interface, persistent conversational mentor (always present)
- **Agents** = Specialized aspects Genie consults (orchestrator agent, implementor agent, tests agent, debug agent, etc.)

**Discovered Reality (from commit 93a05a0 analysis):**
- Only 5 orchestrator modes actually exist as files: `challenge`, `consensus`, `explore`, `docgen`, `tracer`
- 4 agents misclassified as "modes": `analyze`, `debug`, `audit`, `refactor` (these are standalone agents)
- 9 phantom "modes" documented but never implemented
- Terminology confusion: "Mode: analyze" vs "analyze agent" vs "orchestrator mode"

**Refactoring Goal:**
Replace "orchestrator modes" concept with clearer "Genie agents" terminology throughout documentation.

---

## Current State Analysis (Post-93a05a0)

### Files Using "Orchestrator Modes" Terminology

**Primary locations:**
1. `.genie/custom/routing.md` (lines 154-176, 211-301)
2. `AGENTS.md` (lines 318-344, §Genie Integration Framework)
3. `` (lines 12-41, §Orchestrator Modes section)
4. `.genie/wishes/natural-routing-skills/reports/mode-overlap-analysis-202510151430.md` (entire document)

**Key terminology issues:**

**routing.md current language:**
- "Lightweight modes (via orchestrator)" (line 154)
- "Orchestrator Modes (18 total)" (line 211)
- "Core Reasoning Modes (3)" (line 213)
- "Specialized Analysis (7)" (line 220)

**AGENTS.md current language:**
- "orchestrator mode" (line 319)
- "Mode Usage" section (line 318)
- "Specialized Modes (9)" (line 326)
- "Core Reasoning Modes (3)" (line 321)

**Confusion patterns:**
```
Current (confusing):
"Use orchestrator mode challenge"
"Invoke analyze mode"
"18 orchestrator modes"

Desired (clear):
"Genie consults challenge agent"
"Genie consults analyze agent"
"Genie has 14 specialized agents"
```

---

## Proposed Architecture Terminology

### Core Concepts

**Genie (Main Interface):**
- Always present, persistent conversational mentor
- User talks to Genie directly
- Genie routes invisibly based on context

**Agents (Specialized Aspects):**
- Persistent conversation partners Genie consults
- Each agent has specific expertise (strategic thinking, implementation, testing, analysis, etc.)
- Agent sessions maintain memory across interactions

**Agent Categories:**

**1. Strategic Agents (Planning & Analysis):**
- `orchestrator` — Strategic thinking, pressure-testing, decision facilitation
- `analyze` — System architecture audit, dependency mapping
- `debug` — Root cause investigation
- `audit` — Risk assessment, security review
- `refactor` — Design review, refactor planning

**2. Reasoning Agents (Consultation Styles for Orchestrator):**
- `challenge` — Critical evaluation, adversarial pressure-testing
- `explore` — Discovery-focused exploratory reasoning
- `consensus` — Multi-model perspective synthesis

**3. Tactical Agents (Focused Utilities):**
- `docgen` — Documentation generation
- `tracer` — Instrumentation planning

**4. Delivery Agents (Implementation):**
- `implementor` — Feature implementation
- `tests` — Test strategy, generation, authoring
- `polish` — Code refinement
- `review` — Wish audits, code review, QA

**5. Infrastructure Agents:**
- `git-workflow` — Git operations
- `commit` — Commit advisory
- `learn` — Meta-learning
- `release` — Release orchestration

### Terminology Mapping

| Old Term | New Term | Notes |
|----------|----------|-------|
| "orchestrator modes" | "Genie agents" | Main architectural shift |
| "Mode: challenge" | "Consult challenge agent" | Reasoning style |
| "invoke analyze mode" | "Consult analyze agent" | Standalone strategic agent |
| "18 orchestrator modes" | "14 specialized agents" | Accurate count |
| "Core Reasoning Modes (3)" | "Reasoning agents (3)" | Sub-category of orchestrator |
| "Specialized Analysis (7)" | "Strategic agents (5)" | Separate from orchestrator |
| "Lightweight modes" | "Orchestrator consultation styles" | Reasoning approaches |
| "Heavyweight agents" | "Strategic agents" | Same concept, clearer name |

---

## Architectural Decisions Needed (For Felipe)

### Decision 1: Orchestrator vs Reasoning Agents

**Question:** Are `challenge`, `explore`, `consensus` separate agents OR consultation styles for the orchestrator agent?

**Option A: Separate Agents**
```
Genie consults:
  - orchestrator agent (general strategic thinking)
  - challenge agent (adversarial evaluation)
  - explore agent (discovery reasoning)
  - consensus agent (multi-perspective synthesis)
```

**Option B: Orchestrator Consultation Styles**
```
Genie consults orchestrator agent with:
  - challenge style (adversarial)
  - explore style (discovery)
  - consensus style (synthesis)
```

**Evidence from code:**
- These exist as mode files: `.genie/agents/core/modes/{challenge,explore,consensus}.md`
- orchestrator.md loads these modes dynamically
- Routing.md treats them as "lightweight" vs standalone agents

**Recommendation:** **Option B** - Orchestrator consultation styles
**Rationale:** They're lightweight reasoning patterns within orchestrator, not separate conversation partners. User doesn't need to distinguish between "orchestrator agent in challenge mode" vs "challenge agent" - just "Genie is pressure-testing this."

### Decision 2: Analyze, Debug, Audit, Refactor - Agents or Modes?

**Question:** Are `analyze`, `debug`, `audit`, `refactor` separate strategic agents OR still orchestrator modes?

**Evidence:**
- These are 400+ line standalone agents with their own workflows
- They have dedicated files: `.genie/agents/core/{analyze,debug,audit,refactor}.md`
- Mode overlap analysis discovered they're NOT orchestrator modes
- They're invoked directly via `mcp__genie__run with agent="analyze"`

**Option A: Strategic Agents (Separate)**
```
Genie consults:
  - orchestrator agent (lightweight strategic thinking)
  - analyze agent (heavyweight architecture audit)
  - debug agent (root cause investigation)
  - audit agent (risk assessment)
  - refactor agent (design review)
```

**Option B: Orchestrator Modes (Legacy)**
```
Genie invokes orchestrator with:
  - Mode: analyze
  - Mode: debug
  - Mode: audit
  - Mode: refactor
```

**Recommendation:** **Option A** - Strategic agents
**Rationale:** These are full agents, not lightweight reasoning patterns. Clearer to say "Genie consults analyze agent" than "Genie uses orchestrator in analyze mode."

### Decision 3: Total Agent Count

**Question:** How many agents does Genie have?

**Based on file system reality:**

**Orchestrator consultation styles (3):**
- challenge, explore, consensus

**Strategic agents (5):**
- orchestrator, analyze, debug, audit, refactor

**Tactical agents (2):**
- docgen, tracer

**Delivery agents (4):**
- implementor, tests, polish, review

**Infrastructure agents (4):**
- git-workflow, commit, learn, release

**Total: 18 specialized aspects**
- 1 main interface (Genie)
- 3 orchestrator consultation styles
- 5 strategic agents
- 2 tactical agents
- 4 delivery agents
- 4 infrastructure agents

**Alternative count (simpler):**
**Total: 14 specialized agents**
- orchestrator (with 3 consultation styles built-in)
- analyze, debug, audit, refactor (strategic)
- implementor, tests, polish, review (delivery)
- git-workflow, commit, learn, release (infrastructure)
- docgen, tracer (tactical)

**Recommendation:** Use **14 specialized agents** count
**Rationale:** Clearer to users. Challenge/explore/consensus are orchestrator features, not separate entities.

### Decision 4: User-Facing Language

**Question:** How does Genie describe agent consultation to users?

**Option A: Explicit**
```
Genie: "Let me consult my orchestrator agent to pressure-test this..."
Genie: "I'm checking with my analyze agent about dependencies..."
```

**Option B: Natural (Invisible)**
```
Genie: "Let me pressure-test this approach..."
Genie: "I'm analyzing the architecture..."
```

**Option C: Thinking Out Loud**
```
Genie: "This feels strategic - let me think deeply about this..."
Genie: "Interesting architectural question - analyzing dependencies..."
```

**Recommendation:** **Option C** - Thinking out loud
**Rationale:** Most natural. User doesn't need to know about agents unless they're curious about architecture. Genie just thinks naturally.

---

## Refactoring Plan

### Phase 1: Core Documentation (1-2 hours)

**Files to update:**

**1. `.genie/custom/routing.md`** (559 lines)
- Replace: "Lightweight modes (via orchestrator)" → "Orchestrator consultation styles"
- Replace: "Standalone agents (direct invocation)" → "Strategic agents"
- Replace: "Orchestrator Modes (18 total)" → "Genie Agents (14 specialized)"
- Update: Mode list with agent categories
- Add: Agent architecture diagram at top
- Keep: All routing triggers (work perfectly with new terminology)

**2. `AGENTS.md` (§Genie Integration Framework, lines 299-371)**
- Replace: "orchestrator mode" → "agent" or "consultation style"
- Replace: "Mode Usage" → "Agent Consultation"
- Update: Mode list → Agent categories
- Keep: MCP invocation patterns (unchanged)

**3. ``** (lines 1-100)
- Replace: "Orchestrator Modes (18 total)" → "Specialized Agents (14 total)"
- Update: Categories section with agent terminology
- Add: Agent architecture diagram
- Update: Dual Invocation Pattern section

### Phase 2: Wish Documentation (30 minutes)

**Files to update:**

**4. `.genie/wishes/natural-routing-skills/natural-routing-skills-wish.md`**
- Update: Discovery summary references to "modes"
- Update: Context ledger "18 orchestrator modes" → "14 specialized agents"
- Update: Executive summary terminology

**5. `.genie/wishes/natural-routing-skills/reports/mode-overlap-analysis-202510151430.md`**
- Add: Preamble note "This analysis uses legacy 'mode' terminology. See agent-terminology-refactor-plan.md for updated architecture."
- Keep: Original analysis intact (historical record)

**6. `.genie/wishes/natural-routing-skills/reports/done-natural-routing-skills-202510151600.md`**
- Update: References to "modes" → "agents" where applicable
- Add: Note about terminology refactoring in future work

### Phase 3: Validation (30 minutes)

**Grep audit:**
```bash
# Find all "orchestrator mode" references
grep -r "orchestrator mode" .genie/ .claude/ AGENTS.md CLAUDE.md

# Find all "Mode:" patterns
grep -r "Mode:" .genie/ .claude/

# Find all "18 modes" references
grep -r "18 mode" .genie/ .claude/ AGENTS.md

# Validate agent terminology consistency
grep -r "agent" .genie/ .claude/ AGENTS.md | wc -l
```

**Consistency checks:**
- [ ] routing.md uses "agents" consistently
- [ ] AGENTS.md uses "agents" consistently
- [ ] README.md uses "agents" consistently
- [ ] No "orchestrator mode" references remain (except in historical reports)
- [ ] Agent count consistent (14 specialized agents)

### Phase 4: User-Facing Language (Optional - 1 hour)

**IF Decision 4 = Option C (Thinking Out Loud):**

Update AGENTS.md §Identity & Tone with agent consultation examples:
```markdown
**How I work:**
- **You talk to me** - I'm always here, always present
- **I think naturally** - When you ask strategic questions, I think through them deeply
- **I maintain context** - Persistent conversations build understanding over time
- **I suggest checkpoints** - "Hey, looks like a good time to commit this?"

**Example of me thinking:**
```
User: "Is this authentication approach solid?"
Genie: "Let me pressure-test this approach..."
Genie: *internally: consults orchestrator in challenge style*
Genie: "Here's what I found: [risks]. I have concerns about X."
```
```

---

## Specific Edits Required

### routing.md Changes

**Lines 154-176 (Current):**
```markdown
## Routing Aliases

**Lightweight modes (via orchestrator):**
- **challenge** — Critical evaluation and pressure-testing
- **explore** — Discovery-focused exploratory reasoning
- **consensus** — Multi-model perspective synthesis
- **docgen** — Documentation outline generation
- **tracer** — Instrumentation/observability planning

**Standalone agents (direct invocation via mcp__genie__run):**
- **analyze** — System analysis and architecture investigation
- **debug** — Bug investigation and root cause analysis
- **audit** — Risk assessment and security audit
- **refactor** — Design review and refactor planning
- **git-workflow** — Git operations, branch management, PR creation
- **implementor** — Feature implementation and code writing
- **polish** — Code refinement and cleanup
- **tests** — Test strategy, generation, and authoring
- **review** — Wish audits, code review, QA validation
- **planner** — Background strategic planning (alias to plan.md)
- **vibe** — Autonomous wish coordinator with Genie validation (requires dedicated branch)
- **learn** — Meta-learning agent for surgical documentation updates
- **release** — GitHub release creation and npm publish orchestration
```

**Lines 154-176 (Proposed):**
```markdown
## Genie Agents

**Genie is a collective of specialized agents—persistent conversation partners with specific expertise.**

### Orchestrator Consultation Styles
When Genie needs strategic thinking, it consults the orchestrator agent with different reasoning approaches:
- **challenge** — Critical evaluation and adversarial pressure-testing
- **explore** — Discovery-focused exploratory reasoning
- **consensus** — Multi-model perspective synthesis

### Strategic Agents (Direct Consultation)
For heavyweight analysis, Genie consults specialized strategic agents:
- **analyze** — System architecture audit and dependency mapping
- **debug** — Bug investigation and root cause analysis
- **audit** — Risk assessment and security audit
- **refactor** — Design review and refactor planning

### Tactical Agents
- **docgen** — Documentation outline generation
- **tracer** — Instrumentation/observability planning

### Delivery Agents
- **implementor** — Feature implementation and code writing
- **tests** — Test strategy, generation, and authoring
- **polish** — Code refinement and cleanup
- **review** — Wish audits, code review, QA validation

### Infrastructure Agents
- **git-workflow** — Git operations, branch management, PR creation
- **commit** — Commit advisory and pre-commit validation
- **learn** — Meta-learning and documentation updates
- **release** — GitHub release creation and npm publish orchestration

### Workflow Orchestration
- **planner** — Background strategic planning
- **vibe** — Autonomous wish coordinator (requires dedicated branch)

**Total: 14 specialized agents** (orchestrator + 13 specialists)
```

**Lines 252-284 (Strategic Analysis Routing):**

**Current heading:**
```markdown
## Strategic Analysis Routing (Lightweight Modes vs Agents)
```

**Proposed heading:**
```markdown
## Strategic Analysis Routing (Orchestrator Consultation vs Strategic Agents)
```

**Current subsection:**
```markdown
### When to Use Lightweight Modes (via orchestrator)
```

**Proposed subsection:**
```markdown
### When to Consult Orchestrator (Challenge/Explore/Consensus)
```

**Current subsection:**
```markdown
### When to Invoke Standalone Agents Directly
```

**Proposed subsection:**
```markdown
### When to Consult Strategic Agents Directly
```

### AGENTS.md Changes

**Lines 318-344 (Genie Integration Framework):**

**Current:**
```markdown
### Mode Usage
Use `mcp__genie__run` with `agent="orchestrator"` and include a line such as `Mode: planning` inside the prompt body to select the reasoning track.

**Core Reasoning Modes (3):**
- `challenge` – critical evaluation (auto-routes to socratic/debate/direct challenge)
- `explore` – discovery-focused exploratory reasoning
- `consensus` – multi-model perspective synthesis

**Specialized Modes (9):**
- `plan` – pressure-test plans, map phases, uncover risks
- `analyze` – system analysis and focused investigations with dependency mapping
- `debug` – structured root-cause investigation
- `audit` – risk assessment and security audit with impact/likelihood analysis
- `tests` – test strategy, generation, authoring, and repair across all layers
- `refactor` – design review and staged refactor planning with verification
- `docgen` – audience-targeted outline
- `tracer` – instrumentation/observability plan
- `precommit` – validation gate and commit advisory

**Custom-Only Modes (2):**
- `compliance` – map controls, evidence, sign-offs
- `retrospective` – capture wins, misses, lessons, next actions

**Delivery Agents (not modes):**
- `git-workflow`, `implementor`, `polish`, `tests`, `review`
```

**Proposed:**
```markdown
### Agent Consultation

Genie is a collective intelligence with 14 specialized agents. Consult them via `mcp__genie__run` with the appropriate agent name.

**Orchestrator Consultation Styles (3):**
When consulting the orchestrator agent, specify reasoning style with `Mode: challenge` in prompt:
- `challenge` – Critical evaluation and adversarial pressure-testing
- `explore` – Discovery-focused exploratory reasoning
- `consensus` – Multi-model perspective synthesis

**Strategic Agents (5):**
Consult directly via `mcp__genie__run with agent="<agent>"`:
- `analyze` – System architecture audit and dependency mapping
- `debug` – Root cause investigation with hypothesis testing
- `audit` – Risk assessment and security audit with impact/likelihood analysis
- `refactor` – Design review and refactor planning with verification
- `orchestrator` – Strategic thinking and plan pressure-testing

**Tactical Agents (2):**
- `docgen` – Documentation outline generation
- `tracer` – Instrumentation/observability planning

**Delivery Agents (4):**
- `implementor` – Feature implementation and code writing
- `tests` – Test strategy, generation, authoring across all layers
- `polish` – Code refinement and cleanup
- `review` – Wish audits, code review, QA validation

**Infrastructure Agents (4):**
- `git-workflow` – Git operations, branch management, PR creation
- `commit` – Commit advisory and pre-commit validation
- `learn` – Meta-learning and documentation updates
- `release` – Release orchestration

> Tip: Add project-specific guidance in `.genie/custom/<agent>.md`; core prompts remain immutable.
```

###  Changes

**Lines 12-41 (Orchestrator Modes section):**

**Current heading:**
```markdown
## Orchestrator Usage
```

**Proposed heading:**
```markdown
## Agent Consultation
```

**Current:**
```markdown
The orchestrator automatically routes to the appropriate mode based on your prompt:
```

**Proposed:**
```markdown
Genie consults specialized agents based on your request. You can invoke them directly or let Genie route automatically:
```

**Lines 42-71 (Agent Specialization Matrix):**

Update table headings and categories to use agent terminology.

---

## Implementation Strategy

### Recommended Approach

**1. Surgical Edits (Preferred)**
- Update terminology in-place across 6 key files
- Preserve all routing triggers and patterns (they work perfectly)
- Focus on naming clarity, not architectural changes
- Validate with grep audit

**2. Big Bang Refactor (Alternative)**
- Create new versions of routing.md, AGENTS.md, README.md
- Review side-by-side with Felipe
- Swap in once approved
- More risky (potential context loss)

**Recommendation:** **Surgical edits**
**Rationale:** Terminology change only, no logic changes. Safer, faster, preserves commit history.

### Validation Checklist

After refactoring, verify:
- [ ] No references to "orchestrator modes" remain (except historical reports)
- [ ] Agent count consistent (14 specialized agents)
- [ ] Agent categories clear (orchestrator consultation styles vs strategic agents)
- [ ] Routing triggers still work (keyword patterns unchanged)
- [ ] User-facing language natural (if Option C chosen)
- [ ] MCP invocation patterns unchanged
- [ ] All @ references still valid

---

## Open Questions for Felipe

**Q1: Orchestrator Consultation Styles vs Separate Agents?**
Are challenge/explore/consensus separate agents OR consultation styles for orchestrator?
- Impact: Agent count (14 vs 17), user-facing language
- Recommendation: Consultation styles (simpler)

**Q2: User-Facing Language?**
How should Genie describe agent consultation?
- Option A: Explicit ("consulting orchestrator agent...")
- Option B: Invisible (no mention)
- Option C: Thinking out loud ("let me pressure-test this...")
- Recommendation: Option C (most natural)

**Q3: Scope of Refactoring?**
- Phase 1 only (core docs): ~1-2 hours
- Phase 1-3 (core + wish + validation): ~2-3 hours
- Phase 1-4 (full refactor + user-facing examples): ~3-4 hours
- Recommendation: Phase 1-3 (complete but not exhaustive)

**Q4: Historical Reports?**
Should we update mode-overlap-analysis-202510151430.md or leave as historical record?
- Recommendation: Add preamble note, keep original analysis

---

## Next Steps

**Immediate:**
1. Felipe reviews this plan
2. Felipe decides on Q1-Q4 architectural questions
3. Approve surgical edit approach vs big bang refactor

**After Approval:**
1. Execute Phase 1 (core docs)
2. Execute Phase 2 (wish docs)
3. Execute Phase 3 (validation)
4. Execute Phase 4 (user-facing language) if approved

**Commit Strategy:**
- Single commit: "refactor: replace 'orchestrator modes' with 'Genie agents' terminology"
- Detailed commit message explaining architectural clarification
- Reference this plan document in commit body

---

## Evidence & Documentation

**Analysis Sources:**
- @.genie/code/routing.md (post-commit 93a05a0)
- reports/mode-overlap-analysis-202510151430.md
- reports/done-natural-routing-skills-202510151600.md
- File system reality: only 5 mode files exist

**Deliverables:**
- ✅ This refactoring plan document
- ⏳ Updated routing.md (pending approval)
- ⏳ Updated AGENTS.md (pending approval)
- ⏳ Updated  (pending approval)
- ⏳ Validation grep audit results (pending execution)

**Status:** AWAITING ARCHITECTURAL DECISIONS

---

**Session:** implementor-agent-terminology-refactor
**Created:** 2025-10-15 16:30 UTC
**Next:** Await Felipe's architectural decisions (Q1-Q4)
