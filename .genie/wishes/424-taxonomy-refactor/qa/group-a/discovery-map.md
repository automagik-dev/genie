# Group A: Discovery Map - Files & Types to Rename

**Generated:** 2025-11-14
**Scope:** Core type and file renames (session → task)

## Files to Rename (git mv)

### 1. MCP Library Files
- `src/mcp/lib/session-types.ts` → `src/mcp/lib/task-types.ts`
- `src/mcp/lib/session-manager.ts` → `src/mcp/lib/task-manager.ts`

### 2. CLI Core Files
- `src/cli/cli-core/session-service.ts` → `src/cli/cli-core/task-service.ts`

### 3. CLI Storage Files
- `src/cli/session-store.ts` → `src/cli/task-store.ts`
- `src/cli/lib/session-helpers.ts` → `src/cli/lib/task-helpers.ts`

**Total Files:** 5

## TypeScript Interfaces/Types to Rename

### From session-types.ts
- `SessionInfo` → `TaskInfo`
- `SessionKey` → `TaskKey`

### From session-service.ts
- `SessionServiceOptions` → `TaskServiceOptions`
- `SessionService` (class) → `TaskService`

### From session-store.ts
- `SessionEntry` → `TaskEntry`
- `SessionStore` → `TaskStore`
- `SessionPathsConfig` → `TaskPathsConfig`
- `SessionLoadConfig` → `TaskLoadConfig`
- `SessionDefaults` → `TaskDefaults`

### From session-manager.ts
- `SessionManager` (class) → `TaskManager`
- `sessionManager` (instance) → `taskManager`

### From other files (will be updated in Phase 2)
- `src/cli/lib/markdown-formatter.ts`: `SessionMeta` → `TaskMeta`
- `src/cli/lib/markdown-formatter.ts`: `SessionEntry` → `TaskEntry` (duplicate)
- `src/cli/lib/forge-executor.ts`: `CreateSessionParams` → `CreateTaskParams`
- `src/cli/lib/forge-executor.ts`: `CreateSessionResult` → `CreateTaskResult`
- `src/cli/lib/forge-executor.ts`: `ForgeSessionSummary` → `ForgeTaskSummary`
- `src/cli/lib/stats-tracker.ts`: `SessionStats` → `TaskStats`

**Total Types:** 18

## Import Update Strategy

All files that import from the renamed files will need updates:
- `from './session-types'` → `from './task-types'`
- `from '../session-store'` → `from '../task-store'`
- `from './session-service'` → `from './task-service'`
- `from './session-manager'` → `from './task-manager'`
- `from './session-helpers'` → `from './task-helpers'`

## Exclusions (NOT renamed in Group A)

These remain workflow-session specific and are NOT part of this rename:
- `oauth-session-manager.ts` - OAuth session management (different domain)
- Files related to workflow sessions (wish/forge/review orchestrators)

## Next Steps

1. ✅ Phase 0 complete - Discovery map created
2. Phase 1: Execute file renames with git mv
3. Phase 2: Update type definitions within renamed files
4. Phase 3: Update all import paths
5. Phase 4: Verify TypeScript compilation
6. Phase 5: Create evidence logs and Done Report
