# Rule #2: Wish Initiation (Behavioral Spell)


**CRITICAL RULE:** All significant work must start with a wish document. Work done without a wish = framework violation.

## What Qualifies as "Significant"

Work is significant if ANY of these apply:
- ✅ Multi-part tasks (≥2 distinct groups)
- ✅ Multi-file changes (≥3 files touched)
- ✅ Architectural decisions (routing, priorities, structure)
- ✅ Time investment (≥1 hour estimated)
- ✅ Framework changes (affects multiple agents/workflows)
- ✅ User request explicitly scoped (clear goals/outputs)

## Why This Rule Exists

**Problem it solves:**
1. **Evidence tracking:** Wish documents preserve execution groups, decisions, outcomes
2. **Context preservation:** Session restart doesn't lose work progress
3. **Audit trail:** Clear proof of what was done, why, and evidence
4. **Streamlined workflow:** Plan → Wish → Forge → Review becomes automatic
5. **Team visibility:** Other agents know what's in progress

**What happens without it:**
- ❌ Work scattered across session (no formal grouping)
- ❌ Context lost on session restart
- ❌ No evidence aggregation (efforts forgotten)
- ❌ Framework workflow broken (skipped Wish phase)
- ❌ No Done Report (completion not documented)

## How to Apply This Rule

### BEFORE Starting Work

**Checklist:**
- [ ] Is this significant? (check list above)
- [ ] If YES → Create wish FIRST
- [ ] If NO → Continue with simple task

**Creating a wish:**
```bash
mkdir -p .genie/wishes/<slug>/
cat > .genie/wishes/<slug>/<slug>-wish.md << 'EOF'
# Wish: [Title]

## Context Ledger
- Problem: [what needs fixing]
- Goal: [what we'll deliver]
- Timeline: [estimate]

## Execution Groups
### Group A: [Phase 1]
- Task 1
- Task 2

### Group B: [Phase 2]
- Task 1

## Evidence Checklist
- [ ] Deliverable 1
- [ ] Deliverable 2
EOF
```

### AFTER Work Completes

**Update wish with:**
- [x] All groups marked completed
- [x] Evidence checklist filled
- [x] Done Report path documented
- [x] Lessons learned section updated

## Examples

### ✅ CORRECT: Wish Created First

```
User: "I want to analyze and prioritize our 30 spells"
Me: "Great! Let me create a wish for this..."
[Create: spells-prioritization-wish.md]
"I've set up groups: Analysis, Automation, Docs, Testing"
[Execute groups]
[Close wish with evidence]
```

### ❌ WRONG: Work Done, Then Wish Created

```
User: "I want to analyze and prioritize our 30 spells"
Me: [Works for 2 hours]
[Creates wish AFTER work is done]
← VIOLATION: Broke Plan → Wish → Forge → Review flow
```

### ✅ CORRECT: Simple Task (No Wish Needed)

```
User: "What's the token count for AGENTS.md?"
Me: "Let me check... [quick calculation] About 37.8KB"
← No wish needed: simple informational task
```

## Validation Before Committing

**Never commit work without verifying:**
- [ ] Wish created (if significant)
- [ ] All execution groups documented
- [ ] Evidence checklist completed
- [ ] Done Report path in wish
- [ ] Lessons learned section filled
- [ ] No framework violations

**If wish missing on significant work:**
1. Create wish retroactively (acknowledge violation)
2. Document why (learning entry)
3. Invoke learn agent to propagate lesson
4. Commit with violation note

## Example Violation & Fix

**Violation (2025-10-18):**
- Spells prioritization work executed for 2+ hours
- No wish created at start
- Evidence scattered across session

**Fix:**
- Created wish: `.genie/wishes/spells-prioritization/spells-prioritization-wish.md`
- Documented all groups and deliverables
- Added lessons learned: Rule #2 violation
- Invoked learn agent → created this spell
- Committed: "feat: document Rule #2 + fix spells prioritization violation"

## Anti-Patterns to Avoid

❌ **"It's just a quick thing"** → If it touches >2 files, create wish
❌ **"I'll create the wish after"** → Defeats the purpose (context already lost)
❌ **"No one will notice"** → Framework depends on this discipline
❌ **"This is too simple for a wish"** → If ≥2 hours or ≥3 files, document it
❌ **"I'll remember what we did"** → Session ends, memory lost

## Integration with Framework

**This spell is:**
- **Tier 3 (System Coordination):** Auto-loaded every session
- **Enforced by:** Meta-learn protocol (corrections documented)
- **Verified by:** Review + qa agents
- **Result:** All significant work has formal tracking

---

**Status:** Active behavioral rule (all future work must follow)
**Violation handling:** Retroactive wish + learn agent invocation
**Framework impact:** CRITICAL - enables streamlined Plan → Wish → Forge → Review

**Remember:** The Genie framework depends on this. Every user request must streamline through the wish system. No exceptions.
