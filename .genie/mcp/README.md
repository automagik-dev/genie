# Genie MCP Server
Model Context Protocol (MCP) server for Genie agent orchestration. Exposes Genie's agent management capabilities as MCP tools for integration with Claude Desktop and other MCP clients.

## Features

- **6 MCP Tools**: run, resume, list_agents, list_sessions, view, stop
- **Zero Code Duplication**: Reuses CLI core handlers
- **Dual Transport**: stdio (local development) + httpStream (remote server)
- **Production-Ready**: SessionService with atomic writes, file locking, stale lock reclamation
- **FastMCP Framework**: Built on FastMCP v3.18.0 for best-in-class TypeScript MCP support

## Quick Start

### Local Development (stdio - Default)

```bash
# Build the MCP server
pnpm run build:mcp

# Start with stdio transport (for Claude Desktop)
pnpm run start:mcp:stdio
```

### Remote Server (httpStream)

```bash
# Start with HTTP streaming transport
pnpm run start:mcp:http

# Server will listen on:
# - HTTP Stream: http://localhost:8080/mcp
# - SSE: http://localhost:8080/sse
```

### Environment Variables

- `MCP_TRANSPORT`: Transport type (`stdio` [default] | `httpStream`)
- `MCP_PORT`: HTTP server port (default: 8080)

## Claude Desktop Integration

Add to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "genie": {
      "command": "node",
      "args": ["/absolute/path/to/automagik-genie/.genie/mcp/dist/server.js"],
      "env": {
        "MCP_TRANSPORT": "stdio"
      }
    }
  }
}
```

**Note**: Replace `/absolute/path/to/automagik-genie/` with your actual project path.

After configuration:
1. Restart Claude Desktop
2. Look for the 🔌 plug icon in the input area
3. Click to see available Genie tools

## Available Tools

### `genie_run`
Start a new Genie agent session.

**Parameters:**
- `agent` (string): Agent name (e.g., "plan", "implementor", "review")
- `prompt` (string): Initial prompt for the agent

**Example:**
```typescript
{
  "agent": "plan",
  "prompt": "Analyze the authentication flow and suggest improvements"
}
```

### `genie_resume`
Continue an existing session with a follow-up prompt.

**Parameters:**
- `sessionId` (string): Session ID to resume
- `prompt` (string): Follow-up message

### `genie_list_agents`
List all available Genie agents from `.genie/agents/` directory.

**Parameters:** None

### `genie_list_sessions`
List active and recent Genie sessions.

**Parameters:** None

### `genie_view`
View transcript for a specific session.

**Parameters:**
- `sessionId` (string): Session ID to view
- `full` (boolean, optional): Show full transcript (default: recent only)

### `genie_stop`
Stop a running Genie session.

**Parameters:**
- `sessionId` (string): Session ID to stop

## Architecture

### Zero Duplication Design

```
.genie/cli/src/cli-core/          # Reusable handlers
├── session-service.ts             # Production SessionService
├── handlers/
│   ├── run.ts                     # Run logic
│   ├── resume.ts                  # Resume logic
│   └── ...                        # Other handlers
└── index.ts                       # Factory exports

.genie/mcp/src/
├── server.ts                      # FastMCP server
└── (tools call cli-core handlers) # No duplication
```

**Key Principle**: MCP tools invoke the same handlers as the CLI, ensuring behavioral equivalence.

### SessionService Features

The production-grade `SessionService` provides:

1. **Atomic Writes**: temp file + fsync + rename prevents partial reads
2. **Stale Lock Reclamation**: PID tracking + process detection prevents deadlocks
3. **Fresh Reload**: Reloads disk state before merge prevents data loss from concurrent writes
4. **Lock Retry**: Automatic retry with exponential backoff on lock contention

See `tests/session-service.test.js` for comprehensive test coverage.

## Development

### Build

```bash
# Build CLI core
pnpm run build:genie

# Build MCP server
pnpm run build:mcp
```

### Testing

```bash
# CLI tests
pnpm run test:genie

# SessionService unit tests
pnpm run test:session-service

# All tests
pnpm run test:all
```

### MCP Inspector

Test the MCP server interactively:

```bash
# Install MCP Inspector (one-time)
npm install -g @modelcontextprotocol/inspector

# Inspect the server
npx @modelcontextprotocol/inspector node .genie/mcp/dist/server.js
```

## Transport Configuration

### stdio (Default)

- **Purpose**: Local development, Claude Desktop, MCP Inspector
- **Characteristics**: Process-to-process communication via stdin/stdout
- **Use when**: Integrating with local MCP clients

```bash
MCP_TRANSPORT=stdio pnpm run start:mcp
```

### httpStream

- **Purpose**: Remote server deployment, network-accessible MCP
- **Characteristics**: HTTP streaming + SSE fallback
- **Use when**: Exposing MCP server over network

```bash
MCP_TRANSPORT=httpStream MCP_PORT=8080 pnpm run start:mcp
```

## Production Deployment

### systemd Service (Linux)

Create `/etc/systemd/system/genie-mcp.service`:

```ini
[Unit]
Description=Genie MCP Server
After=network.target

[Service]
Type=simple
User=genie
WorkingDirectory=/opt/automagik-genie
Environment="MCP_TRANSPORT=httpStream"
Environment="MCP_PORT=8080"
Environment="NODE_ENV=production"
ExecStart=/usr/bin/node /opt/automagik-genie/.genie/mcp/dist/server.js
Restart=on-failure
RestartSec=10s

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable genie-mcp
sudo systemctl start genie-mcp
sudo systemctl status genie-mcp
```

### Docker (Optional)

```dockerfile
FROM node:20-alpine

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build:genie && pnpm run build:mcp

ENV MCP_TRANSPORT=httpStream
ENV MCP_PORT=8080

EXPOSE 8080

CMD ["node", ".genie/mcp/dist/server.js"]
```

## Troubleshooting

### Claude Desktop Not Detecting Server

1. Check configuration path is absolute
2. Verify MCP server builds successfully: `pnpm run build:mcp`
3. Test manually: `MCP_TRANSPORT=stdio node .genie/mcp/dist/server.js`
4. Check Claude Desktop logs: `~/Library/Logs/Claude/` (macOS)

### Session State Not Syncing

- Ensure `.genie/state/agents/sessions.json` has correct permissions
- Check `SessionService` logs for lock contention warnings
- Verify no orphaned `.lock` files in `.genie/state/agents/`

### HTTP Server Not Starting

- Check port availability: `lsof -i :8080`
- Verify `MCP_TRANSPORT=httpStream` is set
- Test health endpoint: `curl http://localhost:8080/health`

## Project Status

**Current Phase**: Foundation (Groups A & B complete)

✅ **Complete:**
- CLI core module with SessionService
- FastMCP server with 6 tools (stubs)
- stdio + httpStream transports
- SessionService unit tests

🚧 **In Progress:**
- Handler extraction from genie.ts
- MCP tool integration with cli-core handlers
- End-to-end integration tests

See `.genie/wishes/mcp-integration-wish.md` for full roadmap.

## References

- [FastMCP Documentation](https://github.com/punkpeye/fastmcp)
- [MCP Specification](https://modelcontextprotocol.io/)
- [Claude Desktop MCP Guide](https://modelcontextprotocol.io/quickstart/user)
- Genie Wish: `.genie/wishes/mcp-integration-wish.md`
- Evidence: `.genie/wishes/mcp-integration/evidence/`

## License

Part of the Automagik Genie project. See repository root for license information.
