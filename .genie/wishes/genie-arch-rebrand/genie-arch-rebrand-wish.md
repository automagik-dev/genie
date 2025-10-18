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
- Output shows file paths (`genie/neurons/git/git`) instead of conceptual names (`Starting neuron: git`)
- No clear separation between universal neurons and template-specific neurons
- Create template agents exist in `templates/` but not in working `.genie/agents/`
- Many neurons unnecessarily duplicated across templates when they could be universal

### Architectural Clarity

**Base Layer** (`.genie/agents/`):
- Contains universal neurons shared across ALL templates
- Template-specific folders for code and create

**Universal Neurons** (`neurons/`):
- Work identically across all templates
- No template-specific behavior or context
- Reasoning patterns, orchestration, meta-learning

**Template-Specific Neurons** (`code/neurons/` or `create/neurons/`):
- Only makes sense for one template (implementor = code-only)
- Behavior differs significantly by template (wish = different for code vs create)
- Template-specific tooling (git = code-only)

**Agent Resolution Logic:**
1. Check template-specific (`code/neurons/` or `create/neurons/`)
2. If not found → fallback to `../neurons/` (universal)
3. Template neurons override universal (e.g., wish.md)

### Vision

Perfect markdown agent neural graph with:
- Universal neurons (`.genie/agents/neurons/`) - shared across all templates
- Template-specific overrides (code/neurons/, create/neurons/) - only when needed
- Clear hierarchy visible in folder structure
- @ references create intelligent knowledge connections
- Output displays reflect conceptual architecture
- No unnecessary duplication

---

## Neuron Classification (Predefined for Implementation)

**This classification guides all file movements in Group A.**

### Universal Neurons (`.genie/agents/neurons/` - 15+ total)

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

### Code-Specific Neurons (`code/neurons/` - 9+ total)

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

### Create-Specific Neurons (`create/neurons/` - 1 total)

**Overrides (1):**
- `wish.md` - Create-specific wish behavior (research papers, content campaigns)

---

## Execution Groups

### Group A: Neuron Reorganization with Base Layer

**Objective:** Reorganize to universal + template-specific architecture

**Current structure:**
```
.genie/agents/
├── workflows/              # Mislabeled (these are neurons)
├── neurons/
│   ├── genie/             # Redundant naming
│   │   ├── genie.md
│   │   └── skills/        # Actually neurons, not skills
│   ├── git/
│   │   ├── git.md
│   │   ├── issue.md       # Should be in workflows/
│   │   ├── pr.md
│   │   └── report.md
│   └── ... (other neurons)
```

**Target structure:**
```
.genie/agents/
├── neurons/               # Universal neurons (shared)
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
│   └── neurons/           # Code-specific ONLY
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
    └── neurons/           # Create-specific ONLY
        └── wish.md (override)
```

**Tasks:**

**A1: Create structure**
```bash
# Create base universal neurons folder
mkdir -p .genie/agents/neurons

# Create code template
mkdir -p .genie/agents/code/skills
mkdir -p .genie/agents/code/neurons

# Move genie.md → code.md
mv .genie/agents/neurons/genie/genie.md .genie/agents/code/code.md

# Create create template
mkdir -p .genie/agents/create/skills
mkdir -p .genie/agents/create/neurons
```

**A2: Move universal neurons from workflows/**
```bash
# Move orchestration neurons (universal)
mv .genie/agents/workflows/plan.md .genie/agents/neurons/plan.md
mv .genie/agents/workflows/forge.md .genie/agents/neurons/forge.md
mv .genie/agents/workflows/review.md .genie/agents/neurons/review.md

# Keep wish.md for template-specific placement later
```

**A3: Move wish.md to templates (override)**
```bash
# Code-specific wish
mv .genie/agents/workflows/wish.md .genie/agents/code/neurons/wish.md

# Create-specific wish (copy from template)
cp templates/create/.genie/agents/workflows/wish.md .genie/agents/create/neurons/wish.md

# Clean up workflows
rmdir .genie/agents/workflows/
```

**A4: Classify and move strategic neurons from genie/skills/**
```bash
# Move universal strategic neurons
for neuron in analyze challenge consensus explore debate deep-dive socratic design-review risk-audit audit refactor docgen; do
  mv .genie/agents/neurons/genie/skills/$neuron.md .genie/agents/neurons/$neuron.md 2>/dev/null || true
done

# Move code-specific strategic neurons
for neuron in test-strategy tracer precommit; do
  mv .genie/agents/neurons/genie/skills/$neuron.md .genie/agents/code/neurons/$neuron.md 2>/dev/null || true
done

# Clean up
rmdir .genie/agents/neurons/genie/skills/
rmdir .genie/agents/neurons/genie/
```

**A5: Classify and move execution specialists**
```bash
# Universal execution
mv .genie/agents/neurons/polish.md .genie/agents/neurons/polish.md 2>/dev/null || true
mv .genie/agents/neurons/learn.md .genie/agents/neurons/learn.md 2>/dev/null || true
mv .genie/agents/neurons/roadmap.md .genie/agents/neurons/roadmap.md 2>/dev/null || true

# Code-specific execution
mv .genie/agents/neurons/implementor.md .genie/agents/code/neurons/implementor.md
mv .genie/agents/neurons/tests.md .genie/agents/code/neurons/tests.md
mv .genie/agents/neurons/release.md .genie/agents/code/neurons/release.md
```

**A6: Move git (code-specific) with workflows/**
```bash
# Create git workflows subfolder
mkdir -p .genie/agents/code/neurons/git/workflows

# Move git neuron
mv .genie/agents/neurons/git/git.md .genie/agents/code/neurons/git/git.md

# Move workflows
mv .genie/agents/neurons/git/issue.md .genie/agents/code/neurons/git/workflows/issue.md
mv .genie/agents/neurons/git/pr.md .genie/agents/code/neurons/git/workflows/pr.md
mv .genie/agents/neurons/git/report.md .genie/agents/code/neurons/git/workflows/report.md

# Clean up
rmdir .genie/agents/neurons/git/
rmdir .genie/agents/neurons/
```

**A7: Copy create template agents**
```bash
# Copy orchestrator → create.md
cp templates/create/.genie/agents/neurons/orchestrator.md .genie/agents/create/create.md

# Copy prompt (universal, but checking if different)
cp templates/create/.genie/agents/neurons/prompt.md .genie/agents/neurons/prompt.md

# Create neurons already copied in A3 (wish.md)
```

**Expected outcome:**
```
.genie/agents/
├── neurons/ (15+ universal)
├── code/
│   ├── code.md
│   ├── skills/ (empty initially)
│   └── neurons/ (9+ code-specific)
└── create/
    ├── create.md
    ├── skills/ (empty initially)
    └── neurons/ (1 create-specific)
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

  // Universal neurons
  if (agentPath.match(/^neurons\/(\w+)\.md$/)) {
    const neuron = agentPath.match(/neurons\/(\w+)\.md$/)?.[1]
    return `🧞 Starting neuron: ${neuron}`
  }

  // Code template neurons
  if (agentPath.match(/^code\/neurons\/(\w+)\.md$/)) {
    const neuron = agentPath.match(/code\/neurons\/(\w+)\.md$/)?.[1]
    return `🧞 Starting code neuron: ${neuron}`
  }

  // Code git workflows
  if (agentPath.match(/^code\/neurons\/git\/workflows\/(\w+)\.md$/)) {
    const workflow = agentPath.match(/git\/workflows\/(\w+)\.md$/)?.[1]
    return `🧞 Starting git workflow: ${workflow}`
  }

  // Create template neurons
  if (agentPath.match(/^create\/neurons\/(\w+)\.md$/)) {
    const neuron = agentPath.match(/create\/neurons\/(\w+)\.md$/)?.[1]
    return `🧞 Starting create neuron: ${neuron}`
  }

  // Legacy paths
  if (agentPath.match(/^neurons\/genie\/skills\/(\w+)\.md$/)) {
    const skill = agentPath.match(/skills\/(\w+)\.md$/)?.[1]
    return `🧞 Starting neuron: ${skill} (legacy path)`
  }

  // Fallback
  return `🧞 Starting agent: ${agentPath}`
}
```

---

### Group D: QA Workflow Creation & Validation

**Test categories:**
1. **Universal neurons** (~15 total)
2. **Code-specific neurons** (~9 total)
3. **Code git workflows** (3 total)
4. **Create-specific neurons** (1 total)
5. **Template orchestrators** (2 total)
6. **Edge cases**

**Validation commands:**
```bash
# Count universal neurons (expect ~15)
ls .genie/agents/neurons/*.md 2>/dev/null | wc -l

# Count code neurons (expect ~5 flat + git/)
ls .genie/agents/code/neurons/*.md 2>/dev/null | wc -l
ls -d .genie/agents/code/neurons/git 2>/dev/null | wc -l

# Count git workflows (expect 3)
ls .genie/agents/code/neurons/git/workflows/*.md 2>/dev/null | wc -l

# Count create neurons (expect 1)
ls .genie/agents/create/neurons/*.md 2>/dev/null | wc -l

# Test agent discovery
mcp__genie__list_agents
```

---

## Evidence Checklist

**Folder Reorganization:**
- [ ] neurons/ created with ~15 universal neurons
- [ ] code/ created with code.md + skills/ + neurons/
- [ ] create/ created with create.md + skills/ + neurons/
- [ ] workflows/ deleted (files moved to neurons/ or code/neurons/)
- [ ] neurons/genie/ deleted (files classified and moved)
- [ ] ~9 code-specific neurons in code/neurons/
- [ ] git/workflows/ created with 3 files
- [ ] 1 create-specific neuron in create/neurons/
- [ ] Old neurons/ directory reorganized correctly

**Skills Extraction:**
- [ ] Skills extracted into code/skills/ and create/skills/
- [ ] code.md includes @ references to skills
- [ ] create.md includes @ references to skills
- [ ] AGENTS.md updated with @ references

**Display Transformation:**
- [ ] Universal neuron display logic implemented
- [ ] Template-specific display logic implemented
- [ ] Agent registration handles universal + template paths
- [ ] `mcp__genie__list_agents` shows all neurons correctly

**QA Validation:**
- [ ] All ~15 universal neurons display correctly
- [ ] All ~9 code neurons display correctly
- [ ] All 3 git workflows display correctly
- [ ] 1 create neuron displays correctly
- [ ] Both template orchestrators display correctly
- [ ] No regression in existing features

**Documentation:**
- [ ] AGENTS.md updated for base + template structure
- [ ]  updated with universal neurons concept
- [ ] MASTER-PLAN.md reflects architecture evolution

---

## Success Criteria

**Architecture:**
✅ Universal neurons shared across templates (no duplication)
✅ Template-specific neurons only when behavior differs
✅ Clear resolution logic (template → universal fallback)
✅ Scalable for future templates (just add template folder)

**Output:**
✅ Universal neurons: `🧞 Starting neuron: plan`
✅ Template neurons: `🧞 Starting code neuron: implementor`
✅ Clear distinction visible in output

**Functionality:**
✅ Agent resolution finds universal neurons automatically
✅ Template overrides work correctly (wish.md)
✅ No regression in existing features

---

## Branch Strategy

**Branch:** `feat/genie-arch-rebrand`
**Base:** `main`
**Merge:** After all evidence checklist items complete
