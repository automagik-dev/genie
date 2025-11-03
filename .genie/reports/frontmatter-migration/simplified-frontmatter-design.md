# Simplified Frontmatter Design (Genie Orchestration + Forge Passthrough)

## Core Principle

**Genie's Responsibility:**
- Routing: Which executor to invoke
- Orchestration: How to run the task (background/foreground)
- Discovery: Reading agent files

**Forge's Responsibility:**
- Parsing `forge.*` config
- Validating executor-specific fields
- Applying executor settings

**Genie does NOT:**
- Sync agents to Forge API
- Validate Forge fields
- Know what executor fields are valid
- Transform Forge configs

---

## Frontmatter Schema

### Required Fields (Top-Level)

```yaml
name: implementor              # Agent identifier (required)
description: Brief description # One-line purpose (optional but recommended)
```

### Genie Namespace (Orchestration)

```yaml
genie:
  executor: CLAUDE_CODE        # Which executor to invoke (required)
  variant: DEFAULT             # Which Forge profile variant (optional, default: derived from name)
  background: false            # Run in isolated worktree (optional, default: false)
```

**Field Definitions:**

| Field | Type | Required | Default | Purpose |
|-------|------|----------|---------|---------|
| `executor` | string | ✅ Yes | (none) | Which executor to invoke: CLAUDE_CODE, CODEX, OPENCODE, etc. |
| `variant` | string | ❌ No | Derived from collective+name | Which Forge profile variant to use at runtime |
| `background` | boolean | ❌ No | `false` | Whether to run in isolated worktree (true) or main workspace (false) |

**Notes:**
- `executor` is REQUIRED (Genie needs to know which executor to invoke)
- `variant` defaults to `{COLLECTIVE}_{NAME}` (e.g., `CODE_IMPLEMENTOR`)
- `background: true` = isolated worktree (isolated git branch, worktree cleanup after)
- `background: false` = main workspace (no isolation, faster for quick tasks)

### Forge Namespace (Passthrough Config)

```yaml
forge:
  # Genie does NOT validate these fields
  # Genie passes them to Forge as-is
  # Forge parses and validates based on executor type

  # Example for CLAUDE_CODE:
  model: claude-sonnet-4-5-20250929
  dangerously_skip_permissions: false

  # Example for OPENCODE:
  model: qwen/qwq-32b-preview
  agent: null
```

**Genie's Behavior:**
1. Read `forge.*` as a raw object
2. Pass it to Forge without modification
3. Forge validates based on executor schema

**Why Passthrough?**
- Genie doesn't need to know executor schemas
- Forge owns the schema (single source of truth)
- New Forge fields = zero Genie changes
- Simpler code, fewer bugs

---

## Complete Examples

### Minimal Agent (CLAUDE_CODE, foreground)

```yaml
---
name: polish
description: Code polishing and cleanup
genie:
  executor: CLAUDE_CODE
---
# Agent instructions...
```

**Behavior:**
- Runs in main workspace (no isolation)
- Uses Forge's `DEFAULT` variant for CLAUDE_CODE
- No custom Forge config (uses Forge defaults)

### Background Agent with Custom Forge Config (CLAUDE_CODE)

```yaml
---
name: implementor
description: End-to-end feature implementation
genie:
  executor: CLAUDE_CODE
  background: true
forge:
  model: claude-sonnet-4-5-20250929
  dangerously_skip_permissions: false
---
# Agent instructions...
```

**Behavior:**
- Runs in isolated worktree
- Uses Forge variant: `CODE_IMPLEMENTOR`
- Forge receives: `{ model: "claude-sonnet-4-5-20250929", dangerously_skip_permissions: false }`

### OPENCODE Agent

```yaml
---
name: refactor
description: Code refactoring specialist
genie:
  executor: OPENCODE
  background: true
forge:
  model: qwen/qwq-32b-preview
  agent: null
---
# Agent instructions...
```

**Behavior:**
- Runs in isolated worktree
- Uses Forge variant: `CODE_REFACTOR`
- Forge receives: `{ model: "qwen/qwq-32b-preview", agent: null }`
- Genie doesn't validate what `agent` or `model` mean for OPENCODE

### Neuron (Persistent Orchestrator)

```yaml
---
name: MASTER
description: Persistent master orchestrator
genie:
  executor: CLAUDE_CODE
  background: true
forge:
  model: claude-opus-4-20250514
  dangerously_skip_permissions: true
---
# Neuron instructions...
```

**Behavior:**
- Neuron (detected by location: `.genie/neurons/`)
- Always background mode (neurons are long-running)
- Uses Forge variant: `MASTER` (no collective prefix for neurons)

---

## Migration Strategy

### Before (Old Schema)

```yaml
---
name: implementor
genie:
  executor: CLAUDE_CODE
  executorVariant: DEFAULT
  background: true
  model: sonnet                      # ❌ Wrong namespace
  dangerously_skip_permissions: false  # ❌ Wrong namespace
---
```

### After (New Schema)

```yaml
---
name: implementor
genie:
  executor: CLAUDE_CODE
  variant: DEFAULT                   # Renamed: executorVariant → variant
  background: true
forge:
  model: claude-sonnet-4-5-20250929  # ✅ Moved to forge namespace
  dangerously_skip_permissions: false  # ✅ Moved to forge namespace
---
```

### Migration Script Logic

```typescript
function migrateFrontmatter(oldMeta: any): any {
  const newMeta: any = {
    name: oldMeta.name,
    description: oldMeta.description,
    genie: {},
    forge: {}
  };

  // Migrate genie.* fields
  if (oldMeta.genie) {
    // Orchestration fields stay in genie namespace
    if (oldMeta.genie.executor) newMeta.genie.executor = oldMeta.genie.executor;
    if (oldMeta.genie.executorVariant) newMeta.genie.variant = oldMeta.genie.executorVariant;
    if (oldMeta.genie.background !== undefined) newMeta.genie.background = oldMeta.genie.background;

    // Move executor config fields to forge namespace
    const forgeFields = [
      'model', 'sandbox', 'dangerously_skip_permissions', 'dangerously_allow_all',
      'model_reasoning_effort', 'claude_code_router', 'plan', 'approvals',
      'ask_for_approval', 'oss', 'model_reasoning_summary', 'profile',
      'base_instructions', 'include_plan_tool', 'include_apply_patch_tool',
      'force', 'yolo', 'allow_all_tools', 'allow_tool', 'deny_tool',
      'add_dir', 'disable_mcp_server', 'agent',
      'base_command_override', 'additional_params'
    ];

    for (const field of forgeFields) {
      if (oldMeta.genie[field] !== undefined) {
        newMeta.forge[field] = oldMeta.genie[field];
      }
    }
  }

  // Clean up empty objects
  if (Object.keys(newMeta.genie).length === 0) delete newMeta.genie;
  if (Object.keys(newMeta.forge).length === 0) delete newMeta.forge;

  return newMeta;
}
```

---

## Genie Code Changes

### 1. Agent Registry (Read Frontmatter)

**File:** `src/cli/lib/agent-registry.ts`

**Before:**
```typescript
// Genie validates and transforms Forge fields
if (meta.genie?.model && meta.genie.executor === executor) {
  variantConfig.model = meta.genie.model;
}
if (meta.genie?.dangerously_skip_permissions !== undefined) {
  variantConfig.dangerously_skip_permissions = meta.genie.dangerously_skip_permissions;
}
// ... 20 more executor-specific checks
```

**After:**
```typescript
// Genie reads orchestration fields only
const executor = meta.genie?.executor || 'CLAUDE_CODE';
const variant = meta.genie?.variant || deriveVariantName(meta);
const background = meta.genie?.background ?? false;

// Forge config is passed as-is (no validation)
const forgeConfig = meta.forge || {};
```

### 2. Session Manager (Pass to Forge)

**File:** `src/mcp/lib/session-manager.ts`

**Before:**
```typescript
// Genie builds executor command with specific flags
const command = buildExecutorCommand({
  executor: agent.genie.executor,
  model: agent.genie.model,
  permissions: agent.genie.dangerously_skip_permissions,
  // ... many executor-specific fields
});
```

**After:**
```typescript
// Genie passes executor and variant, Forge handles the rest
const command = buildExecutorCommand({
  executor: agent.genie.executor,
  variant: agent.genie.variant,
  forgeConfig: agent.forge  // Passed as-is to Forge
});
```

### 3. Remove Forge Sync Logic

**Files to Modify:**
- `src/cli/lib/agent-registry.ts` (remove `syncProfiles`, profile generation)
- `src/cli/lib/forge-executor.ts` (remove change detection, cache, API calls)
- `src/lib/forge-client.js` (remove PUT /api/profiles calls)

**Reason:** Forge will discover .genie folders natively, no sync needed.

---

## Forge Behavior (Native Discovery)

### Forge Discovers .genie Folder

1. Forge startup: Scan workspace for `.genie/` folder
2. Discover collectives (directories with `AGENTS.md`)
3. Parse all `*.md` files in `agents/` and `neurons/`
4. Extract frontmatter: `{ name, genie, forge }`
5. Generate executor profiles:
   - Variant name: `{COLLECTIVE}_{NAME}` or `{NAME}` (neurons)
   - Config: `forge.*` fields (validated by Forge executor schema)
   - Instructions: Markdown body (with collective context prepended)

### Forge Validates Executor Configs

```typescript
// In Forge backend
function validateForgeConfig(executor: string, config: any) {
  switch (executor) {
    case 'CLAUDE_CODE':
      return validateAgainstSchema(claudeCodeSchema, config);
    case 'CODEX':
      return validateAgainstSchema(codexSchema, config);
    case 'OPENCODE':
      return validateAgainstSchema(opencodeSchema, config);
    // ...
  }
}
```

**Benefit:** Genie never needs to know executor schemas. Forge owns validation.

---

## Benefits

### 1. Separation of Concerns
- **Genie:** Orchestration (routing, background mode)
- **Forge:** Execution (executor configs, validation)

### 2. Zero Sync Overhead
- No API calls from Genie to Forge
- No change detection
- No cache files
- Faster startup

### 3. Simpler Codebase
- Remove ~300 lines from `agent-registry.ts`
- Remove ~200 lines from `forge-executor.ts`
- No executor-specific logic in Genie

### 4. Future-Proof
- New Forge executors: Zero Genie changes
- New executor fields: Zero Genie changes
- Forge schema evolution: Independent of Genie

### 5. Better Error Messages
- Forge validates executor configs (knows what's valid)
- Errors surface at runtime with context
- Genie doesn't give false positives

---

## Testing Strategy

### Unit Tests (Genie)

```typescript
describe('Frontmatter Migration', () => {
  it('should move executor fields from genie.* to forge.*', () => {
    const old = { genie: { executor: 'CLAUDE_CODE', model: 'sonnet' } };
    const migrated = migrateFrontmatter(old);
    expect(migrated.genie.executor).toBe('CLAUDE_CODE');
    expect(migrated.forge.model).toBe('sonnet');
    expect(migrated.genie.model).toBeUndefined();
  });

  it('should rename executorVariant to variant', () => {
    const old = { genie: { executorVariant: 'CUSTOM' } };
    const migrated = migrateFrontmatter(old);
    expect(migrated.genie.variant).toBe('CUSTOM');
    expect(migrated.genie.executorVariant).toBeUndefined();
  });

  it('should preserve background field in genie namespace', () => {
    const old = { genie: { background: true } };
    const migrated = migrateFrontmatter(old);
    expect(migrated.genie.background).toBe(true);
  });
});
```

### Integration Tests (Genie + Forge)

```typescript
describe('Agent Discovery', () => {
  it('should discover agents and pass forge config to Forge', async () => {
    // Given: Agent with forge.* config
    const agentFile = `
---
name: test
genie:
  executor: CLAUDE_CODE
forge:
  model: claude-sonnet-4-5-20250929
---
# Test agent
`;

    // When: Genie parses and invokes
    const agent = await parseAgentFile(agentFile);
    const session = await createSession(agent);

    // Then: Forge receives config as-is
    expect(session.forgeConfig).toEqual({
      model: 'claude-sonnet-4-5-20250929'
    });
  });
});
```

---

## Migration Checklist

- [ ] Design simplified schema (this doc)
- [ ] Create migration script (`genie helper migrate-frontmatter`)
- [ ] Test migration script on sample agents
- [ ] Update `agent-registry.ts` (read genie.*, pass forge.* as-is)
- [ ] Remove Forge sync logic (agent-registry.ts, forge-executor.ts)
- [ ] Update `session-manager.ts` (pass forgeConfig to Forge)
- [ ] Migrate all agent files (run script on .genie/)
- [ ] Remove `.genie/state/agent-sync-cache.json`
- [ ] Update AGENTS.md documentation
- [ ] Test agent routing (genie run, genie list)
- [ ] Update Forge discovery prompt (use new schema)

---

## File Locations

**Design docs:**
- `/tmp/genie/simplified-frontmatter-design.md` (this file)
- `/tmp/genie/corrected-frontmatter-schema.md` (executor field reference)

**Code to modify:**
- `src/cli/lib/agent-registry.ts` (remove sync, simplify reading)
- `src/cli/lib/forge-executor.ts` (remove change detection)
- `src/mcp/lib/session-manager.ts` (pass forge.* to Forge)
- `src/lib/forge-client.js` (remove PUT /api/profiles)

**Agent files to migrate:**
- `.genie/agents/*.md`
- `.genie/code/agents/*.md`
- `.genie/create/agents/*.md`
- `.genie/neurons/*.md`

**Docs to update:**
- `AGENTS.md` (frontmatter reference)
- `.genie/agents/README.md` (agent architecture)
