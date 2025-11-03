# Implementation Specification: Frontmatter Migration

## Task: Update Genie codebase to use simplified frontmatter schema

### Files to Modify

#### 1. `src/cli/lib/agent-registry.ts`

**Change 1: Update AgentMetadata interface (lines 14-39)**

FROM:
```typescript
export interface AgentMetadata {
  name: string;
  description: string;
  type?: 'agent' | 'neuron';
  color?: string;
  emoji?: string;
  forge_profile_name?: string;
  genie?: {
    executor?: string;
    executorVariant?: string;
    background?: boolean;
    model?: string;
    dangerously_skip_permissions?: boolean;
    sandbox?: string;
    dangerously_allow_all?: boolean;
    model_reasoning_effort?: string;
  };
  collective?: 'code' | 'create';
  filePath: string;
  fullContent?: string;
}
```

TO:
```typescript
export interface AgentMetadata {
  name: string;
  description: string;
  type?: 'agent' | 'neuron';
  color?: string;
  emoji?: string;
  forge_profile_name?: string;

  // Genie orchestration settings (NOT synced to Forge)
  genie?: {
    executor?: string;       // Which executor to invoke (CLAUDE_CODE, CODEX, etc.)
    variant?: string;        // Which Forge profile variant to use (default: derived from collective+name)
    background?: boolean;    // Run in isolated worktree (default: false)
  };

  // Forge executor config (passed to Forge as-is, not validated by Genie)
  forge?: Record<string, any>;

  collective?: 'code' | 'create';
  filePath: string;
  fullContent?: string;
}
```

**Change 2: Remove methods (lines 313-479)**

Remove these 3 methods entirely:
- `loadCollectiveContexts()` (lines 313-337)
- `getSupportedExecutors()` (lines 343-363)
- `generateForgeProfiles()` (lines 372-478)

Replace with single comment:
```typescript
  /**
   * NOTE: Forge sync methods removed (loadCollectiveContexts, getSupportedExecutors, generateForgeProfiles)
   * Forge now discovers .genie folders natively - no sync needed from Genie.
   */
}
```

**Change 3: Update file header comment (lines 1-8)**

FROM:
```typescript
/**
 * Agent Registry - Dynamic agent metadata scanner and Forge profile sync
 *
 * Scans .genie/code/agents/ and .genie/create/agents/ directories
 * to build a registry of all available agents with their metadata.
 *
 * Syncs agent prompts to Forge profiles as `append_prompt` variants.
 */
```

TO:
```typescript
/**
 * Agent Registry - Dynamic agent metadata scanner
 *
 * Scans .genie/code/agents/ and .genie/create/agents/ directories
 * to build a registry of all available agents with their metadata.
 *
 * NOTE: Forge sync logic removed - Forge discovers .genie folders natively.
 */
```

#### 2. `src/cli/lib/forge-executor.ts`

**Change 1: Remove AgentSyncCache interface (lines 41-46)**

Remove:
```typescript
export interface AgentSyncCache {
  version: number;
  lastSync: string;
  agentHashes: Record<string, string>;
  executors: string[];
}
```

Replace with:
```typescript
// NOTE: AgentSyncCache interface removed - Forge discovers .genie folders natively
```

**Change 2: Remove sync methods (lines 57-384)**

Remove entire `syncProfiles()` method and all its helper methods:
- `syncProfiles()` (lines 57-275)
- `loadSyncCache()` (lines 280-296)
- `saveSyncCache()` (lines 301-314)
- `hashContent()` (lines 316-324)
- `cleanNullValues()` (lines 326-344)
- `mergeProfiles()` (lines 346-384)

Add single comment before `createSession()`:
```typescript
  /**
   * NOTE: syncProfiles and helper methods removed - Forge discovers .genie folders natively
   * Removed: syncProfiles, loadSyncCache, saveSyncCache, hashContent, cleanNullValues, mergeProfiles
   */

  async createSession(params: CreateSessionParams): Promise<CreateSessionResult> {
```

**Change 3: Remove import (line 4)**

Remove if no longer used:
```typescript
import { createHash } from 'crypto';
```

(Check if `createHash` is used elsewhere in the file first)

### Expected Results

After changes:
- agent-registry.ts: ~170 lines removed
- forge-executor.ts: ~330 lines removed
- No compilation errors
- All existing functionality preserved (routing, session creation)

### Testing

After implementation, verify:
1. TypeScript compiles: `pnpm run build`
2. No broken imports: `grep -r "generateForgeProfiles\|syncProfiles" src/`
3. Agent registry still works: Import and test `getAgentRegistry()`

### DO NOT

- Do not modify any agent files yet (that's next step)
- Do not update documentation yet (that's next step)
- Do not remove sync cache file yet (that's next step)
- Focus only on code cleanup in these 2 files
