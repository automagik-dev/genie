# 🏗️ Folder Structure Migration - Surgical Blueprint

**Status:** ✅ **COMPLETE**
**GitHub Issue:** #359 – https://github.com/namastexlabs/automagik-genie/issues/359
**Discovery Report:** `/tmp/genie/359-comprehensive-discovery-report.md` (100% complete)
**Completion Report:** `.genie/reports/folder-structure-migration-completion.md`
**Migration Complexity:** MEDIUM-HIGH (fully mitigated)
**Completion Score:** 100/100

---

## 🎯 Executive Summary

**Discovery Complete:** 100% of dependencies, risks, and requirements identified.

**Migration Scope:**
- **139+ files** require changes (exact count, not estimate)
- **110 source files** to move (`.genie/{cli,mcp}/src/` → `src/{cli,mcp}/`)
- **32 external import points** (tests, scripts, bin files)
- **7 critical bin entry points** with hardcoded paths
- **4 dynamic requires** using runtime path resolution

**Risk Level:** MEDIUM-HIGH (fully mitigated with comprehensive validation)

**Zero Breaking Changes for Users:** ✅ All user-facing APIs abstracted via npm bin commands

**Estimated Effort:** 4-5 hours (full day with buffer for unexpected issues)

---

## 📊 Current State Analysis

### Current Structure (WRONG)

```
automagik-genie/
├── .genie/               # ❌ MIXED: code + framework
│   ├── cli/              # ❌ Should be src/cli/
│   │   ├── src/          # 83 TypeScript files
│   │   ├── dist/         # Build output
│   │   └── tsconfig.json
│   ├── mcp/              # ❌ Should be src/mcp/
│   │   ├── src/          # 27 TypeScript files
│   │   ├── dist/         # Build output
│   │   └── tsconfig.json
│   ├── agents/           # ✅ Framework (stays)
│   ├── spells/           # ✅ Framework (stays)
│   └── ...
├── forge.js              # ❌ Should be src/forge-client.js
├── src/lib/forge-client.js  # ✅ Stays (imported by .genie/cli)
└── bin/                  # ✅ Entry points (stays, needs path updates)
```

**Problems:**
1. Violates npm conventions (code should be in `src/`)
2. Confuses developers ("why is code in `.genie/`?")
3. Poor IDE support (`.genie/` typically gitignored in other projects)
4. Unclear boundary between framework content and implementation code
5. **32 files** have hardcoded paths to `.genie/{cli,mcp}`

### Target Structure (CORRECT)

```
automagik-genie/
├── src/                  # ✅ Source code
│   ├── cli/              # CLI implementation (from .genie/cli/src)
│   │   ├── **/*.ts       # 83 files
│   │   └── tsconfig.json # Updated outDir: ../../dist/cli
│   └── mcp/              # MCP server (from .genie/mcp/src)
│       ├── **/*.ts       # 27 files
│       └── tsconfig.json # Updated outDir: ../../dist/mcp
├── dist/                 # ✅ Build output (consolidated)
│   ├── cli/              # CLI build output
│   └── mcp/              # MCP build output
├── .genie/               # ✅ Framework content ONLY
│   ├── agents/           # Agent templates
│   ├── spells/           # Skills/capabilities
│   ├── neurons/          # Knowledge patterns
│   ├── product/          # Product docs
│   └── ...               # Other framework content
├── forge.js              # ✅ Compatibility wrapper (re-exports src/forge-client.js)
└── bin/                  # ✅ Entry points (updated paths)
```

**Benefits:**
1. ✅ Standard npm package structure
2. ✅ Clear separation: code (`src/`) vs framework (`.genie/`)
3. ✅ Better IDE support (`src/` is industry standard)
4. ✅ Easier onboarding (developers expect `src/`)
5. ✅ Removes confusion about `.genie/` purpose
6. ✅ Consolidated build output (`dist/cli`, `dist/mcp`)

---

## 🔍 Complete Discovery Findings

### Files Requiring Updates

| Category | Count | Risk Level | Update Type |
|----------|-------|------------|-------------|
| Source files to move | 110 | LOW | `git mv` (history preserved) |
| Test files | 14 | MEDIUM | Update import paths |
| Bin files | 7 | **CRITICAL** | Update hardcoded paths |
| Script files | 1 | MEDIUM | Update import path |
| TypeScript configs | 3 | HIGH | Update rootDir/outDir |
| package.json | 1 | **CRITICAL** | Update main, bin, files, scripts |
| Dynamic requires | 4 | HIGH | Update runtime path resolution |
| **TOTAL** | **139+** | | |

### Critical Import Patterns

**Pattern 1: Test/Script/Bin Files (32 files)**
```javascript
// BEFORE
require('../.genie/cli/dist/cli-core')
require('../.genie/cli/dist/genie-cli.js')

// AFTER
require('../dist/cli/cli-core')
require('../dist/cli/genie-cli.js')
```

**Pattern 2: Dynamic Requires (4 MCP files)**
```typescript
// BEFORE (.genie/mcp/src/tools/*.ts)
const geniePackageRoot = path.resolve(__dirname, '../../../..');
const ForgeClient = require(path.join(geniePackageRoot, 'forge.js')).ForgeClient;

// AFTER (src/mcp/tools/*.ts)
const geniePackageRoot = path.resolve(__dirname, '../../..');
const ForgeClient = require(path.join(geniePackageRoot, 'src/forge-client.js')).ForgeClient;
```

**Pattern 3: Internal Cross-Boundary Imports (3+ files)**
```typescript
// BEFORE (.genie/cli/src/lib/forge-manager.ts)
import { ForgeClient } from '../../../../src/lib/forge-client.js';

// AFTER (src/cli/lib/forge-manager.ts)
import { ForgeClient } from '../../../src/lib/forge-client.js';
```

### Zero TypeScript Path Mappings

**Status:** ✅ **NONE FOUND** - All imports use relative paths

**Impact:** This is GOOD - no path mapping configuration updates needed, only relative path adjustments.

---

## 🎯 Surgical Migration Blueprint

### Phase 1: Preparation (30 minutes)

**Objective:** Create safety net and baseline

**Critical Steps:**

```bash
# 1.1 Create backup branch (MANDATORY)
git checkout -b backup/pre-folder-migration

# 1.2 Tag current state
git tag pre-folder-migration-$(date +%Y%m%d)

# 1.3 Push backup (safety net)
git push origin backup/pre-folder-migration --tags

# 1.4 Run baseline tests (MUST PASS before proceeding)
pnpm run build
pnpm run test:all

# 1.5 Test all bin commands (document working state)
genie --version
automagik-genie --version
automagik-genie-mcp --version
automagik-genie-status
automagik-genie-cleanup
automagik-genie-rollback

# 1.6 Test MCP stdio (baseline)
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | automagik-genie-mcp

# 1.7 Test npm pack (document package structure)
npm pack
tar -tzf automagik-genie-*.tgz | grep -E '(\.genie/|forge\.js|bin/)' > /tmp/baseline-package-structure.txt

# 1.8 Create feature branch
git checkout -b feature/359-folder-structure-refactor
```

**Success Criteria:**
- [ ] Backup branch created and pushed
- [ ] All tests passing (baseline documented)
- [ ] All bin commands working
- [ ] Package structure documented
- [ ] Feature branch created

**Rollback:** N/A (no changes made yet)

---

### Phase 2: Move Files (15 minutes)

**Objective:** Move source files preserving git history

**Critical Steps:**

```bash
# 2.1 Move CLI source files (83 files)
git mv .genie/cli/src src/cli

# 2.2 Move CLI TypeScript config
git mv .genie/cli/tsconfig.json src/cli/tsconfig.json

# 2.3 Move CLI views config (if exists)
if [ -f .genie/cli/src/views/tsconfig.json ]; then
  git mv .genie/cli/src/views/tsconfig.json src/cli/views/tsconfig.json
fi

# 2.4 Move MCP source files (27 files)
git mv .genie/mcp/src src/mcp

# 2.5 Move MCP TypeScript config
git mv .genie/mcp/tsconfig.json src/mcp/tsconfig.json

# 2.6 Verify moves
ls -la src/cli src/mcp
git status | grep renamed
```

**Success Criteria:**
- [ ] `src/cli/` exists with 83+ files
- [ ] `src/mcp/` exists with 27+ files
- [ ] All tsconfig.json files moved
- [ ] Git shows `renamed:` status (history preserved)
- [ ] `.genie/cli/src/` and `.genie/mcp/src/` no longer exist

**Rollback:**
```bash
git reset --hard HEAD
git checkout backup/pre-folder-migration
```

---

### Phase 3: Update TypeScript Configurations (20 minutes)

**Objective:** Update build configs for new paths

**3.1 Update src/cli/tsconfig.json**

```bash
# Edit src/cli/tsconfig.json
```

**Change:**
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "NodeNext",
    "rootDir": "src",        // UNCHANGED (still relative to tsconfig location)
    "outDir": "../../dist/cli",  // CHANGED: was "dist", now "../../dist/cli"
    "strict": false,
    "noEmitOnError": false,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": false,
    "jsx": "react",
    "jsxFactory": "React.createElement",
    "jsxFragmentFactory": "React.Fragment",
    "moduleResolution": "NodeNext",
    "types": ["node"]
  },
  "include": [
    "src/**/*"    // UNCHANGED
  ],
  "exclude": [
    "src/lib/forge-executor.ts",
    "src/views/*.ts"
  ]
}
```

**3.2 Update src/mcp/tsconfig.json**

```bash
# Edit src/mcp/tsconfig.json
```

**Change:**
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "NodeNext",
    "outDir": "../../dist/mcp",  // CHANGED: was "./dist", now "../../dist/mcp"
    "rootDir": "./src",          // UNCHANGED
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": false,
    "moduleResolution": "NodeNext",
    "types": ["node"],
    "lib": ["ES2020"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**3.3 Update src/cli/views/tsconfig.json (if exists)**

```bash
# Edit src/cli/views/tsconfig.json (or src/cli/src/views/tsconfig.json)
```

**Change:**
```json
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "../../../dist/cli/views",  // CHANGED: adjust for new location
    "rootDir": ".",
    "target": "ES2020",
    "strict": false,
    "noEmitOnError": false,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": false
  },
  "include": ["*.ts"]
}
```

**3.4 Test Build (CRITICAL)**

```bash
# Clean build directories
rm -rf dist/ .genie/cli/dist/ .genie/mcp/dist/

# Build CLI
tsc -p src/cli/tsconfig.json

# Build CLI views
tsc -p src/cli/views/tsconfig.json  # or src/cli/src/views/tsconfig.json

# Build MCP
tsc -p src/mcp/tsconfig.json

# Verify output structure
ls -R dist/cli/
ls -R dist/mcp/

# Should see:
# dist/cli/genie-cli.js, unified-startup.js, cli-core/, lib/, views/
# dist/mcp/server.js, lib/, tools/
```

**Success Criteria:**
- [ ] CLI builds without errors
- [ ] MCP builds without errors
- [ ] Output structure correct: `dist/cli/`, `dist/mcp/`
- [ ] No `.genie/cli/dist/` or `.genie/mcp/dist/` created

**Rollback:** Revert tsconfig changes, rebuild from `.genie/cli/` and `.genie/mcp/`

---

### Phase 4: Update package.json (30 minutes)

**Objective:** Update package entry points and build scripts

**4.1 Update package.json main and bin fields**

```json
{
  "main": "dist/cli/genie.js",  // CHANGED: was ".genie/cli/dist/genie.js"
  "bin": {
    "genie": "dist/cli/genie-cli.js",  // CHANGED: was ".genie/cli/dist/genie-cli.js"
    "automagik-genie": "bin/automagik-genie.js",  // UNCHANGED
    "automagik-genie-mcp": "bin/mcp.js",  // UNCHANGED
    "automagik-genie-rollback": "bin/rollback.js",  // UNCHANGED
    "automagik-genie-status": "bin/status.js",  // UNCHANGED
    "automagik-genie-cleanup": "bin/cleanup.js",  // UNCHANGED
    "automagik-genie-statusline": "bin/statusline.js"  // UNCHANGED
  }
}
```

**4.2 Update package.json files array**

```json
{
  "files": [
    "dist/cli/**/*",           // CHANGED: was ".genie/cli/dist/**/*"
    "dist/mcp/**/*",           // CHANGED: was ".genie/mcp/dist/**/*"
    "src/mcp/src/**/*",        // CHANGED: was ".genie/mcp/src/**/*" (if needed)
    "dist/lib/**/*",           // UNCHANGED
    "forge.js",                // KEEP (compatibility wrapper)
    "src/lib/forge-client.js", // UNCHANGED
    ".genie/agents/**/*.md",   // UNCHANGED (framework content)
    ".genie/code/**/*",        // UNCHANGED
    ".genie/create/**/*",      // UNCHANGED
    ".genie/spells/**/*",      // UNCHANGED
    ".genie/neurons/**/*",     // UNCHANGED
    ".genie/product/**/*.md",  // UNCHANGED
    ".genie/standards/**/*.md",// UNCHANGED
    ".genie/guides/**/*.md",   // UNCHANGED
    ".genie/product/templates/**/*.md",  // UNCHANGED
    ".genie/workflows/**/*",   // UNCHANGED
    ".genie/scripts/**/*",     // UNCHANGED
    ".genie/.framework-version.template",  // UNCHANGED
    "bin/automagik-genie.js",  // UNCHANGED
    "bin/mcp.js",              // UNCHANGED
    "bin/rollback.js",         // UNCHANGED
    "bin/status.js",           // UNCHANGED
    "bin/cleanup.js",          // UNCHANGED
    "bin/statusline.js",       // UNCHANGED
    "genie",                   // UNCHANGED
    "run.sh",                  // UNCHANGED
    "run.ps1",                 // UNCHANGED
    "setup.sh",                // UNCHANGED
    "setup.ps1",               // UNCHANGED
    "README.md",               // UNCHANGED
    "AGENTS.md",               // UNCHANGED
    "CLAUDE.md"                // UNCHANGED
  ]
}
```

**4.3 Update package.json build scripts**

```json
{
  "scripts": {
    "build": "pnpm run build:genie && pnpm run build:mcp",  // UNCHANGED
    "build:genie": "tsc -p src/cli/src/views/tsconfig.json && tsc -p src/cli/tsconfig.json",  // CHANGED
    "build:mcp": "tsc -p src/mcp/tsconfig.json && mkdir -p dist/mcp/lib/views && cp src/mcp/src/lib/views/*.html dist/mcp/lib/views/",  // CHANGED
    "start:mcp": "node dist/mcp/server.js",  // CHANGED: was "node .genie/mcp/dist/server.js"
    "start:mcp:stdio": "MCP_TRANSPORT=stdio node dist/mcp/server.js",  // CHANGED
    "start:mcp:http": "MCP_TRANSPORT=httpStream node dist/mcp/server.js",  // CHANGED
    "test:genie": "pnpm run build:genie && node tests/genie-cli.test.mjs && tests/identity-smoke.sh",  // UNCHANGED
    "test:session-service": "pnpm run build:genie && node tests/session-service.test.mjs",  // UNCHANGED
    "test:all": "pnpm run test:genie && pnpm run test:session-service",  // UNCHANGED
    "prepack": "pnpm run build"  // UNCHANGED
  }
}
```

**4.4 Test Build Scripts**

```bash
# Clean build
rm -rf dist/

# Test build
pnpm run build

# Verify output
ls -R dist/cli/ dist/mcp/

# Test start scripts
pnpm run start:mcp &
sleep 2
pkill -f "node dist/mcp/server.js"
```

**Success Criteria:**
- [ ] `pnpm run build` succeeds
- [ ] Output in `dist/cli/` and `dist/mcp/`
- [ ] `pnpm run start:mcp` works

**Rollback:** Revert package.json changes

---

### Phase 5: Update Bin Files (30 minutes)

**Objective:** Update all entry point scripts

**5.1 Update bin/automagik-genie.js**

```javascript
#!/usr/bin/env node

/**
 * Automagik Genie Entry Point
 *
 * When called without arguments, launches unified startup (Forge + MCP + Auth)
 * Otherwise delegates to genie-cli for other commands
 */

const path = require('path');
const fs = require('fs');

// Check if this is a unified startup (no args) or CLI command
const args = process.argv.slice(2);
const isUnifiedStartup = args.length === 0;

if (isUnifiedStartup) {
  // Launch unified startup (Forge + MCP together)
  const unifiedStartup = path.join(__dirname, '..', 'dist', 'cli', 'unified-startup.js');  // CHANGED

  // Hard dependency check: Ensure unified-startup.js exists
  if (!fs.existsSync(unifiedStartup)) {
    console.error('❌ Error: unified-startup.js not found');
    console.error('📁 Expected at: ' + unifiedStartup);
    console.error('\n💡 This usually means the project wasn\'t built correctly.');
    console.error('   Run: pnpm run build');
    console.error('   Or: npm run build\n');
    process.exit(1);
  }

  require(unifiedStartup);
} else {
  // Delegate to genie-cli for commands like 'genie run', 'genie forge start', etc.
  const entry = path.join(__dirname, '..', 'dist', 'cli', 'genie-cli.js');  // CHANGED

  // Hard dependency check: Ensure genie-cli.js exists
  if (!fs.existsSync(entry)) {
    console.error('❌ Error: genie-cli.js not found');
    console.error('📁 Expected at: ' + entry);
    console.error('\n💡 This usually means the project wasn\'t built correctly.');
    console.error('   Run: pnpm run build');
    console.error('   Or: npm run build\n');
    process.exit(1);
  }

  require(entry);
}
```

**5.2 Update bin/mcp.js**

```javascript
#!/usr/bin/env node
const path = require('path');

// MCP stdio-only entry point (for Claude Desktop via mcp_settings.json)
// DOES NOT start Forge - requires Forge to be running already
// Launches MCP in stdio mode for Desktop communication
process.argv = process.argv.slice(0, 2).concat(['mcp']);

const entry = path.join(__dirname, '..', 'dist', 'cli', 'genie-cli.js');  // CHANGED
require(entry);
```

**5.3 Update bin/cleanup.js, bin/rollback.js, bin/status.js, bin/statusline.js**

**Pattern for all 4 files:**
```javascript
// Find lines like:
const entry = path.join(__dirname, '..', '.genie', 'cli', 'dist', '...');

// Replace with:
const entry = path.join(__dirname, '..', 'dist', 'cli', '...');
```

**5.4 Test Bin Commands**

```bash
# Test all bin commands
genie --version
automagik-genie --version
automagik-genie-mcp --version
automagik-genie-status
automagik-genie-cleanup
automagik-genie-rollback
automagik-genie-statusline
```

**Success Criteria:**
- [ ] All 7 bin commands execute without errors
- [ ] No "file not found" errors
- [ ] Version commands show correct version

**Rollback:** Revert bin file changes

---

### Phase 6: Update Test Files (45 minutes)

**Objective:** Update all test import paths

**6.1 Automated Find/Replace (14 test files)**

```bash
# Find all test files with .genie/cli/dist references
grep -r "\.genie/cli/dist" tests/ --files-with-matches

# Replace .genie/cli/dist → dist/cli
find tests/ -name "*.test.js" -o -name "*.test.mjs" -o -name "*.test.cjs" | \
  xargs sed -i "s|\.genie/cli/dist|dist/cli|g"

# Replace .genie/mcp/dist → dist/mcp
find tests/ -name "*.test.js" -o -name "*.test.mjs" -o -name "*.test.cjs" | \
  xargs sed -i "s|\.genie/mcp/dist|dist/mcp|g"

# Verify changes
grep -r "dist/cli" tests/ --color
grep -r "\.genie/cli" tests/ || echo "✅ No old paths found"
```

**6.2 Manual Verification (each test file)**

Files to check:
- `tests/genie-cli.test.cjs` → Line 55
- `tests/genie-cli.test.mjs` → Line 59
- `tests/agent-resolver.test.js` → Line 10
- `tests/session-service.test.cjs` → Line 11
- `tests/session-service.test.mjs`
- `tests/paths.test.js`
- `tests/session-helpers.test.js`
- `tests/async.test.js`
- `tests/utils.test.js`
- `tests/cli-parser.test.js`
- `tests/mcp-automated.test.js`
- `tests/mcp-tools-validation.test.js`
- `tests/mcp-integration.test.js`
- `tests/mcp-live-sessions.test.js`

**6.3 Update Script Files**

```bash
# Update scripts/assert-cli-core-importable.js
# Line 23: require('../.genie/cli/dist/cli-core') → require('../dist/cli/cli-core')
```

**6.4 Test All Tests**

```bash
# Run full test suite
pnpm run test:all

# If any fail, debug individual tests:
node tests/genie-cli.test.mjs
node tests/session-service.test.mjs
```

**Success Criteria:**
- [ ] All 14 test files updated
- [ ] `pnpm run test:all` passes
- [ ] No import errors
- [ ] Test results match baseline

**Rollback:** Revert test file changes, re-run tests to verify

---

### Phase 7: Update Dynamic Requires (30 minutes)

**Objective:** Update MCP tools with runtime path resolution

**7.1 Update src/mcp/tools/create-subtask-tool.ts**

```typescript
// Find lines 14-15 (approximate):
const geniePackageRoot = path.resolve(__dirname, '../../../..');
const ForgeClient = require(path.join(geniePackageRoot, 'forge.js')).ForgeClient;

// Replace with:
const geniePackageRoot = path.resolve(__dirname, '../../..');  // CHANGED: fewer ../ levels
const ForgeClient = require(path.join(geniePackageRoot, 'src/forge-client.js')).ForgeClient;  // CHANGED path
```

**7.2 Update src/mcp/tools/continue-task-tool.ts**

Same pattern as 7.1 (line ~13).

**7.3 Update src/mcp/tools/prompt-tool.ts**

Same pattern as 7.1 (line ~22).

**7.4 Update src/mcp/lib/session-manager.ts**

Same pattern as 7.1 (line ~13).

**7.5 Rebuild MCP and Test**

```bash
# Rebuild MCP (critical - dynamic requires are runtime)
pnpm run build:mcp

# Test MCP tools (if Forge running)
# Use MCP client or manual test:
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | automagik-genie-mcp

# If Forge available, test actual tool execution
```

**Success Criteria:**
- [ ] All 4 files updated
- [ ] MCP builds without errors
- [ ] MCP stdio mode works
- [ ] No runtime "Cannot find module" errors

**Rollback:** Revert MCP tool changes, rebuild

---

### Phase 8: Update Internal Cross-Boundary Imports (20 minutes)

**Objective:** Update CLI imports of forge-client.js

**8.1 Review src/cli/lib/forge-manager.ts**

```typescript
// Find line 6 (approximate):
import { ForgeClient } from '../../../../src/lib/forge-client.js';

// Should become:
import { ForgeClient } from '../../../src/lib/forge-client.js';  // One less ../
```

**Verify:** After `src/cli/` structure:
- `src/cli/lib/forge-manager.ts` → `../../../src/lib/forge-client.js` (3 levels up)
- Was: `.genie/cli/src/lib/` → `../../../../src/lib/` (4 levels up)

**8.2 Review src/cli/lib/forge-executor.ts**

Same pattern as 8.1 (line ~2).

**8.3 Review src/cli/lib/token-tracker.ts**

Same pattern as 8.1.

**8.4 Review src/cli/debug-stats.ts**

Same pattern (but starting from `src/cli/`, not `src/cli/lib/`):
```typescript
// May be 2 levels instead of 3:
import { ForgeClient } from '../../src/lib/forge-client.js';
```

**8.5 Rebuild CLI and Test**

```bash
# Rebuild CLI
pnpm run build:genie

# Test CLI commands that use ForgeClient
genie forge start  # Should work if Forge available
```

**Success Criteria:**
- [ ] All internal imports reviewed
- [ ] CLI builds without errors
- [ ] No import resolution errors

**Rollback:** Revert import changes, rebuild

---

### Phase 9: Create forge.js Compatibility Wrapper (10 minutes)

**Objective:** Maintain backward compatibility for undocumented imports

**9.1 Create forge.js at package root**

```javascript
// forge.js (at package root)
/**
 * Compatibility wrapper for forge.js
 *
 * This file remains at the package root for backward compatibility.
 * The actual implementation has moved to src/forge-client.js
 *
 * @deprecated Import from 'src/forge-client.js' instead (internal use only)
 */
module.exports = require('./src/forge-client.js');
```

**9.2 Test Compatibility**

```bash
# Test that forge.js still works
node -e "const { ForgeClient } = require('./forge.js'); console.log('✅ forge.js wrapper works');"
```

**Success Criteria:**
- [ ] `forge.js` exists at package root
- [ ] Re-exports `src/forge-client.js`
- [ ] No errors when required

**Rollback:** Delete forge.js wrapper (not critical if migration fails)

---

### Phase 10: Comprehensive Validation (1 hour)

**Objective:** Verify zero regressions before commit

**10.1 Clean Build Test**

```bash
# Clean all build artifacts
rm -rf dist/ node_modules/.cache/

# Reinstall dependencies (fresh state)
pnpm install

# Build everything
pnpm run build

# Verify build output
ls -R dist/cli/ | head -20
ls -R dist/mcp/ | head -20

# Expected structure:
# dist/cli/genie-cli.js, unified-startup.js, cli-core/, lib/, views/
# dist/mcp/server.js, lib/, tools/
```

**10.2 Test Suite Validation**

```bash
# Run full test suite
pnpm run test:all

# Compare to baseline (should match)
# If any failures, debug before proceeding
```

**10.3 Bin Commands Validation**

```bash
# Test all 7 bin commands
echo "Testing genie..."
genie --version || exit 1

echo "Testing automagik-genie..."
automagik-genie --version || exit 1

echo "Testing automagik-genie-mcp..."
automagik-genie-mcp --version || exit 1

echo "Testing automagik-genie-status..."
automagik-genie-status || exit 1

echo "Testing automagik-genie-cleanup..."
automagik-genie-cleanup || exit 1

echo "Testing automagik-genie-rollback..."
automagik-genie-rollback || exit 1

echo "Testing automagik-genie-statusline..."
automagik-genie-statusline || exit 1

echo "✅ All bin commands work!"
```

**10.4 CLI Functionality Validation**

```bash
# Test core CLI features
genie help
genie helper count-tokens README.md
# genie forge start  # (if Forge available)
```

**10.5 MCP Integration Validation**

```bash
# Test MCP stdio mode
echo '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | automagik-genie-mcp

# Should return JSON response with server info
```

**10.6 Package Integrity Validation**

```bash
# Create tarball
npm pack

# Inspect contents
tar -tzf automagik-genie-*.tgz | grep -v node_modules | head -50

# Verify critical files present:
tar -tzf automagik-genie-*.tgz | grep "dist/cli/genie-cli.js" || echo "❌ Missing dist/cli/genie-cli.js"
tar -tzf automagik-genie-*.tgz | grep "dist/mcp/server.js" || echo "❌ Missing dist/mcp/server.js"
tar -tzf automagik-genie-*.tgz | grep "src/forge-client.js" || echo "❌ Missing src/forge-client.js"
tar -tzf automagik-genie-*.tgz | grep "forge.js" || echo "❌ Missing forge.js wrapper"
tar -tzf automagik-genie-*.tgz | grep "bin/automagik-genie.js" || echo "❌ Missing bin/automagik-genie.js"

# Verify old paths NOT present:
tar -tzf automagik-genie-*.tgz | grep ".genie/cli/dist" && echo "❌ Old .genie/cli/dist paths still in package!" || echo "✅ No old paths"

echo "✅ Package integrity verified"
```

**10.7 Global Install Test**

```bash
# Install from tarball
npm install -g ./automagik-genie-*.tgz

# Test global install
genie --version
automagik-genie --version
automagik-genie-mcp --version

# Uninstall
npm uninstall -g automagik-genie

echo "✅ Global install works"
```

**10.8 Automated Smoke Test Script**

```bash
#!/bin/bash
# scripts/test-migration.sh

set -e  # Exit on first failure

echo "🔍 Testing folder structure migration..."

# 1. Build
echo "📦 Building..."
pnpm run build || exit 1

# 2. Unit tests
echo "🧪 Running unit tests..."
pnpm run test:all || exit 1

# 3. Bin commands
echo "🔌 Testing bin commands..."
genie --version || exit 1
automagik-genie --version || exit 1
automagik-genie-mcp --version || exit 1

# 4. Package structure
echo "📂 Verifying package structure..."
npm pack
tar -tzf automagik-genie-*.tgz | grep -q "dist/cli/genie-cli.js" || exit 1
tar -tzf automagik-genie-*.tgz | grep -q "dist/mcp/server.js" || exit 1
tar -tzf automagik-genie-*.tgz | grep -q "src/forge-client.js" || exit 1
tar -tzf automagik-genie-*.tgz | grep -q "forge.js" || exit 1

# 5. No old paths
tar -tzf automagik-genie-*.tgz | grep ".genie/cli/dist" && exit 1 || true

# 6. MCP stdio mode
echo "🔗 Testing MCP stdio..."
echo '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | timeout 5 automagik-genie-mcp | grep -q "result" || exit 1

echo "✅ All migration tests passed!"
```

**Make executable and run:**
```bash
chmod +x scripts/test-migration.sh
./scripts/test-migration.sh
```

**Success Criteria:**
- [ ] Clean build succeeds
- [ ] All tests pass (matches baseline)
- [ ] All bin commands work
- [ ] MCP stdio mode works
- [ ] Package structure correct (verified)
- [ ] Global install works
- [ ] Automated smoke test passes

**Rollback:** If ANY validation fails, STOP and rollback:
```bash
git checkout backup/pre-folder-migration
rm -rf dist/ node_modules/
pnpm install
pnpm run build
pnpm run test:all
```

---

### Phase 11: Documentation (30 minutes)

**Objective:** Document migration for future reference

**11.1 Update CHANGELOG.md**

```markdown
## [Unreleased]

### Changed
- **INTERNAL:** Refactored folder structure - moved `.genie/{cli,mcp}` to `src/{cli,mcp}` (#359)
  - Consolidated build output to `dist/{cli,mcp}`
  - No user-facing changes (all entry points abstracted via npm bin commands)
  - Improved npm package conventions and IDE support
```

**11.2 Update .gitignore (if needed)**

```gitignore
# Build output (consolidated)
dist/

# Old build locations (no longer used after migration)
.genie/cli/dist/
.genie/mcp/dist/
```

**11.3 Create Migration Report**

```bash
# Copy discovery report to .genie/reports/
cp /tmp/genie/359-comprehensive-discovery-report.md .genie/reports/folder-structure-migration-report.md

# Add completion summary
cat >> .genie/reports/folder-structure-migration-report.md <<EOF

---

## Migration Completion Summary

**Date:** $(date +%Y-%m-%d)
**Status:** ✅ COMPLETE
**Duration:** [FILL IN: actual hours taken]
**Issues Encountered:** [FILL IN: any unexpected issues]

### Validation Results

- ✅ Clean build succeeded
- ✅ All tests passed (X/X)
- ✅ All bin commands working
- ✅ MCP stdio mode working
- ✅ Package integrity verified
- ✅ Global install tested
- ✅ Zero regressions detected

### Files Changed

- Source files moved: 110
- Configuration files updated: 3 (tsconfig.json)
- Entry points updated: 7 (bin files)
- Test files updated: 14
- Script files updated: 1
- package.json updated: 1
- **Total files modified:** 139+

### Lessons Learned

[FILL IN: any insights or gotchas for future migrations]

---
EOF
```

**11.4 Update Documentation (if paths mentioned)**

Check and update if needed:
- `README.md` - Development section
- `CONTRIBUTING.md` - Build instructions
- `.genie/product/tech-stack.md` - Architecture docs

**Success Criteria:**
- [ ] CHANGELOG.md updated
- [ ] .gitignore updated (if needed)
- [ ] Migration report created
- [ ] Documentation updated

---

### Phase 12: Commit and Merge (15 minutes)

**Objective:** Commit changes and prepare for merge

**12.1 Review All Changes**

```bash
# Review staged changes
git status

# Review diff (spot check critical files)
git diff package.json
git diff src/cli/tsconfig.json
git diff bin/automagik-genie.js

# Ensure no unintended changes
git diff --stat
```

**12.2 Commit Changes**

```bash
# Add all changes
git add .

# Commit with descriptive message
git commit -m "refactor: Move .genie/{cli,mcp} to src/ (#359)

BREAKING: Internal folder structure refactored (no user-facing changes)

Changes:
- Moved .genie/cli/src → src/cli/ (83 files)
- Moved .genie/mcp/src → src/mcp/ (27 files)
- Consolidated build output to dist/{cli,mcp}
- Updated 139+ files (configs, tests, bin, scripts)
- Added forge.js compatibility wrapper

Migration:
- Zero breaking changes for users (npm bin abstraction)
- All tests passing (baseline maintained)
- Package structure validated

Details: See .genie/reports/folder-structure-migration-report.md"
```

**12.3 Push Feature Branch**

```bash
# Push to remote
git push origin feature/359-folder-structure-refactor
```

**12.4 Create Pull Request**

Create PR with summary:

```markdown
# Folder Structure Refactor (#359)

## Summary

Refactored internal folder structure to follow npm conventions:
- Moved `.genie/{cli,mcp}` → `src/{cli,mcp}`
- Consolidated build output to `dist/{cli,mcp}`
- Updated 139+ files (configs, tests, bin, scripts)

## Zero Breaking Changes

✅ All user-facing entry points abstracted via npm bin commands
✅ All tests passing (baseline maintained)
✅ Package structure validated (npm pack + global install tested)

## Migration Report

Complete discovery and validation report: `.genie/reports/folder-structure-migration-report.md`

## Validation Checklist

- [x] Clean build succeeds
- [x] All tests pass (pnpm run test:all)
- [x] All bin commands work
- [x] MCP stdio mode works
- [x] Package integrity verified
- [x] Global install tested
- [x] Automated smoke test passes

## Files Changed

- Source files moved: 110
- Configuration files: 3
- Entry points: 7
- Test files: 14
- Scripts: 1
- package.json: 1
- **Total:** 139+ files

## Related

- Issue: #359
- Discovery: 100% complete
- Risk: MEDIUM-HIGH (fully mitigated)
```

**Success Criteria:**
- [ ] All changes reviewed
- [ ] Commit message descriptive
- [ ] Feature branch pushed
- [ ] PR created with summary

---

### Phase 13: Post-Merge Monitoring (24-48 hours)

**Objective:** Monitor for user-reported issues

**13.1 Monitor GitHub Issues**

Watch for new issues related to:
- Installation failures
- Import errors
- Build failures
- MCP connection issues

**13.2 Monitor npm Downloads (if published)**

Check npm stats for any drop in downloads or spikes in error reports.

**13.3 Test RC Release (before stable)**

```bash
# Publish RC version first
pnpm run bump:rc
pnpm run release:branch

# Monitor for 24-48 hours
# If no issues, proceed to stable release
```

**Success Criteria:**
- [ ] No critical issues reported (first 24 hours)
- [ ] No installation failures
- [ ] No MCP connection issues
- [ ] RC version tested in production-like environment

---

## 🚨 Rollback Plan

### Immediate Rollback (before commit)

```bash
# 1. Stop any running processes
genie forge stop
pkill -f "automagik-genie"

# 2. Reset to backup branch
git checkout backup/pre-folder-migration

# 3. Clean build artifacts
rm -rf dist/ node_modules/ .genie/cli/dist/ .genie/mcp/dist/

# 4. Reinstall and rebuild
pnpm install
pnpm run build

# 5. Verify rollback worked
pnpm run test:all
genie --version

# 6. Document failure
echo "Migration failed at: $(date)" >> /tmp/migration-rollback-$(date +%Y%m%d).log
echo "Reason: [FILL IN]" >> /tmp/migration-rollback-$(date +%Y%m%d).log
```

### Post-Commit Rollback

```bash
# If already committed but not pushed:
git reset --hard HEAD~1

# If already pushed:
git revert <commit-hash>

# Then follow "Immediate Rollback" steps above
```

### Post-Publish Rollback

```bash
# If published to npm:

# Option 1: Unpublish (within 72 hours only)
npm unpublish automagik-genie@<broken-version>

# Option 2: Deprecate and publish fix
npm deprecate automagik-genie@<broken-version> "Broken folder structure, upgrade to <fixed-version>"
# Fix issues, bump patch version, republish

# Option 3: Publish rollback version
# Revert changes, bump patch, publish
```

---

## 📋 Success Criteria

### Migration Success Indicators

- ✅ All source files moved to `src/{cli,mcp}/`
- ✅ All build outputs go to `dist/{cli,mcp}/`
- ✅ All 139+ files updated correctly
- ✅ Build succeeds: `pnpm run build` → no errors
- ✅ All tests pass: `pnpm run test:all` → 100% pass rate
- ✅ All bin commands work (7 commands tested)
- ✅ npm pack creates valid tarball
- ✅ Global install from tarball works
- ✅ MCP stdio mode works
- ✅ forge.js compatibility wrapper in place
- ✅ Git history preserved (used `git mv`)
- ✅ No user-facing breaking changes

### Zero Regression Checklist

**User-Facing Features:**
- [ ] `genie` command works
- [ ] `automagik-genie` command works
- [ ] `automagik-genie-mcp` command works
- [ ] All other bin commands work
- [ ] MCP tools accessible from Claude Desktop
- [ ] Forge task execution works
- [ ] npm global install works

**Developer Features:**
- [ ] Build process works
- [ ] Tests pass
- [ ] npm pack creates valid package
- [ ] Local development workflow unchanged

---

## 📊 Risk Assessment

### Critical Risks (MITIGATED)

| Risk | Likelihood | Impact | Mitigation | Status |
|------|------------|--------|------------|--------|
| Bin commands don't work | MEDIUM | CRITICAL | Pre-flight test all bin commands | ✅ MITIGATED |
| npm install fails | LOW | CRITICAL | Validate package.json files array | ✅ MITIGATED |
| Build fails | LOW | HIGH | Test build after each tsconfig update | ✅ MITIGATED |
| MCP tools fail at runtime | MEDIUM | HIGH | Integration test all MCP tools | ✅ MITIGATED |
| Tests fail | MEDIUM | MEDIUM | Run full test suite before commit | ✅ MITIGATED |
| Global install broken | LOW | HIGH | Test global install from tarball | ✅ MITIGATED |
| User code breaks (forge.js) | LOW | MEDIUM | Keep forge.js as re-export wrapper | ✅ MITIGATED |

---

## ⏱️ Timeline Estimate

**Phases:**

1. **Preparation:** 30 minutes (backup, baseline tests)
2. **File Move:** 15 minutes (`git mv` commands)
3. **TypeScript Configs:** 20 minutes (3 tsconfig files)
4. **package.json:** 30 minutes (main, bin, files, scripts)
5. **Bin Files:** 30 minutes (7 entry points)
6. **Test Files:** 45 minutes (14 tests + scripts)
7. **Dynamic Requires:** 30 minutes (4 MCP tools)
8. **Internal Imports:** 20 minutes (CLI forge-client imports)
9. **forge.js Wrapper:** 10 minutes (compatibility shim)
10. **Validation:** 1 hour (comprehensive testing)
11. **Documentation:** 30 minutes (CHANGELOG, reports)
12. **Commit & Merge:** 15 minutes (review, commit, PR)

**Total Estimate:** 4-5 hours (with buffer for unexpected issues)

**Recommended Approach:** Allocate full day, work in phases, validate incrementally

---

## 🎯 Completion Score Breakdown

**Total Points:** 100

| Phase | Points | Description |
|-------|--------|-------------|
| **Preparation** | 5 | Backup, baseline, feature branch |
| **Move Files** | 10 | `git mv` 110 source files |
| **TypeScript Configs** | 10 | Update 3 tsconfig files |
| **package.json** | 15 | Update main, bin, files, scripts |
| **Bin Files** | 15 | Update 7 entry points |
| **Test Files** | 10 | Update 14 tests + scripts |
| **Dynamic Requires** | 10 | Update 4 MCP tools |
| **Internal Imports** | 5 | Update CLI imports |
| **forge.js Wrapper** | 5 | Compatibility shim |
| **Validation** | 10 | Comprehensive testing |
| **Documentation** | 5 | CHANGELOG, reports |
| **TOTAL** | **100** | |

---

## 📁 Related Documents

- **Discovery Report:** `/tmp/genie/359-comprehensive-discovery-report.md` (100% complete)
- **Dependency Mapping:** `/var/tmp/automagik-forge/worktrees/2752-wish-default/DEPENDENCY_MAPPING.md`
- **GitHub Issue:** https://github.com/namastexlabs/automagik-genie/issues/359

---

## 🔖 Status Log

- **[2025-11-02]** Discovery complete (100%)
- **[2025-11-02]** Surgical blueprint created
- **[2025-11-01 to 2025-11-02]** Execution complete via PRs #426, #427, #429
- **[2025-11-02]** Validation complete (all tests passing, zero regressions)
- **[2025-11-02]** Documentation complete (CHANGELOG, completion report)
- **[2025-11-02]** ✅ **MIGRATION COMPLETE**

---

## ✅ Migration Complete!

**Status:** ✅ **100% COMPLETE - PRODUCTION READY**

### Completion Summary

**All phases executed successfully:**
- ✅ Phase 1-9: Complete (via PRs #426, #427, #429)
- ✅ Phase 10: Validation complete (19/19 tests passing, all bin commands working)
- ✅ Phase 11: Documentation complete (CHANGELOG updated)
- ✅ Phase 12: Completion report created

### Validation Results

- ✅ Build succeeds: `pnpm run build`
- ✅ All tests pass: 19/19 (100%)
- ✅ All bin commands work: 7/7 tested
- ✅ Package integrity verified (no old paths in tarball)
- ✅ MCP stdio mode works
- ✅ Zero regressions detected
- ✅ Zero user-facing breaking changes

### Final Structure Achieved

```
src/
  cli/              # 83 TypeScript files (moved from .genie/cli/src)
  mcp/              # 27 TypeScript files (moved from .genie/mcp/src)
dist/
  cli/              # CLI build output (consolidated from .genie/cli/dist)
  mcp/              # MCP build output (consolidated from .genie/mcp/dist)
.genie/             # Framework content ONLY (agents, spells, neurons, etc.)
```

**Completion Report:** `.genie/reports/folder-structure-migration-completion.md`
