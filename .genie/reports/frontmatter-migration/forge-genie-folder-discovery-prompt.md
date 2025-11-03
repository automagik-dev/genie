# Forge: .genie Folder Discovery & Consumption Protocol

## Mission

Enable Forge to **discover and consume `.genie` folders from any project**, parsing frontmatter into executor profiles dynamically. This makes Forge project-aware, allowing custom agents/neurons to be defined per-project without hardcoding.

---

## Why This Matters

**Current State:**
- Forge has built-in profiles (hardcoded in backend)
- Genie CLI syncs agent definitions via `syncProfiles()` API
- Sync is centralized, requires CLI intermediary

**Future State:**
- Forge **auto-discovers** `.genie/` in any project workspace
- Frontmatter is **parsed directly** into Forge profiles
- No CLI intermediary needed for project-specific agents
- Enables **per-project customization** (e.g., client X gets custom QA agent)

**Benefits:**
- ✅ Project-scoped agent definitions
- ✅ Frontmatter = single source of truth
- ✅ No sync lag (live discovery)
- ✅ Support multi-project workflows
- ✅ Enable Forge standalone usage (no Genie CLI dependency)

---

## Architecture Overview

### 1. .genie Folder Structure

```
<project-root>/.genie/
│
├── agents/                     # Global agents (no collective)
│   ├── wish.md
│   ├── forge.md
│   └── review.md
│
├── code/                       # Code collective
│   ├── AGENTS.md               # Collective marker (presence = collective exists)
│   └── agents/
│       ├── implementor.md
│       ├── tests.md
│       ├── polish.md
│       └── refactor.md
│
├── create/                     # Create collective
│   ├── AGENTS.md               # Collective marker
│   └── agents/
│       ├── writer.md
│       ├── editor.md
│       └── researcher.md
│
├── neurons/                    # Persistent orchestrators
│   ├── master.md
│   ├── wish.md
│   └── forge.md
│
└── spells/                     # Reusable knowledge (not agents)
    ├── know-yourself.md
    ├── ace-protocol.md
    └── forge-orchestration.md
```

**Discovery Rules:**
1. **Collective detection**: Directory with `AGENTS.md` file = collective
2. **Agent directories**: `<collective>/agents/*.md` OR `.genie/agents/*.md`
3. **Neuron directory**: `.genie/neurons/*.md` (always global)
4. **Ignore**: spells/, workflows/, state/, reports/, backups/, cli/, mcp/, product/

---

### 2. Frontmatter Schema

#### **Agent Frontmatter** (`.genie/agents/` or `.genie/<collective>/agents/`)

```yaml
---
name: implementor                         # Required: agent identifier
description: End-to-end feature implementation with TDD discipline  # Required
color: green                              # Optional: UI color hint
emoji: 🛠️                                 # Optional: display emoji
forge_profile_name: CODE_IMPLEMENTOR      # Optional: explicit Forge profile name override
genie:                                    # Optional: execution config
  executor: CLAUDE_CODE                   # Required: CLAUDE_CODE | CODEX | GEMINI | etc.
  executorVariant: DEFAULT                # Optional: profile variant name
  model: sonnet                           # Optional: model name (sonnet, opus-4, haiku)
  background: true                        # Optional: run in background mode
  dangerously_skip_permissions: false     # Optional: CLAUDE_CODE only
  sandbox: read-only                      # Optional: CODEX only
  dangerously_allow_all: false            # Optional: AMP only
  model_reasoning_effort: medium          # Optional: CODEX only
---

# Agent instructions (markdown body)
Your mission is...
```

**Required Fields:**
- `name` - Agent identifier (used for namespacing)
- `description` - One-line purpose

**Optional Fields:**
- `color`, `emoji` - UI hints (not sent to Forge)
- `forge_profile_name` - Override derived profile name
- `genie.*` - Execution configuration (executor-specific)

#### **Neuron Frontmatter** (`.genie/neurons/`)

```yaml
---
name: MASTER                              # Required: neuron identifier
description: Persistent master orchestrator (neuron)  # Required
genie:
  executor: CLAUDE_CODE
  model: opus-4
  background: true
  dangerously_skip_permissions: true
---

# Neuron instructions (markdown body)
You are the persistent master orchestrator...
```

**Differences from Agents:**
- No `collective` field (neurons are always global)
- `type: 'neuron'` auto-set by scanner
- Persistent WebSocket connections (not task-based)

#### **Spell Frontmatter** (`.genie/spells/`)

```yaml
---
name: Know Yourself (Token Efficiency Through Self-Awareness)
description: Understand your role as orchestrator and capabilities
---

# Spell content (markdown body)
You are Master Genie...
```

**Note:** Spells are **NOT agents**. They're reusable knowledge loaded via `mcp__genie__read_spell`. Don't sync to Forge as profiles.

---

### 3. Frontmatter → Forge Profile Mapping

| **Frontmatter Field** | **Forge Profile Field** | **Notes** |
|----------------------|------------------------|-----------|
| `name` | Variant name (derived) | Uppercase, sanitized: `code/implementor` → `CODE_IMPLEMENTOR` |
| `forge_profile_name` | Variant name (override) | Explicit override: `forge_profile_name: "CUSTOM"` → `CUSTOM` |
| `description` | Not sent | Documentation only (Forge doesn't store descriptions) |
| `genie.executor` | `executors.<EXECUTOR>.<VARIANT>` | Profile executor key |
| `genie.executorVariant` | Variant name modifier | Allows multiple variants per agent |
| `genie.model` | `variantConfig.model` | Model name (only set on default executor) |
| `genie.background` | `variantConfig.background` | `true` = background execution |
| `genie.dangerously_skip_permissions` | `variantConfig.dangerously_skip_permissions` | CLAUDE_CODE only |
| `genie.sandbox` | `variantConfig.sandbox` | CODEX only: `'danger-full-access'` \| `'read-only'` \| `'safe'` |
| `genie.dangerously_allow_all` | `variantConfig.dangerously_allow_all` | AMP only |
| `genie.model_reasoning_effort` | `variantConfig.model_reasoning_effort` | CODEX only: `'low'` \| `'medium'` \| `'high'` |
| `collective` (derived from path) | Used in variant naming | `code` → `CODE_`, `create` → `CREATE_`, none → no prefix |
| Markdown body | `variantConfig.append_prompt` | Full instructions (with collective context prepended) |

**Naming Convention:**
```typescript
// Agents with collectives
"code/implementor" → "CODE_IMPLEMENTOR"
"create/writer" → "CREATE_WRITER"

// Global agents (no collective)
"agents/wish" → "WISH"

// Neurons (no collective prefix)
"neurons/master" → "MASTER"
"neurons/forge" → "FORGE"

// Explicit override
forge_profile_name: "CUSTOM_NAME" → "CUSTOM_NAME"
```

---

## Discovery Algorithm

### Step 1: Scan for .genie Folder

```typescript
async function discoverGenieFolder(workspaceRoot: string): Promise<string | null> {
  const geniePath = path.join(workspaceRoot, '.genie');

  // Check if .genie exists and is a directory
  if (!fs.existsSync(geniePath) || !fs.statSync(geniePath).isDirectory()) {
    return null;
  }

  return geniePath;
}
```

### Step 2: Discover Collectives

**Rule:** A directory with `AGENTS.md` file = collective

```typescript
interface Collective {
  id: string;           // 'code', 'create', etc.
  root: string;         // '/path/to/.genie/code'
  agentsDir: string;    // '/path/to/.genie/code/agents'
  contextFile: string;  // '/path/to/.genie/code/AGENTS.md'
}

async function discoverCollectives(genieRoot: string): Promise<Collective[]> {
  const collectives: Collective[] = [];
  const maxDepth = 2; // Don't scan too deep

  // Directories to ignore
  const ignoreDirs = new Set([
    'agents', 'workflows', 'skills', 'backups', 'cli', 'mcp',
    'product', 'reports', 'state', 'spells', 'neurons',
    'node_modules', '.git'
  ]);

  // Scan .genie/ for directories with AGENTS.md
  const entries = await fs.readdir(genieRoot, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || ignoreDirs.has(entry.name)) continue;

    const collectiveRoot = path.join(genieRoot, entry.name);
    const agentsFile = path.join(collectiveRoot, 'AGENTS.md');

    // Check if AGENTS.md exists (marker for collective)
    if (fs.existsSync(agentsFile)) {
      collectives.push({
        id: entry.name,                                  // 'code', 'create'
        root: collectiveRoot,                            // '/path/.genie/code'
        agentsDir: path.join(collectiveRoot, 'agents'), // '/path/.genie/code/agents'
        contextFile: agentsFile                         // '/path/.genie/code/AGENTS.md'
      });
    }
  }

  return collectives;
}
```

### Step 3: Scan Agent/Neuron Files

```typescript
interface AgentFile {
  name: string;         // 'implementor'
  filePath: string;     // '/path/.genie/code/agents/implementor.md'
  collective: string | null;  // 'code' | 'create' | null
  type: 'agent' | 'neuron';
  namespacedKey: string;  // 'code/implementor' or 'neuron/master'
}

async function scanAgentFiles(genieRoot: string, collectives: Collective[]): Promise<AgentFile[]> {
  const files: AgentFile[] = [];

  // 1. Scan global agents (.genie/agents/)
  const globalAgentsDir = path.join(genieRoot, 'agents');
  if (fs.existsSync(globalAgentsDir)) {
    const agentFiles = await glob('*.md', { cwd: globalAgentsDir });
    for (const file of agentFiles) {
      const name = path.basename(file, '.md');
      files.push({
        name,
        filePath: path.join(globalAgentsDir, file),
        collective: null,
        type: 'agent',
        namespacedKey: `agents/${name}`
      });
    }
  }

  // 2. Scan collective agents
  for (const collective of collectives) {
    if (!fs.existsSync(collective.agentsDir)) continue;

    const agentFiles = await glob('**/*.md', { cwd: collective.agentsDir });
    for (const file of agentFiles) {
      const name = path.basename(file, '.md');
      files.push({
        name,
        filePath: path.join(collective.agentsDir, file),
        collective: collective.id,
        type: 'agent',
        namespacedKey: `${collective.id}/${name}`
      });
    }
  }

  // 3. Scan neurons (.genie/neurons/)
  const neuronsDir = path.join(genieRoot, 'neurons');
  if (fs.existsSync(neuronsDir)) {
    const neuronFiles = await glob('*.md', { cwd: neuronsDir });
    for (const file of neuronFiles) {
      const name = path.basename(file, '.md');
      files.push({
        name,
        filePath: path.join(neuronsDir, file),
        collective: null,
        type: 'neuron',
        namespacedKey: `neuron/${name}`
      });
    }
  }

  return files;
}
```

### Step 4: Parse Frontmatter & Markdown Body

```typescript
import yaml from 'yaml';

interface ParsedAgent {
  meta: AgentMetadata;    // Frontmatter fields
  instructions: string;   // Markdown body (after frontmatter)
  filePath: string;
}

interface AgentMetadata {
  name: string;
  description?: string;
  color?: string;
  emoji?: string;
  forge_profile_name?: string;
  genie?: {
    executor?: string;
    executorVariant?: string;
    model?: string;
    background?: boolean;
    dangerously_skip_permissions?: boolean;
    sandbox?: string;
    dangerously_allow_all?: boolean;
    model_reasoning_effort?: string;
  };
  collective?: string | null;
  type: 'agent' | 'neuron';
  namespacedKey: string;
}

function extractFrontMatter(content: string): { meta: any; body: string } {
  const frontMatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
  const match = content.match(frontMatterRegex);

  if (!match) {
    return { meta: {}, body: content };
  }

  const [, frontMatter, body] = match;
  const meta = yaml.parse(frontMatter);

  return { meta, body: body.trim() };
}

async function parseAgentFile(file: AgentFile): Promise<ParsedAgent> {
  const content = await fs.readFile(file.filePath, 'utf-8');
  const { meta, body } = extractFrontMatter(content);

  // Build full metadata
  const agentMeta: AgentMetadata = {
    name: meta.name || file.name,
    description: meta.description,
    color: meta.color,
    emoji: meta.emoji,
    forge_profile_name: meta.forge_profile_name,
    genie: meta.genie,
    collective: file.collective,
    type: file.type,
    namespacedKey: file.namespacedKey
  };

  return {
    meta: agentMeta,
    instructions: body,
    filePath: file.filePath
  };
}
```

### Step 5: Load Collective Context

**Rule:** For agents in collectives, prepend the collective's `AGENTS.md` content

```typescript
async function loadCollectiveContext(
  collective: Collective | null
): Promise<string> {
  if (!collective) return ''; // Global agents/neurons have no collective context

  const contextContent = await fs.readFile(collective.contextFile, 'utf-8');

  // Remove frontmatter if present
  const { body } = extractFrontMatter(contextContent);

  return body;
}
```

### Step 6: Generate Forge Profile

```typescript
interface ForgeProfile {
  executors: {
    [executor: string]: {
      [variantName: string]: {
        [executor: string]: {
          append_prompt: string;
          model?: string;
          background?: boolean;
          dangerously_skip_permissions?: boolean;
          sandbox?: string;
          dangerously_allow_all?: boolean;
          model_reasoning_effort?: string;
        }
      }
    }
  }
}

async function generateForgeProfile(
  agent: ParsedAgent,
  collectiveContext: string
): Promise<ForgeProfile> {
  const { meta, instructions } = agent;

  // Determine profile variant name
  const variantName = meta.forge_profile_name || deriveVariantName(meta);

  // Determine executor
  const executor = meta.genie?.executor || 'CLAUDE_CODE';

  // Build append_prompt (collective context + agent instructions)
  const appendPrompt = collectiveContext
    ? `${collectiveContext}\n\n---\n\n${instructions}`
    : instructions;

  // Build variant config
  const variantConfig: any = {
    append_prompt: appendPrompt
  };

  // Add executor-specific fields
  if (meta.genie?.model) {
    variantConfig.model = meta.genie.model;
  }
  if (meta.genie?.background !== undefined) {
    variantConfig.background = meta.genie.background;
  }
  if (meta.genie?.dangerously_skip_permissions !== undefined) {
    variantConfig.dangerously_skip_permissions = meta.genie.dangerously_skip_permissions;
  }
  if (meta.genie?.sandbox) {
    variantConfig.sandbox = meta.genie.sandbox;
  }
  if (meta.genie?.dangerously_allow_all !== undefined) {
    variantConfig.dangerously_allow_all = meta.genie.dangerously_allow_all;
  }
  if (meta.genie?.model_reasoning_effort) {
    variantConfig.model_reasoning_effort = meta.genie.model_reasoning_effort;
  }

  // Build profile structure
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

function deriveVariantName(meta: AgentMetadata): string {
  // Neurons: NAME (uppercase)
  if (meta.type === 'neuron') {
    return meta.name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  }

  // Agents with collective: COLLECTIVE_NAME
  if (meta.collective) {
    const collectivePrefix = meta.collective.toUpperCase();
    const agentName = meta.name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    return `${collectivePrefix}_${agentName}`;
  }

  // Global agents: NAME
  return meta.name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}
```

---

## Full Discovery Pipeline

```typescript
async function discoverAndLoadGenieProfiles(workspaceRoot: string): Promise<ForgeProfile> {
  // Step 1: Find .genie folder
  const genieRoot = await discoverGenieFolder(workspaceRoot);
  if (!genieRoot) {
    console.log('No .genie folder found in workspace');
    return { executors: {} };
  }

  // Step 2: Discover collectives
  const collectives = await discoverCollectives(genieRoot);
  console.log(`Found ${collectives.length} collectives: ${collectives.map(c => c.id).join(', ')}`);

  // Step 3: Scan agent/neuron files
  const agentFiles = await scanAgentFiles(genieRoot, collectives);
  console.log(`Found ${agentFiles.length} agent/neuron files`);

  // Step 4: Parse and generate profiles
  const profiles: ForgeProfile[] = [];

  for (const file of agentFiles) {
    // Parse frontmatter + body
    const agent = await parseAgentFile(file);

    // Load collective context (if applicable)
    const collective = collectives.find(c => c.id === file.collective);
    const collectiveContext = await loadCollectiveContext(collective || null);

    // Generate Forge profile
    const profile = await generateForgeProfile(agent, collectiveContext);
    profiles.push(profile);

    console.log(`✓ Loaded ${agent.meta.namespacedKey} → ${deriveVariantName(agent.meta)}`);
  }

  // Step 5: Merge all profiles
  return mergeProfiles(profiles);
}

function mergeProfiles(profiles: ForgeProfile[]): ForgeProfile {
  const merged: ForgeProfile = { executors: {} };

  for (const profile of profiles) {
    for (const [executor, variants] of Object.entries(profile.executors)) {
      if (!merged.executors[executor]) {
        merged.executors[executor] = {};
      }

      for (const [variantName, variantConfig] of Object.entries(variants)) {
        merged.executors[executor][variantName] = variantConfig;
      }
    }
  }

  return merged;
}
```

---

## Change Detection & Caching

**Problem:** Parsing 40+ agents on every startup is slow and wasteful.

**Solution:** Content-based change detection using SHA-256 hashes.

### Cache Structure

```json
// .genie/state/agent-sync-cache.json
{
  "version": 1,
  "lastSync": "2025-01-03T12:34:56.789Z",
  "agentHashes": {
    "code/implementor": "abc123...",
    "create/writer": "def456...",
    "neuron/master": "789ghi..."
  },
  "executors": ["CLAUDE_CODE", "CODEX", "GEMINI"]
}
```

### Change Detection Algorithm

```typescript
async function detectChanges(
  agentFiles: AgentFile[],
  cachePath: string
): Promise<{
  added: AgentFile[];
  modified: AgentFile[];
  removed: string[];
}> {
  // Load cache
  const cache = await loadCache(cachePath);

  const currentHashes: Record<string, string> = {};
  const added: AgentFile[] = [];
  const modified: AgentFile[] = [];

  // Compute hashes for current agents
  for (const file of agentFiles) {
    const content = await fs.readFile(file.filePath, 'utf-8');
    const { body } = extractFrontMatter(content);
    const hash = computeHash(body); // SHA-256 of markdown body only

    currentHashes[file.namespacedKey] = hash;

    // Check if new or modified
    if (!cache.agentHashes[file.namespacedKey]) {
      added.push(file);
    } else if (cache.agentHashes[file.namespacedKey] !== hash) {
      modified.push(file);
    }
  }

  // Detect removed agents
  const removed = Object.keys(cache.agentHashes).filter(
    key => !currentHashes[key]
  );

  return { added, modified, removed };
}

function computeHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
```

### Incremental Sync

```typescript
async function syncChangedAgents(
  added: AgentFile[],
  modified: AgentFile[],
  removed: string[],
  collectives: Collective[]
): Promise<void> {
  const changed = [...added, ...modified];

  if (changed.length === 0 && removed.length === 0) {
    console.log('No changes detected, skipping sync');
    return;
  }

  console.log(`Syncing ${changed.length} changed agents, removing ${removed.length} orphaned profiles`);

  // Load current Forge profiles (includes built-ins)
  const currentProfiles = await forgeClient.getProfiles();

  // Generate profiles for changed agents
  for (const file of changed) {
    const agent = await parseAgentFile(file);
    const collective = collectives.find(c => c.id === file.collective);
    const collectiveContext = await loadCollectiveContext(collective || null);
    const profile = await generateForgeProfile(agent, collectiveContext);

    // Merge into current profiles
    mergeProfile(currentProfiles, profile);
  }

  // Remove orphaned profiles
  for (const namespacedKey of removed) {
    const variantName = deriveVariantNameFromKey(namespacedKey);
    deleteProfile(currentProfiles, variantName);
  }

  // Sync to Forge (one agent at a time to avoid 2MB limit)
  await forgeClient.putProfiles(currentProfiles);

  // Update cache
  await updateCache(cachePath, changed, removed);
}
```

---

## Error Handling & Validation

### Frontmatter Validation

```typescript
function validateAgentMeta(meta: AgentMetadata, filePath: string): void {
  const errors: string[] = [];

  // Required fields
  if (!meta.name) {
    errors.push('Missing required field: name');
  }

  // Executor validation
  const validExecutors = [
    'CLAUDE_CODE', 'CODEX', 'GEMINI', 'CURSOR',
    'QWEN_CODE', 'AMP', 'OPENCODE', 'COPILOT'
  ];
  if (meta.genie?.executor && !validExecutors.includes(meta.genie.executor)) {
    errors.push(`Invalid executor: ${meta.genie.executor}`);
  }

  // Executor-specific field validation
  if (meta.genie?.sandbox && meta.genie.executor !== 'CODEX') {
    errors.push('Field "sandbox" is only valid for CODEX executor');
  }

  if (meta.genie?.dangerously_skip_permissions && meta.genie.executor !== 'CLAUDE_CODE') {
    errors.push('Field "dangerously_skip_permissions" is only valid for CLAUDE_CODE executor');
  }

  if (errors.length > 0) {
    throw new Error(`Validation errors in ${filePath}:\n${errors.join('\n')}`);
  }
}
```

### File Read Errors

```typescript
async function safeParseAgentFile(file: AgentFile): Promise<ParsedAgent | null> {
  try {
    return await parseAgentFile(file);
  } catch (error) {
    console.error(`Failed to parse ${file.filePath}: ${error.message}`);
    return null; // Skip broken agents, continue processing others
  }
}
```

---

## Performance Optimizations

### 1. Lazy Loading
- Don't load all agents on startup
- Load on-demand when user selects an agent
- Cache parsed results in memory

### 2. Parallel Processing
```typescript
const agents = await Promise.all(
  agentFiles.map(file => safeParseAgentFile(file))
);
```

### 3. File Watching
- Watch `.genie/**/*.md` for changes
- Invalidate cache on file modification
- Hot-reload profiles without restart

### 4. Incremental Sync
- Only sync changed agents (not all 40+ every time)
- Use content hashes for change detection
- Preserve built-in profiles (merge strategy)

---

## Testing Strategy

### Unit Tests

```typescript
describe('Genie Folder Discovery', () => {
  it('should discover collectives by AGENTS.md marker', async () => {
    const collectives = await discoverCollectives('/path/.genie');
    expect(collectives).toHaveLength(2);
    expect(collectives.map(c => c.id)).toEqual(['code', 'create']);
  });

  it('should ignore non-collective directories', async () => {
    const collectives = await discoverCollectives('/path/.genie');
    expect(collectives.find(c => c.id === 'spells')).toBeUndefined();
  });

  it('should parse frontmatter correctly', () => {
    const content = `---
name: test
description: Test agent
genie:
  executor: CLAUDE_CODE
  model: sonnet
---
# Instructions
Do the thing`;

    const { meta, body } = extractFrontMatter(content);
    expect(meta.name).toBe('test');
    expect(meta.genie.executor).toBe('CLAUDE_CODE');
    expect(body).toContain('# Instructions');
  });

  it('should generate correct variant names', () => {
    expect(deriveVariantName({ name: 'implementor', collective: 'code', type: 'agent' }))
      .toBe('CODE_IMPLEMENTOR');
    expect(deriveVariantName({ name: 'master', collective: null, type: 'neuron' }))
      .toBe('MASTER');
  });
});
```

### Integration Tests

```typescript
describe('End-to-End Discovery', () => {
  it('should discover and load all agents from .genie folder', async () => {
    const profile = await discoverAndLoadGenieProfiles('/path/to/project');

    expect(profile.executors.CLAUDE_CODE).toBeDefined();
    expect(profile.executors.CLAUDE_CODE.CODE_IMPLEMENTOR).toBeDefined();
    expect(profile.executors.CLAUDE_CODE.CREATE_WRITER).toBeDefined();
    expect(profile.executors.CLAUDE_CODE.MASTER).toBeDefined();
  });

  it('should prepend collective context to agent instructions', async () => {
    const profile = await discoverAndLoadGenieProfiles('/path/to/project');
    const implementor = profile.executors.CLAUDE_CODE.CODE_IMPLEMENTOR.CLAUDE_CODE;

    expect(implementor.append_prompt).toContain('Code Collective'); // From .genie/code/AGENTS.md
    expect(implementor.append_prompt).toContain('---'); // Separator
    expect(implementor.append_prompt).toContain('End-to-end feature'); // From agent body
  });
});
```

---

## Implementation Checklist

### Phase 1: Discovery (Week 1)
- [ ] Implement `discoverGenieFolder()`
- [ ] Implement `discoverCollectives()`
- [ ] Implement `scanAgentFiles()`
- [ ] Add unit tests for discovery logic
- [ ] Test on automagik-genie repo

### Phase 2: Parsing (Week 2)
- [ ] Implement `extractFrontMatter()`
- [ ] Implement `parseAgentFile()`
- [ ] Implement `loadCollectiveContext()`
- [ ] Add frontmatter validation
- [ ] Test on sample agents

### Phase 3: Profile Generation (Week 3)
- [ ] Implement `generateForgeProfile()`
- [ ] Implement `deriveVariantName()`
- [ ] Implement profile merging
- [ ] Add executor-specific field mapping
- [ ] Test profile output matches expected format

### Phase 4: Change Detection (Week 4)
- [ ] Implement cache loading/saving
- [ ] Implement `detectChanges()`
- [ ] Implement `computeHash()`
- [ ] Add incremental sync logic
- [ ] Test cache invalidation

### Phase 5: Integration (Week 5)
- [ ] Integrate discovery into Forge startup
- [ ] Add file watching for live reload
- [ ] Add performance monitoring
- [ ] Test on multiple projects
- [ ] Document usage in Forge README

### Phase 6: Polish (Week 6)
- [ ] Add error handling for broken agents
- [ ] Add logging for debugging
- [ ] Add CLI command: `forge sync-agents`
- [ ] Add UI for viewing discovered agents
- [ ] Write migration guide for existing users

---

## Example Usage

### CLI Command

```bash
# Auto-discover .genie folder in current workspace
forge sync-agents

# Discover from specific path
forge sync-agents --workspace /path/to/project

# Dry-run (show what would be synced)
forge sync-agents --dry-run

# Force full sync (ignore cache)
forge sync-agents --force
```

### API Endpoint

```typescript
// POST /api/agents/discover
{
  "workspaceRoot": "/path/to/project"
}

// Response
{
  "discovered": 42,
  "collectives": ["code", "create"],
  "agents": [
    { "name": "implementor", "collective": "code", "variant": "CODE_IMPLEMENTOR" },
    { "name": "writer", "collective": "create", "variant": "CREATE_WRITER" }
  ],
  "neurons": [
    { "name": "master", "variant": "MASTER" }
  ]
}
```

---

## Success Metrics

**Functionality:**
- ✅ Discover all 40+ agents from automagik-genie
- ✅ Parse frontmatter with 100% accuracy
- ✅ Generate correct Forge profiles (match current sync output)
- ✅ Detect changes within 1 second of file modification
- ✅ Hot-reload profiles without Forge restart

**Performance:**
- ✅ Initial discovery: < 500ms (for 40+ agents)
- ✅ Incremental sync: < 100ms (changed agents only)
- ✅ Memory usage: < 50MB (cached agents)

**Reliability:**
- ✅ Handle malformed frontmatter gracefully
- ✅ Skip broken agents, continue processing others
- ✅ Validate executor-specific fields
- ✅ Prevent duplicate variant names

---

## Questions to Resolve

1. **Cache location**: `.genie/state/agent-sync-cache.json` or Forge's DB?
2. **Sync strategy**: Auto-sync on startup or manual command?
3. **Multi-project**: Support multiple .genie folders simultaneously?
4. **Backwards compat**: Support legacy agent formats during migration?
5. **File watching**: Use chokidar or OS-native watchers?
6. **Error recovery**: Retry failed syncs or require manual intervention?

---

## References

**Source Code (automagik-genie):**
- `src/cli/lib/agent-resolver.ts` - Discovery logic
- `src/cli/lib/agent-registry.ts` - Parsing & metadata
- `src/cli/lib/forge-executor.ts` - Sync orchestration
- `src/lib/forge-client.js` - Forge API client

**Documentation:**
- `.genie/agents/README.md` - Agent architecture
- `.genie/neurons/README.md` - Neuron architecture
- `AGENTS.md` - Core framework

**Test Data:**
- `.genie/code/agents/implementor.md` - Sample agent
- `.genie/neurons/master.md` - Sample neuron
- `.genie/code/AGENTS.md` - Collective context example
