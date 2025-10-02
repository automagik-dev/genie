# MCP Integration - Production Gap Analysis

**Date:** 2025-10-01 13:30Z
**Current Score:** 45/100 (Foundation only, NOT production-ready)
**Previous Score:** 100/100 (Incorrectly assessed as complete)

## Critical Misunderstanding

**What was delivered:** Foundation architecture with 2/6 tools working
**What was expected:** Complete, production-ready, publishable npm package

## Current State Assessment

### ✅ Completed (45 points)

**Architecture & Infrastructure (20 pts):**
- [x] cli-core module with SessionService
- [x] FastMCP server structure
- [x] stdio + httpStream transports
- [x] Build pipeline
- [x] Test framework

**Documentation (15 pts):**
- [x] MCP README
- [x] Tech stack docs
- [x] Claude Desktop config examples
- [x] Evidence folder structure

**Partial Tool Implementation (10 pts):**
- [x] genie_list_agents (fully working)
- [x] genie_list_sessions (fully working)
- [x] Tool stubs with helpful guidance (4 tools)

### ❌ Missing for Production (55 points)

**Handler Integration (20 pts) - CRITICAL:**
- [ ] Extract handlers from genie.ts to cli-core/handlers/
  - [ ] run.ts - Start agent sessions
  - [ ] resume.ts - Continue sessions
  - [ ] view.ts - Show transcripts
  - [ ] stop.ts - Terminate sessions
- [ ] Connect MCP tools to handlers (4 tools stubbed)
- [ ] End-to-end integration tests
- [ ] CLI/MCP behavioral equivalence validation

**npm Package & Global CLI (20 pts) - CRITICAL:**
- [ ] Package.json configuration for npm publishing
  - [ ] Package name: `automagik-genie`
  - [ ] Bin entry: `genie` command
  - [ ] Proper dependencies vs devDependencies
  - [ ] Publishable build artifacts
- [ ] Global CLI command: `genie` (not `./genie`)
- [ ] Unified CLI interface with subcommands
- [ ] MCP subcommand: `genie mcp -t stdio|sse|http`
- [ ] Port configuration: default 8885 for sse/http
- [ ] MCP config usage: `npx automagik-genie mcp -t stdio`

**Production Polish (10 pts) - HIGH:**
- [ ] Full integration test suite (10 test cases planned)
- [ ] MCP Inspector screenshots (visual evidence)
- [ ] Performance benchmarks (<500ms validated)
- [ ] Production deployment guide (systemd, docker)

**Cross-Platform & Edge Cases (5 pts) - MEDIUM:**
- [ ] Windows/macOS file locking tests
- [ ] Concurrent write stress tests
- [ ] Error handling for edge cases
- [ ] Recovery from network failures

---

## Detailed Gap Breakdown

### Gap 1: Handler Integration (20 pts)

**Current State:**
- 4/6 tools are stubs returning "handler integration pending"
- cli-core has handler stubs but no implementation
- No connection between MCP tools and CLI logic

**Required Work:**
1. **Extract from genie.ts → cli-core/handlers/run.ts:**
   ```typescript
   export async function handleRun(context: HandlerContext, agent: string, prompt: string): Promise<RunResult> {
     // Move all run logic from genie.ts:182+
     // Return session ID, status, output path
   }
   ```

2. **Extract from genie.ts → cli-core/handlers/resume.ts:**
   ```typescript
   export async function handleResume(context: HandlerContext, sessionId: string, prompt: string): Promise<ResumeResult> {
     // Move all resume logic from genie.ts
   }
   ```

3. **Extract from genie.ts → cli-core/handlers/view.ts:**
   ```typescript
   export async function handleView(context: HandlerContext, sessionId: string, full: boolean): Promise<ViewResult> {
     // Move all view logic from genie.ts
   }
   ```

4. **Extract from genie.ts → cli-core/handlers/stop.ts:**
   ```typescript
   export async function handleStop(context: HandlerContext, sessionId: string): Promise<StopResult> {
     // Move all stop logic from genie.ts
   }
   ```

5. **Update MCP tools → .genie/mcp/src/tools/*.ts:**
   ```typescript
   import { createHandlers } from '../../../cli/src/cli-core';

   execute: async (args, context) => {
     const handlers = createHandlers(/* context */);
     const result = await handlers.run(args.agent, args.prompt);
     return formatMcpResponse(result);
   }
   ```

6. **Integration tests:**
   - CLI creates session → MCP lists it
   - MCP creates session → CLI lists it
   - Resume from CLI → Resume from MCP
   - View from both interfaces shows same data

**Estimated Effort:** 8-10 hours

---

### Gap 2: npm Package & Global CLI (20 pts)

**Current State:**
- Local development only (`./genie` script)
- Not publishable to npm
- No global `genie` command
- MCP server is separate script

**Required Work:**

1. **Package.json Configuration:**
   ```json
   {
     "name": "automagik-genie",
     "version": "0.1.0",
     "description": "AI agent orchestration with MCP integration",
     "bin": {
       "genie": "./dist/cli/genie-cli.js"
     },
     "main": "./dist/cli/index.js",
     "types": "./dist/cli/index.d.ts",
     "files": [
       "dist/",
       ".genie/agents/",
       ".genie/product/",
       ".genie/standards/"
     ],
     "scripts": {
       "prepublishOnly": "pnpm run build:all && pnpm run test:all",
       "postinstall": "node scripts/post-install.js"
     }
   }
   ```

2. **Unified CLI Entry Point (.genie/cli/src/genie-cli.ts):**
   ```typescript
   #!/usr/bin/env node
   import { Command } from 'commander';

   const program = new Command();

   program
     .name('genie')
     .description('AI agent orchestration CLI')
     .version('0.1.0');

   // Existing commands
   program
     .command('run <agent> <prompt>')
     .description('Start agent session')
     .action(handleRun);

   program
     .command('resume <sessionId> <prompt>')
     .description('Continue session')
     .action(handleResume);

   // ... list, view, stop commands

   // NEW: MCP subcommand
   program
     .command('mcp')
     .description('Start MCP server')
     .option('-t, --transport <type>', 'Transport type: stdio, sse, http', 'stdio')
     .option('-p, --port <port>', 'Port for sse/http', '8885')
     .action(handleMcp);

   program.parse();
   ```

3. **MCP Subcommand Handler (.genie/cli/src/commands/mcp.ts):**
   ```typescript
   export async function handleMcp(options: McpOptions) {
     const { transport, port } = options;

     // Validate transport
     if (!['stdio', 'sse', 'http'].includes(transport)) {
       console.error('Invalid transport. Use: stdio, sse, or http');
       process.exit(1);
     }

     // Set environment
     process.env.MCP_TRANSPORT = transport === 'sse' ? 'httpStream' : transport;
     process.env.MCP_PORT = port;

     // Load and start MCP server
     const { startMcpServer } = await import('../../mcp/dist/server.js');
     await startMcpServer();
   }
   ```

4. **SSE as Separate Transport Option:**
   - Update server.ts to handle 'sse' transport explicitly
   - Map to httpStream internally but expose as user-facing option

5. **Post-install Setup:**
   ```typescript
   // scripts/post-install.js
   console.log('✅ Genie installed successfully!');
   console.log('');
   console.log('Try: genie --help');
   console.log('MCP: genie mcp -t stdio');
   console.log('Docs: https://github.com/namastexlabs/automagik-genie');
   ```

6. **Update MCP Config Examples:**
   ```json
   {
     "mcpServers": {
       "genie": {
         "command": "npx",
         "args": ["automagik-genie", "mcp", "-t", "stdio"]
       }
     }
   }
   ```

**Estimated Effort:** 6-8 hours

---

### Gap 3: Production Polish (10 pts)

**Required Work:**

1. **Full Integration Tests (tests/mcp-integration.test.js):**
   - Expand from 7 to 20+ assertions
   - Test all 6 tools end-to-end
   - Validate CLI/MCP session consistency
   - Test error handling and edge cases

2. **Visual Evidence:**
   - MCP Inspector screenshots (6 images)
   - Claude Desktop integration proof
   - Performance benchmark graphs

3. **Performance Validation:**
   - Measure tool latency
   - Validate <500ms for list operations
   - Document results in evidence folder

4. **Production Deployment:**
   - Complete systemd service template
   - Docker configuration
   - Kubernetes manifests (optional)
   - Deployment troubleshooting guide

**Estimated Effort:** 4-6 hours

---

### Gap 4: Cross-Platform & Edge Cases (5 pts)

**Required Work:**

1. **Windows/macOS Testing:**
   - File locking validation
   - Path handling
   - Process management

2. **Stress Testing:**
   - 10+ concurrent writes
   - Network failure recovery
   - Graceful degradation

3. **Error Handling:**
   - Invalid session IDs
   - Missing agents
   - Corrupted session files

**Estimated Effort:** 2-4 hours

---

## Total Estimated Effort

- Handler Integration: 8-10 hours
- npm Package: 6-8 hours
- Production Polish: 4-6 hours
- Cross-Platform: 2-4 hours

**Total: 20-28 hours of focused development**

---

## Revised Scoring

### Current: 45/100

**Discovery (30 pts):** 30/30 ✅
- Context complete
- Scope defined (but misunderstood as foundation-only)

**Implementation (40 pts):** 12/40 ❌
- Code Quality: 12/15 (foundation good, incomplete)
- Test Coverage: 0/10 (stubs not tests)
- Documentation: 0/5 (foundation docs, not production)
- Execution Alignment: 0/10 (tools don't work)

**Verification (30 pts):** 3/30 ❌
- Validation: 0/15 (stubs can't be validated)
- Evidence: 3/10 (foundation only)
- Thoroughness: 0/5 (incomplete)

### Target: 100/100 (TRUE Production-Ready)

**Discovery:** 30/30 (unchanged)
**Implementation:** 40/40 (handlers + npm package + working tools)
**Verification:** 30/30 (full integration tests + visual evidence + benchmarks)

---

## Recommended Path Forward

### Phase 1: Critical Gaps (40 pts → 85/100)
**Effort: 14-18 hours**

1. **Handler Integration (20 pts):**
   - Extract run, resume, view, stop handlers
   - Connect MCP tools
   - Basic integration tests

2. **npm Package (20 pts):**
   - Package.json config
   - Unified CLI with MCP subcommand
   - `genie mcp -t stdio|sse|http`
   - Publish to npm (or test with `npm link`)

### Phase 2: Production Polish (15 pts → 100/100)
**Effort: 6-10 hours**

3. **Full Testing & Evidence:**
   - Complete integration test suite
   - MCP Inspector screenshots
   - Performance benchmarks
   - Production deployment docs

---

## Conclusion

**Current State:** Foundation (45/100)
- Architecture solid
- 2/6 tools working
- Not publishable
- Not production-ready

**Path to 100/100:**
- Implement handlers (20 pts)
- Create npm package (20 pts)
- Complete testing (10 pts)
- Add evidence (5 pts)

**Total Effort:** 20-28 focused hours to TRUE completion.
