# NPM Package Files Array Analysis

## Critical Finding: Missing Universal Directories

Your package.json "files" array is **MISSING CRITICAL DIRECTORIES** that are required for the Genie framework to function in installed packages.

### Summary Table

| Directory | Size | Files | Type | Status | Impact |
|-----------|------|-------|------|--------|--------|
| `.genie/spells/` | 388K | 38 MD | Universal | ❌ MISSING | CRITICAL - Behavioral framework |
| `.genie/neurons/` | 24K | 4 MD | Universal | ❌ MISSING | CRITICAL - Orchestration layer |
| `.genie/teams/` | 20K | 2 MD | Repo-specific | ❌ MISSING (OK) | Advisory groups, repo-local |
| `.genie/utilities/` | 16K | 2 MD | Universal | ❌ MISSING | LOW - Optional agents |

---

## Detailed Analysis

### 1. `.genie/spells/` - UNIVERSAL (MUST INCLUDE)

**Status:** 🔴 CRITICAL - Missing from package

**Purpose:** Behavioral patterns and knowledge database. The behavioral framework that guides all agents.

**Current Content (38 files, 9,002 lines):**
```
.genie/spells/
├── README.md                                (documentation)
├── ask-one-at-a-time.md                     (sequential questioning)
├── blocker-protocol.md                      (escalation patterns)
├── break-things-move-fast.md               (development speed)
├── collaborate.md                           (team coordination)
├── delegate-dont-do.md                     (orchestration discipline)
├── experiment.md                            (exploration patterns)
├── file-creation-protocol.md                (asset creation)
├── forge-integration.md                     (Forge workflow)
├── forge-orchestration.md                   (Forge patterns)
├── gather-context.md                        (discovery)
├── global-health-check.md                   (diagnostics)
├── investigate-before-commit.md             (validation)
├── learn.md                                 (meta-learning)
├── mcp-first.md                             (MCP patterns)
├── orchestrator-not-implementor.md         (role boundaries)
├── prompt.md                                (prompt engineering)
├── review.md                                (review protocol)
├── run-in-parallel.md                       (concurrent execution)
├── session-state-updater-example.md        (state management)
├── troubleshoot-infrastructure.md          (debugging)
├── wish-initiation.md                      (wish creation)
├── wish-issue-linkage.md                   (issue tracking)
├── wish-lifecycle.md                       (workflow states)
└── + 14 more spell files
```

**Why It's Critical:**
1. **Used by MCP server at runtime** - `list_spells` tool loads from `.genie/spells/`
2. **Used by CLI** - `spell-changelog.ts` tracks spell changes for release notes
3. **Referenced by collective AGENTS.md** - Both code and create collectives load spells:
   ```
   @.genie/spells/investigate-before-commit.md
   @.genie/spells/know-yourself.md
   @.genie/spells/delegate-dont-do.md
   ```
4. **Behavioral library** - Without spells, agents can't load their behavioral patterns
5. **Knowledge base** - Persistent consciousness documentation

**Code References:**
- `.genie/mcp/src/server.ts:559` - Loads global spells directory
- `.genie/cli/src/lib/spell-changelog.ts:33` - Tracks spell changes
- `.genie/cli/src/lib/upgrade/diff-generator.ts:19` - Spell pattern matching
- `.genie/code/AGENTS.md` - References `@.genie/spells/*` for behavioral loading
- `.genie/create/AGENTS.md` - References `@.genie/spells/*` for behavioral loading

**Token Impact:** 9,002 lines = ~67,515 tokens (loaded per session in agent AGENTS.md refs)

**ACTION:** ✅ **MUST ADD TO PACKAGE.FILES**

---

### 2. `.genie/neurons/` - UNIVERSAL (MUST INCLUDE)

**Status:** 🔴 CRITICAL - Missing from package

**Purpose:** Persistent master orchestrators that coordinate work across Forge. Required for multi-session coordination.

**Current Content (4 files, ~1,200 lines):**
```
.genie/neurons/
├── README.md                    (neuron architecture documentation)
├── neuron-wish.md              (wish creation orchestrator)
├── neuron-forge.md             (task execution orchestrator)
└── neuron-review.md            (validation orchestrator)
```

**Why It's Critical:**
1. **Used by MCP tools at runtime** - Wish, Forge, and Review tools invoke neurons:
   ```typescript
   // .genie/mcp/src/tools/wish-tool.ts
   executor: `CLAUDE_CODE:neuron-wish`
   
   // .genie/mcp/src/tools/forge-tool.ts
   executor: `CLAUDE_CODE:neuron-forge`
   
   // .genie/mcp/src/tools/review-tool.ts
   executor: `CLAUDE_CODE:neuron-review`
   ```

2. **Discovered by MCP server on startup** - Session manager queries neurons to resume persistent tasks:
   ```typescript
   // .genie/mcp/src/lib/session-manager.ts
   t.executor?.includes(`:neuron-${workflow}`)
   ```

3. **Required for task persistence** - Without neurons, master orchestrators can't resume across sessions

4. **Core architecture** - CORE_AGENTS.md documents neurons as system requirement

**Code References:**
- `.genie/mcp/src/server.ts:910` - References neuron tools
- `.genie/mcp/src/tools/wish-tool.ts` - Uses `neuron-wish` executor
- `.genie/mcp/src/tools/forge-tool.ts` - Uses `neuron-forge` executor
- `.genie/mcp/src/tools/review-tool.ts` - Uses `neuron-review` executor
- `.genie/mcp/src/lib/session-manager.ts` - Queries neurons by role

**Token Impact:** ~1,200 lines = ~9,000 tokens (referenced in MCP runtime)

**ACTION:** ✅ **MUST ADD TO PACKAGE.FILES**

---

### 3. `.genie/teams/` - REPO-SPECIFIC (OPTIONAL)

**Status:** ⚠️  NOT CRITICAL - Can be optional

**Purpose:** Advisory teams and architectural consultation groups (optional feature).

**Current Content (2 files):**
```
.genie/teams/
├── tech-council.md             (architectural advisor team)
└── sessions/                   (archived meeting notes)
    └── 2025-10-19-...md
```

**Assessment:**
1. **NOT loaded by CLI or MCP** - No code references this directory
2. **Not in agent routing** - Not discovered by `discoverCollectives()`
3. **Repo-specific** - Only used in THIS repo for architectural consultation
4. **Not part of distributed framework** - New installations don't need this

**Why It Should Be OMITTED from package:**
- Repo-specific advisory structure, not framework-wide
- Zero code dependencies
- Adds size without value for new installations
- Team-specific decisions (author: Nayr, Oettam, JT - repo locals)

**ACTION:** ❌ **LEAVE OUT OF PACKAGE.FILES** (repo-only artifact)

---

### 4. `.genie/utilities/` - UNIVERSAL (OPTIONAL)

**Status:** ⚠️  OPTIONAL - Can be included for completeness

**Purpose:** Utility agents for infrastructure and automation tasks.

**Current Content (2 files, 72 lines):**
```
.genie/utilities/
├── AGENTS.md                   (utilities collective metadata)
└── agents/
    └── upstream-update.md      (upstream dependency automation)
```

**Assessment:**
1. **Is a discovered collective** - `discoverCollectives()` finds it via AGENTS.md
2. **Not essential** - Only used for optional upstream update workflows
3. **Low token cost** - Just 72 lines
4. **Completes the framework** - Makes all collectives available

**How It Works:**
- Discovered by `collective-discovery.ts` via presence of `AGENTS.md`
- Listed by MCP `list_agents` tool
- Available for `genie run utilities/upstream-update` commands

**Code References:**
- `.genie/cli/src/lib/collective-discovery.ts:26` - Scans for collectives
- MCP `list_agents` tool automatically discovers it

**ACTION:** ✅ **SHOULD ADD TO PACKAGE.FILES** (low cost, completes framework)

---

## Current package.json "files" Array

```json
"files": [
  ".genie/cli/dist/**/*",
  ".genie/mcp/dist/**/*",
  ".genie/mcp/src/**/*",
  "forge.js",
  ".genie/agents/**/*.md",          // ✅ Has agents
  ".genie/code/**/*",               // ✅ Has code collective
  ".genie/create/**/*",             // ✅ Has create collective
  ".genie/product/**/*.md",
  ".genie/standards/**/*.md",
  ".genie/guides/**/*.md",
  ".genie/product/templates/**/*.md",
  ".genie/workflows/**/*",
  ".genie/scripts/**/*",
  ".genie/.framework-version.template",
  "bin/automagik-genie.js",
  "bin/mcp.js",
  "bin/rollback.js",
  "bin/status.js",
  "bin/cleanup.js",
  "bin/statusline.js",
  "genie",
  "run.sh",
  "run.ps1",
  "setup.sh",
  "setup.ps1",
  "README.md",
  "AGENTS.md",
  "CLAUDE.md"
]
```

---

## Required Changes

### Minimum Changes (CRITICAL)

Add these two lines to include the behavioral framework and orchestration layer:

```json
".genie/spells/**/*",
".genie/neurons/**/*",
```

**Impact:** 
- Fixes missing behavioral framework
- Enables neuron-based orchestration
- Makes installed packages fully functional

### Recommended Changes (COMPLETE)

Add utilities to make the framework complete:

```json
".genie/spells/**/*",
".genie/neurons/**/*",
".genie/utilities/**/*",
```

**Impact:**
- Includes all universal collectives
- Adds optional automation agents
- Minimal token cost (72 lines)

### NOT Recommended

Do NOT add `.genie/teams/` - it's repo-specific:
- No code dependencies
- Team-specific decisions
- Zero utility for new installations

---

## Why This Matters

### For Package Users

**WITHOUT spells/neurons:**
- ❌ Agents can't load behavioral patterns (`@.genie/spells/*`)
- ❌ Neural orchestration breaks (`neuron-*` executors fail)
- ❌ `list_spells` MCP tool returns empty results
- ❌ Master orchestrators can't persist across sessions
- ❌ Half the framework is missing

**WITH spells/neurons:**
- ✅ Full behavioral framework available
- ✅ All MCP tools work correctly
- ✅ Agents load complete spell library
- ✅ Master orchestrators persist sessions
- ✅ Ready for production use

### For Clone Discovery

When users clone a repo with Genie:
```bash
npm install              # Installs package from npm
genie                    # Initializes workspace with installed files
```

The installed package provides:
- CLI commands (`genie` binary)
- MCP server
- **Spells & neurons** (behavioral framework) ← MISSING
- Agent templates (code, create)
- Product documentation

---

## How Spells Are Used

### 1. MCP Runtime Discovery

```typescript
// .genie/mcp/src/server.ts:559
const globalSpellsDir = path.join(WORKSPACE_ROOT, '.genie', 'spells');
result.global = listSpellsInDir(globalSpellsDir);  // ← Fails if missing
```

**Tool:** `list_spells` returns empty if directory doesn't exist

### 2. Agent Behavioral Loading

```markdown
# .genie/code/AGENTS.md
@.genie/spells/investigate-before-commit.md
@.genie/spells/delegate-dont-do.md
@.genie/spells/multi-step-execution.md
```

**Effect:** Agents can't load spells if files aren't installed

### 3. CLI Release Notes

```typescript
// .genie/cli/src/lib/spell-changelog.ts
const spellPatterns = [
  '.genie/spells/**/*.md',
  '.genie/code/spells/**/*.md',
  '.genie/create/spells/**/*.md'
];
```

**Effect:** `genie update` displays new spells learned in the release

### 4. Collective Discovery

```typescript
// .genie/cli/src/lib/collective-discovery.ts
const skipDirs = ['agents', 'workflows', 'skills', 'backups', ..., 'teams'];
```

**Effect:** `.genie/utilities/` is discovered as a collective because it has AGENTS.md

---

## Validation Checklist

To verify these directories should be in the package:

- [x] Used by CLI code? Spells ✅, Neurons ✅, Utilities ✅, Teams ❌
- [x] Loaded by MCP server? Spells ✅, Neurons ✅, Utilities ❌, Teams ❌
- [x] Referenced in AGENTS.md? Spells ✅ (code & create), Others ❌
- [x] Runtime dependency? Spells ✅, Neurons ✅, Others ❌
- [x] Repo-specific content? Teams ✅, Others ❌
- [x] Framework feature? Spells ✅, Neurons ✅, Utilities ⚠️, Teams ❌

**Result:**
- Spells: UNIVERSAL + CRITICAL ✅
- Neurons: UNIVERSAL + CRITICAL ✅
- Utilities: UNIVERSAL + OPTIONAL ✅
- Teams: REPO-SPECIFIC + OPTIONAL (recommend EXCLUDE) ❌

---

## Recommendation

**IMMEDIATELY ADD:**
```json
".genie/spells/**/*",
".genie/neurons/**/*",
```

**OPTIONALLY ADD:**
```json
".genie/utilities/**/*",
```

**DO NOT ADD:**
```json
// Teams is repo-specific, not part of distributed framework
```

---

## Implementation

Edit `package.json` and add these lines to the "files" array (after agents, before workflows):

```json
{
  "files": [
    ".genie/cli/dist/**/*",
    ".genie/mcp/dist/**/*",
    ".genie/mcp/src/**/*",
    "forge.js",
    ".genie/agents/**/*.md",
    ".genie/code/**/*",
    ".genie/create/**/*",
    ".genie/spells/**/*",        // ← ADD (CRITICAL)
    ".genie/neurons/**/*",       // ← ADD (CRITICAL)
    ".genie/utilities/**/*",     // ← ADD (optional, recommended)
    ".genie/product/**/*.md",
    // ... rest of files
  ]
}
```

**Impact:**
- Spells: 388K (9,002 lines)
- Neurons: 24K (1,200 lines)
- Utilities: 16K (72 lines)
- **Total added:** 428K

**Verification:**
```bash
npm pack                         # Creates tarball
tar -tzf automagik-genie-*.tgz | grep "\.genie/spells"
tar -tzf automagik-genie-*.tgz | grep "\.genie/neurons"
```

Both should list files.
