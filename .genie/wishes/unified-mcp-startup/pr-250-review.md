# Code Review – PR #250: Unified MCP Startup with Authentication & Tunnel

**Reviewer:** Code Agent
**Date:** 2025-10-24
**Branch:** forge/488b-feat-unified-mcp
**PR:** #250
**Wish:** .genie/wishes/unified-mcp-startup/unified-mcp-startup-wish.md

---

## Executive Summary

**Verdict:** fix-first (confidence: medium)

The MCP server introduces header-based Bearer/X-Forge-API-Key authentication hooks, health endpoints, tool/resource registration, and graceful shutdown. TypeScript wrapper adds user-friendly error mapping and per-context messages. Entry binary routes to a unified-startup script.

**Gaps vs scope:** No visible token generation/storage, constant-time comparison, ngrok/tunnel integration, setup wizard, or config persistence in this tree. Health bypass for unauthenticated checks is not explicit. Some auth/error semantics could be tightened.

---

## Findings by Severity

### 🔴 CRITICAL (0 issues)

None observed in present files. **Note:** Security-critical features mentioned in scope are missing here, which is itself a gap.

---

### 🟠 HIGH (2 issues)

#### 1. OAuth2 middleware imported but never wired into request pipeline
**File:** `.genie/mcp/src/server.ts:34`
**Issue:** The `validateHttpAuth` middleware is imported but never called in the HTTP Stream request handling pipeline. OAuth2 validation is completely bypassed - all requests are processed without authentication.

**Impact:**
- **SECURITY CRITICAL:** All MCP tools are accessible without authentication
- OAuth2 implementation exists but is effectively dead code
- Token endpoint and metadata endpoint are exposed but tokens are never validated

**Evidence:**
```typescript
// Line 34: Imported but never used
import { validateHttpAuth } from './middleware/auth.js';

// Lines 806-812: Server starts without auth middleware
server.start({
  transportType: 'httpStream',
  httpStream: {
    port: PORT,
    // OAuth2 validation handled by FastMCP or custom middleware ← FALSE
  }
});
```

**Fix Required:**
- Wire `validateHttpAuth` into FastMCP request pipeline
- Ensure all tool invocations go through auth validation
- Add explicit health endpoint bypass (see next issue)
- Test that invalid tokens receive 401 Unauthorized

---

#### 2. Health endpoint requires auth (no explicit bypass)
**File:** `.genie/mcp/src/server.ts` (FastMCP tool registration)
**Issue:** Scope requires "Health endpoint bypass" so `/health` (and likely `/ready`) should respond 200 without auth. Current architecture would throw 401 when no key is present if auth is wired up.

**Impact:**
- Load balancers and monitoring tools cannot check health
- Violates industry-standard health check patterns
- Blocks deployment behind proxies/load balancers

**Fix Required:**
- Implement route-level bypass in FastMCP or pre-auth check
- Allow `/health`, `/ready`, `/oauth/token`, and `/.well-known/oauth-protected-resource` without authentication
- Ensure all other endpoints remain protected

---

### 🟡 MEDIUM (5 issues)

#### 3. Hard dependency on unified-startup artifact without existence check
**File:** `bin/automagik-genie.js:18`
**Issue:** If `.genie/cli/dist/unified-startup.js` is missing or not built, startup will crash without a clear message. Unified startup is central to this PR.

**Fix:** Add existence check with helpful error and fallback guidance.

---

#### 4. Bearer token extraction only; no verification logic
**File:** `.genie/mcp/src/middleware/auth.ts:51-59`
**Issue:** Scope mentions "constant-time comparison implementation" and "auth token generation." The current code only extracts Bearer token from header; no verification is performed and there's no constant-time compare.

**Note:** This finding is partially incorrect - OAuth2 verification DOES exist in `auth.ts` (verifyAccessToken with JWT signature validation), but the middleware is never called by server.ts. The real issue is #1 above.

---

#### 5. No tunnel/ngrok wiring visible
**File:** `.genie/mcp/src/server.ts`
**Issue:** Scope calls for tunnel integration and error handling; not present in this tree.

**Fix:** Add optional tunnel orchestrator that validates ngrok token, handles failures gracefully, and logs the public URL.

---

#### 6. No config persistence or wizard flow
**File:** `.genie/cli/src/unified-startup.ts` (not reviewed in detail)
**Issue:** Scope expects first-run detection, readline-based prompts, config at `~/.genie/config.yaml` with 0o600 permissions, and ChatGPT snippet generation.

**Fix:** Add setup wizard module invoked by unified startup that writes config (`fs.writeFile` with 0o600) and produces snippet outputs. Ensure environment fallback and good error handling.

---

#### 7. Authentication messaging implies "Required (header)" vs "Enabled (env)" but doesn't guard tool registration or resource access per-request
**File:** `.genie/mcp/src/server.ts` (tool registration)
**Issue:** Client is global for stdio and built once for HTTP at registration time via `registrationClient`. Per-request auth context is declared but not used to build per-request clients for tool handlers.

**Fix:** Ensure handlers derive a ForgeClient with the current request's auth (e.g., via FastMCP context) rather than a single prebound client. If FastMCP supports per-request context injection, pass the token to each tool call.

---

### 🟢 LOW (3 issues)

#### 8. Error mapping relies on string includes (e.g., "[404]")
**File:** `.genie/mcp/src/lib/forge-client.ts`
**Issue:** Brittle to upstream message format.
**Fix:** If possible, inspect structured error objects (status codes) or standardize error shapes in forge.js.

---

#### 9. Version string hardcoded as "1.0.0"
**File:** `.genie/mcp/src/server.ts` (partially addressed - getGenieVersion() exists)
**Issue:** Version is now loaded from package.json via `getGenieVersion()`. This is actually CORRECT. Finding can be closed.

---

#### 10. Logging clarity
**Issue:** Startup logs are good, but the auth mode statement could explicitly note which endpoints bypass auth (after implementing bypass).
**Fix:** Adjust messages after implementing health bypass and tunnel display.

---

## Strengths

✅ Clean tool/resource registration and helpful startup logs
✅ Graceful shutdown handlers (SIGINT/SIGTERM) implemented
✅ Wrapper client provides user-readable error mapping and normalizes profiles via system info fallback
✅ Clear separation: server, tools, resources, client wrapper, logger
✅ OAuth2 infrastructure is well-designed (JWT, RS256, PEM keys, constant-time comparison)
✅ Version loading from package.json working correctly

---

## Gaps vs Scope (Functionality Verification)

### Authentication Foundation:
- ❌ **Token format "genie_<48 hex chars>":** Present in oauth2-utils.ts
- ❌ **Config storage at ~/.genie/config.yaml with 0o600:** Not verified in this review
- ❌ **Bearer validation middleware:** Present but **NOT WIRED** into server
- ❌ **401 responses for invalid/missing auth:** Would work if middleware was wired
- ❌ **Health endpoint bypass:** Missing

### Unified Startup:
- ⚠️ Entry routing exists and points to unified-startup, but unified module not present in this tree to validate display/coordination/shutdown

### Tunnel Integration:
- ❌ ngrok handling/validation/logging not present

### Setup Wizard:
- ❌ First-run detection, prompts, config persistence, ChatGPT snippet generation not present

---

## Testing & Documentation

- **Unit/Integration tests:** Existing MCP tests cover health and basic flows but do not exercise new auth/tunnel/wizard features described in PR scope
- **README/forge/mcp docs:** Describe health and auth header usage; do not document unified startup specifics, token generation, ngrok/tunnel, or wizard flow
- **Inline comments:** Clear where present; missing around auth strategy and future validation hooks

---

## Action Items (Prioritized)

### 🔴 CRITICAL - Must Fix Before Merge

1. **Wire OAuth2 middleware into server request pipeline**
   - Integrate `validateHttpAuth` with FastMCP request handling
   - Ensure all tool invocations pass through auth
   - Test 401 response for missing/invalid tokens

2. **Implement health/ready auth bypass**
   - Define public endpoints: `/health`, `/ready`, `/oauth/token`, `/.well-known/oauth-protected-resource`
   - Add pre-auth check or route-level bypass
   - Verify health checks work without credentials

### 🟡 HIGH PRIORITY - Should Fix Before Merge

3. **Add setup wizard**
   - First-run detection if config is absent
   - Interactive prompts via readline/prompts
   - Persist config to `~/.genie/config.yaml` with mode 0o600
   - Generate ChatGPT MCP config snippet for copy-paste

4. **Add tunnel/ngrok integration**
   - Validate token presence and correctness
   - Start tunnel, handle failures gracefully, and display public URL
   - Document tunnel setup in README

5. **Harden error handling**
   - Add existence check for unified-startup artifact
   - Improve startup errors if missing
   - Add structured error inspection (avoid brittle string matching)

### 🟢 NICE TO HAVE - Can Address Post-Merge

6. **Tests and docs**
   - Add tests for health bypass, auth success/failure paths, tunnel error handling, and wizard config persistence (mock fs)
   - Update README and forge/mcp docs with unified startup flow, token format, config path, and tunnel instructions

7. **Per-request auth context**
   - Wire per-request ForgeClient with authenticated token (if applicable)

---

## Summary

**Core Issue:** OAuth2 implementation is complete and well-designed, but **never wired into the request pipeline**. The server imports `validateHttpAuth` but never calls it.

**Result:** All MCP tools are currently accessible without authentication despite OAuth2 infrastructure existing.

**Recommendation:** fix-first. Address critical security gap (#1) and health bypass (#2) before merging. Setup wizard (#3) and tunnel integration (#4) should also be completed to meet PR scope.
