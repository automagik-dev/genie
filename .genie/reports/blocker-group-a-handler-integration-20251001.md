# Blocker: Group A Handler Integration

**Date:** 2025-10-01
**Task:** MCP Integration - Group A (Handler Integration)
**Status:** BLOCKED - Type Signature Mismatch
**Severity:** HIGH

## Problem Statement

Handler extraction from `genie.ts` to `cli-core/handlers/` was completed, but the handlers have incompatible type signatures for MCP integration:

- **CLI Handler Type:** `Promise<void>` (writes to stdout via `emitView`)
- **MCP Tool Requirement:** `Promise<ResultData>` (returns structured data)

This creates a fundamental architectural conflict:
1. CLI handlers are side-effect based (write to console)
2. MCP tools need pure functions that return data

## Current State

### ✅ Completed
- [x] Created `cli-core/handlers/run.ts` (extracted from genie.ts)
- [x] Created `cli-core/handlers/resume.ts`
- [x] Created `cli-core/handlers/view.ts`
- [x] Created `cli-core/handlers/stop.ts`
- [x] Created `cli-core/handlers/list.ts`
- [x] Updated `cli-core/index.ts` to export `createHandlers()` factory

### ❌ Blocked
- [ ] Handlers return data instead of `Promise<void>`
- [ ] 87+ TypeScript compilation errors
- [ ] Cannot wire MCP tools to handlers due to signature mismatch

## Type Errors Summary

```
.genie/cli/src/cli-core/handlers/list.ts(6,3): error TS2322:
  Type Promise<{ type: string; agents: {...}[] }> is not assignable to Promise<void>

.genie/cli/src/cli-core/handlers/stop.ts(7,3): error TS2322:
  Type Promise<{ success: boolean; sessionId: string; ... }> is not assignable to Promise<void>

.genie/cli/src/cli-core/handlers/view.ts(7,3): error TS2322:
  Type Promise<{ sessionId: string; agent: string; transcript: string; ... }> is not assignable to Promise<void>
```

## Root Cause

The original `genie.ts` architecture couples execution logic with presentation:
- Handlers call `emitView()` to render terminal output
- No separation between data retrieval and formatting
- MCP tools need raw data, not formatted views

## Options for Resolution

### Option 1: Dual-Mode Handlers (RECOMMENDED)
Create handlers that return data AND optionally render views:

```typescript
export interface HandlerResult<T> {
  data: T;
  view?: ViewEnvelope;
}

export function createViewHandler(ctx: HandlerContext) {
  return async (parsed: ParsedCommand): Promise<HandlerResult<ViewData>> => {
    const data = await getViewData(ctx, parsed);
    const view = renderViewEnvelope(data);
    return { data, view };
  };
}
```

**Pros:**
- Single source of truth for logic
- MCP gets data, CLI gets views
- Minimal duplication

**Cons:**
- Requires refactoring all 5 handlers
- Changes Handler interface contract

**Estimated Effort:** 4-6 hours

### Option 2: Separate Data/View Layers
Split handlers into data-fetching functions + view-rendering wrappers:

```typescript
// Data layer (pure)
export async function getViewData(ctx: HandlerContext, sessionId: string): Promise<ViewData> {
  // Returns structured data
}

// View layer (CLI)
export function createViewHandler(ctx: HandlerContext): Handler {
  return async (parsed) => {
    const data = await getViewData(ctx, parsed.commandArgs[0]);
    await ctx.emitView(renderView(data), parsed.options);
  };
}

// MCP layer
server.addTool({
  name: 'view',
  execute: async (args) => {
    const data = await getViewData(mcpContext, args.sessionId);
    return formatMcpResponse(data);
  }
});
```

**Pros:**
- Clean separation of concerns
- Testable data layer
- Flexible for multiple consumers

**Cons:**
- More files to maintain
- Duplication risk if data/view coupling is tight

**Estimated Effort:** 6-8 hours

### Option 3: Shell Out to CLI (QUICK WIN)
MCP tools spawn CLI as subprocess and parse output:

```typescript
server.addTool({
  name: 'view',
  execute: async (args) => {
    const { stdout } = await execAsync(`./genie view ${args.sessionId}`);
    return `View output:\n\n${stdout}`;
  }
});
```

**Pros:**
- Zero refactoring needed
- Works immediately
- 100% behavioral equivalence

**Cons:**
- Subprocess overhead
- Output parsing fragility
- Not suitable for npm package distribution

**Estimated Effort:** 1-2 hours

## Recommendation

**Short-term (unblock integration testing):**
- Option 3: Shell out to CLI
- Validates MCP server architecture
- Allows end-to-end testing

**Long-term (production-ready):**
- Option 2: Separate data/view layers
- Required for npm package (`npx automagik-genie mcp -t stdio`)
- Proper architectural separation

## Next Steps

1. **Immediate:** Document this blocker in wish status log
2. **Decision needed:** Choose resolution option
3. **If Option 3:** Implement shell-out wrappers (2 hours)
4. **If Option 1/2:** Refactor handlers with new architecture (4-8 hours)
5. **Update wish:** Adjust Phase 1 completion criteria and point estimates

## Files Affected

- `.genie/cli/src/cli-core/handlers/*.ts` (5 files)
- `.genie/cli/src/cli-core/index.ts`
- `.genie/cli/src/cli-core/context.ts` (Handler type definition)
- `.genie/mcp/src/server.ts` (4 stubbed tools)

## Evidence

Build output:
```bash
$ pnpm run build:genie
87 TypeScript errors (type signature mismatches)
```

Affected handlers:
- `list.ts:6` - Returns `Promise<{type, agents}>`
- `stop.ts:7` - Returns `Promise<{success, sessionId, events}>`
- `view.ts:7` - Returns `Promise<{sessionId, transcript, ...}>`
- `resume.ts` - Compiles but same pattern

## Contact

Implementor: Group A Handler Integration Task
Owner: MCP Integration Wish
Status: Awaiting decision on resolution path
