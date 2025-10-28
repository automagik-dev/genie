# Wish: Refactor genie-cli.ts - Split into Focused Modules

**Status:** 📝 Blueprint
**Created:** 2025-10-28
**GitHub Issue:** #297
**Priority:** CRITICAL
**Amendment:** #10 (File Size Discipline)

---

## 🎯 Goal

Split `genie-cli.ts` (1780 lines, 78% over Amendment 10 hard limit) into focused modules while preserving exact behavior. Target: Main file under 800 lines (soft limit).

---

## 📊 Current State

**File:** `.genie/cli/src/genie-cli.ts`
**Current Size:** 1780 lines, ~16,000 tokens (estimated)
**Hard Limit:** 1000 lines
**Soft Limit:** 800 lines
**Violation Severity:** CRITICAL (78% over hard limit)

**Impact:**
- Cognitive overload during code review
- Multiple responsibility violations (SRP)
- Difficult navigation and maintenance
- Large git diffs, increased merge conflicts
- Massive context load per session

---

## 🎯 Success Criteria

### Primary Goals
- ✅ `genie-cli.ts` reduced to <800 lines
- ✅ All existing tests pass (zero regressions)
- ✅ Exact behavioral preservation
- ✅ Token reduction: ~8,000-10,000 tokens saved (50-60%)

### Quality Standards
- ✅ Single Responsibility Principle enforced per module
- ✅ Clear module boundaries and interfaces
- ✅ Type safety maintained (TypeScript strict mode)
- ✅ Import/export structure clean and logical
- ✅ Documentation updated (inline comments, JSDoc)

### Validation
- ✅ All unit tests pass
- ✅ CLI smoke tests pass
- ✅ Integration tests pass
- ✅ Manual testing: `genie`, `genie init`, `genie update`, `genie talk`, `genie run`

---

## 🗺️ Extraction Plan

### Phase 1: Extract Core Router (Priority 1)
**Target:** `lib/router.ts`
**Estimated Savings:** 200-300 lines

**Functions to Extract:**
- `smartRouter()` - Main routing logic
- Route decision tree logic
- Agent/collective resolution

**Why First:**
- Core orchestration logic
- Clear single responsibility
- Well-defined interface

### Phase 2: Extract Server Management (Priority 2)
**Target:** `lib/server-manager.ts`
**Estimated Savings:** 150-250 lines

**Functions to Extract:**
- `startGenieServer()` - Forge server startup
- `startMCPServer()` - MCP server startup
- `checkPortAvailability()` - Port conflict detection
- `promptUserForTakeover()` - Takeover prompt logic
- `killProcessOnPort()` - Process cleanup

**Why Second:**
- Related server lifecycle management
- Natural grouping of port/process operations
- Reduces main file complexity significantly

### Phase 3: Extract MCP Stdio Handler (Priority 3)
**Target:** `lib/mcp-stdio.ts`
**Estimated Savings:** 100-150 lines

**Functions to Extract:**
- `startMCPStdio()` - MCP stdio initialization
- MCP transport setup
- Error handling for MCP mode

**Why Third:**
- Isolated MCP communication logic
- Clear boundary with server mode
- Minimal dependencies on main file

### Phase 4: Extract CLI Utilities (Priority 4)
**Target:** `lib/cli-utils.ts`
**Estimated Savings:** 100-200 lines

**Functions to Extract:**
- CLI formatting helpers
- User prompt utilities
- Validation helpers
- Display/logging utilities

**Why Fourth:**
- Supporting utilities
- No core business logic
- Easy to extract without risk

### Phase 5: Extract Types & Constants (Priority 5)
**Target:** `lib/types.ts`, `lib/constants.ts`
**Estimated Savings:** 50-100 lines

**What to Extract:**
- TypeScript interfaces
- Shared type definitions
- Configuration constants
- Magic strings/numbers

**Why Last:**
- Low risk
- Quick wins
- Improves type organization

---

## 🔧 Implementation Strategy

### Per-Extraction Protocol
1. **Read current code** - Understand dependencies
2. **Create new module** - Set up file structure
3. **Extract function(s)** - Copy to new module
4. **Update imports** - Wire up new module
5. **Test extraction** - Run all tests
6. **Verify behavior** - Manual smoke test
7. **Commit** - Atomic commit per extraction

### Critical Rules
- ❌ **NEVER** change behavior during extraction
- ❌ **NEVER** refactor logic while extracting
- ❌ **NEVER** skip testing after extraction
- ✅ **ALWAYS** preserve exact function signatures
- ✅ **ALWAYS** maintain type safety
- ✅ **ALWAYS** commit after each successful extraction

### Testing After Each Phase
```bash
# Unit tests
pnpm test

# CLI smoke tests
genie --version
genie --help
genie init
genie update --check
genie mcp-cleanup

# Integration tests (if applicable)
pnpm test:integration
```

---

## 📐 Expected Final Structure

```
.genie/cli/src/
├── genie-cli.ts              # <800 lines (main entry point)
├── lib/
│   ├── router.ts             # smartRouter + routing logic
│   ├── server-manager.ts     # Server lifecycle management
│   ├── mcp-stdio.ts          # MCP stdio communication
│   ├── cli-utils.ts          # CLI helpers and utilities
│   ├── types.ts              # Shared TypeScript interfaces
│   └── constants.ts          # Configuration constants
└── commands/
    ├── init.ts               # (already exists)
    ├── update.ts             # (already exists)
    └── ... (other commands)
```

---

## 🎯 Token Savings Analysis

**Before:**
- `genie-cli.ts`: 1780 lines, ~16,000 tokens

**After (Estimated):**
- `genie-cli.ts`: <800 lines, ~7,000 tokens
- `lib/router.ts`: ~250 lines, ~2,200 tokens
- `lib/server-manager.ts`: ~200 lines, ~1,800 tokens
- `lib/mcp-stdio.ts`: ~125 lines, ~1,100 tokens
- `lib/cli-utils.ts`: ~150 lines, ~1,300 tokens
- `lib/types.ts`: ~50 lines, ~400 tokens
- `lib/constants.ts`: ~50 lines, ~400 tokens

**Total After:** ~1,625 lines (distributed), ~14,200 tokens
**Net Savings:** 155 lines, ~1,800 tokens

**Context Load Savings:**
- Before: Load entire 16,000-token file for any CLI change
- After: Load only relevant module (~2,000-7,000 tokens)
- **Effective Savings:** 50-70% reduction in typical context loads

---

## 🚧 Risks & Mitigations

### Risk 1: Breaking Existing Functionality
**Mitigation:**
- Test after every extraction
- Preserve exact function signatures
- No logic changes during extraction
- Atomic commits for easy rollback

### Risk 2: Import/Export Circular Dependencies
**Mitigation:**
- Extract in dependency order (router → server → utils)
- Keep types/constants separate
- Use explicit imports (no `export *`)

### Risk 3: Type Safety Violations
**Mitigation:**
- Run TypeScript strict mode checks
- Maintain explicit type annotations
- Use `lib/types.ts` for shared interfaces

### Risk 4: Merge Conflicts During Active Development
**Mitigation:**
- Coordinate with team before starting
- Work in isolated Forge worktree
- Complete extraction in single session if possible

---

## 📋 Definition of Done

- [ ] `genie-cli.ts` under 800 lines
- [ ] All extracted modules created in `lib/` directory
- [ ] All imports/exports wired correctly
- [ ] All unit tests passing (0 failures)
- [ ] CLI smoke tests passing (manual verification)
- [ ] TypeScript strict mode passes (0 errors)
- [ ] Token count measured using `genie helper count-tokens`
- [ ] Documentation updated (inline comments, JSDoc)
- [ ] Committed atomically (one commit per phase)
- [ ] PR created with evidence of testing

---

## 📚 References

- **Amendment #10:** File Size Discipline (AGENTS.md)
- **GitHub Issue:** #297 (File size violation)
- **Detection:** garbage-collector automated scan (2025-10-26)
- **Code:** `.genie/code/AGENTS.md` Amendment #Code-10 (refactoring tactics)

---

## 🎓 Learning Opportunities

**What We'll Learn:**
- Effective module extraction strategies
- Dependency management in large files
- Balancing file size vs import complexity
- Testing strategies for refactoring

**What We'll Document:**
- Extraction protocol refinements
- Common pitfalls and solutions
- Best practices for TypeScript module organization
- Amendment #10 enforcement patterns

---

**Created:** 2025-10-28
**Issue:** #297
**Assignee:** Code Collective (via Forge task)
**Estimated Effort:** 4-6 hours (phased extraction)
