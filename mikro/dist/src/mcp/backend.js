/**
 * Runtime backend seam — Wish mikro-v2-prime-backend Group 1.
 *
 * The MCP server used to call `rlmLoop` directly; it now calls a backend.
 * That inversion is the whole point of this module: the server owns the
 * MCP contract (tools, sessions, result shape, progress presentation) and a
 * backend owns "what actually executes the turn", so a second engine can
 * slot in behind the same host-visible surface.
 *
 * Deliberately no `signal` parameter: the MCP server has no cancellation
 * wiring and `RLMOptions` (`src/rlm.ts`) has no `signal` field, so a signal
 * would have no producer and no legacy consumer. Each backend owns its own
 * stopping semantics — the legacy backend keeps its internal
 * `maxIterations`/`timeout` → `budgetHit` behavior; a future backend owns a
 * deadline/kill of its own.
 */
export {};
//# sourceMappingURL=backend.js.map