# COMPLETE DEPENDENCY MAPPING FOR .GENIE/CLI, .GENIE/MCP & FORGE.JS MIGRATION

> ⚠️ **HISTORICAL DOCUMENT** - This documents the file structure BEFORE Issue #359 migration.
>
> **Current structure (after #359):**
> - `.genie/cli/src/` → `src/cli/`
> - `.genie/mcp/src/` → `src/mcp/`
> - `.genie/cli/dist/` → `dist/cli/`
> - `.genie/mcp/dist/` → `dist/mcp/`
>
> This document is preserved for historical reference and understanding the migration scope.

**Project Root:** `/var/tmp/automagik-forge/worktrees/2752-wish-default`
**Date Generated:** 2025-11-02
**Analysis Scope:** 100% of external imports + internal cross-folder imports

---

## EXECUTIVE SUMMARY

### File Counts

| Component | Type | Count | Location |
|-----------|------|-------|----------|
| .genie/cli source files | TypeScript/JavaScript | 83 | `.genie/cli/src/**/*.ts` |
| .genie/mcp source files | TypeScript/JavaScript | 27 | `.genie/mcp/src/**/*.ts` |
| forge.js file | JavaScript | 1 | `/forge.js` (root) |
| Test files importing from .genie/cli | JavaScript/TypeScript | 14 | `/tests/**/*` |
| Script files importing from .genie/cli | JavaScript | 1 | `/scripts/**/*` |

### Key Finding

**Three distinct locations for ForgeClient imports:**
1. **Direct path in .genie/mcp/src tools:** `require(path.join(geniePackageRoot, 'forge.js'))`
2. **Import path in .genie/cli/src:** `import { ForgeClient } from '../../../../src/lib/forge-client.js'`
3. **Direct reference in /forge.js:** Main implementation

---

## 1. ALL FILES IMPORTING FROM .GENIE/CLI

### Imports from Tests Directory

#### File: `/tests/genie-cli.test.cjs`
- **Type:** CommonJS test file
- **Imports:**
  - Line 7: `// const { extractSessionIdFromContent, buildJsonlView } = require('../.genie/cli/dist/executors/codex-log-viewer.js');` (COMMENTED OUT)
  - Line 8: `// const { loadSessions } = require('../.genie/cli/dist/session-store.js');` (COMMENTED OUT)
  - Line 55: `const cliCore = require('../.genie/cli/dist/cli-core/index.js');` (ACTIVE)
- **Relative Path:** `../` (up 1 level from /tests/ to project root)
- **Import Pattern:** Relative path to compiled dist code

#### File: `/tests/genie-cli.test.mjs`
- **Type:** ES Module test file
- **Imports:**
  - Line 11: `// const { extractSessionIdFromContent, buildJsonlView} = await import('../.genie/cli/dist/executors/codex-log-viewer.js');` (COMMENTED OUT)
  - Line 12: `// const { loadSessions } = await import('../.genie/cli/dist/session-store.js');` (COMMENTED OUT)
  - Line 59: `const cliCore = await import('../.genie/cli/dist/cli-core/index.js');` (ACTIVE)
- **Relative Path:** `../` (up 1 level from /tests/ to project root)
- **Import Pattern:** Dynamic ESM import to compiled dist code

#### File: `/tests/agent-resolver.test.js`
- **Type:** Node.js test file
- **Imports:**
  - Line 10: `} = require('../.genie/cli/dist/lib/agent-resolver.js');`
- **Relative Path:** `../` (up 1 level)
- **Import Pattern:** Relative require of compiled dist code
- **Imported:** `agent-resolver.js` from compiled output

#### File: `/tests/session-service.test.cjs`
- **Type:** CommonJS test file
- **Imports:**
  - Line 11: `const { SessionService } = require('../.genie/cli/dist/cli-core/session-service');`
- **Relative Path:** `../` (up 1 level)
- **Import Pattern:** Relative require to compiled cli-core/session-service
- **Note:** Path has no .js extension but resolves to compiled JS

#### File: `/tests/paths.test.js`
- **Type:** Node.js test file
- **Imports found:** grep found this file imports `.genie/cli`
- **Expected pattern:** `require('../.genie/cli/dist/lib/paths.js')`

#### File: `/tests/session-helpers.test.js`
- **Type:** Node.js test file
- **Imports found:** grep found this file imports `.genie/cli`
- **Expected pattern:** `require('../.genie/cli/dist/lib/session-helpers.js')`

#### File: `/tests/async.test.js`
- **Type:** Node.js test file
- **Imports found:** grep found this file imports `.genie/cli`
- **Expected pattern:** `require('../.genie/cli/dist/lib/async.js')`

#### File: `/tests/utils.test.js`
- **Type:** Node.js test file
- **Imports found:** grep found this file imports `.genie/cli`
- **Expected pattern:** `require('../.genie/cli/dist/lib/utils.js')`

#### File: `/tests/cli-parser.test.js`
- **Type:** Node.js test file
- **Imports found:** grep found this file imports `.genie/cli`
- **Expected pattern:** `require('../.genie/cli/dist/lib/cli-parser.js')`

#### Other Test Files Importing .genie/cli
- `/tests/mcp-automated.test.js`
- `/tests/mcp-tools-validation.test.js`
- `/tests/mcp-integration.test.js`
- `/tests/mcp-live-sessions.test.js`

### Imports from Scripts Directory

#### File: `/scripts/assert-cli-core-importable.js`
- **Type:** Node.js script
- **Imports:**
  - Line 23: `const cliCore = require('../.genie/cli/dist/cli-core');`
- **Relative Path:** `../` (up 1 level from /scripts/ to project root)
- **Import Pattern:** Relative require to compiled cli-core index
- **Purpose:** Verification that cli-core is importable post-build

### Summary of .genie/cli Imports
- **Total external files importing .genie/cli:** 14 test files + 1 script = **15 files**
- **All imports reference:** `.genie/cli/dist/**/*` (compiled output, not source)
- **Import mechanism:** Mix of CommonJS require() and ESM import()
- **Path pattern:** Relative paths using `../` prefix
- **Exported items:**
  - `cli-core/index.js` (most common)
  - `cli-core/session-service.js`
  - `lib/agent-resolver.js`
  - `lib/cli-parser.js`
  - `lib/paths.js`
  - `lib/session-helpers.js`
  - `lib/async.js`
  - `lib/utils.js`

---

## 2. ALL FILES IMPORTING FROM .GENIE/MCP

### MCP Tool Files Importing forge.js

#### File: `/`.genie/mcp/src/tools/create-subtask-tool.ts`
- **Type:** TypeScript source
- **Imports:**
  - Line 14: `const geniePackageRoot = path.resolve(__dirname, '../../../..');`
  - Line 15: `const ForgeClient = require(path.join(geniePackageRoot, 'forge.js')).ForgeClient;`
- **Import Pattern:** Dynamic path resolution + require
- **Path Resolution:** Resolves to `<package-root>/forge.js` (root-level)
- **Exported:** `{ ForgeClient }` destructured from module

#### File: `/`.genie/mcp/src/tools/continue-task-tool.ts`
- **Type:** TypeScript source
- **Imports:**
  - Line 13: `const ForgeClient = require(path.join(geniePackageRoot, 'forge.js')).ForgeClient;`
- **Import Pattern:** Same as above (dynamic path + require)

#### File: `/`.genie/mcp/src/tools/prompt-tool.ts`
- **Type:** TypeScript source
- **Imports:**
  - Line 22: `const ForgeClient = require(path.join(geniePackageRoot, 'forge.js')).ForgeClient;`
- **Comment:** "// forge.js is at: <genie-package>/forge.js"
- **Import Pattern:** Same as above (dynamic path + require)

#### File: `/`.genie/mcp/src/lib/session-manager.ts`
- **Type:** TypeScript source
- **Imports:**
  - Line 13: `const ForgeClient = require(path.join(geniePackageRoot, 'forge.js')).ForgeClient;`
- **Import Pattern:** Same as above (dynamic path + require)

### Summary of .genie/mcp Imports
- **Total files in .genie/mcp importing external code:** 4 files
- **All imports reference:** `/forge.js` (root-level file)
- **Import mechanism:** CommonJS require() with dynamic path.join()
- **Path pattern:** `path.join(geniePackageRoot, 'forge.js')`
- **Exported item:** `{ ForgeClient }` class

---

## 3. ALL FILES IMPORTING FORGE.JS (DIRECT AND INDIRECT)

### Direct Imports (Require forge.js Explicitly)

#### From .genie/mcp/src (4 files listed above)
- `/`.genie/mcp/src/tools/create-subtask-tool.ts` - Line 15
- `/`.genie/mcp/src/tools/continue-task-tool.ts` - Line 13
- `/`.genie/mcp/src/tools/prompt-tool.ts` - Line 22
- `/`.genie/mcp/src/lib/session-manager.ts` - Line 13

### Indirect Imports (Via Type References)

#### From .genie/cli/src/lib/forge-manager.ts
- **Line 6:** `import { ForgeClient } from '../../../../src/lib/forge-client.js';`
- **Comment:** `// @ts-ignore - compiled client shipped at project root`
- **Source:** Not forge.js directly, but `src/lib/forge-client.js`
- **Path Resolution:** Goes UP from `.genie/cli/src/lib/` → `/src/lib/forge-client.js`

#### From .genie/cli/src/lib/forge-executor.ts
- **Line 2:** `import { ForgeClient } from '../../../../src/lib/forge-client.js';`
- **Comment:** `// @ts-ignore - forge.js is compiled JS without type declarations`
- **Path Resolution:** Same as above

#### From .genie/cli/src/lib/token-tracker.ts
- **Line (approx):** `import { ForgeClient } from '../../../../src/lib/forge-client.js';`
- **Path Resolution:** Same as above

#### From .genie/cli/src/debug-stats.ts
- **Line:** `import { ForgeClient } from '../../../src/lib/forge-client.js';`
- **Path Resolution:** Goes UP from `.genie/cli/src/` → `/src/lib/forge-client.js`

### Summary of forge.js References
- **Total files referencing forge.js or its proxy:** ~7 files
- **Direct imports:** 4 files (.genie/mcp tools)
- **Indirect imports:** 3+ files (.genie/cli using src/lib/forge-client.js)
- **Total distinct import locations:** 2
  1. `/forge.js` (direct from MCP tools)
  2. `/src/lib/forge-client.js` (from CLI code)

---

## 4. CURRENT FOLDER STRUCTURE

### .genie/cli Directory Structure
```
.genie/cli/
├── src/
│   ├── check-statuses.ts
│   ├── debug-stats.ts
│   ├── genie-cli.ts
│   ├── genie.ts
│   ├── session-store.ts
│   ├── unified-startup.ts
│   ├── cli-core/
│   │   ├── context.js & context.ts
│   │   ├── handlers/
│   │   │   ├── list.ts
│   │   │   ├── resume.ts
│   │   │   ├── run.ts
│   │   │   ├── stop.ts
│   │   │   └── view.ts
│   │   ├── index.js & index.ts
│   │   ├── session-service.js & session-service.ts
│   │   └── types.js & types.ts
│   ├── commands/
│   │   ├── cleanup.ts
│   │   ├── dashboard.ts
│   │   ├── dashboard-live.ts
│   │   ├── help.ts
│   │   ├── init.ts
│   │   ├── mcp-cleanup.ts
│   │   ├── rollback.ts
│   │   ├── status.ts
│   │   ├── statusline.ts
│   │   ├── talk.ts
│   │   └── update.ts
│   ├── lib/
│   │   ├── __tests__/
│   │   │   └── markdown-formatter.test.ts
│   │   ├── agent-registry.ts
│   │   ├── agent-resolver.ts
│   │   ├── async.ts
│   │   ├── cli-parser.ts
│   │   ├── cli-utils.ts
│   │   ├── collective-discovery.ts
│   │   ├── config-manager.ts
│   │   ├── config.ts
│   │   ├── display-transform.ts
│   │   ├── esm-dirname.ts
│   │   ├── executor-auth.ts
│   │   ├── executor-definitions.ts
│   │   ├── executor-manager.ts
│   │   ├── executor-prompt.ts
│   │   ├── executor-registry.ts
│   │   ├── forge-executor.ts
│   │   ├── forge-helpers.ts
│   │   ├── forge-manager.ts
│   │   ├── forge-stats.ts
│   │   ├── fs-utils.ts
│   │   ├── headless-helpers.ts
│   │   ├── install-helpers.ts
│   │   ├── markdown-formatter.ts
│   │   ├── mcp-config.ts
│   │   ├── mcp-stdio.ts
│   │   ├── migrate.ts
│   │   ├── oauth2-utils.ts
│   │   ├── package.ts
│   │   ├── paths.ts
│   │   ├── router.ts
│   │   ├── server-manager.ts
│   │   ├── session-helpers.ts
│   │   ├── setup-wizard.ts
│   │   ├── spell-changelog.ts
│   │   ├── startup-display.ts
│   │   ├── stats-integration.ts
│   │   ├── stats-tracker.ts
│   │   ├── token-tracker.ts
│   │   ├── tunnel-manager.ts
│   │   ├── types.ts
│   │   ├── upgrade/
│   │   │   ├── diff-generator.ts
│   │   │   ├── index.ts
│   │   │   ├── merge-strategy.ts
│   │   │   ├── types.ts
│   │   │   └── version-checker.ts
│   │   ├── utils.ts
│   │   └── view-helpers.ts
│   ├── types/
│   │   └── gradient-string.d.ts
│   ├── views/
│   │   ├── agent-catalog.ts
│   │   ├── background.ts
│   │   ├── common.ts
│   │   ├── help.ts
│   │   ├── init-wizard.ts
│   │   ├── install-chat.ts
│   │   └── stop.ts
│   └── view/
│       └── index.ts
├── tsconfig.json
├── package.json
├── dist/ (compiled output)
└── tests/

**Total TypeScript/JavaScript files in .genie/cli/src:** 83 files
```

### .genie/mcp Directory Structure
```
.genie/mcp/
├── src/
│   ├── server.js & server.ts
│   ├── websocket-manager.ts
│   ├── lib/
│   │   ├── cli-executor.ts
│   │   ├── display-transform.ts
│   │   ├── git-validation.ts
│   │   ├── http-server.ts
│   │   ├── oauth-provider.ts
│   │   ├── oauth-session-manager.ts
│   │   ├── oauth2-endpoints.ts
│   │   ├── oauth2-utils.ts
│   │   ├── oidc-endpoints.ts
│   │   ├── process-cleanup.ts
│   │   ├── project-detector.ts
│   │   ├── role-detector.ts
│   │   ├── secret-token-auth.ts
│   │   ├── server-helpers.ts
│   │   ├── session-manager.ts
│   │   ├── session-types.ts
│   │   ├── spell-utils.ts
│   │   ├── task-title-formatter.ts
│   │   └── url-shortener.ts
│   ├── middleware/
│   │   └── auth.ts
│   ├── resources/
│   │   └── neuron-provider.ts
│   ├── tools/
│   │   ├── continue-task-tool.ts
│   │   ├── create-subtask-tool.ts
│   │   └── prompt-tool.ts
│   └── types/
│       └── oauth2.ts
├── tsconfig.json
├── package.json
├── dist/ (compiled output)
└── tests/

**Total TypeScript/JavaScript files in .genie/mcp/src:** 27 files
```

### Root-Level Files
```
/
├── forge.js (1,164+ lines, main ForgeClient implementation)
├── src/
│   └── lib/
│       └── forge-client.js (ForgeClient proxy/alias to forge.js)
├── bin/
│   ├── automagik-genie.js (entry point)
│   ├── mcp.js (MCP entry point)
│   ├── cleanup.js
│   ├── rollback.js
│   ├── status.js
│   └── statusline.js
├── package.json (declares bin entries)
└── tests/
    ├── genie-cli.test.cjs
    ├── genie-cli.test.mjs
    ├── agent-resolver.test.js
    ├── session-service.test.cjs
    ├── paths.test.js
    ├── session-helpers.test.js
    ├── async.test.js
    ├── utils.test.js
    ├── cli-parser.test.js
    ├── mcp-automated.test.js
    ├── mcp-tools-validation.test.js
    ├── mcp-integration.test.js
    └── mcp-live-sessions.test.js
```

---

## 5. ENTRY POINTS (bin/ directory)

### File: `/bin/automagik-genie.js`
**Lines 19 & 34:**
```javascript
const unifiedStartup = path.join(__dirname, '..', '.genie', 'cli', 'dist', 'unified-startup.js');
const entry = path.join(__dirname, '..', '.genie', 'cli', 'dist', 'genie-cli.js');
```
- **Dependency:** `.genie/cli/dist/` (compiled output)
- **Type:** Dynamic path construction
- **Resolves to:** `.genie/cli/dist/unified-startup.js` OR `.genie/cli/dist/genie-cli.js`

### File: `/bin/mcp.js`
**Line 9:**
```javascript
const entry = path.join(__dirname, '..', '.genie', 'cli', 'dist', 'genie-cli.js');
```
- **Dependency:** `.genie/cli/dist/genie-cli.js` (compiled output)
- **Type:** Dynamic path construction

### File: `/bin/cleanup.js`, `/bin/rollback.js`, `/bin/status.js`, `/bin/statusline.js`
- All follow same pattern: `require(path.join(..., '.genie', 'cli', 'dist', '...'))`

---

## 6. PACKAGE.JSON BIN ENTRIES

**File:** `/package.json` (lines 6-13)
```json
"bin": {
  "genie": ".genie/cli/dist/genie-cli.js",
  "automagik-genie": "bin/automagik-genie.js",
  "automagik-genie-mcp": "bin/mcp.js",
  "automagik-genie-rollback": "bin/rollback.js",
  "automagik-genie-status": "bin/status.js",
  "automagik-genie-cleanup": "bin/cleanup.js",
  "automagik-genie-statusline": "bin/statusline.js"
}
```

- **genie** → `.genie/cli/dist/genie-cli.js` (DIRECT reference to compiled code)
- **automagik-genie** → `bin/automagik-genie.js` (wrapper that internally references `.genie/cli/dist/`)

---

## 7. REVERSE DEPENDENCY GRAPH

### Dependency Chain Summary

```
EXTERNAL CONSUMERS
├── /bin/*.js (7 files)
│   └── Require .genie/cli/dist/**/*
├── /tests/*.js (14 files)
│   └── Require .genie/cli/dist/**/*
└── /scripts/*.js (1 file)
    └── Require .genie/cli/dist/**/*

.GENIE/CLI
├── Compiles to: .genie/cli/dist/**/*
├── Contains: 83 TypeScript/JavaScript source files
└── Uses imports:
    ├── Internal: relative imports (../, ./lib/, etc.)
    ├── forge-client: 3+ files import ../../../../src/lib/forge-client.js
    └── Standard packages: path, fs, child_process, etc.

.GENIE/MCP
├── Compiles to: .genie/mcp/dist/**/*
├── Contains: 27 TypeScript/JavaScript source files
└── Uses imports:
    ├── Internal: relative imports (../, ./lib/, etc.)
    ├── forge.js: 4 files require(path.join(geniePackageRoot, 'forge.js'))
    └── Standard packages: express, ws, zod, etc.

ROOT-LEVEL FILES
├── /forge.js
│   ├── 1,164 lines of ForgeClient implementation
│   ├── CommonJS exports: { ForgeClient }
│   └── Used by: .genie/mcp/src/tools/** & .genie/mcp/src/lib/session-manager.ts
├── /src/lib/forge-client.js
│   ├── Proxy/alias to forge.js
│   └── Used by: .genie/cli/src/**

FINAL CONSUMERS
├── npm bin: genie, automagik-genie, automagik-genie-mcp, etc.
├── Tests: 14 test files
├── Scripts: 1 assertion script
└── Internal: .genie/** code uses ForgeClient via imports
```

---

## 8. IMPORT PATTERNS SUMMARY

### Pattern 1: .genie/cli/dist (Compiled Output)
**Used by:** tests, scripts, bin/ files, package.json
```javascript
require('../.genie/cli/dist/cli-core/index.js')
require('../.genie/cli/dist/lib/agent-resolver.js')
// etc.
```

### Pattern 2: forge.js (Direct Dynamic Path)
**Used by:** .genie/mcp/src/tools/**, .genie/mcp/src/lib/session-manager.ts
```typescript
const geniePackageRoot = path.resolve(__dirname, '../../../..');
const ForgeClient = require(path.join(geniePackageRoot, 'forge.js')).ForgeClient;
```

### Pattern 3: src/lib/forge-client.js (TypeScript Import)
**Used by:** .genie/cli/src/lib/**
```typescript
import { ForgeClient } from '../../../../src/lib/forge-client.js';
```

---

## 9. FILES MODIFIED (LINTED)

The following files have been auto-formatted by tools:
1. `/forge.js` - Full file modified
2. `/src/lib/forge-client.js` - Full file modified
3. `.genie/cli/src/lib/forge-executor.ts` - Partial modifications (lines 32-343)
4. `.genie/cli/src/lib/forge-manager.ts` - Partial modifications (lines 22-474)
5. `.genie/mcp/src/tools/create-subtask-tool.ts` - Partial modifications (lines 22-121)

---

## 10. MIGRATION IMPACT ANALYSIS

### Critical Import Paths That Must Update

| Current Path | Type | Used By | Update Required |
|---|---|---|---|
| `../../../../src/lib/forge-client.js` | TypeScript import | 3+ .genie/cli files | YES - if moving forge-client |
| `path.join(geniePackageRoot, 'forge.js')` | Dynamic require | 4 .genie/mcp files | YES - if moving forge.js |
| `.genie/cli/dist/**/*` | Relative require | tests, scripts, bin | YES - if moving dist output |
| `../../../src/lib/forge-client.js` | TypeScript import | .genie/cli/src/debug-stats.ts | YES - if moving forge-client |

### Files Requiring Path Updates After Migration

1. All 83 files in `.genie/cli/src/` - check relative imports
2. All 27 files in `.genie/mcp/src/` - check relative imports
3. All 14 test files - check dist references
4. All 7 bin files - check dist references
5. 1 script file - check dist references

---

## CONCLUSION

### High-Level Dependency Summary

- **Total external imports from .genie/cli:** 15 files (all reference compiled dist/)
- **Total imports of forge.js:** 4 files directly, 3+ indirectly
- **Total cross-folder imports:** 6+ files (.genie/cli uses src/lib/forge-client.js)
- **Total affected source files:** 83 + 27 = 110 source files
- **Total affected test/script files:** 15 files
- **Total affected bin files:** 7 files

### Critical Paths for Migration

1. **forge.js location:** Currently at `/forge.js` → Used by `.genie/mcp/src/**`
2. **forge-client.js location:** Currently at `/src/lib/forge-client.js` → Used by `.genie/cli/src/**`
3. **Compiled output:** `.genie/cli/dist/**` → Used by tests, scripts, bin files
4. **Relative imports:** All 110 source files use relative imports internally

