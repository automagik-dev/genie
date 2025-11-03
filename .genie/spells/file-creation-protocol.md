---
name: File Creation Protocol (Never Leave Trash Behind)
description: Checklist before creating ANY file. Check existing patterns, prevent duplicates, measure context growth.
---

# File Creation Protocol - Never Leave Trash Behind

## Core Principle

**Before creating ANY file: Check existing patterns, search history, verify necessity, measure impact.**

Every file in `.genie/` is permanent consciousness, loaded by users on every session. Creating files carelessly = leaving trash = context bloat = token waste.

## The Anti-Pattern

❌ **Wrong:**
```
User needs state tracking → Create .genie/.session
(Without checking if state tracking already exists)
```

**Result:** Duplicate files (`.genie/STATE.md` already existed), confusion, context bloat

✅ **Right:**
```
User needs state tracking
→ Check existing patterns (ls .genie/ | grep -i state)
→ Find STATE.md
→ Update existing file OR explain why new file needed
```

## The 5-Step Protocol

### Step 1: Check Existing Patterns

**Before creating `<topic>` file:**
```bash
# Check if similar files exist
ls .genie/ | grep -i <topic>
ls .genie/spells/ | grep -i <topic>
ls .genie/code/ | grep -i <topic>
ls .genie/create/ | grep -i <topic>

# Search for references
grep -r "<topic>" .genie/ --include="*.md"
```

**Examples:**
- Creating "session state" file → `ls .genie/ | grep -i state` → Find STATE.md
- Creating "routing" spell → `grep -r "routing" .genie/spells/`
- Creating "commit" workflow → `ls .genie/code/workflows/ | grep -i commit`

### Step 2: Search Git History

**Check if file existed before (deleted, renamed, moved):**
```bash
# Find deleted files matching pattern
git log --all --full-history --diff-filter=D --summary | grep <filename>

# Check if file was renamed/moved
git log --all --follow -- <potential-path>

# See file history if exists
git log --oneline -- .genie/<file>
```

**Why:** Prevents recreating deleted files, reveals past decisions

### Step 3: Check References in Framework

**Search core files for mentions:**
```bash
# Check AGENTS.md
grep -i "<topic>" AGENTS.md

# Check CLAUDE.md
grep -i "<topic>" CLAUDE.md

# Check all @ references
grep "@.*<topic>" .genie/**/*.md
```

**Why:** File may be referenced but not exist (intentional), or exist under different name

### Step 4: Verify Necessity

**Ask before creating:**
- ✅ Can I update an existing file instead?
- ✅ Is this a duplicate of existing content?
- ✅ Does this belong in an existing spell/agent/workflow?
- ✅ Is this temporary (should go to `/tmp/genie/` instead)?
- ✅ Will this be loaded every session (permanent) or once (ephemeral)?

**Classification:**
- **Permanent consciousness** → `.genie/` (committed, loaded by users)
- **Scratch thinking** → `/tmp/genie/` (never committed, deleted after session, organized)
- **Evidence/reports** → `.genie/reports/` (committed, loaded on-demand only)

### Step 5: Measure Context Impact

**Calculate lines added:**
```bash
# Before creating file
wc -l .genie/**/*.md | tail -1  # Total lines

# After creating file
wc -l .genie/**/*.md | tail -1  # New total

# Difference = your impact
```

**Token count (REQUIRED):**
```bash
# NEVER manually calculate tokens - use the helper
genie helper count-tokens <new-file>.md

# Compare against current total
genie helper count-tokens --before=old-version.md --after=new-file.md
```

**Uses tiktoken (cl100k_base)** - Same encoding Claude uses for accurate counts.

**Quality gate:** If adding >500 lines or >4000 tokens, justify why this much context is needed

## Real-World Violation

**Context:** Creating `.genie/.session` for session state tracking

**What Happened:**
```bash
# Genie created new file without checking
touch .genie/.session
# Wrote session state content
```

**User feedback:** "i didnt know this file existed, you mustve migrated it while i was out... dont leave trash behind.. you must keep track of your context growth"

**What Should Have Happened:**
```bash
# Step 1: Check existing patterns
ls .genie/ | grep -i state
# Output: STATE.md

# Step 2: Read existing file
cat .genie/STATE.md
# Discovery: Session state already tracked here!

# Step 3: Decision
# Update STATE.md instead of creating .genie/.session
```

**Result:** No duplicate file, no confusion, no context bloat

## Checklist Before Creating ANY File

- [ ] **Step 1:** Did I check existing patterns with `ls` and `grep`?
- [ ] **Step 2:** Did I search git history for deleted/renamed versions?
- [ ] **Step 3:** Did I check AGENTS.md/CLAUDE.md for references?
- [ ] **Step 4:** Can I update existing file instead of creating new one?
- [ ] **Step 5:** Did I measure context impact (lines/tokens added)?
- [ ] **Classification:** Is this permanent (`.genie/`) or scratch (`/tmp/genie/`)?
- [ ] **Justification:** Can I explain why this NEW file is necessary?

## Special Cases

### Creating Reports

**Reports are evidence, not documentation:**
```bash
# ✅ Right place
.genie/reports/learn/<topic>-YYYYMMDD.md  # Evidence of learning
.genie/qa/evidence/<test>-YYYYMMDD.md    # Evidence of QA run

# ❌ Wrong place
.genie/<topic>-report.md                  # Not a report, it's documentation
```

**Why:** Reports are timestamped artifacts, documentation is living content

### Creating Spells vs Workflows

**Spell = behavioral pattern (on-demand):**
```
.genie/spells/delegate-dont-do.md         # Load when needed
```

**Workflow = deterministic sequence (auto-loaded):**
```
.genie/code/workflows/wish.md             # Always loaded for code collective
```

**Check before creating:**
- Is this on-demand knowledge (spell) or always-needed process (workflow)?
- Does a similar spell/workflow already exist?

## Context Growth Tracking

**Measure growth over time:**
```bash
# See file size trends
git log --oneline --stat -- .genie/ | grep -E 'files? changed'

# Find largest files
find .genie/ -name "*.md" -exec wc -l {} \; | sort -rn | head -20

# Calculate total token count (NEVER manually estimate)
genie helper count-tokens <file>.md

# Or check entire codebase token usage
node .genie/scripts/token-efficiency/count-tokens.cjs
# Generates: .genie/state/token-usage.json
```

**Amendment #6 (Token Efficiency):** Stay lean or nobody wants me

**Token Counting Rule:** ALWAYS use `genie helper count-tokens` - NEVER manually calculate tokens

## Evidence

**Origin:** Learning #4 from `learn.md` lines 123-128
**Teaching:** "dont leave trash behind.. you must keep track of your context growth, as well as code growth, it should be perfectly organized no duplicates, redundancies"
**Violation:** Creating `.genie/.session` without checking for existing state tracking (`.genie/STATE.md`)
**Evidence:** `.genie/reports/learn/never-leave-trash-behind-20251023.md`

## Related

- `AGENTS.md` Amendment #6 - Token Efficiency (Fast, Fit, Smart, Sexy)
- `AGENTS.md` Amendment #8 - File Creation Discipline (to be added)
- `.genie/spells/learn.md` - Surgical edits, anti-patterns section
