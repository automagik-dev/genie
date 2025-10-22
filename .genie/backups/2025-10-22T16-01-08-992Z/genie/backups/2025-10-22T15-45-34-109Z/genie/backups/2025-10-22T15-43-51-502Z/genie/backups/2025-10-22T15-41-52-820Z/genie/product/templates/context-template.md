# 🧞 Genie Context: {{USER_NAME}}

**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Current Repo:** !`basename $(pwd)`
**Active Since:** !`date -u +"%Y-%m-%d"`

---

## 📊 Runtime Context (Auto-Updated)

**Branch:** !`git branch --show-current`

**Status:**
!`git status --short | head -10`

**Staged Changes:**
!`git diff --cached --stat | head -5`

**Unstaged Changes:**
!`git diff --stat | head -5`

**Recent Commits:**
!`git log --oneline -5`

---

## 🎯 Current Focus

**Task:** [What you're working on]
**Status:** [ACTIVE | PAUSED | PLANNING]
**Started:** [YYYY-MM-DD HH:MM UTC]

**Context:**
- [Key context points]
- [What's been completed]
- [What's in progress]

**Next Action:**
[What to do next]

---

## 🔄 Active Parallel Work

### Background Orchestrators
*Track MCP agent sessions here*

### Delegated Work
*Track task delegations here*

**Note:** When spawning parallel work, add entries here with session IDs and status checks.

---

## ⏳ Decision Queue (One at a Time)

### Decision 1: [Topic] [ACTIVE NOW]

**Question:** [The decision you need to make]

**Context:**
- [Background information]
- [What it affects]
- [What it blocks]

**Question presented:** [YYYY-MM-DD ~HH:MM UTC]

---

## 👤 User Profile: {{USER_NAME}}

### Communication Preferences

**Decision Presentation:**
- ✅ ONE decision per message (never ABCD parallel options)
- ✅ Full context: question, background, what it blocks
- ✅ Present options AFTER question, not bundled
- ✅ Wait for response before next decision
- ✅ Use decision queue (this file) for sequential presentation

**Working Style:**
- [Your preferences]
- [How you like to work]
- [Communication style]

**Session Interaction:**
- ✅ Greet with current context (reference this file)
- ✅ Build on previous learnings
- ✅ Sequential focus (one thing deeply, not many shallowly)
- ✅ Use this file to track parallel work and decisions

**Feedback Style:**
- [How you prefer feedback]
- [What works well]
- [What to avoid]

---

## 📚 Relationship History

**First session:** [YYYY-MM-DD]
**Total sessions:** [Count]
**Collaboration style:** [Description]

**Key moments:**
- [Date]: [Important milestone or learning]
- [Date]: [Another key moment]

**Current projects:**
1. [Project name] ([status/phase])
2. [Another project]

**Working relationship:**
- [How you work with Claude Code]
- [Patterns that work well]
- [Things to remember]

---

## 📋 Recent Completions (Current Session)

**Major accomplishments:**
- ✅ [Completed item]
- ✅ [Another completion]

**Learnings captured:**
- [New pattern learned]
- [Technique discovered]

---

## 🗂️ Open Issues Registry ({{PROJECT_NAME}})

| # | Title | Status | % | Action |
|---|-------|--------|---|--------|
| X | [Issue title] | [PASS/FAIL/PARTIAL] | X% | [Next step] |

**Summary:** [Compliance stats or overview]

---

## 💡 Patterns Learned (Cross-Repo)

### [Pattern Name] ([YYYY-MM-DD])
- **Pattern:** [Description]
- **Why:** [Reasoning]
- **Examples:** [Usage examples]
- **Use cases:** [When to apply]
- **Report:** [Link to learning report if exists]

---

## 🛠️ How to Use This File

**Session Start (Auto):**
1. Claude Code loads CLAUDE.md
2. Finds `@~/.genie/context.md` reference
3. Executes all `!command` statements
4. Greets you with:
   - Current focus
   - Where you left off
   - Fresh git context
   - Next queued decision

**During Session:**
- Check "Current Focus" to know what you're working on
- Update "Recent Completions" as you finish tasks
- Add decisions to queue (don't present all at once!)
- Track parallel work in "Active Parallel Work" section

**Session End:**
- Update "Current Focus" with progress
- Add completions to "Recent Completions"
- Queue any pending decisions
- Learnings auto-captured via /learn command

**Decision Management:**
- Add decisions to queue as they arise
- Present ONE at a time from queue
- Remove from queue when resolved
- Never present multiple decisions in parallel (ABCD format)

---

## 🎯 Session Greeting Template

When you start a new session, Claude Code greets like this:

> "Hey {{USER_NAME}}! 👋
>
> **Current focus:** [from Current Focus section]
> **Where we left off:** [last item from Recent Completions]
> **Branch:** [from !git branch]
> **Status:** [summary from !git status]
>
> [If decision queued]: **Next up:** Decision 1 about [topic]. Ready to discuss?
> [If no decision]: Ready to continue or switch focus?"

This ensures:
- ✅ Immediate context restoration
- ✅ Fresh runtime state
- ✅ Clear continuation point
- ✅ No replanning needed
- ✅ Relationship continuity

---

**System Status:** ✅ ACTIVE

**This file location:** `~/.genie/context.md` (user-local, cross-repo)

**Loaded via:** `@~/.genie/context.md` in CLAUDE.md (line 3)

**Next evolution:** [Your ideas for improving this system]

---

🧞 **Session continuity system active!** No more amnesia. Let's build. ✨

