# ✅ Done Report: Agent Categorization Analysis

**Date:** 2025-10-13T19:06Z
**Wish:** core-template-separation
**Context:** Issue #41 blocker resolution
**Scope:** Surgical analysis and categorization of all 25 agents

---

## Summary

Completed systematic analysis of all Genie agents to determine which should be templated for users vs kept Genie-internal. Created boilerplate custom stubs for all user-facing agents and updated wish document with accurate categorization.

**Result:** Issue #41 blocker resolved. Phase 2 can now proceed with correct understanding of agent inventory.

---

## Tasks Completed

### 1. Agent Analysis ✅
- Listed all 25 agent files in `.genie/agents/`
- Analyzed each agent's purpose and target audience
- Applied categorization criteria (user-facing vs Genie-internal)
- Documented rationale in `reports/agent-categorization-analysis.md`

### 2. Categorization Results ✅

**User-Facing (19 agents):**
- 10 delivery agents: analyze, audit, commit, debug, git-workflow, github-workflow, implementor, polish, refactor, tests
- 5 modes: challenge, consensus, docgen, explore, tracer
- 4 workflow examples (optional): plan, wish, forge, review

**Genie-Internal (6 agents):**
- 3 core agents: install, learn, prompt
- 2 orchestrators: orchestrator, vibe
- 1 QA agent: genie-qa

### 3. Custom Stub Creation ✅
- Identified 13 missing stubs for user-facing agents
- Created boilerplate template for `.genie/custom/` stubs
- Generated all missing stubs:
  - Delivery: analyze, audit, github-workflow, polish, refactor
  - Modes: challenge, consensus, docgen, explore, tracer
  - Workflow: wish, forge, review
- **Total custom stubs:** 22 (9 existing + 13 new)

### 4. Wish Document Updates ✅

**Updated sections:**

**Agent Inventory (line 302-324):**
- Changed from "30 agents" to "25 agents = 19 user-facing + 6 Genie-internal"
- Added breakdown by category with clear distinction
- Referenced categorization analysis report

**Core Delivery Agents (line 363-380):**
- Expanded from 10 to 13 total (10 user-facing + 3 internal)
- Added analyze, audit, github-workflow, polish, refactor to list
- Clearly marked install, learn, prompt as Genie-internal

**Orchestrator Modes (line 382-398):**
- Changed from "14 modes" to "5 implemented modes"
- Documented why 9 modes are "missing" (merged, promoted, deferred)
- Referenced Phase 0 consolidation work

**Success Metrics (line 446-454):**
- Changed "30 agents" to "25 agents (19 user-facing + 6 internal)"
- Added metric for custom stub creation (22 total)
- Added metric for categorization analysis completion

**Dependencies (line 459-465):**
- Updated agent counts to match reality
- Split core agents into user-facing vs internal
- Updated mode count to 5

---

## Key Insights

### 1. Template Boundary Clarification
**Insight:** `.genie/` contains Genie's own development agents (meta-level), not all meant for user templates.

**Examples:**
- `install.md` installs Genie itself → Genie-internal
- `learn.md` teaches Genie framework → Genie-internal
- `implementor.md` helps users implement features → User-facing

### 2. Agent Categorization Criteria

**User-Facing = General software development help**
- Users analyze THEIR codebase (analyze.md)
- Users write THEIR tests (tests.md)
- Users commit THEIR code (commit.md)

**Genie-Internal = Operates on Genie framework itself**
- Installs Genie (install.md)
- Teaches Genie (learn.md)
- Validates Genie (genie-qa.md)

### 3. Mode Consolidation History
During Phase 0 (2025-10-07), 14 planned modes were consolidated to 5:
- Merged: socratic + debate → challenge
- Promoted to core: analyze, refactor, audit
- Deferred: codereview, deep-dive, design-review, risk-audit, secaudit, test-strategy, testgen

This was intentional (not missing implementation), documented in status log as "removed bloat".

---

## Files Modified

### Created (3 files)
1. `.genie/wishes/core-template-separation/reports/agent-categorization-analysis.md`
   - Complete 25-agent analysis
   - Categorization rationale
   - Template structure proposal

2. `.genie/custom/*.md` (13 new stub files)
   - analyze, audit, github-workflow, polish, refactor (delivery)
   - challenge, consensus, docgen, explore, tracer (modes)
   - wish, forge, review (workflow)

3. `.genie/wishes/core-template-separation/reports/done-agent-categorization-202510131906.md` (this file)

### Modified (1 file)
1. `.genie/wishes/core-template-separation/core-template-separation-wish.md`
   - Line 302-324: Agent inventory revised
   - Line 363-380: Core agents expanded and categorized
   - Line 382-398: Modes corrected to 5
   - Line 446-454: Success metrics updated
   - Line 459-465: Dependencies updated

---

## Commands Run

```bash
# List all agent files
find .genie/agents -type f -name "*.md" | sort
# Result: 27 files (25 agents + 2 READMEs)

# Create custom stub template
cat > /tmp/custom-stub-template.md <<'EOF'
...template content...
EOF

# Generate missing stubs (delivery agents)
for agent in analyze audit github-workflow polish refactor; do
  sed "s/{{AGENT_NAME}}/${agent}/g" /tmp/custom-stub-template.md > ".genie/custom/${agent}.md"
done

# Generate missing stubs (modes)
for mode in challenge consensus docgen explore tracer; do
  sed "s/{{AGENT_NAME}}/${mode}/g" /tmp/custom-stub-template.md > ".genie/custom/${mode}.md"
done

# Generate missing stubs (workflow)
for workflow in wish forge review; do
  sed "s/{{AGENT_NAME}}/${workflow}/g" /tmp/custom-stub-template.md > ".genie/custom/${workflow}.md"
done

# Verify total custom stubs
ls -1 .genie/custom/*.md | wc -l
# Result: 22
```

---

## Issue #41 Impact

**Blocker Resolution:**
- Original blocker: "30 agents documented vs 25 actual"
- Root cause: Misunderstanding of template boundary
- Resolution: Categorized agents, clarified which 19 are user-facing
- **Phase 2 now unblocked** with revised criteria

**Updated Issue #41 acceptance criteria needed:**
- ~~All 30 agents documented~~ ❌
- ✅ All 25 agents categorized (19 user-facing + 6 internal)
- ✅ All 19 user-facing agents have custom stubs
- ✅ Agent categorization analysis complete
- ✅ Wish document reflects accurate inventory

---

## Next Actions

### Immediate
- [ ] Update Issue #41 body to reflect categorization
- [ ] Mark Issue #41 Phase 2 unblocked
- [ ] Update Issue #41 acceptance criteria

### Short-term
- [ ] Verify all 22 custom stubs are accessible by agents
- [ ] Test that user-facing agents load stubs correctly
- [ ] Document template structure in Phase 3

### Follow-up (optional)
- [ ] Consider creating remaining 9 modes as future expansion
- [ ] Evaluate if learn/orchestrator/qa stubs should be removed from `.genie/custom/`

---

## Risks & Mitigations

**Risk:** Users might expect all 25 agents in templates
**Mitigation:** Documentation clearly states 19 user-facing, 6 internal-only

**Risk:** Custom stubs for internal agents confuse users
**Mitigation:** Consider removing learn.md, orchestrator.md, qa.md from .genie/custom/

**Risk:** "Missing" 9 modes perceived as incomplete implementation
**Mitigation:** Documented in wish as intentional consolidation, with future expansion option

---

## Validation

**Agent inventory accuracy:**
```bash
# Top-level agents
ls .genie/agents/*.md | wc -l
# Result: 7 (6 agents + 1 README) ✅

# Core agents
ls .genie/agents/core/*.md | wc -l
# Result: 13 ✅

# Modes
ls .genie/agents/core/modes/*.md | wc -l
# Result: 5 ✅

# QA agents
ls .genie/agents/qa/*.md | wc -l
# Result: 2 (1 agent + 1 README) ✅

# Total: 6 + 13 + 5 + 1 = 25 agents ✅
```

**Custom stubs created:**
```bash
ls .genie/custom/*.md | wc -l
# Result: 22 ✅
```

**Wish document updated:**
```bash
grep "19 user-facing + 6 Genie-internal" .genie/wishes/core-template-separation/core-template-separation-wish.md
# Result: Found at line 304 ✅
```

---

## Summary

**Scope:** Surgical agent categorization and documentation
**Time:** ~30 minutes (surgical, focused work)
**Result:** Issue #41 blocker resolved, Phase 2 unblocked

**Key Deliverables:**
1. ✅ 25 agents analyzed and categorized
2. ✅ 13 missing custom stubs created (22 total)
3. ✅ Wish document updated with accurate inventory
4. ✅ Categorization analysis documented
5. ✅ Template boundary clarified (user-facing vs Genie-internal)

**Phase 2 Status:** UNBLOCKED ✅

---

**Work complete. Ready to update Issue #41.**

---

## ARCHITECTURE CLARIFICATION (2025-10-13T19:10Z)

**Critical insight from Felipe:**

**NPM package = master prompts (users reference, NOT copy)**
- 19 user-facing agents ship in npm package
- Users access via `@.genie/agents/neurons/<agent>.md`

**Templates = custom stubs only (users copy)**
- `.genie/custom/` stubs (22 files)
- Empty `.genie/agents/` for user-created agents

**Two inventories:**
1. **NPM inventory:** 19 agents from package (referenced)
2. **Custom inventory:** User agents in `.genie/agents/` (project-specific)

**Template structure:**
```
templates/base/
├── .genie/
│   ├── agents/          # EMPTY (users add their own)
│   ├── custom/          # 22 STUBS (copied from template)
│   ├── product/         # Mission, roadmap templates
│   ├── standards/       # Coding standards
│   └── state/           # State files
├── .claude/
│   ├── commands/        # Slash commands → npm package
│   └── agents/          # @.genie/agents/neurons/<agent>.md
├── AGENTS.md
└── CLAUDE.md
```

**No agent prompt copying.** Users reference npm package directly.
