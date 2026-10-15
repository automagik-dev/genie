/**
 * Microagent discovery gate — `mikro mcp`.
 *
 * Deterministic, no-LLM proofs for the discovery contract that a live MCP
 * smoke cannot pin down precisely:
 *   1. Tool names are MCP-legal (`^[a-zA-Z0-9_-]{1,128}$`) for hostile
 *      directory names — an illegal name would make the whole tools/list
 *      response invalid, not just that one agent.
 *   2. Root precedence: a project agent shadows a global agent of the same
 *      name, so a repo can override a machine-wide default.
 *   3. A broken agent.yaml is skipped rather than taking down the server.
 *   4. Descriptions are never empty — an empty description makes an agent
 *      effectively invisible to the host model.
 *   5. The live-refresh seam: a re-scan rebuilds the advertised list and the
 *      call lookup together, and reports a set change exactly once.
 *   6. The session seam: TTL expiry, LRU eviction, per-tool orphan eviction,
 *      turn-history bounding, and the resume fold — all the parts a live smoke
 *      cannot force deterministically.
 *   7. The propose-only boundary: a `<name>.proposed/` draft is neither listed
 *      nor callable, and the rename that approves it takes effect on the next
 *      refresh without a reconnect.
 *   8. The output contract: `structuredContent` actually carries every field
 *      `outputSchema` promises — above all the answer, which a host reading the
 *      structured channel instead of the text block would otherwise never see.
 */
export {};
//# sourceMappingURL=mcp-agents.test.d.ts.map