# Genie Environment Variables

**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`

This document lists all environment variables that configure Genie's behavior.

---

## Session Management

### `GENIE_POLL_TIMEOUT`

**Purpose:** Configure the maximum time Genie waits for background agent sessions to start.

**Default:** `60000` (60 seconds)

**Unit:** Milliseconds

**When to use:**
- Slow machines or cold starts that need more time
- CI/CD environments with variable performance
- Debugging session start issues

**Examples:**

```bash
# Wait up to 2 minutes (120 seconds)
GENIE_POLL_TIMEOUT=120000 npx automagik-genie run plan "analyze architecture"

# Wait up to 30 seconds (faster feedback, but may timeout on slow starts)
GENIE_POLL_TIMEOUT=30000 npx automagik-genie run implementor "build feature"

# Wait up to 5 minutes (very slow environments)
GENIE_POLL_TIMEOUT=300000 npx automagik-genie run debug "investigate bug"
```

**Technical details:**
- Added in version 2.4.0-rc.22 (fixes Issue #120)
- Replaces hardcoded 20-second timeout that caused race conditions
- Works with exponential backoff (500ms → 5s max poll interval)
- Progress feedback every 5 seconds during wait
- See: `.genie/cli/src/lib/background-launcher.ts:67`

**Troubleshooting:**

If you see "Timeout waiting for session ID" errors:
1. Increase timeout: `GENIE_POLL_TIMEOUT=120000`
2. Check logs: Location shown in error message
3. Verify agent is actually starting (check process list)
4. Report persistent issues to: https://github.com/namastexlabs/automagik-genie/issues

---

## MCP Server

### `MCP_PORT`

**Purpose:** Configure the port for MCP HTTP server mode.

**Default:** `8080`

**When to use:**
- Port 8080 is already in use
- Multiple MCP servers running on same machine
- Custom networking requirements

**Example:**

```bash
MCP_PORT=9000 npx automagik-genie mcp -t http
```

### `MCP_TRANSPORT`

**Purpose:** Configure the transport protocol for MCP server.

**Default:** `stdio`

**Options:**
- `stdio` - Standard input/output (recommended for Claude Code, Cursor)
- `http` - HTTP server on configured port
- `sse` - Server-Sent Events

**Example:**

```bash
# Use HTTP transport on port 8080
MCP_TRANSPORT=http npx automagik-genie mcp

# Use stdio (default, no need to set)
npx automagik-genie mcp -t stdio
```

---

## Future Environment Variables

These are planned but not yet implemented:

### `GENIE_LOG_LEVEL` (Planned)
- Control logging verbosity (debug, info, warn, error)
- Default: `info`

### `GENIE_SESSION_STORE` (Planned)
- Custom location for sessions.json
- Default: `.genie/state/agents/sessions.json`

### `GENIE_MAX_PARALLEL_SESSIONS` (Planned)
- Limit concurrent background agent sessions
- Default: `10`

---

## See Also

- [MCP Interface Documentation](.genie/docs/mcp-interface.md)
- [Genie Configuration](.genie/cli/src/lib/config-defaults.ts)
- [Session Store Documentation](.genie/cli/src/session-store.ts)

---

**Report Issues:** https://github.com/namastexlabs/automagik-genie/issues
