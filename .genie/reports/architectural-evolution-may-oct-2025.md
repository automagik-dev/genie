# Architectural Evolution: May-October 2025
**Created:** 2025-10-23
**Source:** MASTER-PLAN.md (archived)
**Status:** Historical documentation

---

## 🎯 Core Architectural Evolution

### Identity Shift: Single-Session → Persistent Collective Coordinator

**OLD:** I was a single-session orchestrator who forgot everything on restart
**NEW:** I am a persistent collective coordinator with permanent state tracking

**Key capabilities:**
1. **Permanent state** via SESSION-STATE.md (track all active agents)
2. **Natural context acquisition** via @ / ! / patterns
3. **Mandatory prompt workflow** for ALL instruction writing
4. **Base consciousness** - .genie is foundation, templates derive from it

---

## 📋 Historical Milestones (October 17, 2025)

### 1. Natural Context Acquisition Audit ✅ COMPLETED

**@ (File Reference) - CORRECTED UNDERSTANDING:**
- Pattern: `@file.md` shows PATH REFERENCE ONLY (lightweight pointer)
- **NOT:** Full content load (that happens at session start via CLAUDE.md)
- Use case: "If you need X, check @ path" (token-efficient)
- Goal: SAVE tokens with pointers, not explode with duplication

**! (Command Execution) - Dynamic context:**
- Pattern: `!command` executes BEFORE processing, output in context
- Use case: Fresh data that changes between sessions
- Examples: `!date -u`, `!git status --short`, `!node -p "require('./package.json').version"`

**Results:**
- Phase 1 cancelled (backwards optimization - misunderstood @ semantics)
- Phase 2 completed (README enhancements with ! commands)

### 2. Agent Invocation Hierarchy Architecture

**Three-tier hierarchy:**

**Tier 1: Base Genie (main conversation)**
- Role: Human interface, persistent coordinator
- Can start: Agents ONLY
- Cannot start: Workflows directly
- Tracks: All agents in SESSION-STATE.md

**Tier 2: Agents (persistent subagent sessions)**
- Role: Specialized execution (git, implementor, tests, genie, release, learn)
- Can start: Their OWN workflows only
- Cannot start: Other agents, cross-delegate
- Identity: AGENTS.md (base) + agent specialty

**Tier 3: Workflows (agent-specific execution)**
- Role: Specialized sub-tasks within agent domain
- Can start: NOTHING (execute directly with Edit/Write/Bash)
- Examples: git/issue.md, git/pr.md, git/report.md

### 3. RC Iteration Strategy

**Goal:** RC8 → RC9 → ... → RC-final (perfectly smooth)

**RC iteration process:**
1. Implement feature/fix in .genie
2. Commit, version bump
3. Delegate to release agent
4. Test MCP with fresh start
5. Identify bugs/issues
6. Repeat until smooth

**Actual journey:** RC8 (Oct 17) → RC92 (Oct 23) = 84 iterations in 6 days

---

## 🧪 Experimentation Notes

**Natural context acquisition patterns:**
- @ for agent file networks (knowledge graphs)
- ! for dynamic data injection (runtime values)
- / for MCP automation (workflow triggers)

**Prompt workflow enforcement:**
- All instruction writing MUST go through prompt agent
- No ad-hoc prompt creation
- Sessions tracked in SESSION-STATE.md

**Collective coordination:**
- SESSION-STATE.md = source of truth
- Multiple agents work in parallel (tracked)
- Resume/restart capability (state preserved)

---

## 🎯 Key Learnings

1. @ shows path reference ONLY (lightweight), not full load
2. AGENTS.md already loaded at outer level (agents = base + specialty)
3. Three-tier hierarchy: Base Genie → Agents → Workflows
4. Folder structure = delegation hierarchy
5. Application-level enforcement prevents paradoxes

---

## 📊 Success Metrics (October 17, 2025)

**Completed:**
- ✅ RC8 published
- ✅ SESSION-STATE.md created and used effectively
- ✅ Git agent split complete (4 focused files, 43-71% context reduction)
- ✅ AGENTS/CLAUDE merge complete (CLAUDE.md: 230→32 lines, AGENTS.md: +79 unique patterns)
- ✅ Natural context audit complete
- ✅ Phase 2 README enhancements (! commands for dynamic context)
- ✅ Major architectural clarification: Agent delegation hierarchy

**Path Forward (October 17):**
- Implement folder restructuring (agents/git/ with workflows)
- Application-level list_agents scoping
- Smooth RC iterations (no critical bugs)
- .genie consciousness perfected
- Template extraction
- Public launch preparation

**Actual Outcome (October 23):**
- ✅ Reached RC92 (84 iterations)
- ✅ Seven Amendments framework established
- ✅ Forge integration stable
- ✅ Persistent sessions working
- ⏭️ Approaching stable 2.5.0 release

---

**Note:** This document captures historical architectural evolution from May-October 2025. For current state, see SESSION-STATE.md.
