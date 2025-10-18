# Genie Workflow Integration in Git Hooks
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**The Architecture:** How Genie agent outputs become git hook decisions

---

## The Problem We're Solving

Traditional git hooks run simple scripts. Genie workflows are **intelligent agents** that produce rich outputs. How do we:

1. **Start** a Genie workflow from a git hook?
2. **Capture** the workflow session?
3. **Parse** the output?
4. **Extract** validation results?
5. **Feed back** decisions to the hook?

This guide walks through the complete mechanics.

---

## Data Flow Architecture

```
┌─────────────┐
│  git commit │
└──────┬──────┘
       │
       ▼
┌─────────────────────────┐
│ .git/hooks/pre-commit   │ (Node.js orchestrator)
│                         │
│  1. Run local validations
│  2. Start Genie workflow ──────────────────┐
│  3. Wait for results                       │
│  4. Parse output                           │
│  5. Decide: block or allow                 │
└──────┬──────────────────────────────────────┤
       │                                      │
       │                    ┌─────────────────▼─────────────────┐
       │                    │ Genie CLI (background process)   │
       │                    │                                  │
       │                    │  1. Run agent: neurons/git/...   │
       │                    │  2. Execute workflow logic       │
       │                    │  3. Generate JSONL session log   │
       │                    │  4. Store in .genie/state/...   │
       │                    └──────────┬──────────────────────┘
       │                               │
       │                    ┌──────────▼──────────────┐
       │                    │ Session Log (JSONL)    │
       │                    │                        │
       │                    │ event1: {...}          │
       │                    │ event2: {...}          │
       │                    │ message: "✅ Passed"   │
       │                    │ turn.completed         │
       │                    └──────────┬─────────────┘
       │                               │
       │◄──────────────────────────────┤
       │ genie-workflow-parser.js
       │ (extracts validation structure)
       │
       ▼
┌──────────────────────────────┐
│ Hook Decision                │
│                              │
│ errors? → BLOCK (exit 1)     │
│ warnings? → WARN (exit 0)    │
│ pass? → ALLOW (exit 0)       │
└──────────────────────────────┘
```

---

## Step-by-Step: How It Works

### Step 1: Hook Invokes Genie

**File:** `.git/hooks/pre-commit`

```javascript
function runGenie(agent, prompt) {
  // Start workflow in background (non-blocking)
  const proc = spawn('node', [genieCliPath, 'run', agent, prompt], {
    stdio: 'ignore',
    detached: true  // ← Key: runs in background
  });
  proc.unref();  // ← Disconnect from parent process

  return { success: true, message: `Workflow ${agent} started` };
}

// In hook:
const workflow = runGenie('neurons/git/commit-advisory', 'Pre-commit validation');
```

**What happens:**
- Genie CLI starts in background
- Hook does NOT wait (returns immediately)
- Workflow runs independently
- Result stored in `.genie/state/agents/sessions.json` + log file

---

### Step 2: Genie Agent Runs & Logs

**File:** `.genie/agents/neurons/git/commit-advisory.md`

The Genie workflow executes and produces:

```markdown
# Pre-Push Commit Advisory

**Branch:** main
**Commits:** 2 new commit(s)

## Validation Results

### ✅ Passed
- Commit linked to wish

### ⚠️ Warnings (1)
1. Pushing to main directly

### ❌ Blocking Issues (0)
```

**Stored as:** JSONL log file with events
```json
{"type":"session.created","session_id":"abc-123-xyz"}
{"type":"item.started","item_type":"assistant_message"}
{"type":"item.completed","item":{"text":"# Pre-Push Commit Advisory...","item_type":"assistant_message"}}
{"type":"turn.completed","status":"success"}
```

---

### Step 3: Hook Calls Parser

**File:** `.genie/scripts/genie-workflow-parser.js`

```javascript
// Hook can extract results later:
const parser = new GenieworkflowParser();
const results = parser.parseSession(sessionId, 'json');

// Returns:
{
  "exitCode": 1,
  "validations": {
    "passed": ["Commit linked"],
    "warnings": ["Main branch push"],
    "errors": [],
    "hasBlockingErrors": false,
    "hasWarnings": true
  }
}
```

**Parser workflow:**

```
Input: sessionId
   ↓
Find log file (.genie/state/agents/logs/...)
   ↓
Read JSONL events
   ↓
Extract assistant_message items
   ↓
Parse markdown structure (## sections, emoji counts)
   ↓
Extract: passed[], warnings[], errors[]
   ↓
Determine exit code (0/1/2)
   ↓
Output: JSON / exit code / markdown
```

---

### Step 4: Parsing Markdown Output

The parser extracts validation structure from workflow markdown:

**Input markdown:**
```markdown
## ✅ Passed
- Rule 1 passed
- Rule 2 passed

## ⚠️ Warnings (2)
1. Warning 1
2. Warning 2

## ❌ Blocking Issues (1)
1. Error 1
```

**Parser regex patterns:**

```javascript
// Extract passed items
const passedMatch = fullText.match(/###\s*✅\s*Passed[\s\S]*?(?=###|$)/);
// → ["- Rule 1 passed", "- Rule 2 passed"]

// Extract warnings with count
const warningsMatch = fullText.match(/###\s*⚠️\s*Warnings?\s*\((\d+)\)/);
// → Groups: [1] = "2"

// Extract errors with count
const errorsMatch = fullText.match(/###\s*❌\s*(?:Blocking\s+)?Issues?\s*\((\d+)\)/);
// → Groups: [1] = "1"

// Extract items (numbered list)
const items = section.match(/^\d+\.\s+(.+?)(?=\n\d+\.|$)/gm);
// → ["1. Error 1", "2. Error 2"]
```

**Key insight:** Genie outputs **structured markdown** → Parser uses **regex patterns** → Extracts **numeric validation data** → Returns **machine-readable JSON**

---

### Step 5: Hook Makes Decision

```javascript
// After parsing:
if (summary.blocking) {
  // Exit code 2 = blocking errors
  log('red', '❌', 'Validation failed (blocking)');
  process.exit(1);  // Block commit
}

if (summary.warnings > 0) {
  log('yellow', '⚠️', 'Validation has warnings');
  process.exit(0);  // Allow commit with warning
}

// Exit code 0 = all pass
process.exit(0);
```

---

## Complete Example: Pre-Commit Hook

**Real flow:**

```bash
$ git commit -m "feat: new feature"

🧞 Genie pre-commit validation

✅ User files validation passed
✅ Cross-references valid
Running Genie workflow: neurons/git/commit-advisory...
ℹ️  Workflow neurons/git/commit-advisory started (runs in background)

✅ All pre-commit validations passed
[main abc1234] feat: new feature
 3 files changed, 45 insertions(+)
```

**What happened behind the scenes:**

1. Hook ran synchronously: user file checks, ref validation
2. Hook fired off Genie workflow in background (didn't wait)
3. Genie started running independently
4. Hook returned immediately (commit succeeded)
5. Genie logged output to `.genie/state/agents/logs/`
6. Later, hook (or user) can query: `genie view <session-id>`

---

## Two Patterns: Blocking vs Non-Blocking

### Pattern A: Non-Blocking (Current Pre-Commit)

**File:** `.git/hooks/pre-commit`

```javascript
// Start workflow, don't wait
const proc = spawn('node', [genieCliPath, 'run', agent, prompt], {
  stdio: 'ignore',
  detached: true  // ← Non-blocking
});
proc.unref();

// Commit proceeds immediately
process.exit(0);
```

**Pros:**
- ✅ Fast commit (no waiting)
- ✅ Workflow continues in background
- ✅ Results available later via `genie view`

**Cons:**
- ❌ Issues found AFTER commit pushed
- ❌ No real-time feedback

---

### Pattern B: Blocking (Future Pre-Push)

**File:** `.git/hooks/pre-push`

```javascript
// Start workflow, WAIT for results
const output = spawnSync('node', [genieCliPath, 'run', agent, prompt], {
  timeout: 30000  // ← Blocking, max 30s
});

// Extract session ID from output
const sessionId = output.stdout.match(/Session ID: ([a-f0-9-]+)/)[1];

// Wait for completion
const result = parser.parseSession(sessionId, 'validation');

if (result.errors.length > 0) {
  process.exit(1);  // Block push
}
```

**Pros:**
- ✅ Catches issues before push
- ✅ Real-time validation
- ✅ User can fix immediately

**Cons:**
- ❌ Slower push (30s timeout)
- ❌ Must wait for workflow

---

## Using Parser from Scripts

### CLI Usage

```bash
# Extract as JSON
node .genie/scripts/genie-workflow-parser.js <sessionId> json

# Get exit code only
node .genie/scripts/genie-workflow-parser.js <sessionId> exit-code
echo $?  # 0 = pass, 1 = warnings, 2 = errors

# Get markdown output
node .genie/scripts/genie-workflow-parser.js <sessionId> markdown

# Get validation summary
node .genie/scripts/genie-workflow-parser.js <sessionId> summary
```

### Module Usage

```javascript
const GenieworkflowParser = require('./.genie/scripts/genie-workflow-parser.js');

const parser = new GenieworkflowParser();
const results = parser.parseSession('abc-123', 'json');

console.log(results.validations.errors);
console.log(results.validations.warnings);
```

---

## Session State & Sessions.json

**Location:** `.genie/state/agents/sessions.json`

**Format (V2):**
```json
{
  "version": 2,
  "sessions": {
    "sessionId-1": {
      "agent": "neurons/git/commit-advisory",
      "sessionId": "abc-123-xyz",
      "executor": "claude",
      "logFile": ".genie/state/agents/logs/neurons-git-commit-advisory-abc-123.log",
      "startTime": "2025-10-18T07:00:00Z",
      "status": "completed"
    }
  }
}
```

**Parser uses this to:**
1. Find log file for sessionId
2. Read JSONL events
3. Extract validation structure
4. Return parsed results

---

## Workflow Output Standards

For parsers to work, Genie workflows should output structured markdown:

```markdown
# [Title]

## Context
[Key info]

## Validation Results

### ✅ Passed
- Item 1
- Item 2

### ⚠️ Warnings ({count})
1. Warning 1
2. Warning 2

### ❌ Blocking Issues ({count})
1. Error 1
2. Error 2

**Generated:** {timestamp}
```

**Parser expects:**
- `## Validation Results` section
- `### ✅ Passed` with bullet list
- `### ⚠️ Warnings (N)` with count and numbered list
- `### ❌ Blocking Issues (N)` with count and numbered list

---

## Extending the Parser

**Add new format:**

```javascript
case 'custom':
  return this.validations.errors.map(e => `ERR: ${e}`).join('\n');
```

**Add new extraction pattern:**

```javascript
extractTestCoverage(fullText) {
  const match = fullText.match(/Coverage:\s+(\d+)%/);
  return match ? parseInt(match[1]) : 0;
}
```

---

## Summary

**Key Mechanics:**

| Component | Purpose |
|-----------|---------|
| **Hook** | Orchestrates validations, starts Genie workflow |
| **Genie Agent** | Runs workflow logic, produces JSONL log |
| **Session Store** | Tracks agent metadata (V2 format) |
| **Log File** | JSONL events with structured markdown output |
| **Parser** | Extracts validation structure from markdown |
| **Decision Logic** | Hook uses parsed results to block/allow |

**Patterns:**

- **Non-blocking:** Start workflow, return immediately (pre-commit)
- **Blocking:** Wait for workflow, parse results, decide (pre-push)

**Data Format:**

- **Output:** Markdown with emoji-based sections (`✅ / ⚠️ / ❌`)
- **Parser:** Regex extraction of sections, item counts, lists
- **Result:** JSON with `passed[]`, `warnings[]`, `errors[]`, `exitCode`

