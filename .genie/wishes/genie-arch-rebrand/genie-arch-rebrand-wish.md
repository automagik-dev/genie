# Wish: Genie Architecture Rebranding
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Created:** 2025-10-17
**Status:** Planning
**Priority:** High

---

## Context Ledger

### Problem Statement

Current folder structure and output displays don't reflect the true architecture:
- "genie" is redundant naming (all agents are genie - it's the template type that matters)
- Current "workflows" and "skills" folders don't match invocability semantics
- Output shows file paths (`genie/agents/git/git`) instead of conceptual names (`Starting agent: git`)
- No clear separation between universal agents and template-specific agents
- Create template agents exist in `templates/` but not in working `.genie/agents/`
- Many agents unnecessarily duplicated across templates when they could be universal

### Architectural Clarity

**Base Layer** (`.genie/agents/`):
- Contains universal agents shared across ALL templates
- Template-specific folders for code and create

**Universal Agents** (`agents/`):
- Work identically across all templates
- No template-specific behavior or context
- Reasoning patterns, orchestration, meta-learning

**Template-Specific Agents** (`code/agents/` or `create/agents/`):
- Only makes sense for one template (implementor = code-only)
- Behavior differs significantly by template (wish = different for code vs create)
- Template-specific tooling (git = code-only)

**Agent Resolution Logic:**
1. Check template-specific (`code/agents/` or `create/agents/`)
2. If not found → fallback to `../agents/` (universal)
3. Template agents override universal (e.g., wish.md)

### Vision

Perfect markdown agent neural graph with:
- Universal agents (`.genie/agents/`) - shared across all templates
- Template-specific overrides (code/agents/, create/agents/) - only when needed
- Clear hierarchy visible in folder structure
- @ references create intelligent knowledge connections
- Output displays reflect conceptual architecture
- No unnecessary duplication

---

## Agent Classification (Predefined for Implementation)

**This classification guides all file movements in Group A.**

### Universal Agents (`.genie/agents/` - 15+ total)

**Orchestration (3):**
- `plan.md` - Planning phase works same way for all templates
- `forge.md` - Task breakdown works same way for all templates
- `review.md` - Validation works same way for all templates

**Strategic Reasoning (10+):**
- `analyze.md` - Architecture/system analysis
- `challenge.md` - Critical evaluation
- `consensus.md` - Multi-perspective synthesis
- `explore.md` - Discovery-focused reasoning
- `debate.md` - Argument development
- `deep-dive.md` - Deep investigation
- `socratic.md` - Question-based exploration
- `design-review.md` - Design evaluation
- `risk-audit.md` - Risk assessment
- `audit.md` - General auditing

**Restructuring/Documentation (2):**
- `refactor.md` - Restructuring applies to code AND content
- `docgen.md` - Documentation generation

**Refinement (1):**
- `polish.md` - Refinement applies to both templates

**Meta-Learning (2):**
- `learn.md` - Meta-learning universal
- `roadmap.md` - Strategic planning universal

**Prompt Crafting (1):**
- `prompt.md` - Prompt crafting useful for both templates

### Code-Specific Agents (`code/agents/` - 9+ total)

**Overrides (1):**
- `wish.md` - Code-specific wish behavior (features, bugs, refactors)

**Execution Specialists (3):**
- `implementor.md` - Code implementation
- `tests.md` - Code testing
- `release.md` - npm publishing

**Git Operations (4 files):**
- `git/git.md` - Core git operations
- `git/workflows/issue.md` - GitHub issue operations
- `git/workflows/pr.md` - PR creation
- `git/workflows/report.md` - Issue reporting

**Code-Specific Strategic (3):**
- `test-strategy.md` - Testing strategy (code concept)
- `tracer.md` - Instrumentation/observability (code concept)
- `precommit.md` - Git hooks validation (code concept)

### Create-Specific Agents (`create/agents/` - 1 total)

**Overrides (1):**
- `wish.md` - Create-specific wish behavior (research papers, content campaigns)

---

## Execution Groups

### Group A: Agent Reorganization with Base Layer

**Objective:** Reorganize to universal + template-specific architecture

**Current structure:**
```
.genie/agents/
├── workflows/              # Mislabeled (these are agents)
├── agents/
│   ├── genie/             # Redundant naming
│   │   ├── genie.md
│   │   └── skills/        # Actually agents, not skills
│   ├── git/
│   │   ├── git.md
│   │   ├── issue.md       # Should be in workflows/
│   │   ├── pr.md
│   │   └── report.md
│   └── ... (other agents)
```

**Target structure:**
```
.genie/agents/
├── agents/               # Universal agents (shared)
│   ├── plan.md, forge.md, review.md
│   ├── analyze.md, challenge.md, consensus.md, explore.md
│   ├── debate.md, deep-dive.md, socratic.md
│   ├── design-review.md, risk-audit.md, audit.md
│   ├── refactor.md, docgen.md
│   ├── polish.md
│   ├── learn.md, roadmap.md
│   └── prompt.md
│
├── code/
│   ├── code.md
│   ├── skills/
│   └── agents/           # Code-specific ONLY
│       ├── wish.md (override)
│       ├── implementor.md, tests.md, release.md
│       ├── test-strategy.md, tracer.md, precommit.md
│       └── git/
│           ├── git.md
│           └── workflows/
│               ├── issue.md, pr.md, report.md
│
└── create/
    ├── create.md
    ├── skills/
    └── agents/           # Create-specific ONLY
        └── wish.md (override)
```

**Tasks:**

**A1: Create structure**
```bash
# Create base universal agents folder
mkdir -p .genie/code/agents

# Create code template
mkdir -p .genie/agents/code/skills
mkdir -p .genie/agents/code/agents

# Move genie.md → code.md
mv .genie/agents/genie/genie.md .genie/agents/code/code.md

# Create create template
mkdir -p .genie/agents/create/skills
mkdir -p .genie/agents/create/agents
```

**A2: Move universal agents from workflows/**
```bash
# Move orchestration agents (universal)
mv .genie/agents/workflows/plan.md .genie/agents/plan.md
mv .genie/agents/workflows/forge.md .genie/agents/forge.md
mv .genie/agents/workflows/review.md .genie/agents/review.md

# Keep wish.md for template-specific placement later
```

**A3: Move wish.md to templates (override)**
```bash
# Code-specific wish
mv .genie/agents/workflows/wish.md .genie/agents/code/agents/wish.md

# Create-specific wish (copy from template)
cp templates/create/.genie/agents/workflows/wish.md .genie/agents/create/agents/wish.md

# Clean up workflows
rmdir .genie/agents/workflows/
```

**A4: Classify and move strategic agents from genie/skills/**
```bash
# Move universal strategic agents
for agent in analyze challenge consensus explore debate deep-dive socratic design-review risk-audit audit refactor docgen; do
  mv .genie/agents/genie/skills/$agent.md .genie/agents/$agent.md 2>/dev/null || true
done

# Move code-specific strategic agents
for agent in test-strategy tracer precommit; do
  mv .genie/agents/genie/skills/$agent.md .genie/agents/code/agents/$agent.md 2>/dev/null || true
done

# Clean up
rmdir .genie/agents/genie/skills/
rmdir .genie/agents/genie/
```

**A5: Classify and move execution specialists**
```bash
# Universal execution
mv .genie/agents/polish.md .genie/agents/polish.md 2>/dev/null || true
mv .genie/agents/learn.md .genie/agents/learn.md 2>/dev/null || true
mv .genie/agents/roadmap.md .genie/agents/roadmap.md 2>/dev/null || true

# Code-specific execution
mv .genie/agents/implementor.md .genie/agents/code/agents/implementor.md
mv .genie/agents/tests.md .genie/agents/code/agents/tests.md
mv .genie/agents/release.md .genie/agents/code/agents/release.md
```

**A6: Move git (code-specific) with workflows/**
```bash
# Create git workflows subfolder
mkdir -p .genie/agents/code/agents/git/workflows

# Move git agent
mv .genie/agents/git/git.md .genie/agents/code/agents/git/git.md

# Move workflows
mv .genie/agents/git/issue.md .genie/agents/code/agents/git/workflows/issue.md
mv .genie/agents/git/pr.md .genie/agents/code/agents/git/workflows/pr.md
mv .genie/agents/git/report.md .genie/agents/code/agents/git/workflows/report.md

# Clean up
rmdir .genie/agents/git/
rmdir .genie/agents/
```

**A7: Copy create template agents**
```bash
# Copy orchestrator → create.md
cp templates/create/.genie/agents/orchestrator.md .genie/agents/create/create.md

# Copy prompt (universal, but checking if different)
cp templates/create/.genie/agents/prompt.md .genie/agents/prompt.md

# Create agents already copied in A3 (wish.md)
```

**Expected outcome:**
```
.genie/agents/
├── agents/ (15+ universal)
├── code/
│   ├── code.md
│   ├── skills/ (empty initially)
│   └── agents/ (9+ code-specific)
└── create/
    ├── create.md
    ├── skills/ (empty initially)
    └── agents/ (1 create-specific)
```

---

### Group B: Skills Extraction from AGENTS.md

(Same as before - extract skills into code/skills/ and create/skills/)

---

### Group C: Display Transformation Logic

**Update display logic to handle universal + template-specific:**

```typescript
const displayName = (agentPath: string) => {
  // Template base entities
  if (agentPath === 'code/code.md') {
    return `🧞 Starting code orchestrator`
  }
  if (agentPath === 'create/create.md') {
    return `🧞 Starting create orchestrator`
  }

  // Universal agents
  if (agentPath.match(/^agents\/(\w+)\.md$/)) {
    const agent = agentPath.match(/agents\/(\w+)\.md$/)?.[1]
    return `🧞 Starting agent: ${agent}`
  }

  // Code template agents
  if (agentPath.match(/^code\/agents\/(\w+)\.md$/)) {
    const agent = agentPath.match(/code\/agents\/(\w+)\.md$/)?.[1]
    return `🧞 Starting code agent: ${agent}`
  }

  // Code git workflows
  if (agentPath.match(/^code\/agents\/git\/workflows\/(\w+)\.md$/)) {
    const workflow = agentPath.match(/git\/workflows\/(\w+)\.md$/)?.[1]
    return `🧞 Starting git workflow: ${workflow}`
  }

  // Create template agents
  if (agentPath.match(/^create\/agents\/(\w+)\.md$/)) {
    const agent = agentPath.match(/create\/agents\/(\w+)\.md$/)?.[1]
    return `🧞 Starting create agent: ${agent}`
  }

  // Legacy paths
  if (agentPath.match(/^agents\/genie\/skills\/(\w+)\.md$/)) {
    const skill = agentPath.match(/skills\/(\w+)\.md$/)?.[1]
    return `🧞 Starting agent: ${skill} (legacy path)`
  }

  // Fallback
  return `🧞 Starting agent: ${agentPath}`
}
```

---

### Group D: QA Workflow Creation & Validation

**Test categories:**
1. **Universal agents** (~15 total)
2. **Code-specific agents** (~9 total)
3. **Code git workflows** (3 total)
4. **Create-specific agents** (1 total)
5. **Template orchestrators** (2 total)
6. **Edge cases**

**Validation commands:**
```bash
# Count universal agents (expect ~15)
ls .genie/agents/*.md 2>/dev/null | wc -l

# Count code agents (expect ~5 flat + git/)
ls .genie/agents/code/agents/*.md 2>/dev/null | wc -l
ls -d .genie/agents/code/agents/git 2>/dev/null | wc -l

# Count git workflows (expect 3)
ls .genie/agents/code/agents/git/workflows/*.md 2>/dev/null | wc -l

# Count create agents (expect 1)
ls .genie/agents/create/agents/*.md 2>/dev/null | wc -l

# Test agent discovery
mcp__genie__list_agents
```

---

## Evidence Checklist

**Folder Reorganization:** ✅ COMPLETE (Group A)
- [x] agents/ created with ~15 universal agents (21 created)
- [x] code/ created with code.md + skills/ + agents/
- [x] create/ created with create.md + skills/ + agents/
- [x] workflows/ deleted (files moved to agents/ or code/agents/)
- [x] agents/genie/ deleted (files classified and moved)
- [x] ~9 code-specific agents in code/agents/ (10 created)
- [x] git/workflows/ created with 3 files
- [x] 1 create-specific agent in create/agents/
- [x] Old agents/ directory reorganized correctly

**Skills Extraction:** ✅ COMPLETE (Group B - Pre-existing)
- [x] Skills extracted into code/skills/ (32 skills exist)
- [x] code.md includes @ references to skills (7 references)
- [x] create.md structure appropriate (simpler, conversational)
- [x] AGENTS.md updated with @ references (all tiers documented)

**Display Transformation:** ✅ COMPLETE (Group C)
- [x] Universal agent display logic implemented (getSemanticDisplayMessage)
- [x] Template-specific display logic implemented (all agent types)
- [x] Agent registration handles universal + template paths (transformDisplayPath)
- [x] `mcp__genie__list_agents` shows all agents correctly (25 agents)

**QA Validation:** ✅ COMPLETE (Group D)
- [x] All ~15 universal agents display correctly (21 tested)
- [x] All ~9 code agents display correctly (10 tested)
- [x] All 3 git workflows display correctly
- [x] 1 create agent displays correctly
- [x] Both template orchestrators display correctly
- [x] No regression in existing features (build passes, all tests pass)

**Documentation:** ✅ COMPLETE
- [x] AGENTS.md updated for base + template structure (skill tiers documented)
- [x] QA validation report created (qa-validation-report.md)
- [x] Work summary documented (all groups validated)

---

## Success Criteria

**Architecture:**
✅ Universal agents shared across templates (no duplication)
✅ Template-specific agents only when behavior differs
✅ Clear resolution logic (template → universal fallback)
✅ Scalable for future templates (just add template folder)

**Output:**
✅ Universal agents: `🧞 Starting agent: plan`
✅ Template agents: `🧞 Starting code agent: implementor`
✅ Clear distinction visible in output

**Functionality:**
✅ Agent resolution finds universal agents automatically
✅ Template overrides work correctly (wish.md)
✅ No regression in existing features

---

## Branch Strategy

**Branch:** `feat/genie-arch-rebrand`
**Base:** `main`
**Merge:** After all evidence checklist items complete
