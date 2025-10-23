# Wish: Unified MCP Startup with Authentication & Tunnel

**Status:** Discovery
**Created:** 2025-10-20
**Priority:** HIGH (Release Blocker - ChatGPT homologation)
**Related Issues:** #152 (MCP Authentication)

---
version: 1.0.0

## Executive Summary

Transform `npx automagik-genie` into a single-command startup that launches both Forge backend (port 8887) and MCP server (port 8885) with built-in authentication and optional ngrok tunnel for ChatGPT integration.

**Current State:**
```bash
# User must start services separately
$ genie forge start         # Start Forge on 8887
$ genie mcp --transport sse # Start MCP on 8885
# No auth, no tunnel, manual coordination
```

**Target State:**
```bash
# Single command starts everything
$ npx automagik-genie

🚀 Genie MCP Server started!

📦 Forge:  http://localhost:8887 ✓
📡 MCP:    http://localhost:8885/sse ✓
🌐 Tunnel: https://abc-123-def.ngrok-free.app/sse
🔑 Auth:   Bearer genie_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

Press Ctrl+C to stop
```

---

## Problem Statement

### Current Pain Points

1. **Fragmented Startup**
   - Forge and MCP must be started separately
   - No coordination between services
   - User confusion about which ports/services

2. **No Authentication**
   - MCP server has no auth layer
   - Cannot safely expose to internet
   - Blocks ChatGPT integration
   - Fails homologation requirements

3. **No Tunnel Support**
   - Users must manually configure ngrok/cloudflare
   - Complex setup for remote access
   - No integration with ChatGPT guidelines

4. **Poor UX**
   - No unified output showing all services
   - No clear connection instructions
   - Manual config for ChatGPT

### Business Impact

- **Release Blocker:** Cannot submit for ChatGPT homologation without auth
- **User Friction:** Complex setup deters adoption
- **Security Risk:** Unauthenticated MCP servers exposed to internet
- **Support Burden:** Users confused about startup sequence

---

## Success Criteria

### Must Have (Release Blocker)

- ✅ Single command `npx automagik-genie` starts Forge + MCP
- ✅ Bearer token authentication (ChatGPT compliant)
- ✅ Token generation on first run (stored in `~/.genie/config.yaml`)
- ✅ Auth middleware validates all HTTP requests
- ✅ Graceful shutdown (Ctrl+C stops both services)
- ✅ Unified startup output shows all connection info

### Should Have (Quality)

- ✅ Optional ngrok tunnel integration
- ✅ Interactive first-run setup wizard
- ✅ ChatGPT config snippet in output
- ✅ Health check before showing "ready"
- ✅ Logs clearly separated (forge.log + mcp.log)

### Nice to Have (Future)

- 🔄 Multiple auth tokens (per-client)
- 🔄 Token revocation command
- 🔄 OAuth flow (future homologation)
- 🔄 Custom tunnel providers (localtunnel, cloudflare)

---

## Technical Architecture

### Component Overview

```
bin/automagik-genie.js
  ↓
.genie/cli/dist/genie-cli.ts (modified)
  ↓
  ├─→ forge-manager.ts → startForgeInBackground()
  │    └─→ npx automagik-forge start (port 8887)
  │
  └─→ mcp-server-manager.ts (NEW)
       ├─→ setupWizard() (first run only)
       ├─→ loadOrGenerateToken()
       ├─→ startMCPServer() (port 8885, httpStream)
       │    └─→ auth middleware (Bearer validation)
       └─→ startTunnel() (optional ngrok)
            └─→ @ngrok/ngrok integration
```

### Discovery Questions

**Q1: Config Storage Location**
- Option A: `~/.genie/config.yaml` (global, user-level)
- Option B: `.genie/config.yaml` (project-level)
- **Decision:** Option A (global) - tokens should be per-user, not per-project

**Q2: Forge Startup Wait Strategy**
- Current: `waitForForgeReady()` polls health check (15s timeout)
- Issue: Blocking startup, no progress indication
- **Decision:** Keep polling but show progress spinner

**Q3: ngrok Free Tier Limitations**
- Free tier: Random URLs on restart
- Paid tier: Static URLs
- **Decision:** Support both, warn users about URL changes

**Q4: Auth Token Format**
- Option A: `genie_` prefix + 48 hex chars
- Option B: JWT with claims
- **Decision:** Option A (simple Bearer token) - matches ChatGPT guidelines

**Q5: Multiple MCP Instances**
- What if user runs `npx automagik-genie` twice?
- **Decision:** Check ports, show "already running" message

---

## Execution Plan

### Phase 1: Auth Foundation (Core)

**Duration:** 4-6 hours

**Tasks:**
1. Create `~/.genie/config.yaml` schema
   ```yaml
   mcp:
     auth:
       token: "genie_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
       created: "2025-10-20T12:34:56Z"
     tunnel:
       enabled: false
       provider: "ngrok"
       token: null
     server:
       port: 8885
       transport: "httpStream"
   ```

2. Implement token generation (`crypto.randomBytes(24).toString('hex')`)

3. Add auth middleware to `.genie/mcp/src/server.ts`
   ```typescript
   // Validate Bearer token on all HTTP requests
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

4. Test: `curl -H "Authorization: Bearer <token>" http://localhost:8885/sse`

**Deliverables:**
- `~/.genie/config.yaml` created on first run
- Auth token generated and stored
- MCP server validates all requests
- 401 Unauthorized for invalid/missing auth

**Evidence:**
- Screenshot of 401 error with invalid token
- Screenshot of successful request with valid token
- Config file showing generated token

---

### Phase 2: Unified Startup (Integration)

**Duration:** 3-4 hours

**Tasks:**
1. Modify `bin/automagik-genie.js` to call unified startup
   ```javascript
   // OLD: require(mcp-server-entry)
   // NEW: require(unified-startup-entry)
   ```

2. Create `.genie/cli/src/unified-startup.ts`
   ```typescript
   export async function startGenie() {
     // 1. Check/create config
     // 2. Start Forge in background
     // 3. Wait for Forge ready
     // 4. Start MCP server (with auth)
     // 5. Start tunnel (optional)
     // 6. Display unified output
     // 7. Wait for Ctrl+C
   }
   ```

3. Implement graceful shutdown
   ```typescript
   process.on('SIGINT', async () => {
     console.log('\n🛑 Shutting down...');
     await stopMCPServer();
     stopForge(logDir);
     process.exit(0);
   });
   ```

4. Display unified output with all connection info

**Deliverables:**
- `npx automagik-genie` starts both services
- Output shows Forge + MCP + tunnel + auth
- Ctrl+C gracefully stops both services

**Evidence:**
- Terminal recording of startup sequence
- Both services accessible via curl
- Clean shutdown logs

---

### Phase 3: ngrok Integration (Tunnel)

**Duration:** 2-3 hours

**Tasks:**
1. Add dependency: `@ngrok/ngrok` (package.json)

2. Implement tunnel startup in `unified-startup.ts`
   ```typescript
   import ngrok from '@ngrok/ngrok';

   async function startTunnel(port: number, token: string) {
     const listener = await ngrok.forward({
       addr: port,
       authtoken: token,
       schemes: ['https'],
     });
     return listener.url();
   }
   ```

3. Handle tunnel errors gracefully (no token → skip tunnel)

4. Display tunnel URL in output

**Deliverables:**
- ngrok tunnel starts if token configured
- HTTPS URL displayed in output
- Tunnel accessible from internet

**Evidence:**
- External request via tunnel URL succeeds
- Auth token validated through tunnel
- ChatGPT can connect via tunnel

---

### Phase 4: Setup Wizard (UX)

**Duration:** 3-4 hours

**Tasks:**
1. First-run detection (`!fs.existsSync(CONFIG_FILE)`)

2. Interactive prompts using `readline`
   ```
   🧞 Genie MCP Server - First Run Setup

   ? Do you want to enable remote access via tunnel? (Y/n) › Yes

   ? Enter ngrok authtoken (free at https://ngrok.com/signup):
     › 2xxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

   ✓ Saved to ~/.genie/config.yaml
   ✓ Generated MCP auth token
   ```

3. Save config to `~/.genie/config.yaml`

4. Show ChatGPT configuration snippet
   ```json
   {
     "mcpServers": {
       "genie": {
         "url": "https://abc-123.ngrok-free.app/sse",
         "headers": {
           "Authorization": "Bearer genie_xxx..."
         }
       }
     }
   }
   ```

**Deliverables:**
- First-run wizard collects ngrok token
- Config file created automatically
- ChatGPT setup instructions displayed

**Evidence:**
- Fresh install walkthrough video
- Config file created with correct structure
- ChatGPT successfully connects

---

## Validation & Testing

### Functional Tests

**Test 1: Fresh Install**
```bash
# Clean state
rm -rf ~/.genie/config.yaml

# Run first time
npx automagik-genie
# Expected: Setup wizard runs, config created, services start
```

**Test 2: Subsequent Runs**
```bash
# Run second time (config exists)
npx automagik-genie
# Expected: No wizard, uses existing config, services start
```

**Test 3: Auth Validation**
```bash
# Valid token
curl -H "Authorization: Bearer <valid-token>" http://localhost:8885/sse
# Expected: 200 OK

# Invalid token
curl -H "Authorization: Bearer invalid" http://localhost:8885/sse
# Expected: 401 Unauthorized

# Missing token
curl http://localhost:8885/sse
# Expected: 401 Unauthorized
```

**Test 4: Tunnel Access**
```bash
# External request through tunnel
curl -H "Authorization: Bearer <token>" https://xxx.ngrok-free.app/sse
# Expected: Same response as localhost
```

**Test 5: Graceful Shutdown**
```bash
# Start services
npx automagik-genie

# Press Ctrl+C
# Expected: Both services stop cleanly
```

### Integration Tests

**Test 6: ChatGPT Connection**
- Add Genie MCP to ChatGPT settings
- Send message: "List available Genie agents"
- Expected: ChatGPT calls MCP, returns agent list

**Test 7: Forge+MCP Coordination**
- Start via `npx automagik-genie`
- Verify Forge API accessible
- Verify MCP can create Forge tasks
- Expected: MCP→Forge communication works

---

## Risks & Mitigations

**Risk 1: Port Conflicts**
- **Impact:** Services fail to start if ports 8887/8885 occupied
- **Mitigation:** Check ports, show clear error message with instructions

**Risk 2: ngrok Token Invalid**
- **Impact:** Tunnel fails to start
- **Mitigation:** Catch error, show warning, continue with local-only mode

**Risk 3: Config File Corruption**
- **Impact:** Services fail to parse config
- **Mitigation:** Validate YAML on load, show repair instructions

**Risk 4: Auth Token Leak**
- **Impact:** Unauthorized access to MCP server
- **Mitigation:**
  - Store config with restrictive permissions (chmod 600)
  - Never log token values
  - Document token rotation procedure

**Risk 5: Forge Not Responding**
- **Impact:** Startup hangs waiting for Forge
- **Mitigation:** 15s timeout, show error, link to logs

---

## Documentation Updates

### README.md

```markdown
## Quick Start

Start Genie MCP server with integrated Forge backend:

\`\`\`bash
npx automagik-genie
\`\`\`

First run will prompt for optional ngrok tunnel setup.

### Connect to ChatGPT

1. Copy connection details from terminal output
2. In ChatGPT: Settings → Connectors → Add MCP Server
3. Paste URL (with `/sse` path) and auth header
4. Test: "List available Genie agents"
```

### CONTRIBUTING.md

Add section on testing MCP auth locally

### New: MCP_AUTH_GUIDE.md

- Token generation process
- Security best practices
- ChatGPT setup walkthrough
- Troubleshooting guide

---

## Dependencies

**New Dependencies:**
- `@ngrok/ngrok: ^1.4.1` (tunnel support)

**Modified Files:**
- `bin/automagik-genie.js` - Entry point modification
- `.genie/cli/src/unified-startup.ts` - NEW
- `.genie/mcp/src/server.ts` - Auth middleware
- `package.json` - Add ngrok dependency
- `README.md` - Update quick start

**No Breaking Changes:**
- Existing `genie mcp` command still works
- Existing `genie forge start` still works
- Config file is additive (no migration needed)

---

## Acceptance Criteria Checklist

**Core Functionality:**
- [ ] `npx automagik-genie` starts Forge + MCP
- [ ] Auth token generated on first run
- [ ] Bearer token validation on all MCP requests
- [ ] 401 Unauthorized for invalid auth
- [ ] Graceful shutdown (Ctrl+C)

**Tunnel Support:**
- [ ] ngrok integration working
- [ ] Tunnel URL displayed in output
- [ ] External requests via tunnel succeed
- [ ] Tunnel failures handled gracefully

**UX:**
- [ ] First-run setup wizard
- [ ] Unified output shows all services
- [ ] ChatGPT config snippet provided
- [ ] Clear error messages

**Security:**
- [ ] Config file has restrictive permissions
- [ ] Tokens never logged
- [ ] Health check endpoint bypasses auth
- [ ] 401 response for missing/invalid auth

**Documentation:**
- [ ] README updated with quick start
- [ ] MCP_AUTH_GUIDE.md created
- [ ] ChatGPT setup instructions documented

**Testing:**
- [ ] Fresh install wizard tested
- [ ] Auth validation tests pass
- [ ] Tunnel access verified
- [ ] ChatGPT connection tested
- [ ] Graceful shutdown verified

---

## Open Questions

**Q: Should we support multiple auth tokens?**
- Current: Single token in config
- Future: Array of tokens with names/expiry
- **Decision Deferred:** Single token for v1, multi-token in v2

**Q: Token rotation strategy?**
- How does user generate new token?
- Command: `genie mcp token rotate`?
- **Decision Deferred:** Manual config edit for v1, CLI command in v2

**Q: What if Forge fails to start?**
- Current: Timeout and exit
- Alternative: Start MCP anyway (degraded mode)
- **Decision:** Exit on Forge failure (both services required)

**Q: Support for other tunnel providers?**
- localtunnel, cloudflare, custom
- **Decision Deferred:** ngrok only for v1

---

## Success Metrics

**Technical:**
- ✅ Auth validation: 100% requests validated
- ✅ Startup time: <5s for both services ready
- ✅ Uptime: No crashes for 24h continuous operation
- ✅ Shutdown: <2s graceful termination

**User Experience:**
- ✅ First-run setup: <2 minutes to complete
- ✅ ChatGPT connection: <5 minutes from install to working
- ✅ Support tickets: <5 setup-related issues per 100 users

**Business:**
- ✅ Homologation: Passes ChatGPT MCP submission requirements
- ✅ Adoption: 80%+ users enable tunnel in setup
- ✅ Retention: Users successfully reconnect after restart

---

**Status:** Ready for forge.md breakdown
**Next Step:** Create execution groups in forge workflow
