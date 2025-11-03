# Executive Summary: Forge .genie Discovery

## The Vision

Enable Forge to **auto-discover** `.genie/` folders in any project and **parse frontmatter** directly into executor profiles — eliminating the Genie CLI as an intermediary.

---

## Current Architecture (Genie CLI → Forge)

```
Project/.genie/
  └─ agents/*.md (frontmatter + instructions)
         ↓
  Genie CLI (syncProfiles)
    - Scans .genie/
    - Parses frontmatter
    - Generates Forge profiles
    - Calls Forge API
         ↓
  Forge API (/api/profiles)
    - Receives profiles
    - Stores in database
    - Makes available to executors
```

**Problem:** Requires Genie CLI as intermediary. Forge can't discover project-specific agents independently.

---

## Target Architecture (Forge Native Discovery)

```
Project/.genie/
  └─ agents/*.md (frontmatter + instructions)
         ↓
  Forge (native discovery)
    - Auto-discovers .genie/ in workspace
    - Parses frontmatter directly
    - Loads profiles dynamically
    - No CLI dependency
         ↓
  Available to all executors
```

**Benefits:**
- ✅ **Project-scoped customization** (per-client agents)
- ✅ **No sync lag** (live discovery)
- ✅ **Forge standalone** (works without Genie CLI)
- ✅ **Multi-project support** (different .genie configs per workspace)

---

## Key Concepts

### 1. Discovery Mechanism

**Collective Detection:**
- Directory with `AGENTS.md` file = collective
- Example: `.genie/code/AGENTS.md` → code collective

**Agent Locations:**
- `.genie/agents/` → Global agents (no collective)
- `.genie/code/agents/` → Code collective agents
- `.genie/create/agents/` → Create collective agents
- `.genie/neurons/` → Persistent orchestrators (neurons)

**Ignore Directories:**
- `spells/`, `workflows/`, `state/`, `reports/`, `backups/`, `cli/`, `mcp/`, `product/`

### 2. Frontmatter → Profile Mapping

```yaml
# In: .genie/code/agents/implementor.md
---
name: implementor
description: End-to-end feature implementation
genie:
  executor: CLAUDE_CODE
  model: sonnet
  background: true
---
# Instructions...
```

```json
// Out: Forge profile
{
  "executors": {
    "CLAUDE_CODE": {
      "CODE_IMPLEMENTOR": {  // ← Derived from collective + name
        "CLAUDE_CODE": {
          "append_prompt": "<collective context>\n\n---\n\n<agent body>",
          "model": "sonnet",
          "background": true
        }
      }
    }
  }
}
```

**Naming Convention:**
- Agents: `<COLLECTIVE>_<NAME>` → `CODE_IMPLEMENTOR`
- Neurons: `<NAME>` → `MASTER`
- Override: `forge_profile_name: "CUSTOM"` → `CUSTOM`

### 3. Collective Context Prepending

Agents in collectives inherit the collective's `AGENTS.md` as context:

```
Final append_prompt =
  <.genie/code/AGENTS.md content>

  ---

  <.genie/code/agents/implementor.md content>
```

This gives agents collective-specific knowledge (e.g., code standards, workflows).

### 4. Change Detection

**Cache Structure** (`.genie/state/agent-sync-cache.json`):
```json
{
  "version": 1,
  "lastSync": "2025-01-03T...",
  "agentHashes": {
    "code/implementor": "abc123...",  // SHA-256 of markdown body
    "neuron/master": "def456..."
  }
}
```

**Incremental Sync:**
- Compute SHA-256 hash of each agent's markdown body
- Compare with cached hashes
- Sync only: added, modified, removed
- Skip if no changes (performance optimization)

---

## Implementation Pipeline

### Discovery Algorithm (6 steps)

1. **Scan for .genie/** → Find workspace .genie folder
2. **Discover collectives** → Scan for `AGENTS.md` markers
3. **Scan agent files** → Find all `*.md` in agents/ dirs
4. **Parse frontmatter** → Extract YAML + markdown body
5. **Load collective context** → Read `AGENTS.md` for agents
6. **Generate profiles** → Map frontmatter to Forge executor configs

### Code Structure

```typescript
// 1. Discover .genie folder
const genieRoot = await discoverGenieFolder(workspaceRoot);

// 2. Discover collectives
const collectives = await discoverCollectives(genieRoot);
// Returns: [{ id: 'code', root: '...', agentsDir: '...', contextFile: '...' }]

// 3. Scan agent files
const agentFiles = await scanAgentFiles(genieRoot, collectives);
// Returns: [{ name: 'implementor', filePath: '...', collective: 'code', type: 'agent' }]

// 4. Parse frontmatter
const agents = await Promise.all(agentFiles.map(parseAgentFile));
// Returns: [{ meta: {...}, instructions: '...', filePath: '...' }]

// 5. Load collective context
const context = await loadCollectiveContext(collective);

// 6. Generate Forge profile
const profile = await generateForgeProfile(agent, context);
// Returns: { executors: { CLAUDE_CODE: { CODE_IMPLEMENTOR: {...} } } }
```

---

## Frontmatter Fields Reference

### Agent Frontmatter

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `name` | ✅ | string | Agent identifier (used for namespacing) |
| `description` | ✅ | string | One-line purpose |
| `color` | ❌ | string | UI color hint (not synced to Forge) |
| `emoji` | ❌ | string | Display emoji (not synced to Forge) |
| `forge_profile_name` | ❌ | string | Override derived profile name |
| `genie.executor` | ❌ | string | Executor type (CLAUDE_CODE, CODEX, etc.) |
| `genie.model` | ❌ | string | Model name (sonnet, opus-4, haiku) |
| `genie.background` | ❌ | boolean | Run in background mode |
| `genie.dangerously_skip_permissions` | ❌ | boolean | CLAUDE_CODE only |
| `genie.sandbox` | ❌ | string | CODEX only: 'danger-full-access' \| 'read-only' \| 'safe' |
| `genie.dangerously_allow_all` | ❌ | boolean | AMP only |
| `genie.model_reasoning_effort` | ❌ | string | CODEX only: 'low' \| 'medium' \| 'high' |

### Executor-Specific Fields

**CLAUDE_CODE:**
- `model`, `background`, `dangerously_skip_permissions`

**CODEX:**
- `model`, `background`, `sandbox`, `model_reasoning_effort`

**AMP:**
- `dangerously_allow_all`

**Others (GEMINI, CURSOR, etc.):**
- `model`, `background`

---

## Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| Initial discovery | < 500ms | 40+ agents |
| Incremental sync | < 100ms | Changed agents only |
| Memory usage | < 50MB | Cached agents in memory |
| Cache invalidation | < 1s | File watcher latency |

---

## Testing Strategy

### Unit Tests
- ✅ Collective discovery (AGENTS.md markers)
- ✅ Frontmatter parsing (YAML → metadata)
- ✅ Variant name derivation (collective + name)
- ✅ Profile generation (frontmatter → executor config)
- ✅ Change detection (hash comparison)

### Integration Tests
- ✅ End-to-end discovery (full pipeline)
- ✅ Collective context prepending
- ✅ Multi-collective support
- ✅ Neuron vs agent handling
- ✅ Cache persistence

### Real-World Tests
- ✅ automagik-genie repo (40+ agents)
- ✅ Client projects (custom agents)
- ✅ Multi-workspace scenarios
- ✅ Hot-reload on file changes

---

## Migration Path

### Phase 1: Forge Native Discovery (Parallel with CLI)
- Forge implements discovery logic
- Both CLI sync AND Forge discovery work
- Compare outputs for parity
- Fix any discrepancies

### Phase 2: Forge as Primary (CLI as Fallback)
- Forge discovery becomes primary
- CLI sync still available for manual use
- Encourage migration to Forge-native

### Phase 3: CLI Sync Deprecated
- Remove `syncProfiles()` from Genie CLI
- Forge discovery is sole mechanism
- Update documentation

---

## Open Questions

1. **Cache Location**
   - Current: `.genie/state/agent-sync-cache.json`
   - Alternative: Forge database (better for multi-workspace?)

2. **Sync Trigger**
   - Auto-sync on Forge startup?
   - Manual command: `forge sync-agents`?
   - File watcher (live reload)?

3. **Multi-Project Support**
   - Load .genie from multiple workspaces simultaneously?
   - How to namespace profiles (workspace + agent)?

4. **Backwards Compatibility**
   - Support legacy agent formats during migration?
   - Conversion tool for old → new frontmatter?

5. **Error Handling**
   - Skip broken agents or fail entire sync?
   - Retry logic for transient errors?
   - How to surface errors to users?

---

## Success Criteria

**Functionality:**
- ✅ Discover all agents from automagik-genie (40+)
- ✅ Parse frontmatter with 100% accuracy
- ✅ Generate profiles matching current CLI sync output
- ✅ Support all executor types (CLAUDE_CODE, CODEX, etc.)
- ✅ Handle collectives correctly (context prepending)

**Performance:**
- ✅ Discovery completes in < 500ms
- ✅ Incremental sync in < 100ms
- ✅ Memory usage under 50MB

**Reliability:**
- ✅ Graceful handling of malformed frontmatter
- ✅ Continue on single-agent failures
- ✅ Validate executor-specific fields

**UX:**
- ✅ CLI command: `forge sync-agents`
- ✅ UI shows discovered agents
- ✅ Clear error messages
- ✅ Documentation for .genie folder setup

---

## Files to Review

**Main Prompt:**
- `/tmp/genie/forge-genie-folder-discovery-prompt.md` (FULL SPEC)

**Reference Implementation (automagik-genie):**
- `src/cli/lib/agent-resolver.ts` (Discovery logic)
- `src/cli/lib/agent-registry.ts` (Parsing & metadata)
- `src/cli/lib/forge-executor.ts` (Sync orchestration)
- `src/lib/forge-client.js` (Forge API client)

**Test Data:**
- `.genie/code/agents/implementor.md` (Sample agent)
- `.genie/neurons/master.md` (Sample neuron)
- `.genie/code/AGENTS.md` (Collective context)

---

**Next Steps:**
1. Review full prompt: `/tmp/genie/forge-genie-folder-discovery-prompt.md`
2. Ask clarifying questions
3. Use prompt to teach Forge agent (via `mcp__genie__run`)
4. Implement discovery in automagik-forge
5. Test on automagik-genie repo
6. Document migration for users
