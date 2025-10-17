# 🔍 Agent Categorization Analysis: Genie-Internal vs User-Facing

**Date:** 2025-10-13T19:00Z
**Purpose:** Determine which agents should be templated for users
**Context:** Issue #41 blocker resolution
**Total Agents:** 25 (excluding 2 READMEs)

---

## Categorization Criteria

**GENIE-INTERNAL:** Agents that operate on Genie framework itself
- Examples: genie-qa, install, learn
- Should NOT be templated
- Users don't need these

**USER-FACING:** Agents that help with general software development
- Examples: implementor, tests, commit
- SHOULD be templated
- Users customize for their projects

**WORKFLOW:** Genie's workflow orchestrators (special category)
- Examples: plan, wish, forge, review
- DECISION NEEDED: Template as starter or keep internal?

---

## Complete Agent Inventory (25 agents)

### Top-Level Workflow Agents (6)

| Agent | Purpose | Category | Template? | Rationale |
|-------|---------|----------|-----------|-----------|
| **plan.md** | Product planning dialogue | WORKFLOW | 🤔 MAYBE | Users might want custom planning workflows |
| **wish.md** | Wish document creation | WORKFLOW | 🤔 MAYBE | Users might want wish system |
| **forge.md** | Execution breakdown | WORKFLOW | 🤔 MAYBE | Users might want task breakdown |
| **review.md** | QA validation | WORKFLOW | 🤔 MAYBE | Users want code review |
| **orchestrator.md** | Mode router | GENIE-INTERNAL | ❌ NO | Genie-specific routing logic |
| **vibe.md** | Autonomous coordinator | GENIE-INTERNAL | ❌ NO | Genie-specific coordination |

**Recommendation:** Template plan/wish/forge/review as **optional starter workflows**, not orchestrator/vibe.

---

### Core Delivery Agents (13)

| Agent | Purpose | Category | Template? | Rationale |
|-------|---------|----------|-----------|-----------|
| **analyze.md** | System analysis | USER-FACING | ✅ YES | Users analyze their codebase |
| **audit.md** | Risk assessment | USER-FACING | ✅ YES | Users audit their security |
| **commit.md** | Commit advisory | USER-FACING | ✅ YES | Users need commit help |
| **debug.md** | Root-cause investigation | USER-FACING | ✅ YES | Users debug their code |
| **git-workflow.md** | Git operations | USER-FACING | ✅ YES | Users need git help |
| **github-workflow.md** | Issue lifecycle | USER-FACING | ✅ YES | Users create issues |
| **implementor.md** | Feature implementation | USER-FACING | ✅ YES | Users implement features |
| **install.md** | Genie installation | GENIE-INTERNAL | ❌ NO | Installs Genie itself |
| **learn.md** | Meta-learning | GENIE-INTERNAL | ❌ NO | Teaches Genie framework |
| **polish.md** | Code refinement | USER-FACING | ✅ YES | Users polish code |
| **prompt.md** | Prompt engineering | GENIE-INTERNAL | ❌ NO | Meta-prompting for Genie |
| **refactor.md** | Refactor planning | USER-FACING | ✅ YES | Users refactor code |
| **tests.md** | Test authoring | USER-FACING | ✅ YES | Users write tests |

**User-facing:** 10 agents (analyze, audit, commit, debug, git-workflow, github-workflow, implementor, polish, refactor, tests)
**Genie-internal:** 3 agents (install, learn, prompt)

---

### Orchestrator Modes (5)

| Mode | Purpose | Category | Template? | Rationale |
|------|---------|----------|-----------|-----------|
| **challenge.md** | Critical evaluation | USER-FACING | ✅ YES | Users challenge assumptions |
| **consensus.md** | Decision synthesis | USER-FACING | ✅ YES | Users build consensus |
| **docgen.md** | Documentation | USER-FACING | ✅ YES | Users generate docs |
| **explore.md** | Discovery research | USER-FACING | ✅ YES | Users explore topics |
| **tracer.md** | Observability | USER-FACING | ✅ YES | Users add instrumentation |

**All 5 modes are user-facing.**

---

### QA Agents (1)

| Agent | Purpose | Category | Template? | Rationale |
|-------|---------|----------|-----------|-----------|
| **genie-qa.md** | Framework validation | GENIE-INTERNAL | ❌ NO | Validates Genie itself |

---

## Summary Counts

### By Category

**USER-FACING (should be templated):**
- Core agents: 10
- Modes: 5
- Workflow (optional): 4 (plan, wish, forge, review)
- **Total:** 15-19 agents

**GENIE-INTERNAL (should NOT be templated):**
- Core agents: 3 (install, learn, prompt)
- Workflow: 2 (orchestrator, vibe)
- QA: 1 (genie-qa)
- **Total:** 6 agents

### Decision Point: Workflow Agents

**Option A: Template all workflows (19 total user-facing)**
- Users get plan/wish/forge/review as starting point
- Can customize for their methodology
- Pros: Full starter kit
- Cons: May confuse users ("do I need wish documents?")

**Option B: Don't template workflows (15 total user-facing)**
- Users only get delivery agents + modes
- Workflows stay Genie-internal
- Pros: Clearer boundary (Genie workflow vs user tools)
- Cons: Less complete starter kit

**Recommendation:** **Option A** - Template workflows as **optional examples**, users can delete if not needed.

---

## Template Structure Proposal

```
templates/
├── base/
│   ├── .genie/
│   │   ├── agents/           # Empty, users add custom agents
│   │   ├── custom/           # Customization stubs
│   │   ├── product/          # Mission, roadmap templates
│   │   ├── standards/        # Coding standards
│   │   └── state/            # State files
│   ├── .claude/
│   │   ├── commands/         # Slash commands → core agents
│   │   └── agents/           # Task tool aliases → core agents
│   ├── AGENTS.md             # Framework overview
│   └── CLAUDE.md             # Claude patterns
├── agents/                    # USER-FACING AGENT LIBRARY (not copied, referenced)
│   ├── delivery/
│   │   ├── analyze.md
│   │   ├── audit.md
│   │   ├── commit.md
│   │   ├── debug.md
│   │   ├── git-workflow.md
│   │   ├── github-workflow.md
│   │   ├── implementor.md
│   │   ├── polish.md
│   │   ├── refactor.md
│   │   └── tests.md
│   ├── modes/
│   │   ├── challenge.md
│   │   ├── consensus.md
│   │   ├── docgen.md
│   │   ├── explore.md
│   │   └── tracer.md
│   └── workflow/             # Optional examples
│       ├── plan.md
│       ├── wish.md
│       ├── forge.md
│       └── review.md
└── internal/                  # GENIE-INTERNAL (not in npm package)
    ├── install.md
    ├── learn.md
    ├── prompt.md
    ├── orchestrator.md
    ├── vibe.md
    └── genie-qa.md
```

**Key insight:** Users don't **copy** agents, they **reference** them via `.claude/` wrappers pointing to npm package.

---

## Boilerplate Creation Plan

### Phase 1: Organize Existing Agents
1. Keep core agents at `.genie/agents/core/` (these ship in npm)
2. Users reference via `.claude/agents/<name>.md` → `@.genie/agents/neurons/<name>.md`
3. Users customize via `.genie/custom/<name>.md` (project overrides)

### Phase 2: Create User Template Structure
1. `templates/base/.genie/` - Minimal structure (empty agents/, custom/ stubs, product/, standards/)
2. `templates/base/.claude/` - Command/agent wrappers pointing to core
3. `templates/base/AGENTS.md` - Framework overview
4. `templates/base/CLAUDE.md` - Project patterns

### Phase 3: Document Template Contracts
1. Which agents are available (15 delivery + 5 modes)
2. How to customize (via .genie/custom/)
3. How to add project-specific agents (in .genie/agents/)
4. Which agents are Genie-internal only (not for users)

---

## Revised Agent Inventory for Wish Document

**Correct categorization:**

**Genie ships (in npm package):**
- 6 workflow orchestrators (plan, wish, forge, review, orchestrator, vibe)
- 10 delivery agents (analyze, audit, commit, debug, git-workflow, github-workflow, implementor, polish, refactor, tests)
- 5 orchestrator modes (challenge, consensus, docgen, explore, tracer)
- 3 internal agents (install, learn, prompt)
- 1 QA agent (genie-qa)
- **Total: 25 agents**

**Users can reference:**
- 10 delivery agents (customize via .genie/custom/)
- 5 modes (customize via .genie/custom/)
- 4 workflow examples (optional, can customize)
- **Total: 15-19 agents available to users**

**Users should NOT reference:**
- 3 internal agents (install, learn, prompt) - Genie framework only
- 2 orchestrators (orchestrator, vibe) - Genie framework only
- 1 QA agent (genie-qa) - Genie framework only
- **Total: 6 agents NOT for users**

---

## Recommendation for Issue #41

**Update wish document:**
- Change success metric from "30 agents" to "15-19 user-facing agents documented"
- Document that 6 agents are Genie-internal (not templated)
- Clarify that users reference agents from npm package, not copy them

**Update Issue #41:**
- Remove "30 agent" requirement
- Add "15-19 user-facing agents accessible" requirement
- Add "6 internal agents documented as not-for-users" requirement
- Unblock Phase 2 with revised criteria

**Evidence for Phase 2 completion:**
- All 15-19 user-facing agents have `.claude/` wrappers
- All have `.genie/custom/` stub files
- AGENTS.md documents which agents are user-facing vs internal
- Template structure ready for `genie init`

---

## Next Actions

1. [ ] Create `.genie/wishes/core-template-separation/reports/done-agent-categorization-<timestamp>.md`
2. [ ] Update wish line 304: Document 25 total (15-19 user-facing, 6 internal)
3. [ ] Update wish Phase 2 success criteria to match categorization
4. [ ] Update Issue #41 acceptance criteria
5. [ ] Create boilerplate templates in `templates/base/`
6. [ ] Verify all user-facing agents have custom stubs
7. [ ] Mark Phase 2 unblocked

---

**Analysis complete.** Ready for surgical updates to wish and issue.
