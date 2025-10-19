# Wish: Triad Context System Redesign
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Status:** 100/100 ✅
**Created:** 2025-10-17
**Branch:** `main` (fast iteration)
**Deadline:** TODAY (RC6 release)

---

## Context Ledger

**Problem:**
- Current triad (CONTEXT, STATE, TODO) has blurred separation of concerns
- CONTEXT mixes user prefs + session state
- TODO has macro backlog + session logs
- Templates ship with Felipe-specific content (breaks general audience)
- 527 lines loaded every session (context bloat)

**Vision:**
- **USERCONTEXT.md** - Static user preferences (personal choices)
- **STATE.md** - Current session work (detailed, reset-friendly)
- **TODO.md** - Macro task list (pointers only, no details)
- @ optimization (strategic use, self-aware system)
- Template-ready local genie

**Mission:**
Genie in Genie repo building Genie for general audience. Fix base prompts → perfect templates → RC6 TODAY.

**Scope:**
- Redesign triad files in local .genie/
- Update CLAUDE.md references
- Remove Felipe-specific refs from agents (vibe, learn, roadmap)
- Delete cleanup files (release-old-backup.md)
- Prepare for template copy

---

## Execution Groups

### Group A: Triad File Restructure (30 min)

**Tasks:**
1. Create USERCONTEXT.md from CONTEXT.md
   - Extract: User profile, communication prefs, patterns learned
   - Remove: Current session, completed today, system mechanics

2. Rebuild STATE.md
   - Add: Current session focus (from CONTEXT)
   - Add: Active work details (from TODO)
   - Keep: Production status, working tree (!commands)
   - Remove: Felipe-specific notes

3. Clean TODO.md
   - Keep: CRITICAL/HIGH/MEDIUM/INVESTIGATION queues
   - Remove: "Current Session", "Completed Today" sections
   - Minimal: Pointers only (no task details)

4. Update CLAUDE.md
   - Change `` → `@.genie/USERCONTEXT.md`

**Evidence:**
```bash
# Verify file separation
grep -i "current session" .genie/USERCONTEXT.md  # Should return nothing
grep -i "user profile" .genie/STATE.md            # Should return nothing
grep -i "completed today" .genie/TODO.md          # Should return nothing
```

### Group B: Agent Generalization (20 min)

**Tasks:**
1. Generalize vibe.md (3 Felipe refs)
   - Line 1236: "Felipe, the kingdom is secure" → "The kingdom is secure"
   - Line 1277: "built for Felipe's sleep" → "built for autonomous execution"
   - Line 1283: "while Felipe sleeps" → "autonomously"

2. Generalize learn.md (3 Felipe refs)
   - Line 24: "absorbs Felipe's teachings" → "absorbs user teachings"
   - Line 519: "Teacher: <Felipe|Agent|System>" → "Teacher: <User|Agent|System>"
   - Line 833: "Absorb Felipe's teachings" → "Absorb user teachings"

3. Generalize roadmap.md (17 namastex refs)
   - Replace hardcoded `namastexlabs/automagik-roadmap` → `{{ROADMAP_REPO}}`

**Evidence:**
```bash
# Verify no personal refs
grep -ri "felipe" .genie/agents/ --include="*.md"  # Should return 0
grep -ri "namastex" .genie/agents/ --include="*.md" | grep -v "{{" # Should return 0
```

### Group C: Cleanup & Validation (10 min)

**Tasks:**
1. Delete cleanup files
   - Remove: `.genie/agents/release-old-backup.md`

2. Validate @ usage
   - Count: `grep -r "^@" .genie/agents/ --include="*.md" | wc -l`
   - Should remain at 76 (examples are legitimate)

3. Test CLAUDE.md loading
   - Verify USERCONTEXT.md loads correctly
   - Check STATE.md has current session
   - Confirm TODO.md is minimal

**Evidence:**
```bash
# Verify cleanup
ls .genie/agents/release-old-backup.md  # Should not exist

# Test loading (open new Claude session)
# Should see USERCONTEXT loaded, not CONTEXT
```

---

## Tracking

**GitHub Issue:** TBD (inline work, no issue needed)
**Forge Plan:** Inline above
**Branch:** main (fast iteration, deadline TODAY)

---

## Evidence Checklist

- [x] USERCONTEXT.md exists with user prefs only
- [x] STATE.md has current session details
- [x] TODO.md is macro-only (no details)
- [x] CLAUDE.md loads USERCONTEXT.md
- [x] 0 Felipe refs in .genie/agents/
- [x] 0 hardcoded namastex refs (except {{placeholders}})
- [x] release-old-backup.md deleted
- [x] @ count stable at 75 (strategic use, down from 76)
- [x] Template-ready (can copy to templates/code/)

---

## Success Criteria

**Must have (RC6 blocking):**
- ✅ Triad restructure complete (USERCONTEXT, STATE, TODO)
- ✅ CLAUDE.md updated
- ✅ Agent generalization complete (0 personal refs)
- ✅ Cleanup files removed

**Should have (RC6 target):**
- ⚠️ @ usage documented
- ⚠️ Template copy verified

**RC6 release:**
- Triad redesign + template perfection
- General audience ready
- Test → extensive review → stable version

---

## Notes

**@ Optimization Strategy:**
- Strategic use (not excessive)
- Self-aware: Genie calls itself via MCP (same prompts, same LLM)
- Mindful in .md edits & agent prompts

**Parallel Execution:**
- Group A, B, C can run simultaneously
- Unlimited subagent sessions available
- Namastex Labs infrastructure

---

**Status:** Ready for forge/execution
