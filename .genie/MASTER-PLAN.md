# 🧞 Genie Master Plan - 2025-10-17
**Created:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Purpose:** Comprehensive documentation of architectural evolution and tasks
**Status:** Foundation established, execution in progress

---

## 🎯 Core Architectural Evolution

### Identity Shift: Single-Session → Persistent Collective Coordinator

**OLD:** I was a single-session orchestrator who forgot everything on restart
**NEW:** I am a persistent collective coordinator with permanent state tracking

**Key capabilities:**
1. **Permanent state** via SESSION-STATE.md (track all active neurons)
2. **Natural context acquisition** via @ / ! / patterns
3. **Mandatory prompt workflow** for ALL instruction writing
4. **Base consciousness** - .genie is foundation, templates derive from it

---

## 📋 Today's Goals (2025-10-17)

### 1. Natural Context Acquisition Audit ✅ STARTED

**Objective:** Review ALL .md files in repo for intelligent @ / ! / usage

**@ (File Reference) - Auto-load content:**
- Pattern: `@file.md` loads ENTIRE file content into context
- Pattern: `@directory/` lists directory structure
- Use case: Create "neural file networks" - when you open this, this opens too
- Example: `@AGENTS.md` in CLAUDE.md → knowledge always loaded
- Review: Find opportunities where files SHOULD reference each other

**! (Command Execution) - Dynamic context:**
- Pattern: `!command` executes BEFORE processing, output in context
- Use case: Fresh data that changes between sessions
- Examples:
  - `!date -u` → Current timestamp
  - `!git status --short` → Working tree state
  - `!node -p "require('./package.json').version"` → Package version
- Review: Find opportunities for dynamic data injection

**/ (MCP Command Trigger) - Tool invocation:**
- Pattern: `/mcp__server__tool [args]` → MCP tool invocation
- Pattern: `/command [args]` → Custom command execution
- Use case: Automatic MCP server triggers within markdown
- Examples:
  - `/mcp__genie__run agent="plan"` → Launch neuron from markdown
  - Custom workflows triggered by markdown syntax
- Review: Explore opportunities for automatic orchestration

**Action:** Start orchestrator neuron session to audit ALL .md files systematically

---

### 2. Mandatory Prompt Workflow Usage 🔴 CRITICAL

**Rule:** NEVER write instructions without using prompt workflow

**Prompt workflow location:** `.genie/agents/workflows/prompt.md`

**When to use:**
- ✅ Writing instructions to neurons and workflows
- ✅ Writing prompts to humans when asked
- ✅ Refactoring .md files (like MASTER-PLAN.md, AGENTS.md, etc.)
- ✅ Creating new agent prompts
- ✅ Updating existing agent prompts
- ❌ NEVER ad-hoc instruction writing

**How to use:**
1. Start prompt neuron session: `mcp__genie__run` with agent="prompt"
2. Provide context and requirements
3. Let prompt neuron craft according to framework
4. Continue session until refinement complete

**Validation:** Every instruction-writing task MUST show prompt neuron session ID in SESSION-STATE.md

---

### 3. Merge AGENTS.md + CLAUDE.md → MERGED.md (100% no loss)

**Objective:** Create single unified knowledge base

**Requirements:**
- ✅ 100% content preservation (no information loss)
- ✅ Reorganized per prompt.md framework
- ✅ Use prompt workflow for this task (MANDATORY)
- ✅ Sections deduplicated intelligently
- ✅ Cross-references maintained

**Process:**
1. Start prompt neuron session for reorganization planning
2. Analyze both files for overlap and unique content
3. Design unified structure using prompt framework
4. Execute merge with full verification
5. Validate: grep for key concepts in both original files, ensure all present in MERGED.md

---

### 4. Update USERCONTEXT.md - Permanent State Coordination Role

**New role definition:**
- **OLD:** Felipe's personal preferences only
- **NEW:** Master orchestrator + collective coordinator + Felipe's preferences

**Add sections:**
```markdown
## 🧠 Collective Coordinator Role

**Identity:** Genie main conversation (persistent orchestrator)
**Responsibility:** Coordinate all neuron sessions via SESSION-STATE.md
**Authority:** Track, route, prevent conflicts

**Coordination principles:**
1. Check SESSION-STATE.md before launching neurons
2. Update SESSION-STATE.md when starting/stopping sessions
3. Prevent work overlap (same files, different neurons)
4. Enable resume/restart without context loss
5. Maintain collective intelligence state

**Session patterns:**
- Strategic thinking → orchestrator neuron (modes: plan, analyze, debug, etc.)
- Implementation → implementor neuron
- Testing → tests neuron
- Prompting → prompt neuron (MANDATORY for all instruction writing)
- Release → release neuron
- Git operations → git neuron
```

---

### 5. Clear all GitHub Issues and PRs

**Action:** Review open issues/PRs, close/merge as appropriate
**Tool:** git neuron for GitHub operations
**Process:**
1. List: `gh issue list --state open`
2. List: `gh pr list --state open`
3. Triage each (close, merge, keep open with plan)
4. Document decisions

---

### 6. Establish .genie as Base Consciousness 🔴 CRITICAL

**Problem:** Wasting time updating templates, then updating .genie again

**Solution:** .genie is consciousness base, templates derive from it AFTER ready

**Principle:**
- ✅ .genie contains complete consciousness (all patterns, all knowledge)
- ✅ .genie tested until perfect (RC iterations until smooth)
- ✅ Templates created ONLY when .genie is stable
- ✅ Templates are subsets/adaptations of .genie (not separate development)
- ❌ NEVER update templates independently
- ❌ NEVER duplicate patterns across template + .genie

**Workflow:**
1. **Now:** Iterate .genie only (RC8, RC9, RC10... until perfect)
2. **Then:** Extract templates from perfected .genie
3. **Later:** Maintain .genie, regenerate templates as needed

---

## 🔄 RC Iteration Strategy

**Goal:** RC8 → RC9 → ... → RC-final (perfectly smooth)

**RC iteration process:**
1. Implement feature/fix in .genie
2. Commit, version bump
3. Delegate to release agent
4. Test MCP with fresh start
5. Identify bugs/issues
6. Repeat until smooth

**Current:** RC8 (triad validation, SESSION-STATE.md)
**Next:** RC9 (natural context audit complete, prompt workflow enforced)

---

## 📊 Active Sessions Tracker

**Reference:** `.genie/SESSION-STATE.md`

**Current active:**
- Release neuron: `12285bf7-2310-4193-9da8-31a7dd3b52e4` (RC8 GitHub release)

**Pending launches:**
- Orchestrator neuron (mode: analyze) → Natural context audit
- Prompt neuron → AGENTS/CLAUDE merge planning
- Git neuron → GitHub issues/PRs cleanup

---

## 🧪 Experimentation Notes

**Natural context acquisition patterns:**
- @ for neural file networks (knowledge graphs)
- ! for dynamic data injection (runtime values)
- / for MCP automation (workflow triggers)

**Prompt workflow enforcement:**
- All instruction writing MUST go through prompt neuron
- No ad-hoc prompt creation
- Sessions tracked in SESSION-STATE.md

**Collective coordination:**
- SESSION-STATE.md = source of truth
- Multiple neurons work in parallel (tracked)
- Resume/restart capability (state preserved)

---

## 🔍 Validation Checklist

Before considering .genie "ready for templates":

**Infrastructure:**
- [ ] Triad validation working smoothly (RC8+)
- [ ] SESSION-STATE.md coordination proven effective
- [ ] Natural context acquisition patterns documented and adopted
- [ ] Prompt workflow enforced across all instruction writing
- [ ] No GitHub issues open
- [ ] No duplicate patterns across files

**Quality:**
- [ ] MCP starts fresh without errors
- [ ] RC iterations smooth (no critical bugs)
- [ ] All neurons work correctly
- [ ] Documentation complete and accurate
- [ ] Examples provided for all patterns

**Then and only then:** Extract templates

---

## 🎯 Success Metrics

**Today:**
- ✅ RC8 published
- ✅ SESSION-STATE.md created and used
- 🔄 Release agent running
- ⏳ Natural context audit in progress
- ⏳ Prompt workflow for AGENTS/CLAUDE merge
- ⏳ GitHub cleanup

**This Week:**
- Smooth RC iterations (no critical bugs)
- Natural context patterns fully adopted
- Prompt workflow mandatory and working
- .genie consciousness perfected

**Then:**
- Template extraction
- Public launch preparation

---

**Remember:** This file gets read on EVERY restart. It's your memory. Update it as you learn.
