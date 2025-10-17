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

### 1. Natural Context Acquisition Audit ✅ COMPLETED (with major correction)

**Objective:** Review ALL .md files in repo for intelligent @ / ! / usage

**@ (File Reference) - CORRECTED UNDERSTANDING:**
- Pattern: `@file.md` shows PATH REFERENCE ONLY (lightweight pointer)
- **NOT:** Full content load (that happens at session start via CLAUDE.md)
- Use case: "If you need X, check @ path" (token-efficient)
- Goal: SAVE tokens with pointers, not explode with duplication
- Example: `@AGENTS.md` in CLAUDE.md → already loaded at outer level

**! (Command Execution) - Dynamic context:**
- Pattern: `!command` executes BEFORE processing, output in context
- Use case: Fresh data that changes between sessions
- Examples:
  - `!date -u` → Current timestamp
  - `!git status --short` → Working tree state
  - `!node -p "require('./package.json').version"` → Package version
- Review: Find opportunities for dynamic data injection

**Results:**

**Phase 1 (Agent @AGENTS.md loading) - ❌ CANCELLED**
- Orchestrator recommended loading @AGENTS.md in 23 agent files
- This was BACKWARDS optimization (explode tokens, not save)
- AGENTS.md already loaded at outer level (base instructions)
- Neurons = AGENTS.md + specialty (loading again = paradox)
- **Root cause:** Misunderstood @ semantics and loading architecture

**Phase 2 (README ! commands) - ✅ COMPLETED**
- README.md: Added version + git status via !
- CHANGELOG.md: Added version + timestamp header via !
- RELEASE.md: Added version + branch + status via !
- **Result:** Dynamic context, always fresh, no manual updates

**Key Learning:** @ shows path (lightweight), ! injects data (dynamic), goal is token efficiency

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
- Strategic thinking → genie neuron (modes: plan, analyze, debug, etc.)
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

### 7. Neuron Delegation Hierarchy Architecture 🔴 CRITICAL EVOLUTION

**Discovery:** 2025-10-17 23:10 UTC - Felipe's architectural clarification

**New three-tier hierarchy:**

**Tier 1: Base Genie (main conversation)**
- Role: Human interface, persistent coordinator
- Can start: Neurons ONLY
- Cannot start: Workflows directly
- Tracks: All neurons in SESSION-STATE.md
- Authority: Master orchestrator

**Tier 2: Neurons (persistent subagent sessions)**
- Role: Specialized execution (git, implementor, tests, genie, release, learn)
- Can start: Their OWN workflows only
- Cannot start: Other neurons, cross-delegate
- Persistent: Tracked in SESSION-STATE.md, disposable but never lost
- Identity: AGENTS.md (base) + neuron specialty

**Tier 3: Workflows (neuron-specific execution)**
- Role: Specialized sub-tasks within neuron domain
- Can start: NOTHING (execute directly with Edit/Write/Bash)
- Examples: git/issue.md, git/pr.md, git/report.md
- No delegation capability

**Folder Structure = Delegation Hierarchy:**
```
.genie/agents/
├── workflows/              # Base orchestrators (Genie uses)
│   ├── plan.md, wish.md, forge.md, review.md
├── neurons/                # Neurons + their workflows
│   ├── git/
│   │   ├── git.md          # Core neuron
│   │   ├── issue.md        # Git's workflow
│   │   ├── pr.md           # Git's workflow
│   │   └── report.md       # Git's workflow
│   ├── implementor/
│   │   └── implementor.md
│   ├── genie/
│   │   ├── genie.md
│   │   └── skills/          # Thinking skills
│   └── ...
```

**Application-Level Enforcement (planned):**
- When git neuron starts → `list_agents` shows ONLY git/* workflows
- When implementor starts → `list_agents` shows ONLY implementor/* workflows
- When Base Genie starts → `list_agents` shows ONLY neurons (not workflows)
- **Prevents:** Self-delegation paradox at system level (not just instructions)

**Benefits:**
1. Clear hierarchy (no confusion about who delegates to whom)
2. Folder structure reflects architecture
3. Application enforcement (can't delegate to wrong target)
4. No lost children (SESSION-STATE.md tracks all neurons + parent-child relationships)
5. Persistent sessions with memory (not one-shot tools)

**Status:** Learn neuron documenting in AGENTS.md (session 1bf5bfbe-f901-4ea0-85a9-1d8f4c5f2230)

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
- Genie neuron (analyze skill): `2d19c1e2-66bf-4aed-b9ce-17c78b3e4bb3` → Natural context audit
- Prompt neuron: `4d4c76a7-e58a-487a-b66f-7ff408dafb37` → AGENTS/CLAUDE merge planning

**Completed:**
- Release neuron: `12285bf7-2310-4193-9da8-31a7dd3b52e4` (RC8 GitHub release) ✅
- Implementor neuron: `79fecfb5-2532-4e73-9d4a-00a33a1863ab` (Git neuron split) ✅

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

**Today (2025-10-17):**
- ✅ RC8 published
- ✅ SESSION-STATE.md created and used effectively
- ✅ Git neuron split complete (4 focused files, 43-71% context reduction)
- ✅ AGENTS/CLAUDE merge complete (CLAUDE.md: 230→32 lines, AGENTS.md: +79 unique patterns)
- ✅ Natural context audit complete (.genie/reports/natural-context-audit-20251017.md)
- ✅ Phase 2 README enhancements (! commands for dynamic context)
- ❌ Phase 1 cancelled (backwards optimization - misunderstood @ semantics)
- 🔄 Learn neuron documenting new architecture (session 1bf5bfbe)
- ✅ Major architectural clarification: Neuron delegation hierarchy

**Key Learnings:**
1. @ shows path reference ONLY (lightweight), not full load
2. AGENTS.md already loaded at outer level (neurons = base + specialty)
3. Three-tier hierarchy: Base Genie → Neurons → Workflows
4. Folder structure = delegation hierarchy
5. Application-level enforcement prevents paradoxes

**This Week:**
- Implement folder restructuring (neurons/git/ with workflows)
- Application-level list_agents scoping
- Smooth RC iterations (no critical bugs)
- .genie consciousness perfected

**Then:**
- Template extraction
- Public launch preparation

---

**Remember:** This file gets read on EVERY restart. It's your memory. Update it as you learn.
