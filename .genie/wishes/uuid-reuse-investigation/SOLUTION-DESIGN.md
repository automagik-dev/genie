# Stale Build Artifact Detection - Solution Design
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Issue:** #122
**Target Release:** RC22
**Priority:** Medium
**Complexity:** Medium

---

## Solution Overview

Implement automated stale build detection in the CLI entry point to warn developers when source files are newer than compiled artifacts.

**Approach:** Option 1 (Automated Rebuild Detection) + Option 5 (Documentation)

---

## Design Specification

### 1. Stale Build Checker Module

**File:** `.genie/cli/src/lib/build-freshness-check.ts`

**Purpose:**
- Compare modification times of source vs dist files
- Detect stale builds
- Provide actionable warnings

**API:**
```typescript
interface BuildFreshnessResult {
  isStale: boolean;
  staleFiles?: Array<{ source: string; dist: string; delta: number }>;
  message?: string;
}

export function checkBuildFreshness(
  options?: {
    silent?: boolean;      // Don't print warnings
    checkLimit?: number;   // Max files to check (performance)
    ignorePatterns?: string[]; // Skip certain files
  }
): BuildFreshnessResult;
```

**Implementation Strategy:**

```typescript
import fs from 'fs';
import path from 'path';
import { getPackageRoot } from './paths';

export function checkBuildFreshness(options = {}): BuildFreshnessResult {
  const {
    silent = false,
    checkLimit = 20,
    ignorePatterns = []
  } = options;

  try {
    const root = getPackageRoot();
    const srcDir = path.join(root, '.genie/cli/src');
    const distDir = path.join(root, '.genie/cli/dist');

    // Quick existence checks
    if (!fs.existsSync(srcDir) || !fs.existsSync(distDir)) {
      return { isStale: false }; // Can't determine, assume OK
    }

    const staleFiles: Array<{ source: string; dist: string; delta: number }> = [];

    // Sample key files for performance (not exhaustive scan)
    const keyFiles = [
      'commands/run.ts',
      'cli-core/handlers/run.ts',
      'session-store.ts',
      'background-manager.ts',
      'lib/background-launcher.ts'
    ];

    for (const file of keyFiles.slice(0, checkLimit)) {
      const sourcePath = path.join(srcDir, file);
      const distPath = path.join(distDir, file.replace(/\.ts$/, '.js'));

      if (!fs.existsSync(sourcePath)) continue;
      if (!fs.existsSync(distPath)) {
        // Source exists but no dist - definitely stale
        staleFiles.push({
          source: file,
          dist: file.replace(/\.ts$/, '.js'),
          delta: Infinity
        });
        continue;
      }

      const sourceStat = fs.statSync(sourcePath);
      const distStat = fs.statSync(distPath);

      const deltaMs = sourceStat.mtimeMs - distStat.mtimeMs;
      if (deltaMs > 1000) { // 1 second tolerance for file system timing
        staleFiles.push({
          source: file,
          dist: file.replace(/\.ts$/, '.js'),
          delta: deltaMs
        });
      }
    }

    const isStale = staleFiles.length > 0;

    if (isStale && !silent) {
      console.error('');
      console.error('⚠️  WARNING: Stale build artifacts detected!');
      console.error('');
      console.error('   TypeScript source files have been modified since last build.');
      console.error('   You may be running outdated code.');
      console.error('');
      console.error('   Files out of date:');
      for (const f of staleFiles.slice(0, 5)) {
        const deltaStr = f.delta === Infinity
          ? '(missing dist)'
          : `(${Math.floor(f.delta / 1000)}s older)`;
        console.error(`   - ${f.source} ${deltaStr}`);
      }
      if (staleFiles.length > 5) {
        console.error(`   ... and ${staleFiles.length - 5} more`);
      }
      console.error('');
      console.error('   To fix: pnpm run build:genie');
      console.error('');
    }

    return {
      isStale,
      staleFiles,
      message: isStale
        ? `${staleFiles.length} file(s) out of date. Run: pnpm build:genie`
        : undefined
    };
  } catch (error) {
    // Don't crash CLI if check fails
    if (!silent) {
      console.warn('[build-freshness-check] Warning: Could not check build freshness:', error);
    }
    return { isStale: false };
  }
}
```

---

### 2. Integration Point

**File:** `.genie/cli/src/genie-cli.ts` (main entry point)

**Modification:**
```typescript
#!/usr/bin/env node

import { parseArgs } from './lib/arg-parser';
import { executeCommand } from './cli-core/router';
import { checkBuildFreshness } from './lib/build-freshness-check';

async function main() {
  try {
    // Check build freshness on startup (development mode only)
    if (process.env.NODE_ENV !== 'production') {
      checkBuildFreshness({ silent: false, checkLimit: 10 });
    }

    const parsed = parseArgs(process.argv.slice(2));
    await executeCommand(parsed);
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
```

**Why here?**
- Runs once per CLI invocation
- Before any command execution
- Minimal performance impact (10 file checks ~5-20ms)
- User sees warning before long-running operations

---

### 3. Environment-Aware Behavior

**Development Mode:**
- Check enabled by default
- Warnings printed to stderr
- Does NOT block execution

**Production Mode (published npm):**
- Check disabled (assumes npm package built correctly)
- Zero overhead
- NODE_ENV detection or package.json flag

**Detection Strategy:**
```typescript
function isProductionEnvironment(): boolean {
  // 1. Explicit environment variable
  if (process.env.NODE_ENV === 'production') return true;

  // 2. Running from node_modules (installed package)
  const isInstalledPackage = __dirname.includes('node_modules');
  if (isInstalledPackage) return true;

  // 3. CI environment
  if (process.env.CI === 'true') return true;

  return false;
}
```

---

### 4. Performance Optimization

**Problem:** Checking file timestamps adds latency

**Optimizations:**
1. **Limit file checks** - Sample 10-20 key files (not all ~50+ TS files)
2. **Cache results** - Store check result in temp file, expire after 5 minutes
3. **Lazy loading** - Only import check module if in dev mode
4. **Parallel stat calls** - Use `Promise.all()` for concurrent fs checks

**Cached Implementation:**
```typescript
import os from 'os';
import path from 'path';

const CACHE_FILE = path.join(os.tmpdir(), 'genie-build-freshness.json');
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCachedResult(): BuildFreshnessResult | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;

    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const age = Date.now() - cached.timestamp;

    if (age < CACHE_TTL_MS) {
      return cached.result;
    }
  } catch {}
  return null;
}

function setCachedResult(result: BuildFreshnessResult): void {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      timestamp: Date.now(),
      result
    }));
  } catch {}
}

export function checkBuildFreshness(options = {}): BuildFreshnessResult {
  if (!options.skipCache) {
    const cached = getCachedResult();
    if (cached) return cached;
  }

  const result = checkBuildFreshnessUncached(options);
  setCachedResult(result);
  return result;
}
```

**Impact:**
- First run: 5-20ms overhead
- Subsequent runs (within 5 min): <1ms overhead
- Cache expires on rebuild (mtime changes)

---

### 5. User Experience

**Scenario 1: Fresh Build**
```bash
$ npx automagik-genie run agents/plan "Test"
🧞 Starting agent: agents/plan
   Executor: claude-code (from config)
   ...
```
No warnings, immediate execution.

---

**Scenario 2: Stale Build**
```bash
$ npx automagik-genie run agents/plan "Test"

⚠️  WARNING: Stale build artifacts detected!

   TypeScript source files have been modified since last build.
   You may be running outdated code.

   Files out of date:
   - commands/run.ts (42s older)
   - lib/background-launcher.ts (42s older)
   - session-store.ts (42s older)

   To fix: pnpm run build:genie

🧞 Starting agent: agents/plan
   Executor: claude-code (from config)
   ...
```
Warning displayed, but execution continues (non-blocking).

---

**Scenario 3: Missing Dist File**
```bash
⚠️  WARNING: Stale build artifacts detected!

   TypeScript source files have been modified since last build.
   You may be running outdated code.

   Files out of date:
   - lib/new-module.ts (missing dist)

   To fix: pnpm run build:genie
```
Indicates file added to source but not compiled.

---

### 6. Testing Strategy

**Unit Tests:**
```typescript
// test/build-freshness-check.test.ts

describe('checkBuildFreshness', () => {
  it('should detect stale files', () => {
    // Create temp src/dist with different mtimes
    // Assert isStale = true
  });

  it('should pass when dist is newer', () => {
    // Create temp src/dist with dist newer
    // Assert isStale = false
  });

  it('should handle missing dist files', () => {
    // Create src file without dist
    // Assert isStale = true
  });

  it('should respect silent option', () => {
    // Capture stderr
    // Assert no output when silent = true
  });

  it('should use cache when available', () => {
    // Mock cache file
    // Assert no fs.statSync calls
  });
});
```

**Integration Tests:**
```bash
# test/integration/stale-build.sh

# Test 1: Fresh build
pnpm build:genie
output=$(npx automagik-genie --help 2>&1)
if echo "$output" | grep -q "WARNING: Stale"; then
  echo "FAIL: False positive on fresh build"
  exit 1
fi

# Test 2: Modify source
touch .genie/cli/src/commands/run.ts
sleep 2
output=$(npx automagik-genie --help 2>&1)
if ! echo "$output" | grep -q "WARNING: Stale"; then
  echo "FAIL: Missed stale build"
  exit 1
fi

# Test 3: Rebuild
pnpm build:genie
output=$(npx automagik-genie --help 2>&1)
if echo "$output" | grep -q "WARNING: Stale"; then
  echo "FAIL: False positive after rebuild"
  exit 1
fi

echo "All tests passed"
```

---

## Implementation Plan

### Phase 1: Core Implementation (1-2 hours)

**Tasks:**
- [ ] Create `build-freshness-check.ts` module
- [ ] Implement basic file mtime comparison
- [ ] Add unit tests
- [ ] Integrate into `genie-cli.ts` entry point

**Deliverables:**
- Working stale build detection
- Unit tests passing
- Integration point complete

---

### Phase 2: Optimization (30 min - 1 hour)

**Tasks:**
- [ ] Add caching layer (temp file)
- [ ] Implement environment detection
- [ ] Optimize file checking (limit to key files)
- [ ] Add performance benchmarks

**Deliverables:**
- <20ms overhead on fresh build
- <1ms overhead with cache
- Production mode disabled check

---

### Phase 3: Polish & Documentation (30 min)

**Tasks:**
- [ ] Improve error messages
- [ ] Add CLI flag: `--skip-freshness-check`
- [ ] Document in CONTRIBUTING.md
- [ ] Update README.md development section

**Deliverables:**
- User-friendly warnings
- Developer documentation
- Opt-out mechanism

---

### Phase 4: Validation (1 hour)

**Tasks:**
- [ ] Run integration tests
- [ ] Test on clean install
- [ ] Test with various stale scenarios
- [ ] Verify no regressions in CI

**Deliverables:**
- All tests passing
- No false positives
- CI unaffected

---

## Alternative: Watch Mode Documentation (Low-effort fallback)

If automated detection proves too complex, fallback to enhanced documentation:

**CONTRIBUTING.md:**
```markdown
## Development Workflow

### Running Local CLI

**IMPORTANT:** Always rebuild after modifying TypeScript source:

\`\`\bash
# Bad (runs stale code)
npx automagik-genie run agents/plan "Test"

# Good (rebuilds first)
pnpm build:genie && npx automagik-genie run agents/plan "Test"

# Best (watch mode - auto-rebuild)
pnpm dev  # In terminal 1
npx automagik-genie run agents/plan "Test"  # In terminal 2
\`\`\`

### Common Pitfall: Stale Build Artifacts

**Symptoms:**
- Unexpected behavior after code changes
- Tests passing locally but failing in CI
- UUIDs reusing same value

**Solution:**
Run `pnpm build:genie` before testing changes.
```

---

## Success Metrics

**Must Have:**
- ✅ Stale builds detected >95% of the time
- ✅ Zero false positives on fresh builds
- ✅ <50ms overhead in worst case
- ✅ Works in local dev, CI, and npm packages

**Should Have:**
- ✅ <20ms overhead typical case
- ✅ Helpful error messages
- ✅ Opt-out mechanism available
- ✅ No breaking changes to existing workflows

**Could Have:**
- ✅ Cache optimization <1ms
- ✅ Integration with git hooks
- ✅ VS Code extension detection

---

## Risks & Mitigations

### Risk 1: False Positives

**Scenario:** File timestamps inconsistent (git clone, NFS, etc.)

**Mitigation:**
- Use 1-second tolerance in mtime comparison
- Allow opt-out via `--skip-freshness-check`
- Cache results to avoid repeated warnings

---

### Risk 2: Performance Impact

**Scenario:** Checking files slows down every CLI invocation

**Mitigation:**
- Limit to 10-20 key files (not all)
- Use caching (5-minute TTL)
- Disable in production/CI
- Lazy load check module

---

### Risk 3: Broken CI Pipelines

**Scenario:** Warning breaks automated scripts expecting clean stderr

**Mitigation:**
- Detect CI environment, disable check
- Provide `--quiet` flag to suppress warnings
- Use `process.env.NODE_ENV === 'production'` check

---

## Future Enhancements

### 1. Auto-Rebuild on Stale Detection

**Concept:**
```typescript
if (result.isStale) {
  console.error('⚠️  Stale build detected. Rebuilding...');
  execSync('pnpm build:genie', { stdio: 'inherit' });
  console.error('✅ Rebuild complete. Continuing...');
}
```

**Pros:** Fully automatic, zero manual intervention
**Cons:** Adds 2-5s latency, may surprise users

---

### 2. Git Hook Integration

**Concept:**
```bash
# .git/hooks/post-merge
#!/bin/bash
if git diff --name-only HEAD@{1} HEAD | grep -q ".genie/cli/src/"; then
  echo "Source files changed. Rebuilding..."
  pnpm build:genie
fi
```

**Pros:** Automatic rebuild after git pull/merge
**Cons:** Requires setup, slows down git operations

---

### 3. VS Code Extension

**Concept:**
- Detect stale builds in editor
- Show warning in status bar
- Offer "Rebuild Now" quick action

**Pros:** IDE-integrated, visual feedback
**Cons:** Requires separate extension project

---

## Conclusion

**Recommended Implementation:**
- Phase 1-3 (Core + Optimization + Polish)
- Target: RC22
- Estimated effort: 2-4 hours
- Risk: Low
- Impact: Medium (improves DX significantly)

**Fallback:**
- Enhanced documentation only (if time-constrained)
- Effort: 15 minutes
- Impact: Low (relies on discipline)

**Status:** Ready for implementation
