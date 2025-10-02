# Twin Report — MCP Integration Architecture Review
- Timestamp: 2025-10-01 03:59 UTC
- Initiator: Twin review requested during sleepy mode pre-forge gate
- Mode: planning
- Scope: @.genie/wishes/mcp-integration-wish.md (focus on CLI refactor extraction, session consistency, FastMCP suitability)
- Summary: Identified critical coupling between CLI entrypoint and command handlers, session-store write collision risks under multi-process access, and FastMCP integration assumptions that require adapters to preserve zero-duplication and unified state.

## Key Insights
- `genie.ts` currently executes `main()` on import, so sharing handlers with MCP without restructuring would re-run CLI argument parsing in server context.
- Session persistence relies on naive read/modify/write of `.genie/state/agents/sessions.json`, creating a high collision window when CLI and MCP mutate concurrently.
- FastMCP adds conveniences but also its own session abstractions; without a clear adapter layer, it could diverge from the CLI's execution paths and state model.

## Top Risks & Mitigations
1. Command extraction side effects and hidden dependencies between CLI entrypoint and handlers — mitigate via dedicated `cli-core` module exporting pure handlers plus shared type definitions, with CLI entrypoint lazily invoking them.
2. Session store race conditions when CLI and MCP run simultaneously — mitigate via centralized `SessionService` with file locking or optimistic retry/merge plus telemetry around write failures.
3. Framework lock-in or divergences if FastMCP expectations conflict with Genie abstractions — mitigate by wrapping FastMCP usage behind an adapter that can fall back to the official SDK, keeping surface area minimal and audited.

## Missing Validations
- Add scripted concurrency smoke (`pnpm run test:session-race`) that launches CLI and MCP operations in parallel and asserts session JSON retains both entries.
- Add module import parity check (`node scripts/assert-command-handlers.js`) to confirm MCP imports do not trigger CLI `main()` and expose identical interfaces as the CLI entrypoint.
- Extend runtime validation to hit both HTTP streaming and SSE endpoints with MCP Inspector, capturing latency and schema validation logs.

## Architectural Refinements
- Factor shared command logic into a `cli-core` package that returns handlers + dependencies, injected by both CLI and MCP layers.
- Implement a locking `SessionService` that serializes writes, debounces background polling, and emits change events for the MCP server.
- Introduce a transport abstraction so FastMCP is one provider; document fallback path using `@modelcontextprotocol/sdk` directly.

## Verdict
- Status: Revise before forge
- Confidence: Medium
- Gate: Address mitigations/refinements above, update wish evidence checklist, then rerun twin review.

