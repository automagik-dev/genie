# Dead Code Analysis Report - automagik-genie
**Scan Date:** 2025-10-18
**Repository:** /home/namastex/workspace/automagik-genie
**Scope:** `.genie/cli/src/**/*.ts` TypeScript codebase

---

## Executive Summary

The codebase shows relatively good hygiene with minimal obvious dead code. Most patterns are actively used or intentional. **3 items identified** across severity levels.

**Total Findings:**
- **CRITICAL (Active Bloat):** 1 item
- **MEDIUM (Unused Internal Functions):** 1 item  
- **LOW (Deprecated/Legacy):** 1 item

---

## Critical Issues (Remove/Refactor)

### 1. Unused Parameter in `buildRunCommand` - Codex Executor
**File:** `/home/namastex/workspace/automagik-genie/.genie/cli/src/executors/codex.ts:41`

**Issue:** The `instructions` parameter is accepted but **never used**.

```typescript
function buildRunCommand({ 
  config = {}, 
  instructions,  // ← UNUSED
  prompt, 
  agentPath 
}: { 
  config?: Record<string, any>; 
  instructions?: string;  // ← NEVER REFERENCED IN FUNCTION BODY
  prompt?: string; 
  agentPath?: string; 
}): ExecutorCommand {
  // ... function body uses: config, agentPath, prompt
  // ... but NEVER uses: instructions
}
```

**Evidence:**
- Parameter declared at line 41
- Never referenced in function body (lines 42-74)
- Called from two locations:
  - `/home/namastex/workspace/automagik-genie/.genie/cli/src/commands/run.ts:142` - passes `instructions: agentSpec.instructions`
  - `/home/namastex/workspace/automagik-genie/.genie/cli/src/cli-core/handlers/run.ts:115` - passes `agentPath` instead
- Type interface shows both are optional: `ExecutorBuildRunArgs` (types.ts:85)

**Impact:** Dead parameter - causes confusion, suggests incomplete implementation.

**Recommendation:** 
- **REMOVE:** Delete unused parameter from function signature
- **VERIFY:** Check if this was intentional (maybe meant to pass instructions instead of agentPath?)
- Current behavior: `agentPath` is used to build `-c append_user_instructions_file=...` flag
- Either remove `instructions` param OR replace agentPath usage with instructions

**Severity:** CRITICAL (Parameter bloat, suggests incomplete refactoring)

---

## Medium Issues (Code Smell)

### 1. Unused Internal Function - `tryLocateSessionFileBySessionId`
**File:** `/home/namastex/workspace/automagik-genie/.genie/cli/src/executors/codex.ts:293-328`

**Issue:** Function is exported and included in executor object but **only used via interface check**.

```typescript
// Defined and exported:
function tryLocateSessionFileBySessionId(
  sessionId: string,
  sessionsDir: string
): string | null {
  // Complex logic (60+ lines) searching ~/.codex/sessions/
}

// Included in executor object:
const codexExecutor: Executor = {
  // ...
  tryLocateSessionFileBySessionId,  // ← Exported but why?
};
```

**Evidence:**
- Defined at line 293 in codex.ts
- Exported as part of executor default export (line 401)
- Used via optional chaining checks in 4 locations:
  - `/home/namastex/workspace/automagik-genie/.genie/cli/src/cli-core/handlers/view.ts:25` - `if (executor?.tryLocateSessionFileBySessionId && ...)`
  - `/home/namastex/workspace/automagik-genie/.genie/cli/src/cli-core/handlers/resume.ts:39` - same pattern
  - `/home/namastex/workspace/automagik-genie/.genie/cli/src/commands/view.ts:48` - same pattern
  - `/home/namastex/workspace/automagik-genie/.genie/cli/src/commands/resume.ts:44` - same pattern

**Status:** Not technically dead (used via interface), but marked for `tryLocateSessionFileBySessionId? ...` - optional interface member suggests it might not always be available.

**Recommendation:** 
- **KEEP IF:** This is intentional as fallback session recovery (orphaned sessions)
- **DOCUMENT:** Add comment explaining when/why used
- **OR STANDARDIZE:** Make it non-optional if it should always exist

**Severity:** MEDIUM (Not dead but defensive - consider documenting intent)

---

## Low Issues (Cleanup)

### 1. Deprecated Helper Function - `emitView`
**File:** `/home/namastex/workspace/automagik-genie/.genie/cli/src/lib/view-helpers.ts:11`

**Issue:** Marked as `@deprecated` but still actively used everywhere (9 imports).

```typescript
/**
 * @deprecated - Commands should use formatTranscriptMarkdown directly instead
 */
export async function emitView(
  content: string,
  options: CLIOptions,
  opts: { stream?: NodeJS.WriteStream; forceJson?: boolean } = {}
): Promise<void> {
  // Token-efficient markdown output
}
```

**Evidence:**
- Marked `@deprecated` at line 9
- Actually used in 10+ files:
  - `./genie.ts`, `./commands/help.ts`, `./commands/stop.ts`, 
  - `./commands/init.ts`, `./commands/run.ts`, `./commands/migrate.ts`,
  - `./commands/update.ts`, `./commands/cleanup.ts`, `./commands/rollback.ts`,
  - `./commands/status.ts`
- All usages: `await emitView(buildInfoView(...), parsed.options)`
- Not replaced by `formatTranscriptMarkdown` (which is narrower in scope)

**Recommendation:**
- **Option A:** Remove `@deprecated` marker - this is the current standard output mechanism
- **Option B:** Migrate all commands to use `formatTranscriptMarkdown` directly + implement alternative output layer
- **Current:** The comment doesn't match reality - `emitView` IS being used as the command output mechanism

**Severity:** LOW (Not dead - just mislabeled, causes confusion)

---

## Unused Imports / Type Declarations

### YAML Lazy-Loading (Intentional, Not Dead)
**Files:** 
- `.genie/cli/src/lib/config.ts:8` - `let YAML: typeof import('yaml') | null = null;`
- `.genie/cli/src/lib/agent-resolver.ts:7` - same pattern

**Status:** ✅ INTENTIONAL - Lazy-loaded only when needed (not dead code, performance optimization)

---

## Clear/Unused Declaration

### gradient-string TypeScript Stub
**File:** `.genie/cli/src/types/gradient-string.d.ts`

```typescript
declare module 'gradient-string';
```

**Status:** Type stub for untyped npm package. **NOT USED** anywhere in codebase.
- No grep results for `gradient-string` usage in source files
- Likely artifact from old Ink rendering system (removed in token-efficiency pass)
- **Recommendation:** REMOVE (unused type stub)

**Severity:** LOW (Type definition cleanup)

---

## Codex Executor - Legacy Status

### Complete Codex Executor 
**File:** `.genie/cli/src/executors/codex.ts`

**Status:** ⚠️ SEMI-DEAD - Fully functional but:
1. Loaded dynamically by `loadExecutors()` (index.ts:20-38)
2. Default executor changed to `claude` (see init.ts, line 156-158)
3. All codex-specific code paths reachable but untested
4. Codex provider may not be installed (optional)

**Recommendation:** 
- **KEEP:** Still selectable via `genie model codex` or `--executor codex`
- **DOCUMENT:** Add README section on provider setup
- **TEST:** Add integration tests for codex path if maintaining dual-executor support

**Severity:** MEDIUM (Maintained but low-priority)

---

## Summary Table

| Category | File | Issue | Line | Type | Action |
|----------|------|-------|------|------|--------|
| **CRITICAL** | codex.ts | Unused parameter `instructions` | 41 | Parameter | Remove/Replace |
| **MEDIUM** | codex.ts | Optional recovery function | 293 | Function | Document or standardize |
| **LOW** | view-helpers.ts | Mislabeled \`@deprecated\` | 9 | Marker | Remove marker or migrate |
| **LOW** | gradient-string.d.ts | Unused type stub | 1 | TypeDef | Remove file |

---

## Recommendations Priority

1. **Immediate (Critical):** Remove unused `instructions` parameter from `codex.buildRunCommand()` - reduces confusion and parameter bloat
2. **Short-term (Medium):** Document or standardize `tryLocateSessionFileBySessionId` optional function
3. **Nice-to-have (Low):** 
   - Remove `@deprecated` marker from `emitView` or complete migration
   - Delete unused `gradient-string.d.ts` type stub
   - Add clarifying comments to codex executor about provider setup

---

## Notes

- **No unreachable code blocks found** (no code after return/throw)
- **No unused variables found** in main flows (YAML lazy-loading is intentional)
- **No duplicate function definitions** (clean exports)
- **No DEBUG console calls** that should be removed (5 DEBUG lines are in active handlers - may want to clean)
  - `cli-core/handlers/run.ts:46-48` - 3 debug lines
  - `executors/claude.ts` - 4 debug lines  
  - These appear to be development artifacts, consider removing for production

---

**Report Generated:** 2025-10-18  
**Analysis Scope:** TypeScript CLI codebase  
**Files Analyzed:** 65 .ts files  
**Confidence Level:** HIGH
