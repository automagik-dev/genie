# Corrected .genie Frontmatter Schema (Forge-Aligned)

## Problem Identified

**Current Issue:** Genie's frontmatter includes `background` (a Genie orchestration setting) mixed with Forge executor settings, causing confusion about what's actually synced to Forge.

**Root Cause:** No clear separation between:
- **Genie orchestration settings** (how Genie runs tasks: background/foreground, variants, routing)
- **Forge executor settings** (what gets synced to Forge profiles: model, permissions, sandbox)

---

## Solution: Split Frontmatter into Two Namespaces

### 1. `genie` Namespace (Orchestration - NOT synced to Forge)

```yaml
genie:
  executor: CLAUDE_CODE              # Which executor to use (required for routing)
  variant: DEFAULT                   # Which Forge profile variant to use at runtime
  background: true                   # Run in isolated worktree (Genie orchestration only)
```

**Fields:**
- `executor` (string, required): Which executor to invoke (CLAUDE_CODE, CODEX, etc.)
- `variant` (string, optional): Which Forge profile variant to use (DEFAULT, custom variant name)
- `background` (boolean, optional): Whether Genie runs this in isolated worktree (default: false)

**Purpose:** Genie uses these fields to decide HOW to run the task, but they're NOT synced to Forge.

---

### 2. `forge` Namespace (Executor Config - SYNCED to Forge)

All fields in `forge.*` map directly to Forge's executor profile schemas.

#### **Universal Fields (All Executors)**

```yaml
forge:
  append_prompt: null                # Managed by Genie (collective context + agent body)
  model: "claude-sonnet-4-5-20250929"  # Override executor's default model
  base_command_override: null        # Override executor's base command
  additional_params: []              # Additional CLI params
```

#### **CLAUDE_CODE Specific**

```yaml
forge:
  claude_code_router: false          # Enable Claude Code router mode
  plan: false                        # Enable plan mode
  approvals: false                   # Enable approval prompts
  dangerously_skip_permissions: false  # Skip permission prompts (dangerous!)
```

**Source:** `/home/namastex/workspace/automagik-forge/shared/types.ts:161`

```typescript
export type ClaudeCode = {
  append_prompt: AppendPrompt,
  claude_code_router?: boolean | null,
  plan?: boolean | null,
  approvals?: boolean | null,
  model?: string | null,
  dangerously_skip_permissions?: boolean | null,
  base_command_override?: string | null,
  additional_params?: Array<string> | null,
};
```

#### **CODEX Specific**

```yaml
forge:
  sandbox: auto                      # auto | read-only | workspace-write | danger-full-access
  ask_for_approval: unless-trusted   # unless-trusted | on-failure | on-request | never
  oss: false                         # Use OSS model
  model_reasoning_effort: medium     # low | medium | high
  model_reasoning_summary: auto      # auto | concise | detailed | none
  model_reasoning_summary_format: none  # none | experimental
  profile: null                      # Codex profile name
  base_instructions: null            # Override base instructions
  include_plan_tool: true            # Include plan tool
  include_apply_patch_tool: true     # Include apply patch tool
```

**Source:** `/home/namastex/workspace/automagik-forge/shared/types.ts:169`

```typescript
export type Codex = {
  append_prompt: AppendPrompt,
  sandbox?: SandboxMode | null,
  ask_for_approval?: AskForApproval | null,
  oss?: boolean | null,
  model?: string | null,
  model_reasoning_effort?: ReasoningEffort | null,
  model_reasoning_summary?: ReasoningSummary | null,
  model_reasoning_summary_format?: ReasoningSummaryFormat | null,
  profile?: string | null,
  base_instructions?: string | null,
  include_plan_tool?: boolean | null,
  include_apply_patch_tool?: boolean | null,
  base_command_override?: string | null,
  additional_params?: Array<string> | null,
};
```

#### **AMP Specific**

```yaml
forge:
  dangerously_allow_all: false       # Allow all commands (dangerous!)
```

**Source:** `/home/namastex/workspace/automagik-forge/shared/types.ts:167`

```typescript
export type Amp = {
  append_prompt: AppendPrompt,
  dangerously_allow_all?: boolean | null,
  base_command_override?: string | null,
  additional_params?: Array<string> | null,
};
```

#### **GEMINI Specific**

```yaml
forge:
  model: default                     # default | flash
  yolo: false                        # YOLO mode
```

**Source:** `/home/namastex/workspace/automagik-forge/shared/types.ts:163`

```typescript
export type Gemini = {
  append_prompt: AppendPrompt,
  model: GeminiModel,  // "default" | "flash"
  yolo?: boolean | null,
  base_command_override?: string | null,
  additional_params?: Array<string> | null,
};
```

#### **CURSOR_AGENT Specific**

```yaml
forge:
  force: false                       # Force mode
  model: null                        # Model override
```

**Source:** `/home/namastex/workspace/automagik-forge/shared/types.ts:181`

```typescript
export type CursorAgent = {
  append_prompt: AppendPrompt,
  force?: boolean | null,
  model?: string | null,
  base_command_override?: string | null,
  additional_params?: Array<string> | null,
};
```

#### **COPILOT Specific**

```yaml
forge:
  model: null                        # Model override
  allow_all_tools: false             # Allow all tools
  allow_tool: null                   # Allow specific tool
  deny_tool: null                    # Deny specific tool
  add_dir: []                        # Additional directories
  disable_mcp_server: []             # Disabled MCP servers
```

**Source:** `/home/namastex/workspace/automagik-forge/shared/types.ts:183`

```typescript
export type Copilot = {
  append_prompt: AppendPrompt,
  model?: string | null,
  allow_all_tools?: boolean | null,
  allow_tool?: string | null,
  deny_tool?: string | null,
  add_dir?: Array<string> | null,
  disable_mcp_server?: Array<string> | null,
  base_command_override?: string | null,
  additional_params?: Array<string> | null,
};
```

#### **OPENCODE Specific**

```yaml
forge:
  model: null                        # Model override
  agent: null                        # Agent name
```

**Source:** `/home/namastex/workspace/automagik-forge/shared/types.ts:185`

```typescript
export type Opencode = {
  append_prompt: AppendPrompt,
  model?: string | null,
  agent?: string | null,
  base_command_override?: string | null,
  additional_params?: Array<string> | null,
};
```

#### **QWEN_CODE Specific**

```yaml
forge:
  yolo: false                        # YOLO mode
```

**Source:** `/home/namastex/workspace/automagik-forge/shared/types.ts:187`

```typescript
export type QwenCode = {
  append_prompt: AppendPrompt,
  yolo?: boolean | null,
  base_command_override?: string | null,
  additional_params?: Array<string> | null,
};
```

---

## Complete Frontmatter Example

### Before (Mixed Namespaces - WRONG)

```yaml
---
name: implementor
description: End-to-end feature implementation
genie:
  executor: CLAUDE_CODE              # ✅ Genie orchestration
  variant: DEFAULT                   # ✅ Genie orchestration
  background: true                   # ✅ Genie orchestration
  model: sonnet                      # ❌ Forge setting (wrong namespace!)
  dangerously_skip_permissions: false  # ❌ Forge setting (wrong namespace!)
---
```

### After (Separated Namespaces - CORRECT)

```yaml
---
name: implementor
description: End-to-end feature implementation
genie:
  executor: CLAUDE_CODE              # Genie routing (which executor to use)
  variant: DEFAULT                   # Genie routing (which Forge profile variant)
  background: true                   # Genie orchestration (isolated worktree)
forge:
  model: claude-sonnet-4-5-20250929  # Forge setting (synced to profile)
  dangerously_skip_permissions: false  # Forge setting (synced to profile)
  claude_code_router: false          # Forge setting (CLAUDE_CODE specific)
  plan: false                        # Forge setting (CLAUDE_CODE specific)
---
```

### CODEX Example

```yaml
---
name: tests
description: Test generator with high reasoning
genie:
  executor: CODEX
  background: true
forge:
  model: o1-mini
  sandbox: workspace-write           # Allow writes to workspace
  ask_for_approval: on-failure       # Only ask when sandbox fails
  model_reasoning_effort: high       # Deep reasoning for test generation
  model_reasoning_summary: detailed  # Show detailed reasoning
  include_plan_tool: true            # Enable planning
---
```

---

## Migration Path

### Step 1: Update Genie Agent Registry (Read Logic)

**File:** `src/cli/lib/agent-registry.ts`

**Change:**
```typescript
// OLD: Read from genie.* for everything
const model = meta.genie?.model;
const permissions = meta.genie?.dangerously_skip_permissions;

// NEW: Read orchestration from genie.*, Forge settings from forge.*
const model = meta.forge?.model || meta.genie?.model; // Fallback for legacy
const permissions = meta.forge?.dangerously_skip_permissions || meta.genie?.dangerously_skip_permissions;
const background = meta.genie?.background ?? false;  // Genie-only setting
```

### Step 2: Update Forge Profile Generation (Write Logic)

**File:** `src/cli/lib/agent-registry.ts:441-469`

**Change:**
```typescript
// OLD: Pull from genie.* namespace
const variantConfig = {
  append_prompt: fullContent,
  ...(agent.genie?.model && { model: agent.genie.model }),
  ...(agent.genie?.background !== undefined && { background: agent.genie.background }), // ❌ WRONG
};

// NEW: Pull from forge.* namespace
const variantConfig = {
  append_prompt: fullContent,
  // Merge all forge.* fields directly (they map 1:1 to Forge schema)
  ...agent.forge,
};
```

### Step 3: Update Agent Files (Frontmatter Migration)

**Script:** `genie helper migrate-frontmatter`

```bash
# Auto-migrate all agents to new schema
genie helper migrate-frontmatter .genie/

# Output:
# ✓ Migrated .genie/code/agents/implementor.md (moved 2 fields: genie.model → forge.model)
# ✓ Migrated .genie/code/agents/tests.md (moved 5 fields)
# ⚠ .genie/code/agents/polish.md has no genie.* fields to migrate
```

### Step 4: Add Validation

**File:** `src/cli/lib/agent-registry.ts`

```typescript
function validateFrontmatter(agent: AgentMetadata, filePath: string) {
  const errors: string[] = [];

  // Check for legacy fields in wrong namespace
  const legacyForgeFields = [
    'model', 'sandbox', 'dangerously_skip_permissions', 'dangerously_allow_all',
    'model_reasoning_effort', 'claude_code_router', 'plan', 'approvals'
  ];

  for (const field of legacyForgeFields) {
    if (agent.genie?.[field] !== undefined) {
      errors.push(`Field "genie.${field}" should be "forge.${field}" (Forge setting, not Genie orchestration)`);
    }
  }

  // Check for Genie-only fields in forge namespace
  if (agent.forge?.background !== undefined) {
    errors.push('Field "forge.background" should be "genie.background" (Genie orchestration, not Forge setting)');
  }

  if (errors.length > 0) {
    console.warn(`⚠️  Frontmatter issues in ${filePath}:\n${errors.join('\n')}`);
  }
}
```

---

## Updated Forge Discovery Prompt

### Frontmatter Parsing (Corrected)

```typescript
interface AgentMetadata {
  name: string;
  description?: string;

  // Genie orchestration (NOT synced to Forge)
  genie?: {
    executor?: string;       // CLAUDE_CODE, CODEX, etc. (routing)
    variant?: string;        // DEFAULT, custom variant (routing)
    background?: boolean;    // Isolated worktree (orchestration)
  };

  // Forge executor settings (SYNCED to Forge)
  forge?: {
    // Universal
    append_prompt?: string | null;  // Managed by Genie (don't set manually)
    model?: string | null;
    base_command_override?: string | null;
    additional_params?: string[] | null;

    // CLAUDE_CODE specific
    claude_code_router?: boolean | null;
    plan?: boolean | null;
    approvals?: boolean | null;
    dangerously_skip_permissions?: boolean | null;

    // CODEX specific
    sandbox?: 'auto' | 'read-only' | 'workspace-write' | 'danger-full-access' | null;
    ask_for_approval?: 'unless-trusted' | 'on-failure' | 'on-request' | 'never' | null;
    oss?: boolean | null;
    model_reasoning_effort?: 'low' | 'medium' | 'high' | null;
    model_reasoning_summary?: 'auto' | 'concise' | 'detailed' | 'none' | null;
    model_reasoning_summary_format?: 'none' | 'experimental' | null;
    profile?: string | null;
    base_instructions?: string | null;
    include_plan_tool?: boolean | null;
    include_apply_patch_tool?: boolean | null;

    // AMP specific
    dangerously_allow_all?: boolean | null;

    // GEMINI specific
    // model: 'default' | 'flash'  // Using universal model field
    yolo?: boolean | null;

    // CURSOR_AGENT specific
    force?: boolean | null;

    // COPILOT specific
    allow_all_tools?: boolean | null;
    allow_tool?: string | null;
    deny_tool?: string | null;
    add_dir?: string[] | null;
    disable_mcp_server?: string[] | null;

    // OPENCODE specific
    agent?: string | null;

    // QWEN_CODE specific
    // yolo?: boolean | null;  // Same as GEMINI
  };
}
```

### Generate Forge Profile (Corrected)

```typescript
async function generateForgeProfile(
  agent: ParsedAgent,
  collectiveContext: string
): Promise<ForgeProfile> {
  const { meta, instructions } = agent;

  // 1. Determine executor and variant
  const executor = meta.genie?.executor || 'CLAUDE_CODE';
  const variantName = deriveVariantName(meta);

  // 2. Build append_prompt (collective context + agent instructions)
  const appendPrompt = collectiveContext
    ? `${collectiveContext}\n\n---\n\n${instructions}`
    : instructions;

  // 3. Build variant config from forge.* namespace (1:1 mapping to Forge schema)
  const variantConfig: any = {
    append_prompt: appendPrompt,
    ...meta.forge,  // ✅ All forge.* fields map directly to Forge schema
  };

  // 4. Build Forge profile structure
  return {
    executors: {
      [executor]: {
        [variantName]: {
          [executor]: variantConfig
        }
      }
    }
  };
}
```

---

## Benefits of This Approach

### 1. Clear Separation of Concerns
- **`genie.*`** = How Genie runs the task (orchestration layer)
- **`forge.*`** = What executor receives (execution layer)

### 2. Type Safety
- Each executor has its own TypeScript type in Forge
- Frontmatter fields map 1:1 to Forge schemas
- Easy to validate (JSON schema per executor)

### 3. No Magic Transformations
- No field renaming (`background` → ??? nowhere, it stays in Genie)
- No conditional logic ("only sync if executor matches")
- Direct mapping: `forge.model` → Forge's `model` field

### 4. Future-Proof
- New Forge fields = just add to `forge.*`
- New Genie orchestration = just add to `genie.*`
- No refactoring of sync logic

### 5. Self-Documenting
- Agent files show exactly what's orchestration vs execution
- Easy to understand what gets synced to Forge

---

## Quick Reference

### Genie Namespace (Orchestration Only)

| Field | Type | Purpose | Synced to Forge? |
|-------|------|---------|------------------|
| `genie.executor` | string | Which executor to invoke | ❌ No (routing only) |
| `genie.variant` | string | Which Forge profile variant | ❌ No (routing only) |
| `genie.background` | boolean | Run in isolated worktree | ❌ No (Genie orchestration) |

### Forge Namespace (Synced to Forge)

All fields in `forge.*` are synced directly to Forge executor profiles. See executor-specific tables above.

---

## Action Items

1. **Update agent-registry.ts** (read from `forge.*` instead of `genie.*`)
2. **Create migration script** (`genie helper migrate-frontmatter`)
3. **Add validation** (warn on legacy field locations)
4. **Update all agent files** (migrate frontmatter)
5. **Update AGENTS.md docs** (document new schema)
6. **Update Forge discovery prompt** (use corrected schema)
7. **Add TypeScript types** for frontmatter validation
