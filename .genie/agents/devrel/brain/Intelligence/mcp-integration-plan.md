---
type: entity
created: 2026-03-26
updated: 2026-03-26
tags: [mcp, protocol, integration, architecture, roadmap]
---

# MCP Integration Plan for Genie

## What MCP Is
Model Context Protocol — standardized interface for AI agents to access tools, resources, and context. Genie should be BOTH a server (expose capabilities) AND a client (consume external tools).

## Dual Role Architecture

```
Genie as MCP SERVER (expose to Claude Desktop, VS Code, other clients):
  Tools:     create_wish, get_wishes, spawn_agent, get_status, search_context
  Resources: genie://system/status, genie://wishes/{id}, genie://agent/{id}/logs
  Prompts:   create_agent_wizard, summarize_wish_context

Genie as MCP CLIENT (consume external servers):
  Filesystem → file operations for agents
  Git        → version control operations
  Memory     → persistent knowledge graph
  Fetch      → web research capability
```

## Available MCP Servers (relevant to Genie)
| Server | Relevance | Use Case |
|--------|-----------|----------|
| Filesystem | CRITICAL | Agent file read/write with Roots-based access control |
| Git | CRITICAL | Version control operations |
| Memory | HIGH | Knowledge graph for persistent context |
| Fetch | MEDIUM | Web research for agents |
| Sequential Thinking | MEDIUM | Complex multi-step reasoning |

## Transport Options
- **STDIO**: Local CLI integration (Claude Desktop, editors) — Phase 1
- **Streamable HTTP**: Cloud/multi-agent deployments — Phase 2

## Key Pattern: Tool Annotations
```typescript
annotations: {
  readOnlyHint: true/false,
  idempotentHint: true/false,
  destructiveHint: true/false  // Tells clients this mutates state
}
```
Genie's auto-approve rules map directly to MCP tool annotations.

## Implementation Phases
1. **Phase 1**: Genie as MCP server (STDIO) — expose wishes + agents as tools
2. **Phase 2**: Consume Filesystem + Git servers — agent file/git operations via MCP
3. **Phase 3**: Memory server integration — persistent cross-agent knowledge
4. **Phase 4**: Streamable HTTP transport — cloud deployments
5. **Phase 5**: Event subscriptions — real-time state changes to external clients

## Strategic Value
MCP integration makes Genie composable with the ENTIRE MCP ecosystem (100+ servers on registry.modelcontextprotocol.io). Any tool that speaks MCP becomes a Genie tool. And any client that speaks MCP can orchestrate Genie.
