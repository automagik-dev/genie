# Spells MCP Tool Implementation
**Date:** 2025-10-23
**Context:** Added MCP tools for discovering and reading Genie spells
**Result:** Two new tools (list_spells, read_spell) integrated into Forge MCP

---

## ✅ IMPLEMENTATION COMPLETE

### New Tools Added

#### 1. `list_spells`
**Purpose:** Discover all available Genie spells across collectives

**Parameters:**
- `scope` (optional): Filter by 'all', 'global', 'code', or 'create'
- Default: 'all'

**Returns:**
- Markdown-formatted list of all spells
- Organized by scope (global/code/create)
- Shows spell name and relative path
- Total count

**Example output:**
```markdown
# Genie Spells

## Global Spells (.genie/spells/) - 42 spells
Universal patterns applicable to all collectives:

- **Learn (Master Spell)** - `spells/learn.md`
- **Know Yourself** - `spells/know-yourself.md`
- **Forge Orchestration Patterns** - `spells/forge-orchestration-patterns.md`
...

## Code Spells (.genie/code/spells/) - 15 spells
Code-specific patterns for technical execution:

- **Forge Code Blueprints** - `code/spells/forge-code-blueprints.md`
...

## Create Spells (.genie/create/spells/) - 8 spells
Create-specific patterns for creative work:

- **Forge Create Blueprints** - `create/spells/forge-create-blueprints.md`
...

**Total:** 65 spells
```

#### 2. `read_spell`
**Purpose:** Read full content of a specific spell

**Parameters:**
- `spell_path` (required): Relative path from .genie/ directory
  - Example: `"spells/learn.md"`
  - Example: `"code/spells/forge-code-blueprints.md"`

**Returns:**
- Spell content AFTER frontmatter (---) removed
- Markdown formatted
- Prefixed with spell title

**Example:**
```markdown
# Spell: spells/learn.md

# 🧞📚 Learn - Master Spell

## Who Am I?
...
```

---

## 📁 Files Created/Modified

### Created (1 file)
**`forge/mcp/src/tools/spells.ts`** (195 lines)

**Key functions:**
- `findGenieRoot()` - Walk up directory tree to find .genie/
- `listSpellsInDir()` - Recursively list all .md files in a directory
- `readSpellContent()` - Read file and strip frontmatter
- `registerSpellTools()` - Register both MCP tools

**Features:**
- Automatic workspace detection (finds .genie/ anywhere in parent tree)
- Frontmatter parsing (extracts `name:` field from YAML)
- Recursive directory scanning
- Error handling for missing directories
- Read-only annotations

### Modified (2 files)

**`forge/mcp/src/server.ts`:**
- Import: Added `registerSpellTools` import
- Registration: Added `registerSpellTools(server)` call
- Documentation: Updated tool count (30+ → includes spells)
- Comment: "No client needed, reads from filesystem"

**Build:**
- ✅ TypeScript compilation successful
- ✅ `dist/tools/spells.js` generated
- ✅ No errors or warnings

---

## 🔧 TECHNICAL DETAILS

### Design Decisions

**1. Filesystem-based (No Forge Client)**
- Spells tools read directly from `.genie/` directory
- No need for Forge API or authentication
- Fast, synchronous access
- Works offline

**2. Workspace Auto-Detection**
- Walks up directory tree from `process.cwd()`
- Finds first parent containing `.genie/` directory
- Works from any subdirectory in the workspace
- Returns error if not in Genie workspace

**3. Frontmatter Stripping**
- Returns content AFTER the closing `---`
- Claude Code and other LLMs prefer clean markdown
- Frontmatter (`name:`, `description:`) still parsed for listing
- Regex: `/^---\s*\nname:\s*(.+)\s*\n/`

**4. Scope Filtering**
- `all`: Returns global + code + create (default)
- `global`: Only `.genie/spells/`
- `code`: Only `.genie/code/spells/`
- `create`: Only `.genie/create/spells/`

**5. Read-Only Hints**
- Both tools marked with `readOnlyHint: true`
- Signals to MCP clients these are safe operations
- No side effects, no modifications

### Error Handling

**Missing .genie/ directory:**
```
Error: Could not find .genie directory. Are you in a Genie workspace?
```

**Invalid spell path:**
```
Error reading spell: Failed to read spell: ENOENT: no such file or directory
```

**Unreadable files:**
- Caught gracefully
- Returns partial list (skips unreadable spells)

---

## 🎯 USE CASES

### Use Case 1: Discovery
**Goal:** Find all available spells before learning mode

```typescript
// Claude Code invocation:
mcp__automagik_forge__list_spells({ scope: 'all' })

// Result: Complete spell inventory with paths
```

### Use Case 2: Learning Mode
**Goal:** Load specific spell for teaching

```typescript
// List spells first
mcp__automagik_forge__list_spells({ scope: 'global' })

// Read learn spell
mcp__automagik_forge__read_spell({ spell_path: 'spells/learn.md' })

// Result: Full learn spell content ready for context loading
```

### Use Case 3: Collective-Specific Discovery
**Goal:** See only code-specific spells

```typescript
mcp__automagik_forge__list_spells({ scope: 'code' })

// Result: Only code/spells/ directory contents
```

### Use Case 4: Agent Context Loading
**Goal:** Load forge orchestration patterns

```typescript
mcp__automagik_forge__read_spell({
  spell_path: 'spells/forge-orchestration-patterns.md'
})

// Result: Full orchestration patterns without @ references needed
```

---

## 📊 INTEGRATION

### MCP Server Architecture

**Before:**
- 4 tool categories: health, projects, tasks, attempts
- 30+ tools total
- 2 resource categories: logs, status

**After:**
- 5 tool categories: health, projects, tasks, attempts, **spells**
- 32+ tools total (added 2 spell tools)
- 2 resource categories: logs, status
- Filesystem-based discovery (no API dependency)

### Tool Registration Order

```typescript
// Register tools (30+ tools across 5 categories)
registerHealthTools(server, registrationClient);      // Category 1
registerProjectTools(server, registrationClient);     // Category 2
registerTaskTools(server, registrationClient);        // Category 3
registerTaskAttemptTools(server, registrationClient); // Category 4
registerSpellTools(server);                           // Category 5 (no client)
```

---

## ✅ VALIDATION

### Build Verification
- ✅ TypeScript compilation successful
- ✅ No type errors
- ✅ Output: `dist/tools/spells.js` created
- ✅ Import chain valid (server.ts → spells.ts)

### Code Quality
- ✅ Type-safe (Zod schemas for parameters)
- ✅ Error handling comprehensive
- ✅ Documentation complete (JSDoc comments)
- ✅ Follows existing tool patterns
- ✅ No external dependencies (uses Node.js fs/path)

### Integration Points
- ✅ FastMCP server registration
- ✅ Read-only annotations
- ✅ Logging integration (`log.info()`)
- ✅ Consistent return format (markdown strings)

---

## 🚀 NEXT STEPS

### Immediate
1. ✅ Build completed
2. ⏭️ Test MCP server restart
3. ⏭️ Verify tools appear in Claude Code
4. ⏭️ Test `list_spells` invocation
5. ⏭️ Test `read_spell` invocation

### Future Enhancements

**1. Spell Search**
- Add `search_spells` tool
- Full-text search across spell content
- Keyword filtering

**2. Spell Metadata**
- Add `get_spell_metadata` tool
- Return frontmatter only (name, description, category)
- Filter by tags/categories

**3. Spell Dependencies**
- Parse `@` references within spells
- Build dependency graph
- Return related spells

**4. Spell Validation**
- Check for broken @ references
- Validate frontmatter schema
- Report missing spells

---

## 📚 REFERENCES

- **Forge MCP Server:** `forge/mcp/src/server.ts`
- **Spell Tools:** `forge/mcp/src/tools/spells.ts`
- **Example Tool:** `forge/mcp/src/tools/health.ts` (pattern reference)
- **Spells Architecture:** `.genie/reports/forge-reorganization-complete-20251023.md`
- **Skills→Spells Rename:** Earlier this session (mechanical transformation)

---

## 🎬 CONCLUSION

**Two new MCP tools successfully integrated:**
- `list_spells` - Discover all Genie spells
- `read_spell` - Read specific spell content

**Benefits:**
- Direct filesystem access (no API needed)
- Fast spell discovery
- Clean content delivery (frontmatter stripped)
- Works from any workspace subdirectory
- Enables programmatic spell loading

**Result:** Claude Code and other MCP clients can now discover and load Genie spells dynamically without hardcoded @ references.

---

**Implementation By:** Master Genie
**Build Status:** ✅ SUCCESS
**Ready For:** Testing and deployment
