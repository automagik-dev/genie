# Executor Configuration Schema

## Overview

This document defines the frontmatter schema for configuring Genie agents with executor-specific parameters. Each executor (CLAUDE_CODE, CODEX, AMP, OPENCODE) has different configuration options.

**Source:** Live Forge API query (`GET /api/profiles`) on 2025-10-26

## CLAUDE_CODE Executor

**Most common executor** - Used by majority of agents and all neurons.

### Frontmatter Schema

```yaml
---
name: agent-name
description: Agent purpose
genie:
  executor: CLAUDE_CODE
  model: sonnet | haiku | opus
  background: true | false
  dangerously_skip_permissions: true | false
---
```

### Field Definitions

**`executor`** (required)
- Value: `"CLAUDE_CODE"`
- Specifies Claude Code as the execution environment

**`model`** (optional)
- Values: `"sonnet"` | `"haiku"` | `"opus"`
- Default: Inherits from Forge DEFAULT profile (typically `"sonnet"`)
- Recommendation:
  - `haiku` for neurons (fast orchestration)
  - `sonnet` for complex implementation (most agents)
  - `opus` for critical work requiring highest capability

**`background`** (optional)
- Values: `true` | `false`
- Default: `false`
- Behavior:
  - `true` = Runs in isolated Forge worktree (separate git branch)
  - `false` = Runs in current workspace
- Recommendation: `true` for all agents (prevents conflicts)

**`dangerously_skip_permissions`** (optional)
- Values: `true` | `false`
- Default: Inherits from Forge DEFAULT profile (typically `true`)
- Behavior:
  - `true` = Skip all permission checks (relaxed/dangerous mode)
  - `false` = Enforce permission checks (safe mode)
- **Note:** This is a BOOLEAN flag, not a complex object
- **Not granular:** Cannot configure read-only, network restrictions, or specific tool allowlists

### What About `additional_params`?

**Finding:** CLAUDE_CODE DEFAULT profile shows `additional_params: []` (empty array)

**Conclusion:** `additional_params` is NOT used for permission control in CLAUDE_CODE. It may be intended for future extensibility but is currently unused.

**Do NOT use:**
```yaml
genie:
  executor: CLAUDE_CODE
  additional_params:  # ❌ This doesn't work
    sandbox_mode: strict
    read_only: true
```

### Forge Profile Structure (Backend)

When agent-registry syncs to Forge, the profile looks like:

```json
{
  "executors": {
    "CLAUDE_CODE": {
      "CODE_IMPLEMENTOR": {
        "CLAUDE_CODE": {
          "append_prompt": "<agent markdown content>",
          "dangerously_skip_permissions": true,
          "additional_params": []
        }
      }
    }
  }
}
```

## CODEX Executor

**Alternative executor** - Different permission model.

### Frontmatter Schema

```yaml
---
name: agent-name
description: Agent purpose
genie:
  executor: CODEX
  model: string
  background: true | false
  sandbox: danger-full-access | safe
---
```

### Field Definitions

**`sandbox`** (optional)
- Values: `"danger-full-access"` | `"safe"`
- Default: `"danger-full-access"` (from Forge DEFAULT)
- Behavior: Controls sandbox isolation level
- **Different from CLAUDE_CODE:** Uses `sandbox` instead of `dangerously_skip_permissions`

### Forge Profile Structure (Backend)

```json
{
  "CODEX": {
    "append_prompt": null,
    "sandbox": "danger-full-access",
    "additional_params": []
  }
}
```

## AMP Executor

**Alternative executor** - Uses `dangerously_allow_all` flag.

### Frontmatter Schema

```yaml
---
name: agent-name
description: Agent purpose
genie:
  executor: AMP
  background: true | false
  dangerously_allow_all: true | false
---
```

### Field Definitions

**`dangerously_allow_all`** (optional)
- Values: `true` | `false`
- Default: `true` (from Forge DEFAULT)
- Behavior: Allow all operations (similar to CLAUDE_CODE's `dangerously_skip_permissions`)
- **Different from CLAUDE_CODE:** Different flag name, same concept

### Forge Profile Structure (Backend)

```json
{
  "AMP": {
    "append_prompt": null,
    "dangerously_allow_all": true
  }
}
```

## OPENCODE Executor

**Minimal executor** - No permission controls exposed.

### Frontmatter Schema

```yaml
---
name: agent-name
description: Agent purpose
genie:
  executor: OPENCODE
  background: true | false
---
```

### Field Definitions

**No permission flags** - OPENCODE has no exposed permission configuration.

### Forge Profile Structure (Backend)

```json
{
  "OPENCODE": {
    "append_prompt": null
  }
}
```

## Neuron Configuration (Special Case)

**Neurons** (neuron-wish, neuron-forge, neuron-review) have **minimal frontmatter** by design.

### Why Minimal Configuration?

1. **MCP orchestration** - Neurons coordinate via MCP tools (WebSocket streaming)
2. **Read-only filesystem** - Enforced by MCP role detection, not Forge profiles
3. **Breaking risk** - User changing sandbox/permissions could break MCP coordination
4. **Hardcoded behavior** - Neurons have specific orchestration patterns

### Neuron Frontmatter (Recommended)

```yaml
---
name: neuron-forge
description: Persistent forge master orchestrator
genie:
  executor: CLAUDE_CODE
  model: haiku
  background: true
  # ← No permission flags
  # ← MCP + Forge handle restrictions
---
```

**Why `background: true`?**
- Neurons run in isolated Forge worktrees
- Persist across MCP restarts (stored in Forge SQLite)
- Separate from main workspace (read-only access)

**What about `dangerously_skip_permissions`?**
- NOT NEEDED - Read-only enforcement happens in MCP via `isReadOnlyFilesystem(role)`
- Neurons detected via branch name pattern: `forge/XXXX-wish-*`, `forge/XXXX-forge-*`, `forge/XXXX-review-*`
- Permission flag is orthogonal to neuron architecture

## Permission Categories (Planned)

**Draft categorization of 77+ agents:**

### Read-Only (Minimal Set)
- ✅ Neurons (neuron-wish, neuron-forge, neuron-review) - MCP enforced
- ✅ Explorers (explore) - Context gathering only
- Recommended: `dangerously_skip_permissions: false`

### Standard Read-Write (Most Agents)
- ✅ Implementation agents (implementor, tests, polish, refactor, etc.)
- ✅ 60+ agents in this category
- Recommended: `dangerously_skip_permissions: true` (default, no change needed)

### Unrestricted (Dangerous, Use Carefully)
- ✅ Git operations (git) - Needs .git/ access
- ✅ Release automation (release) - Needs GitHub access
- ✅ System modification (install, update) - Modifies framework files
- Recommended: `dangerously_skip_permissions: true` (explicitly set)

## Implementation Roadmap

### Phase 1: AgentMetadata Interface ✅ READY
Update `.genie/cli/src/lib/agent-registry.ts`:

```typescript
export interface AgentMetadata {
  name: string;
  description: string;
  color?: string;
  emoji?: string;
  genie?: {
    executor?: string;
    executorVariant?: string;
    background?: boolean;
    model?: string;

    // Executor-specific permission flags
    dangerously_skip_permissions?: boolean;  // CLAUDE_CODE
    sandbox?: string;                        // CODEX
    dangerously_allow_all?: boolean;         // AMP
  };
  collective: 'code' | 'create';
  filePath: string;
  fullContent?: string;
}
```

### Phase 2: Profile Generation ✅ READY
Update `generateForgeProfiles()` method (line 292-301):

```typescript
profiles.executors[executor][variantName] = {
  [executor]: {
    // Inherit all fields from DEFAULT variant
    ...baseConfig,
    // Use agent content
    append_prompt: agent.fullContent,

    // Pass through executor-specific flags from frontmatter
    ...(agent.genie?.dangerously_skip_permissions !== undefined &&
        executor === 'CLAUDE_CODE' &&
        { dangerously_skip_permissions: agent.genie.dangerously_skip_permissions }),
    ...(agent.genie?.sandbox !== undefined &&
        executor === 'CODEX' &&
        { sandbox: agent.genie.sandbox }),
    ...(agent.genie?.dangerously_allow_all !== undefined &&
        executor === 'AMP' &&
        { dangerously_allow_all: agent.genie.dangerously_allow_all }),
    ...(agent.genie?.background !== undefined &&
        { background: agent.genie.background })
  }
};
```

### Phase 3: Validation Helper ⏳ PLANNED
Create frontmatter validation rules:
- Warn if wrong permission flag for executor
- Suggest correct flag name
- Validate boolean values
- Check for deprecated/unknown flags

### Phase 4: Agent Review ⏳ PLANNED
- Review all 77+ agents for permission requirements
- Update frontmatter where needed
- Test with actual Forge execution
- Document patterns and best practices

## Testing Checklist

**Before production use:**
1. ✅ Query live Forge API for profile structure (DONE)
2. ✅ Document all executor defaults (DONE)
3. ⏳ Update AgentMetadata interface (READY)
4. ⏳ Update generateForgeProfiles() (READY)
5. ⏳ Test profile sync to Forge
6. ⏳ Test agent execution with custom permissions
7. ⏳ Verify neurons still work correctly
8. ⏳ Test all 4 executors (CLAUDE_CODE, CODEX, AMP, OPENCODE)

## References

**Live Data (2025-10-26):**
- `/tmp/forge-profiles-raw.json` - Full Forge API response
- `/tmp/executor-defaults-comparison.json` - Executor comparison table
- `/tmp/forge-profile-structure-analysis.md` - Complete analysis

**Code References:**
- `.genie/cli/src/lib/agent-registry.ts` - Agent scanning and profile generation
- `.genie/mcp/src/lib/role-detector.ts` - Neuron read-only enforcement
- `.genie/neurons/*.md` - Neuron configuration examples

**API Reference:**
- `GET http://localhost:8887/api/profiles` - Retrieve current profiles
- `PUT http://localhost:8887/api/profiles` - Update profiles (auto-synced by agent-registry)
