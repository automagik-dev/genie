# Unified Startup Orchestration Plan
**Created:** 2025-10-21
**Status:** READY FOR EXECUTION
**Wish Reference:** `.genie/wishes/unified-mcp-startup/unified-mcp-startup-wish.md`

---
version: 1.0.0

## 🎯 Vision

**Current (Fragmented):**
```bash
# User must start services separately
$ genie forge start         # Start Forge on 8888
$ genie mcp --transport sse # Start MCP on 8885
```

**Target (Unified):**
```bash
# Single command starts everything
$ npx automagik-genie

🚀 Genie MCP Server started!

📦 Forge:  http://localhost:8887 ✓
📡 MCP:    http://localhost:8885/sse ✓
🔑 Auth:   Bearer genie_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

Press Ctrl+C to stop
```

---

## 📋 Implementation Tasks

### Phase 1: Remove Standalone `forge` Command
**Goal:** Forge should not be a user-facing command

**Tasks:**
1. Remove `forge` command from `.genie/cli/src/genie.ts`
2. Remove `forge` subcommand handler
3. Keep `forge-manager.ts` module (used internally)
4. Update help text to remove `genie forge` examples

**Files:**
- `.genie/cli/src/genie.ts` - Remove `forge` case
- `.genie/cli/src/commands/help.ts` - Remove forge command row and example
- Keep: `.genie/cli/src/lib/forge-manager.ts` (internal use)

---

### Phase 2: Auto-Start Forge with MCP
**Goal:** When MCP starts, Forge starts automatically in background

**Current MCP Entry:**
- `bin/automagik-genie.js` → starts MCP server only
- Forge must be started separately

**New Behavior:**
```typescript
// bin/automagik-genie.js or .genie/mcp/src/server.ts
async function main() {
  // 1. Start Forge in background
  await startForgeInBackground();

  // 2. Wait for Forge ready (health check)
  await waitForForgeReady();

  // 3. Start MCP server
  await startMCPServer();

  // 4. Display unified output
  showConnectionInfo();

  // 5. Handle graceful shutdown
  process.on('SIGINT', async () => {
    await stopMCP();
    await stopForge();
  });
}
```

**Files to Modify:**
- `bin/automagik-genie.js` - Entry point modification
- `.genie/mcp/src/server.ts` - Add Forge startup before MCP
- `.genie/cli/src/lib/forge-manager.ts` - Export startForge/stopForge functions

---

### Phase 3: Unified Output Display
**Goal:** Show user all connection info in one place

**Output Format:**
```
🚀 Genie MCP Server v2.4.0-rc.37

Services started:
📦 Forge:  http://localhost:8887 ✓
📡 MCP:    http://localhost:8885/sse ✓

Ready for connections.
Press Ctrl+C to stop all services.
```

**Implementation:**
```typescript
function showConnectionInfo() {
  console.log('🚀 Genie MCP Server v' + version);
  console.log('');
  console.log('Services started:');
  console.log('📦 Forge:  http://localhost:8887 ✓');
  console.log('📡 MCP:    http://localhost:8885/sse ✓');
  console.log('');
  console.log('Ready for connections.');
  console.log('Press Ctrl+C to stop all services.');
}
```

---

### Phase 4: Graceful Shutdown
**Goal:** Ctrl+C stops both services cleanly

**Implementation:**
```typescript
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');

  // Stop MCP first
  await stopMCPServer();

  // Stop Forge
  await stopForge();

  console.log('✅ All services stopped');
  process.exit(0);
});
```

---

## 🔧 Technical Details

### Forge Startup Integration

**Use Existing `forge-manager.ts`:**
```typescript
// .genie/cli/src/lib/forge-manager.ts already has:
export async function startForgeInBackground(): Promise<void>
export function stopForge(logDir: string): void
export async function waitForForgeReady(baseUrl: string, timeout: number): Promise<void>
```

**Import in MCP Server:**
```typescript
// .genie/mcp/src/server.ts
import { startForgeInBackground, stopForge, waitForForgeReady } from '../../cli/src/lib/forge-manager';

// Before starting MCP:
await startForgeInBackground();
await waitForForgeReady('http://localhost:8887', 15000);
```

---

### Port Configuration

**Fixed Ports:**
- Forge: `8888` (backend API)
- MCP: `8885` (SSE endpoint for clients)

**No configuration needed** - these ports are hardcoded for simplicity.

---

### Future: Authentication (Phase 5 - Deferred)
**Per unified-mcp-startup wish:**
- Bearer token auth
- Token stored in `~/.genie/config.yaml`
- Optional ngrok tunnel

**Status:** Not in this phase (RC37 focus is unified startup only)

---

## 📊 Execution Plan

### Task Breakdown

**Task 1: Remove `forge` command (30min)**
- Edit `genie.ts` - remove forge case
- Edit `help.ts` - remove forge from commands and examples
- Build and test
- Commit: "remove standalone forge command"

**Task 2: Integrate Forge startup in MCP (1h)**
- Modify `bin/automagik-genie.js` or `.genie/mcp/src/server.ts`
- Import forge-manager functions
- Add Forge startup before MCP
- Add shutdown handler
- Build and test
- Commit: "auto-start Forge with MCP server"

**Task 3: Unified output display (15min)**
- Add showConnectionInfo() function
- Display after both services ready
- Build and test
- Commit: "add unified startup output"

**Task 4: End-to-end testing (30min)**
- Test: `npx automagik-genie` starts both
- Test: Forge accessible at :8888
- Test: MCP accessible at :8885
- Test: Ctrl+C stops both cleanly
- Test: MCP tools can create Forge tasks

**Total:** ~2-2.5 hours

---

## ✅ Success Criteria

**Must Have:**
- ✅ `npx automagik-genie` starts both Forge + MCP
- ✅ No need to run `genie forge start` separately
- ✅ Unified output shows both services
- ✅ Ctrl+C stops both services
- ✅ MCP tools work (can create Forge tasks)

**Nice to Have (Future):**
- 🔄 Auth token (Phase 5)
- 🔄 ngrok tunnel (Phase 5)
- 🔄 First-run wizard (Phase 5)

---

## 🚀 Next Steps

**Immediate (This Session):**
1. Create Forge task for implementation
2. Execute Task 1-3 (remove forge command, integrate startup, unified output)
3. Test end-to-end
4. Commit to dev branch
5. Update PR #153

**Future (Next RC):**
- Phase 5: Authentication & tunnel support
- Phase 6: First-run setup wizard

---

## 📝 Notes

**Why This Matters:**
- Users confused about which services to start
- Manual coordination is error-prone
- Aligns with ChatGPT homologation goal
- Simplifies documentation ("just run npx automagik-genie")

**Architecture Decision:**
- Forge runs as subprocess (background process)
- MCP runs in main process (foreground)
- Both share lifecycle (start together, stop together)

**No Breaking Changes:**
- Old `genie run` commands still work
- Existing `genie mcp` still works (for advanced users)
- Only removes standalone `genie forge` command

---

**Ready for execution** ✅
