# Filesystem Restrictions Audit Report
**Discovery ID:** #120-A.1
**Parent Wish:** #120-A (Forge Drop-In Replacement)
**Date:** 2025-10-18
**Status:** ✅ COMPLETE
**Severity:** 🟢 LOW RISK (Minimal violations found)

---

## 📊 Executive Summary

**Total Violations Found:** 3 CRITICAL, 0 MEDIUM, 1 LOW

### Severity Classification

- **🔴 CRITICAL (3):** Direct filesystem access that MUST be replaced with Forge API
  - `view.ts`: Log file reading (2 instances)
  - `resume.ts`: Session file existence check (1 instance)

- **🟡 MEDIUM (0):** None found

- **🟢 LOW (1):** Informational only, not a violation
  - `forge-executor.ts`: Hardcoded worktree path (display only, no filesystem access)

### High-Level Recommendations

1. **IMMEDIATE ACTION:** Replace all `view.ts` filesystem operations with Forge API calls
2. **IMMEDIATE ACTION:** Replace `resume.ts` orphaned session detection with Forge API
3. **PREVENTION:** Implement pre-commit hook to block future violations
4. **VALIDATION:** Add CI check to ensure zero violations remain

**Good News:** The CLI architecture is already well-designed for Forge integration:
- No violations in `run.ts`, `stop.ts`, or `list.ts`
- Session store operates on metadata only (no worktree access)
- All agent file operations are local `.genie/agents/` only (not Forge worktrees)

---

## 🔍 Detailed Findings

### File: `.genie/cli/src/cli-core/handlers/view.ts`

**Violations Found:** 2 CRITICAL

---

#### Violation #1: Orphaned Session File Reading

**Location:** Lines 37-48
**Severity:** 🔴 CRITICAL

**Current Code:**
```typescript
const sessionFilePath = executor.tryLocateSessionFileBySessionId(sessionId, sessionsDir);
if (sessionFilePath && fs.existsSync(sessionFilePath)) {
  orphanedSession = true;
  const sessionFileContent = fs.readFileSync(sessionFilePath, 'utf8');

  return {
    sessionId,
    agent: 'unknown',
    status: 'orphaned',
    transcript: sessionFileContent,
    source: 'orphaned session file',
    filePath: sessionFilePath
  };
}
```

**Worktree Path Used:**
Via `executor.tryLocateSessionFileBySessionId()` → `${sessionsDir}/${sessionId}.json`
Where `sessionsDir` is executor-specific and may point to Forge worktree

**Forge API Replacement:** `getTaskAttempt(sessionId)` + `getTaskAttemptLogs(sessionId)`

**Fixed Implementation:**
```typescript
// AFTER (FORGE API) - No filesystem access
try {
  const attempt = await forgeClient.getTaskAttempt(sessionId);
  const logs = await forgeClient.getTaskAttemptLogs(sessionId);

  return {
    sessionId,
    agent: 'unknown', // TODO: Extract from attempt metadata
    status: 'orphaned',
    transcript: logs,
    source: 'forge task attempt',
    forgeAttemptId: attempt.id
  };
} catch (error) {
  throw new Error(`❌ No run found with session id '${sessionId}'`);
}
```

---

#### Violation #2: Session File Reading for Full Transcript

**Location:** Lines 82-95
**Severity:** 🔴 CRITICAL

**Current Code:**
```typescript
const sessionFilePath = executor.locateSessionFile({
  sessionId: entry.sessionId,
  startTime,
  sessionsDir
});

if (sessionFilePath && fs.existsSync(sessionFilePath)) {
  try {
    sessionFileContent = fs.readFileSync(sessionFilePath, 'utf8');
  } catch {
    // Fall back to CLI log if session file read fails
  }
}

const transcript = sessionFileContent || raw;
```

**Worktree Path Used:**
Via `executor.locateSessionFile()` → computed path in Forge worktree

**Forge API Replacement:** `getTaskAttemptLogs(sessionId)`

**Fixed Implementation:**
```typescript
// AFTER (FORGE API) - No filesystem access
let transcript = raw; // Fallback to CLI log

try {
  // Always prefer Forge logs over CLI logs (source of truth)
  transcript = await forgeClient.getTaskAttemptLogs(entry.sessionId);
} catch (error) {
  // Fallback to CLI log file if Forge API fails
  console.warn(`Failed to fetch Forge logs for ${entry.sessionId}, using CLI log`);
}

return {
  sessionId: entry.sessionId || sessionId,
  agent: agentName,
  status: entry.status || 'unknown',
  transcript,
  source: transcript === raw ? 'CLI log' : 'forge task attempt',
  mode: entry.mode || entry.preset,
  created: entry.created,
  lastUsed: entry.lastUsed,
  logFile
};
```

---

### File: `.genie/cli/src/cli-core/handlers/resume.ts`

**Violations Found:** 1 CRITICAL

---

#### Violation #3: Orphaned Session File Detection

**Location:** Lines 50-51
**Severity:** 🔴 CRITICAL

**Current Code:**
```typescript
const sessionFilePath = executor.tryLocateSessionFileBySessionId(sessionIdArg, sessionsDir);
if (sessionFilePath && fs.existsSync(sessionFilePath)) {
  throw new Error(
    `❌ Session '${sessionIdArg}' is not tracked in CLI state.\n\n` +
    `Session file exists at:\n  ${sessionFilePath}\n\n` +
    `This session cannot be resumed because CLI tracking information is missing.\n` +
    // ... error message
  );
}
```

**Worktree Path Used:**
Via `executor.tryLocateSessionFileBySessionId()` → `${sessionsDir}/${sessionId}.json`

**Forge API Replacement:** `getTaskAttempt(sessionId)`

**Fixed Implementation:**
```typescript
// AFTER (FORGE API) - No filesystem access
try {
  const attempt = await forgeClient.getTaskAttempt(sessionIdArg);

  // Session exists in Forge but not in CLI state
  throw new Error(
    `❌ Session '${sessionIdArg}' is not tracked in CLI state.\n\n` +
    `Forge task attempt exists: ${attempt.id}\n` +
    `Status: ${attempt.status}\n\n` +
    `This session cannot be resumed because CLI tracking information is missing.\n` +
    `This may happen if sessions.json was corrupted or deleted.\n\n` +
    `Options:\n` +
    `  1. View the session: npx automagik-genie view ${sessionIdArg}\n` +
    `  2. Start a new session: npx automagik-genie run <agent> "<prompt>"\n` +
    `  3. (Advanced) Manually restore sessions.json entry`
  );
} catch (error) {
  // Session doesn't exist in Forge either
  throw new Error(`❌ No run found with session id '${sessionIdArg}'`);
}
```

---

### File: `.genie/cli/src/lib/forge-executor.ts`

**Violations Found:** 0 (Informational only)

---

#### Informational: Display-Only Worktree Path

**Location:** Lines 242-245
**Severity:** 🟢 LOW (Not a violation)

**Code:**
```typescript
private getWorktreePath(attemptId: string): string {
  // Forge uses: /var/tmp/automagik-forge/worktrees/{prefix}-{slug}
  // For now, return placeholder (will be populated by Forge backend)
  return `/var/tmp/automagik-forge/worktrees/${attemptId}`;
}
```

**Analysis:**
This is **NOT a violation** because:
1. ✅ No filesystem access (`fs.readFileSync`, `fs.existsSync`, etc.)
2. ✅ Return value used for display only (`process.stdout.write`)
3. ✅ Comment explicitly states "placeholder (will be populated by Forge backend)"
4. ✅ No file operations performed on this path

**Recommendation:**
Replace with Forge API call to get actual worktree path:

```typescript
private async getWorktreePath(attemptId: string): Promise<string> {
  const attempt = await this.forge.getTaskAttempt(attemptId);
  return attempt.worktree_path || `/var/tmp/automagik-forge/worktrees/${attemptId}`;
}
```

---

### File: `.genie/cli/src/lib/session-helpers.ts`

**Violations Found:** 0

**Analysis:**
All filesystem operations in this file are on **CLI log files**, not Forge worktrees:

```typescript
// Line 82-84: Reading CLI logs to extract session ID (SAFE)
const logFile = entry.logFile;  // CLI-managed log file
if (!logFile || !fs.existsSync(logFile)) continue;
const content = fs.readFileSync(logFile, 'utf8');
```

**Why this is SAFE:**
- `entry.logFile` points to `.genie/state/agents/logs/{agent}-{timestamp}.log`
- This is CLI-managed state, not Forge worktree
- No risk of race conditions with Forge

---

### File: `.genie/cli/src/session-store.ts`

**Violations Found:** 0

**Analysis:**
All operations are on `sessions.json` file (CLI state):

```typescript
// Line 86: Reading CLI sessions.json (SAFE)
const content = fs.readFileSync(filePath, 'utf8');

// Line 82: Writing CLI sessions.json (SAFE)
fs.writeFileSync(paths.sessionsFile, payload);
```

**Why this is SAFE:**
- Only accesses `paths.sessionsFile` → `.genie/state/agents/sessions.json`
- This is CLI-managed metadata, not Forge worktree
- No overlap with Forge filesystem

---

### File: `.genie/cli/src/cli-core/handlers/shared.ts`

**Violations Found:** 0

**Analysis:**
All filesystem operations are on **local `.genie/agents/`** directory:

```typescript
// Line 213: Reading agent definitions (SAFE)
const baseDir = '.genie/agents';
if (!fs.existsSync(baseDir)) return records;

// Line 225: Reading agent .md files (SAFE)
const content = fs.readFileSync(entryPath, 'utf8');

// Line 252: Loading agent spec (SAFE)
const agentPath = path.join('.genie', 'agents', `${base}.md`);
if (!fs.existsSync(agentPath)) { ... }
```

**Why this is SAFE:**
- Only reads from `.genie/agents/` directory (local project files)
- No interaction with Forge worktrees
- Agent definitions are project-specific, not task-specific

---

## 📋 Forge API Replacement Reference

Complete mapping table of all violations → API calls:

| File | Line | Violation | Forge API Call | Input | Output |
|------|------|-----------|---------------|-------|--------|
| `view.ts` | 37-39 | `fs.readFileSync(sessionFilePath)` | `getTaskAttemptLogs(sessionId)` | `sessionId: string` | `logs: string` |
| `view.ts` | 82-90 | `fs.readFileSync(sessionFilePath)` | `getTaskAttemptLogs(sessionId)` | `sessionId: string` | `logs: string` |
| `resume.ts` | 50-51 | `fs.existsSync(sessionFilePath)` | `getTaskAttempt(sessionId)` | `sessionId: string` | `attempt: TaskAttempt` |

### Forge API Reference

**Get Task Attempt:**
```typescript
interface TaskAttempt {
  id: string;
  task_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'stopped';
  executor_profile_id: string;
  base_branch: string;
  worktree_path: string;
  branch_name: string;
  created_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
  error_message?: string;
}

// Usage
const attempt = await forgeClient.getTaskAttempt(sessionId);
```

**Get Task Attempt Logs:**
```typescript
// Returns full log stream as string
const logs = await forgeClient.getTaskAttemptLogs(sessionId);
```

---

## 🛡️ Pre-Commit Hook Implementation

### Script: `.genie/scripts/prevent-worktree-access.sh`

```bash
#!/bin/bash
# Prevent direct Forge worktree filesystem access
# Installed as pre-commit hook

set -e

echo "🔍 Checking for forbidden Forge worktree access..."

# Forbidden patterns
PATTERNS=(
  # Hardcoded worktree paths
  "/var/tmp/automagik-forge/worktrees/"

  # Filesystem operations on worktree-related paths
  "fs\.readFileSync.*worktree"
  "fs\.writeFileSync.*worktree"
  "fs\.existsSync.*worktree"
  "fs\.mkdirSync.*worktree"
  "fs\.rmdirSync.*worktree"
  "fs\.unlinkSync.*worktree"

  # Session file operations (executor-specific)
  "locateSessionFile"
  "tryLocateSessionFileBySessionId"
)

# Scan staged files in .genie/cli/src/
VIOLATIONS=0

for pattern in "${PATTERNS[@]}"; do
  # Search in staged files only
  if git diff --cached --name-only | grep "^\.genie/cli/src/" | xargs -I {} git diff --cached {} | grep -qE "$pattern"; then
    echo "❌ BLOCKED: Direct worktree access detected"
    echo "   Pattern: $pattern"
    echo "   File(s):"
    git diff --cached --name-only | grep "^\.genie/cli/src/" | xargs -I {} sh -c "git diff --cached {} | grep -l '$pattern' && echo '   - {}'" || true
    echo ""
    echo "   Use Forge API instead:"
    echo "   - getTaskAttempt(sessionId)"
    echo "   - getTaskAttemptLogs(sessionId)"
    echo "   - followUpTaskAttempt(sessionId, prompt)"
    echo ""
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
done

if [ $VIOLATIONS -gt 0 ]; then
  echo ""
  echo "🚫 Commit blocked: $VIOLATIONS violation(s) found"
  echo ""
  echo "Fix violations or bypass with: git commit --no-verify"
  exit 1
fi

echo "✅ No worktree access violations detected"
exit 0
```

### Installation Instructions

```bash
# 1. Make script executable
chmod +x .genie/scripts/prevent-worktree-access.sh

# 2. Install as pre-commit hook
ln -sf ../../.genie/scripts/prevent-worktree-access.sh .git/hooks/pre-commit

# 3. Test the hook
git add .genie/cli/src/cli-core/handlers/view.ts
git commit -m "test: should be blocked by hook"
# Expected: Hook should block commit and show violations
```

### Bypass (Emergency Use Only)

```bash
# If you absolutely need to commit (document why!)
git commit --no-verify -m "fix: worktree access violation (see #120-A.1)"
```

---

## ✅ Validation Commands

### Search for Forbidden Patterns

```bash
# 1. Search for hardcoded worktree paths
grep -r "/var/tmp/automagik-forge/worktrees" .genie/cli/src/
# Expected: Only forge-executor.ts (display-only, not a violation)

# 2. Search for filesystem operations on worktree-related variables
grep -rE "fs\.(readFileSync|writeFileSync|existsSync).*worktree" .genie/cli/src/
# Expected: No results after fixes applied

# 3. Search for session file operations (executor-specific)
grep -rE "(locateSessionFile|tryLocateSessionFileBySessionId)" .genie/cli/src/
# Expected: Only executor interface definitions, no usage in handlers

# 4. Comprehensive violation check
.genie/scripts/prevent-worktree-access.sh
# Expected: ✅ No worktree access violations detected
```

### Integration with CI

Add to `.github/workflows/ci.yml`:

```yaml
- name: Check for Forge worktree violations
  run: |
    chmod +x .genie/scripts/prevent-worktree-access.sh
    .genie/scripts/prevent-worktree-access.sh
```

---

## ✅ Success Criteria Checklist

- [x] All CLI handlers audited (`run.ts`, `resume.ts`, `view.ts`, `stop.ts`, `list.ts`)
- [x] All library code audited (`session-store.ts`, `session-helpers.ts`, `forge-executor.ts`)
- [x] All violations identified and documented (3 CRITICAL)
- [x] Forge API replacements mapped for each violation
- [x] Pre-commit hook script created
- [x] Validation commands provided
- [x] Report published to `.genie/discovery/filesystem-restrictions-audit.md`

**Implementation Status:** ⏳ READY FOR IMPLEMENTATION

---

## 🎯 Next Steps (Implementation Phase)

### Step 1: Update `view.ts` Handler

**File:** `.genie/cli/src/cli-core/handlers/view.ts`

**Changes:**
1. Import ForgeClient
2. Replace orphaned session file reading (lines 37-48) with `getTaskAttemptLogs()`
3. Replace session file reading (lines 82-95) with `getTaskAttemptLogs()`
4. Remove dependency on `executor.tryLocateSessionFileBySessionId()`
5. Remove dependency on `executor.locateSessionFile()`

**Test:**
```bash
# Test viewing Forge-managed session
npx automagik-genie view <forge-session-id>

# Test viewing orphaned session
npx automagik-genie view <orphaned-session-id>
```

---

### Step 2: Update `resume.ts` Handler

**File:** `.genie/cli/src/cli-core/handlers/resume.ts`

**Changes:**
1. Import ForgeClient
2. Replace orphaned session detection (lines 50-51) with `getTaskAttempt()`
3. Remove dependency on `executor.tryLocateSessionFileBySessionId()`

**Test:**
```bash
# Test resuming Forge-managed session
npx automagik-genie resume <forge-session-id> "Continue the conversation"

# Test resuming orphaned session (should fail gracefully)
npx automagik-genie resume <orphaned-session-id> "Test"
```

---

### Step 3: Install Pre-Commit Hook

```bash
chmod +x .genie/scripts/prevent-worktree-access.sh
ln -sf ../../.genie/scripts/prevent-worktree-access.sh .git/hooks/pre-commit
```

**Test:**
```bash
# Should block commits with violations
git add .genie/cli/src/cli-core/handlers/view.ts
git commit -m "test: intentional violation"
# Expected: ❌ Commit blocked
```

---

### Step 4: Add CI Validation

**File:** `.github/workflows/ci.yml`

Add check to CI pipeline to prevent violations from being merged.

---

### Step 5: Final Validation

```bash
# Run all validation commands (should pass)
grep -r "/var/tmp/automagik-forge/worktrees" .genie/cli/src/
grep -rE "fs\.(readFileSync|writeFileSync|existsSync).*worktree" .genie/cli/src/
grep -rE "(locateSessionFile|tryLocateSessionFileBySessionId)" .genie/cli/src/
.genie/scripts/prevent-worktree-access.sh
```

**Expected:** Zero violations

---

## 📚 Reference Documents

- **Wish #120-A:** `.genie/wishes/wish-120-a-forge-drop-in-replacement/wish-120-a-forge-drop-in-replacement.md`
- **Endpoint Mapping:** `.genie/docs/forge-endpoint-mapping.md`
- **Forge Client:** `forge/index.ts` (ForgeClient class)
- **Task Attempt Schema:** See Forge API documentation

---

## 🎓 Key Learnings

### What Went Well

1. **Clean Architecture:** Most handlers already avoid Forge worktree access
2. **Minimal Surface Area:** Only 2 files have violations (`view.ts`, `resume.ts`)
3. **Clear Separation:** CLI state (sessions.json, logs) vs. Forge state (worktrees, session files)
4. **Easy Fixes:** All violations have straightforward Forge API replacements

### Design Patterns to Maintain

1. **Never construct worktree paths** → Always use Forge API
2. **Session files are Forge-managed** → Use `getTaskAttemptLogs()`, not `fs.readFileSync()`
3. **CLI logs are fallback** → Prefer Forge logs when available
4. **Metadata in sessions.json** → Only store references (sessionId), not file paths

### Red Flags to Avoid

❌ **BAD:**
```typescript
const worktreePath = `/var/tmp/automagik-forge/worktrees/${sessionId}`;
const sessionFile = path.join(worktreePath, 'session.json');
const content = fs.readFileSync(sessionFile, 'utf8');
```

✅ **GOOD:**
```typescript
const logs = await forgeClient.getTaskAttemptLogs(sessionId);
```

---

**End of Report**
