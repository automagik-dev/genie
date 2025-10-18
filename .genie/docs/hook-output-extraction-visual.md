# Genie Hook Integration: Visual Reference

**Quick diagram of how Genie workflow outputs flow into git hooks**

---

## The Complete Data Pipeline

```
┌────────────────────────────────────────────────────────────────────┐
│ USER RUNS: git commit                                              │
└───────────────┬────────────────────────────────────────────────────┘
                │
                ▼
┌────────────────────────────────────────────────────────────────────┐
│ .git/hooks/pre-commit (Node.js script)                             │
│                                                                    │
│  1️⃣ Run validate-user-files-not-committed.js                       │
│     └─ Check no .env, .genie/TODO.md in staged files               │
│                                                                    │
│  2️⃣ Run validate-cross-references.js                               │
│     └─ Check all @file.md references exist                         │
│                                                                    │
│  3️⃣ SPAWN Genie workflow (background, non-blocking)                │
│     │                                                              │
│     ├─ spawn('node', [                                            │
│     │   '.genie/cli/dist/genie-cli.js',                           │
│     │   'run',                                                    │
│     │   'neurons/git/commit-advisory',                            │
│     │   'Pre-commit validation'                                   │
│     │ ], { detached: true })  ← KEY: non-blocking                │
│     │                                                              │
│     └─ proc.unref()  ← Disconnect from parent                     │
│                                                                    │
│  ✅ Hook exits(0) → Commit proceeds immediately                   │
└────────────────┬────────────────────────────────────────────────────┘
                 │
                 ▼ (commit succeeds)
        ┌────────────────────┐
        │ Commit created ✅  │
        └────────────────────┘
                 │
                 │ (parallel)
                 │
                 ▼
┌────────────────────────────────────────────────────────────────────┐
│ Genie Workflow (background process)                                │
│                                                                    │
│  genie-cli.js run neurons/git/commit-advisory                      │
│  │                                                                 │
│  ├─ Load workflow: .genie/agents/neurons/git/commit-advisory.md   │
│  │                                                                 │
│  ├─ Execute Haiku agent (Claude model)                            │
│  │  └─ Analyze: commits, wishes, GitHub issues, branch           │
│  │                                                                 │
│  ├─ Generate structured output:                                   │
│  │                                                                 │
│  │  ```markdown                                                  │
│  │  # Commit Advisory                                            │
│  │                                                                 │
│  │  ## ✅ Passed                                                  │
│  │  - Commit linked to wish                                       │
│  │                                                                 │
│  │  ## ⚠️ Warnings (1)                                            │
│  │  1. Pushing to main branch                                     │
│  │                                                                 │
│  │  ## ❌ Blocking Issues (0)                                     │
│  │  ```                                                           │
│  │                                                                 │
│  └─ Store in JSONL log file                                       │
│     └─ .genie/state/agents/logs/neurons-git-abc123.log            │
│        {type: "session.created", session_id: "abc-123"}           │
│        {type: "item.completed", item: {text: "# Commit..."}}      │
│        {type: "turn.completed", status: "success"}                │
│                                                                    │
│  └─ Update session store                                          │
│     └─ .genie/state/agents/sessions.json                          │
│        {                                                          │
│          "abc-123": {                                             │
│            agent: "neurons/git/commit-advisory",                  │
│            logFile: ".genie/state/agents/logs/...",               │
│            status: "completed"                                    │
│          }                                                         │
│        }                                                           │
└────────────────────────────────────────────────────────────────────┘
                 │
                 │ (user can query results later)
                 ▼
┌────────────────────────────────────────────────────────────────────┐
│ USER QUERIES RESULTS (optional, async)                             │
│                                                                    │
│ $ genie view abc-123                                               │
│ $ node .genie/scripts/genie-workflow-parser.js abc-123 json        │
│                                                                    │
│ ┌──────────────────────────────────────────────────────────────┐  │
│ │ Parser: genie-workflow-parser.js                            │  │
│ │                                                              │  │
│ │ 1. Find session in sessions.json                            │  │
│ │    └─ Get logFile path                                       │  │
│ │                                                              │  │
│ │ 2. Read .genie/state/agents/logs/...log                      │  │
│ │    └─ Parse JSONL events                                     │  │
│ │                                                              │  │
│ │ 3. Extract markdown from events                             │  │
│ │    └─ Find item.completed with type: "assistant_message"    │  │
│ │                                                              │  │
│ │ 4. Parse markdown structure with regex:                     │  │
│ │                                                              │  │
│ │    passedMatch = /###\s*✅\s*Passed[\s\S]*?(?=###|$)/        │  │
│ │    warningMatch = /###\s*⚠️\s*Warnings?\s*\((\d+)\)/         │  │
│ │    errorMatch = /###\s*❌\s*Issues?\s*\((\d+)\)/             │  │
│ │    itemMatch = /^\d+\.\s+(.+?)(?=\n\d+\.|$)/gm              │  │
│ │                                                              │  │
│ │ 5. Extract arrays: passed[], warnings[], errors[]           │  │
│ │                                                              │  │
│ │ 6. Determine exit code:                                      │  │
│ │    0 = no blocking errors                                   │  │
│ │    1 = warnings only                                        │  │
│ │    2 = blocking errors                                      │  │
│ │                                                              │  │
│ │ 7. Return structured JSON:                                  │  │
│ │    {                                                         │  │
│ │      "exitCode": 1,                                          │  │
│ │      "validations": {                                        │  │
│ │        "passed": ["Commit linked"],                          │  │
│ │        "warnings": ["Main branch push"],                     │  │
│ │        "errors": [],                                         │  │
│ │        "hasBlockingErrors": false,                           │  │
│ │        "hasWarnings": true                                   │  │
│ │      }                                                        │  │
│ │    }                                                          │  │
│ └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
                 │
                 ▼
        ┌────────────────────┐
        │ Structured Data    │
        │ (JSON / exit code) │
        │ Ready for use      │
        └────────────────────┘
```

---

## Files Involved

```
.git/hooks/
├── pre-commit                              ← Hook orchestrator
│   ├─ Runs: validate-user-files-not-committed.js
│   ├─ Runs: validate-cross-references.js
│   └─ SPAWNS: genie run neurons/git/commit-advisory
│
└── pre-push
    ├─ Runs: tests (pnpm run test:all)
    ├─ Runs: commit-advisory.js (direct Node script)
    └─ Updates: CHANGELOG.md

.genie/
├── agents/neurons/git/
│   └── commit-advisory.md                  ← Genie workflow definition
│
├── scripts/
│   ├── commit-advisory.js                  ← Direct validation (pre-push)
│   ├── validate-user-files-not-committed.js
│   ├── validate-cross-references.js
│   └── genie-workflow-parser.js            ← Output extractor
│
├── state/agents/
│   ├── sessions.json                       ← Session metadata (V2 format)
│   └── logs/
│       └── neurons-git-*.log               ← JSONL output files
│
└── docs/
    ├── commit-advisory-guide.md
    ├── genie-hook-integration.md           ← Full technical docs
    └── hook-output-extraction-visual.md    ← This file
```

---

## Two Hook Scenarios

### Scenario 1: Pre-Commit (Non-Blocking)

```
git commit
  │
  ├─ Sync validation: user files, refs ← BLOCK if fails
  │
  ├─ SPAWN Genie workflow (background)
  │  └─ Returns immediately
  │
  └─ ✅ Commit succeeds
     │
     └─ Workflow runs in background
        Results available later
```

**Command:** `genie view <sessionId>`

---

### Scenario 2: Pre-Push (Blocking)

```
git push
  │
  ├─ Run tests (pnpm run test:all) ← BLOCK if fails
  │
  ├─ RUN commit-advisory.js ← Direct Node script, waits
  │  └─ Returns exit code 0/1/2
  │
  ├─ IF exit 2: BLOCK push ❌
  │  └─ Output errors
  │
  ├─ IF exit 1: WARN (can override)
  │  └─ Output warnings
  │
  └─ IF exit 0: ALLOW ✅
     └─ Push proceeds
```

**Key difference:** Pre-push uses **direct Node.js script**, pre-commit uses **Genie workflow**.

---

## The Parser: Regex Extraction

**Input:** Markdown output from Genie agent

```markdown
# Pre-Push Commit Advisory

## Validation Results

### ✅ Passed
- Commit linked to wish #42
- Files aligned with scope

### ⚠️ Warnings (1)
1. Pushing to main branch
   Suggestion: Use feature branch

### ❌ Blocking Issues (0)
```

**Parser Logic:**

```javascript
// 1. Extract passed items
matches = /###\s*✅\s*Passed[\s\S]*?(?=###|$)/
         .match(/[-*]\s+(.+)/g)
result.passed = ["Commit linked to wish #42", "Files aligned with scope"]

// 2. Extract warning count
matches = /###\s*⚠️\s*Warnings?\s*\((\d+)\)/
count = parseInt(matches[1])  // "1"
result.hasWarnings = true

// 3. Extract error count
matches = /###\s*❌\s*Issues?\s*\((\d+)\)/
count = parseInt(matches[1])  // "0"
result.hasBlockingErrors = false

// 4. Determine exit code
if (hasBlockingErrors) exitCode = 2;
else if (hasWarnings) exitCode = 1;
else exitCode = 0;
```

---

## Session Store Format (V2)

**.genie/state/agents/sessions.json**

```json
{
  "version": 2,
  "sessions": {
    "abc-123-xyz": {
      "agent": "neurons/git/commit-advisory",
      "sessionId": "abc-123-xyz",
      "executor": "claude",
      "model": "haiku",
      "logFile": ".genie/state/agents/logs/neurons-git-commit-advisory-abc123.log",
      "startTime": "2025-10-18T07:15:30.000Z",
      "status": "completed"
    },
    "def-456-uvw": {
      "agent": "neurons/git/commit-advisory",
      "sessionId": "def-456-uvw",
      "executor": "claude",
      "model": "haiku",
      "logFile": ".genie/state/agents/logs/neurons-git-commit-advisory-def456.log",
      "startTime": "2025-10-18T07:20:15.000Z",
      "status": "completed"
    }
  }
}
```

**Parser uses:**
```javascript
// Find log file for session
const entry = Object.values(sessions).find(s => s.sessionId === 'abc-123-xyz');
const logPath = entry.logFile;  // ".genie/state/agents/logs/neurons-git-..."

// Read log file
const content = fs.readFileSync(logPath, 'utf8');
```

---

## Event Flow in JSONL Log

**.genie/state/agents/logs/neurons-git-commit-advisory-abc123.log**

```jsonl
{"type":"session.created","session_id":"abc-123-xyz","timestamp":"2025-10-18T07:15:30.000Z"}
{"type":"turn.started","turn_id":"turn_1"}
{"type":"item.started","item_id":"item_0","item_type":"user_message"}
{"type":"item.completed","item":{"id":"item_0","item_type":"user_message","text":"Pre-commit validation"}}
{"type":"item.started","item_id":"item_1","item_type":"assistant_message"}
{"type":"item.completed","item":{"id":"item_1","item_type":"assistant_message","text":"# Commit Advisory\n\n## ✅ Passed\n- Commit linked\n\n## ⚠️ Warnings (1)\n1. Main branch\n\n## ❌ Blocking Issues (0)"}}
{"type":"turn.completed","turn_id":"turn_1","status":"success"}
```

**Parser extracts:**
```javascript
// Find assistant_message items
const messages = events
  .filter(e => e.type === 'item.completed' && e.item.item_type === 'assistant_message')
  .map(e => e.item.text);

// Combine into full text
const fullText = messages.join('\n');
// Result: "# Commit Advisory\n\n## ✅ Passed\n..."
```

---

## Usage Examples

### As CLI Tool

```bash
# Extract validation structure
node .genie/scripts/genie-workflow-parser.js abc-123 validation

# Get just the exit code
node .genie/scripts/genie-workflow-parser.js abc-123 exit-code
echo $?  # 0, 1, or 2

# Get markdown output
node .genie/scripts/genie-workflow-parser.js abc-123 markdown

# Get summary
node .genie/scripts/genie-workflow-parser.js abc-123 summary
# Output: {"exitCode": 1, "passed": 2, "warnings": 1, "errors": 0}
```

### From Hook Script

```javascript
const GenieworkflowParser = require('./.genie/scripts/genie-workflow-parser.js');

const parser = new GenieworkflowParser();

// Parse existing session
const results = parser.parseSession(sessionId, 'json');

if (results.validations.hasBlockingErrors) {
  console.log('❌ Blocking errors found:');
  results.validations.errors.forEach(err => console.log('  - ' + err));
  process.exit(1);
}
```

---

## Key Design Principles

✅ **Structured Output:** Genie workflows produce emoji-based markdown
✅ **Regex Extraction:** Parser uses patterns, not LLM, for speed
✅ **Non-Blocking Default:** Pre-commit doesn't block on Genie
✅ **Queryable Results:** Sessions persist, results available later
✅ **Modular:** Same parser works for multiple workflow types
✅ **Deterministic:** Exit codes (0/1/2) drive hook decisions

