# Genie Agent Neural Tree

**Generated:** Automatic scan of `.genie/agents/`

---

## Universal Neurons (Shared Across All Templates)

**Count:** 17

### analyze
- **Path:** `.genie/agents/neurons/analyze.md`

### audit
- **Path:** `.genie/agents/neurons/audit.md`

### challenge
- **Path:** `.genie/agents/neurons/challenge.md`

### consensus
- **Path:** `.genie/agents/neurons/consensus.md`

### debug
- **Path:** `.genie/agents/neurons/debug.md`

### docgen
- **Path:** `.genie/agents/neurons/docgen.md`

### explore
- **Path:** `.genie/agents/neurons/explore.md`

### forge
- **Path:** `.genie/agents/neurons/forge.md`
- **Delegates to:** `forge`
- **References:** `implementor`, `tests`, `forge`

### learn
- **Path:** `.genie/agents/neurons/learn.md`
- **Delegates to:** `learn`
- **References:** `commit`, `prompt`

### plan
- **Path:** `.genie/agents/neurons/plan.md`
- **Delegates to:** `genie`, `...`, `plan`
- **References:** `routing`

### polish
- **Path:** `.genie/agents/neurons/polish.md`
- **Delegates to:** `polish`

### prompt
- **Path:** `.genie/agents/neurons/prompt.md`

### qa
- **Path:** `.genie/agents/neurons/qa.md`
- **Delegates to:** `learn`
- **References:** `qa`

### refactor
- **Path:** `.genie/agents/neurons/refactor.md`

### review
- **Path:** `.genie/agents/neurons/review.md`
- **Delegates to:** `review`

### roadmap
- **Path:** `.genie/agents/neurons/roadmap.md`
- **Delegates to:** `roadmap`

### vibe
- **Path:** `.genie/agents/neurons/vibe.md`
- **Delegates to:** `sleepy`, `$agent`

---

## Code Template

### Orchestrator
- **code** (`.genie/agents/code/code.md`)
  - Delegates to: `genie`
  - References: `role-clarity-protocol`, `prompt`, `execution-integrity-protocol`, `delegation-discipline`, `triad-maintenance-protocol`, `publishing-protocol`, `persistent-tracking-protocol`, `evidence-based-thinking`

### Code-Specific Neurons (8)

#### commit
- **Path:** `.genie/agents/code/neurons/commit.md`

#### git
- **Path:** `.genie/agents/code/neurons/git/git.md`
- **Delegates to:** `git`, `pr`, `report`, `issue`
- **References:** `pr`, `report`, `issue`

#### implementor
- **Path:** `.genie/agents/code/neurons/implementor.md`
- **Delegates to:** `implementor`

#### install
- **Path:** `.genie/agents/code/neurons/install.md`
- **Delegates to:** `wish`, `review`, `plan`, `forge`
- **References:** `install`

#### release
- **Path:** `.genie/agents/code/neurons/release.md`
- **Delegates to:** `release`, `commit`

#### tests
- **Path:** `.genie/agents/code/neurons/tests.md`
- **Delegates to:** `tests`

#### tracer
- **Path:** `.genie/agents/code/neurons/tracer.md`
- **References:** `tracer`

#### wish
- **Path:** `.genie/agents/code/neurons/wish.md`
- **Delegates to:** `wish`

### Git Workflows (3)

#### issue
- **Path:** `.genie/agents/code/neurons/git/workflows/issue.md`
- **References:** `git`, `report`

#### pr
- **Path:** `.genie/agents/code/neurons/git/workflows/pr.md`
- **References:** `git`, `issue`

#### report
- **Path:** `.genie/agents/code/neurons/git/workflows/report.md`
- **References:** `git`, `issue`

---

## Create Template

### Orchestrator
- **create** (`.genie/agents/create/create.md`)

### Create-Specific Neurons (1)

#### wish
- **Path:** `.genie/agents/create/neurons/wish.md`

---

## Summary

- **Universal neurons:** 17
- **Code neurons:** 8
- **Git workflows:** 3
- **Create neurons:** 1
- **Orchestrators:** 2
- **Total agents:** 31
