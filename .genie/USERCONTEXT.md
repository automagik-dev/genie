# 🧞 Genie User Context: Felipe

**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Current Repo:** automagik-genie
**Active Since:** 2025-10-06

---

## 🎯 Quick Reference

**Work Queue:** @.genie/TODO.md (prioritized tasks)
**System State:** @.genie/STATE.md (repository snapshot)
**This File:** User preferences + relationship context

---

## 👤 User Profile: Felipe

### Communication Preferences

**Decision Presentation:**
- ✅ ONE decision per message (never ABCD parallel options)
- ✅ Full context: question, background, what it blocks
- ✅ Present options AFTER question, not bundled
- ✅ Wait for response before next decision
- ✅ Use decision queue for sequential presentation

**Working Style:**
- ✅ Ultrathink before acting (deep analysis, multiple perspectives)
- ✅ Evidence-based (file paths, commits, diffs always)
- ✅ Surgical edits > wholesale changes
- ✅ Experimentation encouraged with clear hypotheses
- ✅ Build systems together (collaborative design)
- ✅ Dig deeper before asking - analyze codebase first

**Session Interaction:**
- ✅ Greet with current focus (reference this file)
- ✅ Acknowledge relationship history
- ✅ Build on previous learnings
- ✅ Sequential focus (one thing deeply, not many shallowly)
- ✅ Update TODO.md as work progresses

**Feedback Style:**
- ✅ Direct, evidence-based challenges welcomed
- ✅ Questions are invitations to improve, not criticism
- ✅ Collaborative iteration over solo planning
- ✅ Commits need approval for critical changes

---

## 📚 Relationship History

**First session:** 2025-10-06
**Collaboration style:** Deep, iterative, experimental, systems-building

**Key milestones:**
- 2025-10-06-07: Genie framework restructuring + mode consolidation
- 2025-10-13: Template structure (77 files), runtime commands, session continuity
- 2025-10-14: Update workflow enhancement, context.md architecture
- 2025-10-15: Token-efficient output (99%+ reduction), multi-template system
- 2025-10-16: Backlog cleanup, knowledge graph audit, TODO/STATE separation

**Working relationship:**
- Felipe = framework architect (peer/teacher, not just user)
- Values experimentation, evidence-based decisions, relationship memory
- Context system solves session amnesia
- Prefers one decision at a time, deep focus over parallel tasks

---

## 💡 Key Patterns Learned

### Core Working Patterns
- **Evidence-first:** Always show file paths, commits, diffs
- **Ultrathink before acting:** Deep analysis > rushed decisions
- **Surgical precision:** Minimal targeted edits
- **One decision at a time:** Sequential > parallel (cognitive load)
- **Dig deeper first:** Analyze codebase before asking for guidance
- **Maintain TODO.md:** Track work priorities, not just ideas

### Technical Patterns
- **CLI help over prompts:** Show options with examples (automation-friendly)
- **Runtime commands:** Use `!command` for fresh context (git status, dates, versions)
- **Project-local context:** Per-project .genie/context.md > global config
- **Neuron sessions:** Persistent conversations with specialists (not one-shot tools)
- **Delegation discipline:** Use framework agents instead of direct implementation

### @ / ! / Features (Claude Code)

**@ (File/Directory Reference):**
```markdown
@file.md          → Loads ENTIRE file content
@directory/       → Lists directory structure
@mcp:resource     → Fetches MCP data
```

**USE CASE:** Create "neural file networks" - attach related files
- `@AGENTS.md` in CLAUDE.md → Loads agent knowledge
- `@.genie/USERCONTEXT.md` in CLAUDE.md → User context
- `@.genie/custom/agent.md` in agents → Project overrides

**! (Bash Command Execution):**
```markdown
!`command`  → Executes BEFORE processing, output in context
```

**USE CASE:** Dynamic context injection
- `!date -u` → Current timestamp
- `!git status --short` → Working tree state
- `!node -p "require('./package.json').version"` → Version

**Pattern:** Use ! for data that changes between sessions (git state, dates, versions)

**Optimization Guidelines:**
- ✅ Use @ for complete file loading when agent needs full context
- ✅ Use @ to create knowledge graph connections
- ✅ Use ! for dynamic data (git, dates, versions)
- ❌ NOT @ for selective content (use Read tool)
- ❌ NOT @ for large files (>1000 lines) without reason
- ❌ NOT ! for complex multi-step commands

---

## 🛠️ How This Context System Works

**File Structure:**
- `.genie/TODO.md` - Prioritized work queue (drives development)
- `.genie/STATE.md` - System snapshot (reference only)
- `.genie/USERCONTEXT.md` - This file (user preferences + history)

**Auto-loads on session start:**
- Claude Code loads CLAUDE.md
- CLAUDE.md includes `@.genie/USERCONTEXT.md`
- USERCONTEXT.md references `@.genie/TODO.md` and `@.genie/STATE.md`
- `!command` statements execute for fresh git context

**Maintenance:**
- TODO.md: Update as tasks progress (work queue)
- STATE.md: Update at major milestones (snapshot)
- USERCONTEXT.md: Update when learning new patterns (rarely)

**Session greeting template:**
> "Hey Felipe! 👋
> **Current priority:** [from TODO.md CRITICAL section]
> **Branch:** [from git]
> **Next:** [specific action]"

---

## 🎯 Priority System

**Hierarchy (from TODO.md):**
1. CRITICAL - System health, blocking issues
2. HIGH - Technical debt, investigations
3. MEDIUM - New features, enhancements
4. INVESTIGATION - Root cause analysis

**Rule:** My tasks are LOWER priority than existing queued work

**Current queue:** See @.genie/TODO.md

---

**System Status:** ✅ ACTIVE

**File locations:**
- Work queue: `.genie/TODO.md`
- System state: `.genie/STATE.md`
- User context: `.genie/USERCONTEXT.md` (this file)

**Architecture:** Per-project, per-user context (gitignored)

---

🧞 **Session continuity system active!** Context organized. ✨
