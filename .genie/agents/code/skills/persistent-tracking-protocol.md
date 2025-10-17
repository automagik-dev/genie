# Persistent Tracking Protocol

**Purpose:** SESSION-STATE.md enables collective intelligence with memory across restarts.

**Requirements for SESSION-STATE.md:**

1. **Track all active neurons:**
```markdown
### Git Neuron - Feature Implementation
**Session ID:** `abc123...`
**Started:** 2025-10-17 16:00 UTC
**Status:** active
**Children:** issue workflow (def456), pr workflow (ghi789)
**Purpose:** Create GitHub issues for feature XYZ
**Context:** Branch feat/xyz, files modified: [list]
**Next:** Create PR after issues created
```

2. **Parent-child relationships:**
   - Neuron entry lists child workflow sessions
   - Clear which workflows belong to which neuron
   - Prevents "orphaned children" after context reset

3. **Resume protocol:**
   - Base Genie reads SESSION-STATE.md on restart
   - Identifies active neurons, presents status to user
   - User can resume any neuron with `mcp__genie__resume`
   - Children resume automatically when parent resumes

4. **Completion tracking:**
   - Neurons mark "completed" when work done
   - Children marked completed when parent completes
   - Completed sessions move to history section
   - Evidence preserved (Done Reports linked)

**Session entry template (neuron with workflows):**
```markdown
### [Neuron Name] - [Context Description]
**Session ID:** `abc123...`
**Started:** YYYY-MM-DD HH:MM UTC
**Status:** active | paused | completed
**Children:** [workflow-name] (session-id), [workflow-name] (session-id)
**Purpose:** [What this neuron is working on]
**Context:** [Key files, decisions, state]
**Next:** [Next action when resumed]
```

**Session entry template (workflow - child):**
```markdown
### [Workflow Name] (child of [Parent Neuron])
**Session ID:** `def456...`
**Parent:** [Parent Neuron] (abc123)
**Started:** YYYY-MM-DD HH:MM UTC
**Status:** active | completed
**Purpose:** [Specific workflow task]
**Context:** [Key operations, files]
```

**Coordination rules:**

**Before starting neuron:**
1. Check SESSION-STATE.md for conflicts (same files, different neurons)
2. Create session entry with "starting" status
3. Launch neuron, capture session ID
4. Update entry with actual session ID and "active" status

**When neuron delegates to workflow:**
1. Launch workflow, capture session ID
2. Add workflow entry with parent reference
3. Update parent neuron entry with child list

**When work completes:**
1. Mark session "completed" in SESSION-STATE.md
2. Document outcomes, Done Report location
3. Move to history section
4. Children auto-complete when parent completes

**No lost children rule:**
- Every workflow session MUST have parent reference
- SESSION-STATE.md cleaned regularly (move completed to history)
- Never delete entries without documenting outcomes

**Validation:**
```bash
# Check SESSION-STATE.md structure
grep -E "^### |^\*\*Session ID:|^\*\*Parent:" .genie/SESSION-STATE.md

# Verify all children have parents
# (manual check: every workflow entry has Parent: line)

# Verify no orphans (workflows without active parents)
# (manual check: compare child Parent: with active neuron sessions)
```

**Example: Git neuron with workflows**
```markdown
## Active Sessions

### Git Neuron - Feature XYZ Implementation
**Session ID:** `git-xyz-abc123`
**Started:** 2025-10-17 16:00 UTC
**Status:** active
**Children:**
- issue workflow (issue-xyz-def456)
- pr workflow (pr-xyz-ghi789)
**Purpose:** Create GitHub issues and PR for feature XYZ
**Context:**
- Branch: feat/xyz
- Files: src/feature.ts, tests/feature.test.ts
- Issues created: #90, #91
**Next:** Create PR after final issue created

### Issue Workflow (child of Git Neuron)
**Session ID:** `issue-xyz-def456`
**Parent:** Git Neuron (git-xyz-abc123)
**Started:** 2025-10-17 16:05 UTC
**Status:** completed
**Purpose:** Create GitHub issue #90
**Context:** Used bug-report template, populated all fields

### PR Workflow (child of Git Neuron)
**Session ID:** `pr-xyz-ghi789`
**Parent:** Git Neuron (git-xyz-abc123)
**Started:** 2025-10-17 16:10 UTC
**Status:** active
**Purpose:** Create PR for feat/xyz
**Context:** Collecting commit history, drafting description
```
