# Forge Breakdown: Unified MCP Startup

**Task ID:** 62c00eed-0653-4fc1-b178-0f7ea3494f45
**Wish:** `.genie/wishes/unified-mcp-startup/unified-mcp-startup-wish.md`
**Status:** Ready for execution

---
version: 1.0.0

## Execution Groups

### Group A: Authentication & Config Foundation

**Duration:** 4-6 hours
**Dependencies:** None

**Surfaces:**
1. Config file structure (`~/.genie/config.yaml`)
2. Token generation utility
3. Auth middleware in MCP server
4. Token validation logic

**Deliverables:**
- `.genie/cli/src/lib/config-manager.ts` - Config load/save utilities
- `.genie/cli/src/lib/auth-token.ts` - Token generation (genie_* format)
- `.genie/mcp/src/middleware/auth.ts` - Bearer token validation
- `~/.genie/config.yaml` - Config schema with auth section

**Implementation:**
```typescript
// Config structure
{
  mcp: {
    auth: {
      token: "genie_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      created: "2025-10-20T..."
    },
    server: {
      port: 8885,
      transport: "httpStream"
    }
  }
}

// Auth middleware (server.ts)
server.use((req, res, next) => {
  if (req.path === '/health') return next();

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = auth.slice(7);
  if (token !== loadAuthToken()) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  next();
});
```

**Validation:**
```bash
# Test token generation
node -e "const {generateToken} = require('./.genie/cli/dist/lib/auth-token'); console.log(generateToken())"

# Test auth middleware (invalid token)
curl -H "Authorization: Bearer invalid" http://localhost:8885/sse
# Expected: 401 Unauthorized

# Test auth middleware (valid token)
curl -H "Authorization: Bearer <valid-token>" http://localhost:8885/sse
# Expected: 200 OK

# Test health check (no auth required)
curl http://localhost:8885/health
# Expected: 200 OK
```

**Evidence:**
- Screenshot: 401 error with invalid token
- Screenshot: Successful request with valid token
- Config file: `~/.genie/config.yaml` with generated token

---

### Group B: Unified Startup & Coordination

**Duration:** 3-4 hours
**Dependencies:** Group A (auth foundation)

**Surfaces:**
1. Entry point modification (bin/automagik-genie.js)
2. Unified startup orchestrator
3. Forge + MCP coordination
4. Health checks and ready state
5. Graceful shutdown

**Deliverables:**
- `bin/automagik-genie.js` - Modified entry point
- `.genie/cli/src/unified-startup.ts` - NEW orchestrator
- `.genie/cli/src/lib/startup-display.ts` - Unified output formatter

**Implementation:**
```typescript
// unified-startup.ts
export async function startGenie() {
  console.log('🧞 Starting Genie...\n');

  // 1. Load/create config
  const config = await loadOrCreateConfig();

  // 2. Start Forge in background
  console.log('📦 Starting Forge backend...');
  startForgeInBackground({ logDir: '.genie/state' });

  // 3. Wait for Forge ready
  const forgeReady = await waitForForgeReady('http://localhost:8887', 15000);
  if (!forgeReady) {
    throw new Error('Forge failed to start');
  }
  console.log('📦 Forge:  http://localhost:8887 ✓');

  // 4. Start MCP server (with auth)
  console.log('📡 Starting MCP server...');
  await startMCPServer(config);
  console.log('📡 MCP:    http://localhost:8885/sse ✓');

  // 5. Display connection info
  displayConnectionInfo(config);

  // 6. Handle graceful shutdown
  setupShutdownHandlers();

  console.log('\nPress Ctrl+C to stop');
}
```

**Validation:**
```bash
# Test unified startup
npx automagik-genie
# Expected: Both Forge and MCP start, output shows both URLs

# Verify Forge running
curl http://localhost:8887/health
# Expected: 200 OK

# Verify MCP running (with auth)
curl -H "Authorization: Bearer <token>" http://localhost:8885/sse
# Expected: 200 OK

# Test graceful shutdown
# Press Ctrl+C
# Expected: Both services stop, clean exit
```

**Evidence:**
- Terminal recording: Complete startup sequence
- Screenshot: Both services accessible
- Screenshot: Graceful shutdown logs

---

### Group C: Tunnel & Setup Wizard

**Duration:** 5-6 hours
**Dependencies:** Group B (unified startup)

**Surfaces:**
1. ngrok integration
2. First-run detection
3. Interactive setup wizard
4. Tunnel management
5. Display formatting

**Deliverables:**
- `package.json` - Add @ngrok/ngrok dependency
- `.genie/cli/src/lib/tunnel-manager.ts` - ngrok integration
- `.genie/cli/src/lib/setup-wizard.ts` - First-run wizard
- `README.md` - Updated quick start guide

**Implementation:**
```typescript
// setup-wizard.ts
export async function runSetupWizard() {
  console.log('🧞 Genie MCP Server - First Run Setup\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const enableTunnel = await question(rl,
    '? Do you want to enable remote access via tunnel? (Y/n) › '
  );

  let ngrokToken = null;
  if (enableTunnel.toLowerCase() !== 'n') {
    ngrokToken = await question(rl,
      '\n? Enter ngrok authtoken (free at https://ngrok.com/signup):\n  › '
    );
  }

  // Generate MCP auth token
  const authToken = generateToken();

  // Save config
  const config = {
    mcp: {
      auth: { token: authToken, created: new Date().toISOString() },
      tunnel: { enabled: !!ngrokToken, provider: 'ngrok', token: ngrokToken },
      server: { port: 8885, transport: 'httpStream' }
    }
  };

  await saveConfig(config);

  console.log('\n✓ Saved to ~/.genie/config.yaml');
  console.log('✓ Generated MCP auth token');

  rl.close();
  return config;
}

// tunnel-manager.ts
export async function startTunnel(port: number, token: string) {
  const listener = await ngrok.forward({
    addr: port,
    authtoken: token,
    schemes: ['https'],
  });

  return listener.url();
}
```

**Validation:**
```bash
# Test first-run wizard (clean state)
rm -f ~/.genie/config.yaml
npx automagik-genie
# Expected: Wizard prompts for ngrok token, saves config

# Test subsequent run (config exists)
npx automagik-genie
# Expected: No wizard, uses existing config

# Test tunnel access (external)
curl -H "Authorization: Bearer <token>" https://<tunnel-url>/sse
# Expected: 200 OK, same response as localhost

# Test ChatGPT config snippet
npx automagik-genie
# Expected: Output includes JSON snippet for ChatGPT
```

**Evidence:**
- Video: First-run wizard complete walkthrough
- Screenshot: Config file created with tunnel token
- Screenshot: External curl via tunnel URL succeeds
- Screenshot: ChatGPT config snippet displayed

---

## Success Criteria

**Functional:**
- ✅ Single command starts Forge + MCP
- ✅ Auth validates all requests (401 for invalid)
- ✅ Tunnel accessible from internet
- ✅ First-run wizard works
- ✅ Graceful shutdown stops both services

**Performance:**
- ✅ Startup < 5s for both services ready
- ✅ Shutdown < 2s graceful termination

**UX:**
- ✅ Clear unified output showing all info
- ✅ ChatGPT config snippet ready to copy
- ✅ Error messages actionable

---

## Risk Mitigation

**Port conflicts:** Check before start, show clear error
**ngrok failures:** Continue without tunnel, show warning
**Config corruption:** Validate YAML, offer repair
**Forge timeout:** 15s limit, show log location

---

## File Changes Summary

**New Files:**
- `.genie/cli/src/lib/config-manager.ts`
- `.genie/cli/src/lib/auth-token.ts`
- `.genie/cli/src/lib/tunnel-manager.ts`
- `.genie/cli/src/lib/setup-wizard.ts`
- `.genie/cli/src/lib/startup-display.ts`
- `.genie/cli/src/unified-startup.ts`
- `.genie/mcp/src/middleware/auth.ts`

**Modified Files:**
- `bin/automagik-genie.js` - Call unified-startup
- `.genie/mcp/src/server.ts` - Add auth middleware
- `package.json` - Add @ngrok/ngrok dependency
- `README.md` - Update quick start

**Config Files:**
- `~/.genie/config.yaml` - Created on first run

---

**Status:** Ready for implementation
**Next Step:** Execute Group A → Group B → Group C sequentially
