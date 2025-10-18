# Git Hook Architecture: Genie Integration

**Complete reference for git hook system with Genie workflow integration**

**Updated:** 2025-10-18
**Status:** Ready for testing

---

## Architecture Overview

### What We Built

Two-layer git validation system:

1. **Local Validation Layer** (pre-commit, pre-push)
   - Fast Node.js scripts (validate user files, refs, etc.)
   - Direct Node execution, no agent overhead
   - Blocks commit/push immediately on errors

2. **Intelligent Workflow Layer** (pre-commit with Genie)
   - Genie agent `neurons/git/commit-advisory`
   - Runs in background (non-blocking)
   - Produces structured JSONL logs
   - Results queryable via parser

---

## File Structure

### Hook Files

```
.git/hooks/
├── pre-commit
│   ├─ Run: validate-user-files-not-committed.js (SYNC)
│   ├─ Run: validate-cross-references.js (SYNC)
│   └─ SPAWN: genie run neurons/git/commit-advisory (ASYNC)
│      └─ Non-blocking, runs in background
│
├── pre-push
│   ├─ Run: pnpm run test:all (SYNC, blocks if fails)
│   ├─ Run: commit-advisory.js (SYNC, blocks if errors)
│   └─ Run: update-changelog.js (SYNC, non-blocking)
│
└── post-commit (if needed)
    └─ Could query Genie results: genie view <sessionId>
```

### Validation Scripts

```
.genie/scripts/
├── validate-user-files-not-committed.js
│   └─ Checks .env, .genie/TODO.md not staged
│
├── validate-cross-references.js
│   └─ Validates all @file.md references exist
│
├── commit-advisory.js
│   └─ Direct Node analysis (used in pre-push)
│   ├─ Extract commits to push
│   ├─ Validate wish/GitHub issue references
│   ├─ Check bug fixes have GitHub issues
│   └─ Output: JSON with errors/warnings
│
└── genie-workflow-parser.js ← NEW
    └─ Extract Genie workflow output
    ├─ Find session log file
    ├─ Parse JSONL events
    ├─ Extract markdown structure
    ├─ Return: JSON, exit codes, summary
```

### Workflow Definition

```
.genie/agents/neurons/git/
└── commit-advisory.md ← NEW
    ├─ Executor: claude (Haiku model for speed)
    ├─ Input: Commits to validate
    ├─ Output: Structured markdown advisory
    │  ├─ Validation Results section
    │  ├─ ✅ Passed items
    │  ├─ ⚠️ Warnings with counts
    │  └─ ❌ Blocking Issues with counts
    └─ Stored: .genie/state/agents/logs/...
```

---

## Hook Execution Flow

### Pre-Commit Hook (Non-Blocking Workflow)

```
┌─ User: git commit -m "feat: ..."
│
├─ [SYNC] Validate user files
│  └─ Exit 1 if fails ❌
│
├─ [SYNC] Validate @ cross-references
│  └─ Exit 1 if fails ❌
│
├─ [ASYNC] SPAWN Genie workflow
│  ├─ Start: neurons/git/commit-advisory
│  ├─ Return immediately (don't wait)
│  └─ Workflow runs in background
│
└─ Exit 0 → Commit proceeds ✅
   (Genie results available later)
```

**Time:** ~1 second (no waiting for Genie)

---

### Pre-Push Hook (Blocking Validation)

```
┌─ User: git push
│
├─ [SYNC] Run: pnpm run test:all
│  └─ Exit 1 if fails ❌
│
├─ [SYNC] Run: commit-advisory.js
│  ├─ Analyze commits (direct Node, no agent)
│  ├─ Check wish references
│  ├─ Check GitHub issues for bugs
│  └─ Return exit code: 0/1/2
│
├─ IF exit 2: Block push ❌
│  └─ Output errors, user must fix
│
├─ IF exit 1: Warn ⚠️
│  └─ Output warnings (can override: GENIE_SKIP_WISH_CHECK=1)
│
├─ [SYNC] Update: CHANGELOG.md
│
└─ Exit 0 → Push proceeds ✅
```

**Time:** ~2-5 seconds (includes tests + validation)

---

## How to Use: Three Scenarios

### Scenario 1: Normal Commit

```bash
$ git commit -m "feat: new feature

wish: my-feature-slug"

🧞 Genie pre-commit validation

✅ User files validation passed
✅ Cross-references valid
Running Genie workflow: neurons/git/commit-advisory...
ℹ️  Workflow started (runs in background)

✅ All pre-commit validations passed
[main abc1234] feat: new feature
```

**Result:**
- Commit succeeds immediately
- Genie workflow runs in background
- Can check results later: `genie view <sessionId>`

---

### Scenario 2: Bug Fix Push

```bash
$ git commit -m "fix: button click broken

fixes #42"

$ git push

⚙️  Running tests...
✅ Tests passed
🔍 Commit advisory...

# Commit Advisory

## ✅ Passed
- Commit linked to GitHub issue #42

## ⚠️ Warnings (1)
1. Pushing to main branch directly

**Result:**
- ⚠️ Warnings only (not blocking)
- Can override: GENIE_ALLOW_MAIN_PUSH=1 git push
- Or create feature branch and retry
```

---

### Scenario 3: Untraced Commit (Blocked)

```bash
$ git commit -m "chore: update config"

✅ Commit succeeds (pre-commit is non-blocking)

$ git push

# Commit Advisory

## ❌ Blocking Issues (1)

1. Commit "chore: update config" not linked to wish or issue
   Fix: Add wish reference or GitHub issue link

**Result:**
- ❌ Push blocked
- Error: "Pre-push blocked - commit validation failed"
- Must fix: amend commit with wish/issue reference, then retry
```

---

## Output Extraction Mechanics

### How Parser Works

**Input:** JSONL log file

```jsonl
{"type":"session.created","session_id":"abc-123"}
{"type":"item.completed","item":{"item_type":"assistant_message","text":"# Advisory\n\n## ✅ Passed\n- Item 1\n\n## ⚠️ Warnings (1)\n1. Warning"}}
{"type":"turn.completed"}
```

**Process:**

```javascript
1. Find log file
   └─ Look up sessionId in .genie/state/agents/sessions.json
   └─ Get logFile path

2. Read JSONL events
   └─ Parse each line as JSON

3. Extract assistant_message
   └─ Find event.item.item_type === "assistant_message"
   └─ Get event.item.text (markdown)

4. Parse markdown with regex
   └─ /###\s*✅\s*Passed/    → Extract ✅ items
   └─ /###\s*⚠️\s*Warnings?\s*\((\d+)\)/  → Extract count
   └─ /###\s*❌\s*Issues?\s*\((\d+)\)/    → Extract count
   └─ /^\d+\.\s+(.+?)/gm     → Extract numbered items

5. Build JSON result
   {
     passed: ["item1", "item2"],
     warnings: ["warn1", "warn2"],
     errors: ["err1"],
     hasBlockingErrors: false,
     hasWarnings: true
   }

6. Determine exit code
   └─ hasBlockingErrors = 2
   └─ hasWarnings = 1
   └─ else = 0
```

---

## API Reference

### Direct Node Script (pre-push)

```javascript
const advisory = require('./.genie/scripts/commit-advisory.js');
// Runs analysis, outputs markdown, exits with 0/1/2
```

**Exit codes:**
- `0` = Pass (all validations OK)
- `1` = Warnings only
- `2` = Blocking errors (push blocked)

---

### Genie Workflow (pre-commit)

```bash
node .genie/cli/dist/genie-cli.js run "neurons/git/commit-advisory" "Pre-commit validation"
```

**Output:** JSONL log in `.genie/state/agents/logs/`

**Session ID:** Available in `.genie/state/agents/sessions.json`

---

### Parser CLI

```bash
# Extract validation structure
node .genie/scripts/genie-workflow-parser.js <sessionId> json

# Get exit code
node .genie/scripts/genie-workflow-parser.js <sessionId> exit-code

# Get markdown output
node .genie/scripts/genie-workflow-parser.js <sessionId> markdown

# Get summary
node .genie/scripts/genie-workflow-parser.js <sessionId> summary
```

---

### Parser Module

```javascript
const GenieworkflowParser = require('./.genie/scripts/genie-workflow-parser.js');

const parser = new GenieworkflowParser();
const results = parser.parseSession('abc-123', 'json');

console.log(results.validations.errors);    // ["error1", "error2"]
console.log(results.validations.warnings);  // ["warn1"]
console.log(results.exitCode);              // 1 or 2
```

---

## Configuration & Overrides

### Environment Variables

```bash
# Pre-commit
# (no env overrides currently)

# Pre-push
GENIE_ALLOW_MAIN_PUSH=1 git push
  └─ Skip main branch warning

GENIE_SKIP_WISH_CHECK=1 git push
  └─ Skip wish traceability validation

# Both
GENIE_ALLOW_MAIN_PUSH=1 GENIE_SKIP_WISH_CHECK=1 git push
  └─ Override all warnings, allow push
```

### Bypass Hook

```bash
git commit --no-verify
  └─ Skip pre-commit entirely

git push --no-verify
  └─ Skip pre-push entirely
```

---

## Session Persistence

### Session Store (V2 Format)

**File:** `.genie/state/agents/sessions.json`

```json
{
  "version": 2,
  "sessions": {
    "sessionId-1": {
      "agent": "neurons/git/commit-advisory",
      "sessionId": "sessionId-1",
      "executor": "claude",
      "model": "haiku",
      "logFile": ".genie/state/agents/logs/neurons-git-abc123.log",
      "startTime": "2025-10-18T07:00:00Z",
      "status": "completed"
    }
  }
}
```

### Querying Results Later

```bash
# Show all sessions
genie list-sessions

# View specific session
genie view abc-123

# Parse session output
node .genie/scripts/genie-workflow-parser.js abc-123 json
```

---

## Testing

### Test Commit Advisory (Pre-Push)

```bash
# Run directly to see output
node .genie/scripts/commit-advisory.js

# Expected output:
# # Pre-Push Commit Advisory
#
# **Branch:** main
# **Commits:** N
#
# ## Validation Results
# ...
#
# Exit code: 0/1/2
```

### Test Parser

```bash
# Find a recent session
genie list-sessions | grep neurons/git/commit-advisory

# Parse its output
node .genie/scripts/genie-workflow-parser.js <sessionId> validation

# Should return JSON with passed/warnings/errors
```

---

## Troubleshooting

### Pre-commit not running?

```bash
# Check it's executable
ls -la .git/hooks/pre-commit
# Should show: -rwxr-xr-x

# Make executable if needed
chmod +x .git/hooks/pre-commit
```

### Pre-push blocking unexpectedly?

```bash
# Check commit message has wish/issue reference
git log -1 --oneline

# Add reference if missing
git commit --amend -m "feat: description

wish: slug-name"

# Retry push
git push
```

### Genie workflow not starting?

```bash
# Check CLI is built
ls -la .genie/cli/dist/genie-cli.js

# If missing, rebuild
cd .genie/cli && npm run build

# Verify workflow file
cat .genie/agents/neurons/git/commit-advisory.md
```

---

## Next Steps

### Enhancements

- [ ] Add blocking mode to pre-commit (optional, synchronous Genie)
- [ ] Create `post-commit` hook to query results
- [ ] Add integration tests for hook workflows
- [ ] Create CLI commands: `genie commit-stats`, `genie trace <commit>`

### Documentation

- [x] Commit Advisory Guide
- [x] Genie Hook Integration Guide
- [x] Hook Output Extraction (visual)
- [ ] API Reference
- [ ] Troubleshooting Guide

---

## Summary

**Current State:**
- ✅ Pre-commit: Non-blocking local validation + background Genie workflow
- ✅ Pre-push: Blocking commit advisory + test validation
- ✅ Parser: Extract Genie workflow outputs to structured JSON
- ✅ Sessions: Persistent storage of workflow results

**Architecture:**
- Fast path: Direct Node.js scripts (pre-commit, pre-push blocking checks)
- Smart path: Genie workflows (background analysis, queryable results)
- Parser: Converts markdown output → JSON / exit codes

**Usage:**
- Every commit traced to wish or GitHub issue
- Every bug fix validated against GitHub issues
- Branch warnings to prevent main pushes
- Non-blocking intelligence + blocking validation

