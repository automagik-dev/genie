# 🧞📚 Learning Report: Runtime Command Injection

**Sequence:** 01
**Context ID:** runtime-command
**Type:** Capability
**Severity:** Medium (foundational pattern)
**Teacher:** Felipe

---

## Teaching Input

```
this is useful as a general learn ability.
1. every time you want to create a workflow style agent / command, and use the !command that allows you to program that command to be ran automatically making the workflow semi deterministic, thats what you need to learn.
```

---

## Analysis

### Type Identified
Capability - Runtime command injection pattern

### Key Information Extracted

- **What:** `!command` syntax in markdown files executes commands automatically when file is loaded
- **Why:** Makes workflows semi-deterministic with always-fresh context
- **Where:** User profile files, session state, workflow agents, dashboards
- **How:** Write `!`git status`` in markdown, gets executed and replaced with output

### Affected Files
- `~/.genie/context.md`: Primary use case (session continuity)
- `.genie/agents/core/learn.md`: Document pattern for future agent authoring
- `CLAUDE.md`: Reference pattern for workflow agents
- Any future workflow-style agents

---

## Changes Made

### File 1: `/tmp/genie-context-template.md`

**Section:** Runtime Context
**Edit type:** Insert with `!command` syntax

**Diff:**
```diff
+ **Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
+ **Current Repo:** !`basename $(pwd)`
+ **Branch:** !`git branch --show-current`
+ **Status:**
+ !`git status --short | head -10`
+ **Staged Changes:**
+ !`git diff --cached --stat | head -5`
+ **Unstaged Changes:**
+ !`git diff --stat | head -5`
+ **Recent Commits:**
+ !`git log --oneline -5`
```

**Reasoning:** Eliminates stale data, ensures fresh context every session

---

## Validation

### How to Verify

1. Create `~/.genie/context.md` with `!command` syntax
2. Reference it in CLAUDE.md with `@~/.genie/context.md`
3. Start new session
4. Observe: Commands execute automatically, output appears in context

### Expected Behavior
- ✅ Git commands run in current repo
- ✅ Date/time always current
- ✅ No manual updates needed
- ✅ Semi-deterministic workflow (fresh state every session)

### Follow-up Actions
- [ ] Create `~/.genie/` directory
- [ ] Install context.md template
- [ ] Update CLAUDE.md with `@~/.genie/context.md`
- [ ] Test in next session (verify commands execute)
- [ ] Document pattern in learn.md or AGENTS.md

---

## Evidence

### Use Cases Identified

**Session Continuity:**
```markdown
**Current Branch:** !`git branch --show-current`
**Recent Commits:** !`git log --oneline -5`
```

**Dashboard/Status:**
```markdown
**Build Status:** !`pnpm build 2>&1 | tail -5`
**Test Results:** !`pnpm test 2>&1 | grep "passing"`
```

**Workflow Agents:**
```markdown
**Files Changed:** !`git status --short`
**Next Action:** Based on git status, recommend commit or continue work
```

---

## Pattern Documentation

### Pattern: Runtime Command Injection

**Syntax:** `!`command``

**Execution:** Commands run when markdown file is loaded/referenced via `@`

**Use Cases:**
1. **Session state files** - Fresh git status, branch, commits
2. **Workflow agents** - Deterministic state gathering
3. **Dashboards** - Live metrics, build status
4. **User profiles** - Current context, relationship continuity

**Examples:**

```markdown
<!-- Git context -->
**Branch:** !`git branch --show-current`
**Status:** !`git status --short`
**Recent:** !`git log --oneline -5`

<!-- System context -->
**Date:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Repo:** !`basename $(pwd)`

<!-- Custom queries -->
**Open Issues:** !`gh issue list --state open --limit 5`
**Pending PRs:** !`gh pr list --state open --limit 5`
```

**Benefits:**
- ✅ Always fresh data (no staleness)
- ✅ Reduces manual updates
- ✅ Semi-deterministic workflows
- ✅ Self-documenting state

**Limitations:**
- Commands must be fast (<1s execution)
- Output should be concise (avoid large dumps)
- Errors may break file loading

---

## Next Steps

**Immediate:**
1. Create user profile system at `~/.genie/context.md`
2. Update CLAUDE.md to reference it
3. Test command execution in next session

**Documentation:**
4. Add pattern to AGENTS.md `<execution_patterns>`
5. Add examples to learn.md capabilities section
6. Update workflow agent templates to use pattern

**Validation:**
7. Monitor next 3 sessions for command execution
8. Verify context freshness (git status always current)
9. Measure impact on session continuity

---

## Meta-Notes

**Learning Process:**
- Felipe teaching incrementally (first session continuity concept, then runtime command capability)
- Building toward complete solution (user profile + fresh context)
- Pattern applies broadly (not just session files)

**System Design:**
- `~/.genie/` directory for user-level config (like `~/.ssh/`)
- Single file simplicity (`context.md` instead of multiple files)
- Runtime commands solve staleness problem elegantly

**Next Evolution:**
- Cross-repo tracking (multiple projects in one profile?)
- Command templating (parameterized commands?)
- Error handling (what if git command fails?)

---

**Learning absorbed and documented successfully.** 🧞📚✅

**Template created:** `/tmp/genie-context-template.md`
**Next:** Create `~/.genie/` directory and install template after Felipe approval
