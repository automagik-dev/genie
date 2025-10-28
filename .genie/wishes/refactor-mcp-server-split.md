# Wish: Refactor MCP server.ts - Split into Focused Modules

**Status:** 📝 Blueprint
**Created:** 2025-10-28
**GitHub Issue:** #298
**Priority:** HIGH
**Amendment:** #10 (File Size Discipline)

---

## 🎯 Goal

Split `.genie/mcp/src/server.ts` (1,253 lines, 25% over Amendment 10 hard limit) into focused modules using PR #334's extraction pattern. Target: Main file under 800 lines (soft limit).

---

## 📊 Current State

**File:** `.genie/mcp/src/server.ts`
**Current Size:** 1,253 lines, ~11,873 tokens (measured with word count fallback)
**Hard Limit:** 1,000 lines
**Soft Limit:** 800 lines
**Violation Severity:** ERROR (25% over hard limit)

**Impact:**
- Cognitive overload during code review
- Mixed MCP server concerns in single file
- Harder to test individual components
- Token inefficiency (large context load)
- Multiple responsibility violations (SRP)

---

## 🎯 Success Criteria

### Primary Goals
- ✅ `server.ts` reduced to <800 lines
- ✅ All existing tests pass (zero regressions)
- ✅ Exact behavioral preservation
- ✅ Token reduction: ~4,000-5,000 tokens saved (40-50%)

### Quality Standards
- ✅ Single Responsibility Principle enforced per module
- ✅ Clear module boundaries and interfaces
- ✅ Type safety maintained (TypeScript strict mode)
- ✅ Import/export structure clean and logical
- ✅ Documentation updated (inline comments, JSDoc)

### Validation
- ✅ All unit tests pass
- ✅ MCP server smoke tests pass
- ✅ Integration tests pass
- ✅ Manual testing: MCP server startup, tool execution, spell reading

---

## 🗺️ Extraction Plan

### Phase 1: Extract CLI Executor (Priority 1)
**Target:** `lib/cli-executor.ts`
**Estimated Savings:** 200-300 lines
**Reference:** PR #334 pattern

**Functions to Extract:**
- CLI execution utilities
- Command routing logic
- Process spawning and management
- CLI output formatting

**Why First:**
- Clear separation of CLI concerns
- Well-defined interface
- PR #334 already established pattern

### Phase 2: Extract Server Helpers (Priority 2)
**Target:** `lib/server-helpers.ts`
**Estimated Savings:** 200-300 lines
**Reference:** PR #334 pattern

**Functions to Extract:**
- Agent listing functionality
- Forge executor coordination
- Session management utilities
- Agent discovery and routing

**Why Second:**
- Core server orchestration logic
- Natural grouping of agent operations
- Reduces main file complexity significantly

### Phase 3: Extract Spell Utilities (Priority 3)
**Target:** `lib/spell-utils.ts`
**Estimated Savings:** 150-200 lines
**Reference:** PR #334 pattern

**Functions to Extract:**
- Spell discovery logic
- Spell reading functionality
- Spell metadata extraction
- Spell validation

**Why Third:**
- Isolated spell management logic
- Clear boundary with agent operations
- Minimal dependencies on main file

### Phase 4: Extract Types & Constants (Priority 4)
**Target:** `lib/types.ts`, `lib/constants.ts`
**Estimated Savings:** 50-100 lines

**What to Extract:**
- TypeScript interfaces
- Shared type definitions
- Configuration constants
- MCP tool schemas

**Why Last:**
- Low risk
- Quick wins
- Improves type organization

---

## 🔧 Implementation Strategy

### Per-Extraction Protocol
1. **Read current code** - Understand dependencies
2. **Create new module** - Set up file structure (follow PR #334 pattern)
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
- ✅ **ALWAYS** follow PR #334 extraction pattern

### Testing After Each Phase
```bash
# Unit tests
pnpm test

# MCP server smoke tests
genie mcp-cleanup
genie  # Start MCP server
# Test: mcp__genie__list_agents
# Test: mcp__genie__read_spell
# Test: mcp__genie__run

# Integration tests (if applicable)
pnpm test:integration
```

---

## 📐 Expected Final Structure

```
.genie/mcp/src/
├── server.ts                   # <800 lines (main MCP entry point)
├── lib/
│   ├── cli-executor.ts         # CLI execution utilities (NEW - PR #334 pattern)
│   ├── server-helpers.ts       # Agent listing, Forge executor, sessions (NEW - PR #334 pattern)
│   ├── spell-utils.ts          # Spell discovery and reading (NEW - PR #334 pattern)
│   ├── types.ts                # Shared TypeScript interfaces (NEW)
│   ├── constants.ts            # Configuration constants (NEW)
│   ├── agent-resolver.ts       # (already exists)
│   ├── forge-executor.ts       # (already exists)
│   └── session-service.ts      # (already exists)
└── tools/
    └── ... (existing MCP tools)
```

---

## 🎯 Token Savings Analysis

**Before:**
- `server.ts`: 1,253 lines, ~11,873 tokens (word count estimate)

**After (Estimated):**
- `server.ts`: <800 lines, ~7,000 tokens
- `lib/cli-executor.ts`: ~250 lines, ~2,200 tokens
- `lib/server-helpers.ts`: ~250 lines, ~2,200 tokens
- `lib/spell-utils.ts`: ~175 lines, ~1,500 tokens
- `lib/types.ts`: ~50 lines, ~400 tokens
- `lib/constants.ts`: ~50 lines, ~400 tokens

**Total After:** ~1,575 lines (distributed), ~13,700 tokens
**Net Savings (Total):** -1,827 tokens (distributed modules have overhead)

**Context Load Savings (Real Benefit):**
- Before: Load entire 11,873-token file for any MCP change
- After: Load only relevant module (~1,500-7,000 tokens)
- **Effective Savings:** 40-60% reduction in typical context loads
- **Cognitive Savings:** File under 1,000 lines = readable in single session

---

## 🚧 Risks & Mitigations

### Risk 1: Breaking Existing MCP Functionality
**Mitigation:**
- Test after every extraction
- Preserve exact function signatures
- No logic changes during extraction
- Atomic commits for easy rollback
- Follow proven PR #334 pattern

### Risk 2: Import/Export Circular Dependencies
**Mitigation:**
- Extract in dependency order (CLI → server → spell)
- Keep types/constants separate
- Use explicit imports (no `export *`)
- Reference PR #334 for import structure

### Risk 3: Type Safety Violations
**Mitigation:**
- Run TypeScript strict mode checks
- Maintain explicit type annotations
- Use `lib/types.ts` for shared interfaces
- Preserve existing type structure

### Risk 4: MCP Protocol Compatibility
**Mitigation:**
- No changes to MCP tool definitions
- Preserve all existing tool handlers
- Test with Claude Code MCP integration
- Verify with MCP Inspector

---

## 📋 Definition of Done

- [ ] `server.ts` under 800 lines (soft limit compliance)
- [ ] All extracted modules created in `lib/` directory
- [ ] All imports/exports wired correctly
- [ ] All unit tests passing (0 failures)
- [ ] MCP server smoke tests passing (manual verification)
- [ ] TypeScript strict mode passes (0 errors)
- [ ] Token count measured using `genie helper count-tokens` (with tiktoken if possible)
- [ ] Documentation updated (inline comments, JSDoc)
- [ ] Committed atomically (one commit per phase)
- [ ] PR created with evidence of testing
- [ ] PR references GitHub issue #298
- [ ] Learning captured via `learn` spell if patterns discovered

---

## 📚 References

- **Amendment #10:** File Size Discipline (AGENTS.md)
- **GitHub Issue:** #298 (File size violation)
- **PR #334:** Extraction pattern reference (closed, not merged, but pattern documented)
- **Detection:** garbage-collector automated scan (2025-10-26)
- **Code:** `.genie/code/AGENTS.md` Amendment #Code-10 (refactoring tactics)
- **Files created by PR #334:**
  - `.genie/mcp/src/lib/cli-executor.ts`
  - `.genie/mcp/src/lib/server-helpers.ts`
  - `.genie/mcp/src/lib/spell-utils.ts`

---

## 🎓 Learning Opportunities

**What We'll Learn:**
- MCP server architecture patterns
- Function extraction from large files
- Dependency management in TypeScript
- Testing strategies for MCP servers
- Balancing file size vs import complexity

**What We'll Document:**
- Extraction protocol refinements
- Common pitfalls and solutions
- Best practices for MCP server organization
- Amendment #10 enforcement patterns for MCP code

---

**Created:** 2025-10-28
**Issue:** #298
**Assignee:** Code Collective (via Forge task)
**Estimated Effort:** 3-5 hours (phased extraction, following proven PR #334 pattern)
**Dependencies:** None (PR #334 pattern already established)
