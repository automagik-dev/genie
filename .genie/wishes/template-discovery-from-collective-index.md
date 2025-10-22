# Wish: Template Discovery from Collective Index

**Created:** 2025-10-22
**Status:** Draft
**Priority:** High (blocks stable release)

## Problem Statement

The init wizard hardcodes the template list instead of discovering templates from a collective index. This means:
- Adding a new collective requires code changes
- Cannot dynamically discover available collectives
- Blocks proper template distribution/discovery

## Current State

**Hardcoded in init.ts:76-79:**
```typescript
const templates = [
  { value: 'code', label: '💻 Code', description: 'Full-stack development with Git, testing, CI/CD' },
  { value: 'create', label: '✍️  Create', description: 'Research, writing, content creation' }
];
```

**Actual collective structure:**
```
.genie/
├── code/           # Code collective
├── create/         # Create collective
└── {future}/       # Future collectives (blocked by hardcode)
```

## Collective Detection Method

**KEY INSIGHT:** A collective is identified by the presence of a root `AGENTS.md` file.

```
.genie/
├── code/
│   └── AGENTS.md       ← Presence of this marks 'code' as a collective
├── create/
│   └── AGENTS.md       ← Presence of this marks 'create' as a collective
└── future-collective/
    └── AGENTS.md       ← Any directory with AGENTS.md is a collective
```

## Correct Architecture

### 1. Automatic Collective Discovery (scan directories)
**File:** `.genie/cli/src/lib/collective-registry.ts`
```typescript
export async function getAvailableCollectives(): Promise<Collective[]> {
  const genieRoot = path.join(getPackageRoot(), '.genie');
  const entries = await fs.readdir(genieRoot, { withFileTypes: true });

  const collectives: Collective[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    // Check for AGENTS.md (marks this as a collective)
    const agentsPath = path.join(genieRoot, entry.name, 'AGENTS.md');
    const hasAgents = await pathExists(agentsPath);

    if (hasAgents) {
      // Read metadata from AGENTS.md frontmatter or collective.yaml
      const metadata = await readCollectiveMetadata(agentsPath);
      collectives.push({
        id: entry.name,
        label: metadata.label || entry.name,
        description: metadata.description || '',
        version: metadata.version || '1.0.0'
      });
    }
  }

  return collectives;
}
```

### 2. Optional: Collective Metadata
**File:** `.genie/code/collective.yaml` (optional enhancement)
```yaml
label: "💻 Code"
description: "Full-stack development with Git, testing, CI/CD"
version: "1.0.0"
```

If no `collective.yaml` exists, derive from directory name and AGENTS.md.

### 3. Init Flow (updated)
**File:** `.genie/cli/src/commands/init.ts`
```typescript
// Replace hardcoded list with dynamic discovery
const templates = await getAvailableCollectives();

const wizardConfig = await runInitWizard({
  templates: templates.map(c => ({
    value: c.id,
    label: c.label,
    description: c.description
  })),
  executors,  // Keep hardcoded (Forge executor types)
  hasGit
});
```

## What Stays Hardcoded (Correctly)

**Executors** - These are Forge executor types:
- OpenCode, Codex, Claude Code, Gemini, Cursor, etc.
- Defined in `.genie/cli/src/lib/executor-registry.ts`
- Hardcoded is correct (they're product features, not user content)

## Clarification: Forge Integration

**Initial assumption was wrong:**
- ❌ "Fetch templates from Forge API" - No, templates are local collectives
- ✅ "Discover templates from collective index" - Yes, this is the solution

**Forge's role:**
- Forge provides executors (hardcoded list is fine)
- Forge orchestrates tasks (not template discovery)
- Init doesn't need Forge running to list templates

## Implementation Plan

### Phase 1: Collective Auto-Discovery
- [ ] Create `collective-registry.ts`
- [ ] Implement `getAvailableCollectives()` - scan `.genie/` for directories with `AGENTS.md`
- [ ] Implement `readCollectiveMetadata()` - read from `collective.yaml` or fallback to defaults
- [ ] Handle edge cases (no collectives found, permission errors)

### Phase 2: Update Init Flow
- [ ] Replace hardcoded template list in `init.ts`
- [ ] Use `getAvailableCollectives()` for dynamic discovery
- [ ] Add validation (must have at least one collective)
- [ ] Maintain backward compatibility (fallback to ['code', 'create'] if discovery fails)

### Phase 3: Optional Metadata Files
- [ ] (Optional) Create `.genie/code/collective.yaml` with metadata
- [ ] (Optional) Create `.genie/create/collective.yaml` with metadata
- [ ] If not present, use sensible defaults from directory name

### Phase 4: Documentation
- [ ] Document collective detection method (AGENTS.md presence)
- [ ] Document collective.yaml format (optional metadata)
- [ ] Document how to add new collectives (just create directory with AGENTS.md)
- [ ] Update init flow documentation

## Success Criteria

1. ✅ Can add new collective by creating directory with `AGENTS.md` (no code changes)
2. ✅ Init wizard auto-discovers all collectives from `.genie/` directory
3. ✅ Graceful fallback if discovery fails (use ['code', 'create'] as defaults)
4. ✅ Metadata from `collective.yaml` (if present) or intelligent defaults
5. ✅ Adding a collective is as simple as: `mkdir .genie/new-collective && touch .genie/new-collective/AGENTS.md`

## Timeline

- Phase 1: 1.5 hours (auto-discovery logic)
- Phase 2: 1 hour (integrate into init flow)
- Phase 3: 0.5 hours (optional metadata files)
- Phase 4: 1 hour (documentation)
- **Total: 4 hours**

## Key Simplification

**No manual index needed!** Just scan `.genie/` and look for directories containing `AGENTS.md`. This is:
- ✅ Simpler (no YAML index to maintain)
- ✅ Self-documenting (AGENTS.md already exists)
- ✅ Automatic (new collective = just add directory with AGENTS.md)
- ✅ Consistent with existing architecture

## Related Issues

- #194 - Duplicate executors + hardcoded lists (partial fix done)

## Notes

This is NOT about Forge integration - it's about making templates discoverable. The init flow doesn't need architectural restructuring; it just needs to read from an index file instead of hardcoded arrays.
