# Triad Refactoring Plan (Draft)

**Status:** Awaiting Felipe's input on key decisions
**Date:** 2025-10-17

---

## Current State

```
CONTEXT.md (gitignored, per-user)
├─ User preferences (communication style, patterns)
├─ Current session details (what I'm working on)
├─ Completed work log
└─ Relationship history

TODO.md (committed, shared)
├─ CRITICAL/HIGH/MEDIUM priorities
├─ Full task details embedded
├─ Progress tracking
└─ Evidence links

STATE.md (committed, shared)
├─ System snapshot
├─ Active wishes status
└─ Repository state
```

---

## Target State

```
USERCONTEXT.md (gitignored, per-user)
├─ Personal communication preferences ONLY
├─ Relationship history
├─ Working patterns learned
└─ NO session work details

STATE.md (gitignored, RESETABLE)
├─ Current session work details ONLY
├─ What I'm working on RIGHT NOW
├─ Full context for mid-task resume
└─ Resets to blank when session resets

TODO.md (committed, shared)
├─ Macro task list ONLY
├─ Direction pointers (see X, run Y, check Z)
├─ NO deep implementation details
└─ Team-shared priorities
```

---

## Key Decisions Needed from Felipe

### 1. USERCONTEXT.md Migration
**Question:** From current CONTEXT.md, extract:
- ✅ User Profile section → USERCONTEXT.md
- ✅ Key Patterns Learned → USERCONTEXT.md
- ✅ Relationship History → USERCONTEXT.md
- ❓ Current Session section → STATE.md or delete?

**Proposal:**
```markdown
USERCONTEXT.md (gitignored)
├─ User Profile (preferences, communication style)
├─ Relationship History (milestones, working style)
├─ Key Patterns Learned (technical + workflow patterns)
└─ Context System How-To (unchanged)
```

### 2. STATE.md Content
**Question:** What exactly goes in STATE.md?

**Proposal:**
```markdown
STATE.md (gitignored, RESETABLE)
├─ Current Focus (what I'm working on right now)
├─ Active Context (files loaded, sessions running)
├─ Decision Queue (what I'm waiting on)
├─ Session Metrics (tokens used, time elapsed)
└─ Next Steps (immediate actions)
```

**Reset trigger:** Token limit (170k)? Manual command? New conversation?

### 3. TODO.md Refactoring
**Question:** How much detail to keep?

**Current (detailed):**
```markdown
### 3. Agent Deduplication Rollout
**Files:** 14 remaining agents...
**Progress:** [detailed status]
**Remaining:** [detailed list]
**Evidence:** [path]
```

**Proposed (macro):**
```markdown
### 3. Agent Deduplication Rollout
**Status:** IN PROGRESS (3/18 done)
**Context:** See `.genie/qa/evidence/agent-deduplication-progress-*.md`
**Next:** Run implementor on remaining 15 agents
```

### 4. @ Optimization Scope
**Audit results:**
- 226 files with @ references
- Top offenders: roadmap.md (67@), forge.md (48@), prompt.md (35@)

**Question:** Priority order?
1. Agent prompts (roadmap, forge, prompt) - optimize heavy @ usage
2. CLAUDE.md / AGENTS.md - strategic @ placement
3. Wish documents - cleanup excessive @
4. Evidence files - leave as-is (documentation)

### 5. Template Propagation
**Question:** Does this change templates/code/ and templates/create/?

**Options:**
- A) Just automagik-genie repo (templates stay as-is)
- B) Propagate to both templates (users start with triad)
- C) Propagate to templates but with placeholders

**My recommendation:** B - templates should model best practices

---

## Parallel Work Streams (if approved)

### Stream 1: File Structure (Core)
1. Create USERCONTEXT.md from CONTEXT.md
2. Create STATE.md template
3. Refactor TODO.md to macro-level
4. Update CLAUDE.md to load USERCONTEXT + STATE
5. Update .gitignore

### Stream 2: @ Optimization (Independent)
1. Audit agent prompts (roadmap, forge, prompt)
2. Replace excessive @ with "see X" patterns
3. Document @ usage guidelines
4. Update agents with optimizations

### Stream 3: Template Sync (Dependent on Stream 1)
1. Apply triad structure to templates/code/
2. Apply triad structure to templates/create/
3. Add placeholders where needed
4. Verify template initialization

---

## Questions for Felipe

1. **USERCONTEXT content:** Is my proposed split correct?
2. **STATE reset trigger:** What triggers session reset?
3. **TODO detail level:** Is macro proposal too minimal or just right?
4. **@ optimization priority:** Which files matter most?
5. **Template propagation:** Option A, B, or C?
6. **Execution approval:** Should I proceed with parallel streams once decided?

---

**Waiting for Felipe's input to finalize plan and create wish.**
