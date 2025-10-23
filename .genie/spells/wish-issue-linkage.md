# Rule #6: Wish-Issue Linkage (Behavioral Spell)

**Created:** 2025-10-20
**Priority:** CRITICAL
**Learn Session:** c873572f-fd95-4ea0-a0c9-cdaed1dda898

**CRITICAL RULE:** Every wish MUST link to a GitHub issue. No issue → no wish creation.

---

## The Core Principle

**Before ANY wish document is created:**
1. GitHub issue MUST exist
2. Issue number MUST be validated
3. Issue link MUST be in wish front-matter

**No exceptions.** This is mandatory for all wish workflows.

---

## Why This Rule Exists

### Problem it Solves

**Without issue linkage:**
- ❌ No team visibility (non-Genie users don't know what's planned)
- ❌ No approval checkpoint (work may be rejected after implementation)
- ❌ No audit trail (work history scattered across systems)
- ❌ No search/discovery (GitHub search can't find wishes)
- ❌ No permalink stability (wishes live in .genie/, may move)

**With issue linkage:**
- ✅ Team visibility (everyone sees what's being worked on)
- ✅ Approval gates (issue discussion before implementation starts)
- ✅ Complete audit trail (issue → wish → forge task → PR → merge)
- ✅ Searchable history (GitHub search finds all work)
- ✅ Stable permalinks (issue #XXX never changes)

### Architectural Hierarchy

```
GitHub Issue (Public, Permanent)
    ↓
Wish Document (Internal Planning)
    ↓
Forge Task (Execution Tracking)
    ↓
Git Branch + Worktree (Implementation)
    ↓
Pull Request (Review + Merge)
```

**Each level links to parent:**
- Wish → Issue #XXX
- Forge task → Issue #XXX + Wish path
- Branch → forge/XXXX-kebab-case (derived from task)
- PR → Closes #XXX

---

## How To Apply This Rule

### Step 1: Issue Validation (BEFORE Discovery)

**When user requests wish creation:**

```typescript
// Genie MUST check:
const issueProvided = userInput.includes('#') || userInput.includes('issue');

if (!issueProvided) {
  // Ask user for issue number
  await ask("Is there a GitHub issue for this? If yes, provide #XXX. If no, I'll create one.");
}

// Validate issue exists
const issue = await gh.issue.get(issueNumber);
if (!issue) {
  // Route to issue creation workflow
  await createIssueFirst();
}
```

**BLOCK wish creation until issue confirmed.**

### Step 2: Issue Creation (If Missing)

If no issue exists, route to issue creation:

```markdown
**Issue Creation Checklist:**
1. Ask user: "Should I create GitHub issue first?"
2. Gather context:
   - Title (clear, actionable)
   - Description (context ledger summary)
   - Labels (wish, enhancement, bug, etc.)
   - Acceptance criteria
3. Create issue via GitHub API:
   \`gh issue create --title "..." --body "..." --label wish\`
4. Extract issue number from response
5. THEN proceed to wish creation
```

### Step 3: Wish Document Linkage

Every wish document MUST include issue reference:

```markdown
# Wish: <Title>

**GitHub Issue:** #152  <-- MANDATORY FIELD
**Status:** Discovery
**Created:** !`date -u +"%Y-%m-%d"`
**Forge Task:** (filled after task creation)

## Context Ledger

**Origin:** GitHub Issue #152
**Problem:** [from issue description]
...
```

### Step 4: Forge Task Linkage

When creating Forge task from wish:

```typescript
await mcp__automagik_forge__create_task({
  project_id: "ee8f0a72-44da-411d-a23e-f2c6529b62ce",
  title: `Wish: MCP Server Authentication (#152)`,  // Issue # in title!
  description: `
    **GitHub Issue:** #152
    **Wish Document:** @.genie/wishes/mcp-auth/mcp-auth-wish.md

    [Full wish context from issue]
  `
});
```

---

## Integration With Existing Workflows

### Wish Workflow Enhancement

**Add Step 0 (NEW) before Discovery:**

```markdown
### Step 0: Issue Validation
**Goal:** Ensure GitHub issue exists before starting wish dance

**Process:**
1. Check if user provided issue number
2. If YES:
   - Validate issue exists: \`gh issue view #XXX\`
   - Extract context from issue
   - Proceed to Step 1 (Discovery)
3. If NO:
   - Ask: "Should I create a GitHub issue first?"
   - If user says yes → delegate to issue-creation workflow
   - If user says no → BLOCK wish creation, explain rule

**Delegation:**
\`\`\`
mcp__genie__run with agent="issue-check" prompt="Validate issue #XXX exists"
\`\`\`

**Output:** Issue number + issue context + "Ready for discovery?"
```

### Blueprint Workflow Enhancement

**Update wish document template:**

```markdown
**Required front-matter fields:**
- GitHub Issue: #XXX  <-- MUST be filled
- Forge Task: <task_id>  <-- Auto-filled after creation
- Status: Discovery/In-Progress/Review/Done
- Created: !`date`
```

---

## Enforcement Mechanism

### Pre-Creation Check

**In wish.md orchestrator:**
```typescript
// BEFORE starting wish dance
async function validateIssueExists(userRequest: string): Promise<IssueValidation> {
  const issueMatch = userRequest.match(/#(\d+)/);

  if (!issueMatch) {
    return {
      valid: false,
      reason: "No issue number provided",
      action: "prompt_user_for_issue"
    };
  }

  const issueNumber = issueMatch[1];
  const issue = await gh.issue.get(issueNumber);

  if (!issue) {
    return {
      valid: false,
      reason: `Issue #${issueNumber} does not exist`,
      action: "create_issue_first"
    };
  }

  return {
    valid: true,
    issue: issue,
    issueNumber: issueNumber
  };
}
```

### Post-Creation Validation

**In review.md agent:**
```typescript
// Validate wish document has issue link
async function validateWishDocument(wishPath: string): Promise<boolean> {
  const content = await fs.readFile(wishPath, 'utf-8');
  const hasIssueLink = /\*\*GitHub Issue:\*\* #\d+/.test(content);

  if (!hasIssueLink) {
    throw new Error(`Wish ${wishPath} missing GitHub issue link! Rule #6 violation.`);
  }

  return true;
}
```

---

## Examples

### ✅ CORRECT: Issue First, Then Wish

```
User: "I want to add MCP authentication"

Genie: "Great idea! Is there a GitHub issue for this?"
User: "Yes, #152"

Genie: [Validates #152 exists]
Genie: "Perfect! Issue #152 confirmed. Let's start the wish dance..."
[Creates wish with GitHub Issue: #152]
[Links Forge task to #152]
```

### ✅ CORRECT: Create Issue First

```
User: "I want to unify the naming taxonomy"

Genie: "Excellent! I don't see a GitHub issue for this. Should I create one first?"
User: "Yes please"

Genie: [Creates issue #155 via gh CLI]
Genie: "Issue #155 created! Now let's create the wish..."
[Creates wish with GitHub Issue: #155]
```

### ❌ WRONG: Wish Without Issue

```
User: "Create a wish for voice agent transformation"

Genie: [Creates wish document immediately]  <-- VIOLATION!
Genie: [No issue link in wish]  <-- VIOLATION!

← This breaks Rule #6. MUST validate/create issue FIRST.
```

---

## Spell Metadata

**Spell Type:** Behavioral (Tier 6 - Workflow & State Management)
**Auto-loaded:** YES (every session)
**Enforced by:** wish.md orchestrator, review.md validator
**Violation handling:** BLOCK wish creation, route to issue-creation
**Related spells:**
- Rule #2: Wish Initiation (`@.genie/spells/wish-initiation.md`)
- Wish Document Management (`@.genie/spells/wish-lifecycle.md`)
- Persistent Tracking Protocol (`@.genie/spells/track-long-running-tasks.md`)

---

## Anti-Patterns To Avoid

❌ **"The issue is implied"** → No. Explicit link required.
❌ **"I'll create issue after wish"** → No. Issue FIRST, always.
❌ **"This is internal work, no issue needed"** → No. All wishes need issues.
❌ **"Issue creation slows me down"** → Good. Approval gate is intentional.
❌ **"I forgot to link the issue"** → Fix immediately (retroactive linking).

---

## Retroactive Fixes

**If wish exists without issue:**
1. Create GitHub issue immediately
2. Update wish document with issue #
3. Update Forge task title/description with issue #
4. Add violation note to learn session
5. Document in meta-learn protocol

**Example:**
```bash
# Create missing issue
gh issue create --title "Wish: Voice Agent Transformation" \
  --body "$(cat .genie/wishes/voice-agent/voice-agent-wish.md)" \
  --label wish

# Extract issue number
ISSUE_NUM=$(gh issue list --limit 1 --json number --jq '.[0].number')

# Update wish document
sed -i "s/\*\*GitHub Issue:\*\* TBD/**GitHub Issue:** #$ISSUE_NUM/" \
  .genie/wishes/voice-agent/voice-agent-wish.md

# Document violation
echo "Rule #6 violation: Retroactively linked issue #$ISSUE_NUM" >> \
  .genie/reports/learn-wish-issue-amendment-20251020.md
```

---

## MCP Integration

### Genie Spell Execution Pattern

**Goal:** Genie MCP executes spells dynamically (lighter base prompts)

**How this works:**
1. Base Genie prompt = thin orchestrator
2. Spells loaded as @ references (not full content in base prompt)
3. When wish requested → Genie dynamically loads wish-issue-linkage-rule.md
4. Spell execution = read file, apply rules, validate

**Benefits:**
- Lighter base prompts (token efficiency)
- Spells updated independently (no base prompt changes)
- Clear separation of concerns (orchestration vs execution)

**Implementation:**
```typescript
// In wish.md orchestrator
async function ensureIssueExists(userRequest: string) {
  // Load spell dynamically
  const spell = await loadSkill('@.genie/spells/wish-issue-linkage.md');

  // Execute spell logic
  const validation = await spell.validateIssue(userRequest);

  if (!validation.valid) {
    // Route to issue creation
    return await spell.createIssueFirst(userRequest);
  }

  return validation.issueNumber;
}
```

---

## Summary

**Rule #6 in one sentence:**
> No GitHub issue = no wish creation. Issue first, always.

**Why it matters:**
- Team visibility (public tracking)
- Approval gates (discussion before work)
- Audit trail (complete history)
- Search/discovery (GitHub search works)
- Permalink stability (issue # never changes)

**How to follow:**
1. Check if issue exists
2. If not → create issue first
3. Link issue # in wish front-matter
4. Link issue # in Forge task
5. Close issue when PR merges

**Enforcement:**
- wish.md blocks creation without issue
- review.md validates issue link exists
- Meta-learn tracks violations

---

**Status:** Active behavioral rule (all future wishes must follow)
**Violation handling:** BLOCK + route to issue creation
**Framework impact:** CRITICAL - enables public visibility + audit trail

**Remember:** GitHub is source of truth. Wishes are implementation plans. Forge tasks are execution. All three MUST link together.
