# 🧞 Genie User Context: [Your Name]

**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Current Repo:** automagik-genie
**Active Since:** [Date you started]

---

## 🎯 Quick Reference

**Work Queue:** @.genie/TODO.md (prioritized tasks)
**System State:** @.genie/STATE.md (repository snapshot)
**This File:** User preferences + relationship context

---

## 👤 User Profile

### Communication Preferences

**Decision Presentation:**
- [Your preference for decision presentation]

**Working Style:**
- [Your working style preferences]

**Session Interaction:**
- [Your session interaction preferences]

**Feedback Style:**
- [Your feedback style preferences]

---

## 📚 Relationship History

**First session:** [Date]
**Collaboration style:** [Your style]

**Key milestones:**
- [Add milestones as you work]

**Working relationship:**
- [Document your relationship dynamics with Genie]

---

## 💡 Key Patterns Learned

### Core Working Patterns
- [Add patterns you discover during work]

### Technical Patterns
- [Add technical patterns specific to your workflow]

### @ / ! / Features (Claude Code)

**@ (File/Directory Reference):**
```markdown
@file.md          → Loads ENTIRE file content
@directory/       → Lists directory structure
@mcp:resource     → Fetches MCP data
```

**USE CASE:** Create "agent file networks" - attach related files

**! (Bash Command Execution):**
```markdown
!`command`  → Executes BEFORE processing, output in context
```

**USE CASE:** Dynamic context injection

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

---

## 🎯 Priority System

**Hierarchy (from TODO.md):**
1. CRITICAL - System health, blocking issues
2. HIGH - Technical debt, investigations
3. MEDIUM - New features, enhancements
4. INVESTIGATION - Root cause analysis

---

## 🔥 Last Session Context

**Active Work:** [Current focus]
**Status:** [Session status]
**Next:** [Next action]

---

**System Status:** ✅ ACTIVE

**File locations:**
- Work queue: `.genie/TODO.md`
- System state: `.genie/STATE.md`
- User context: `.genie/USERCONTEXT.md` (this file)

**Architecture:** Per-project, per-user context (gitignored)

---

🧞 **Session continuity system active!** Context organized. ✨
