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

## Correct Architecture

### 1. Collective Index (manually maintained)
**File:** `.genie/collectives.yaml`
```yaml
collectives:
  - id: code
    label: "💻 Code"
    description: "Full-stack development with Git, testing, CI/CD"
    version: "1.0.0"

  - id: create
    label: "✍️ Create"
    description: "Research, writing, content creation"
    version: "1.0.0"
```

### 2. Template Discovery
**File:** `.genie/cli/src/lib/collective-registry.ts`
```typescript
export async function getAvailableCollectives(): Promise<Collective[]> {
  const indexPath = path.join(getPackageRoot(), '.genie', 'collectives.yaml');
  const raw = await fs.readFile(indexPath, 'utf8');
  const data = YAML.parse(raw);
  return data.collectives;
}
```

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

### Phase 1: Create Collective Index
- [ ] Create `.genie/collectives.yaml`
- [ ] Add current collectives (code, create)
- [ ] Define schema (id, label, description, version)

### Phase 2: Template Discovery
- [ ] Create `collective-registry.ts`
- [ ] Add `getAvailableCollectives()` function
- [ ] Handle missing/invalid index gracefully

### Phase 3: Update Init Flow
- [ ] Replace hardcoded template list in `init.ts`
- [ ] Use dynamic discovery
- [ ] Maintain backward compatibility

### Phase 4: Documentation
- [ ] Document collective index format
- [ ] Document how to add new collectives
- [ ] Update init flow documentation

## Success Criteria

1. Can add new collective without changing code
2. Init wizard discovers templates from index
3. Missing index fails gracefully (fallback to defaults)
4. Index is validated on package build

## Timeline

- Phase 1-2: 2 hours
- Phase 3: 1 hour
- Phase 4: 1 hour
- **Total: 4 hours**

## Related Issues

- #194 - Duplicate executors + hardcoded lists (partial fix done)

## Notes

This is NOT about Forge integration - it's about making templates discoverable. The init flow doesn't need architectural restructuring; it just needs to read from an index file instead of hardcoded arrays.
