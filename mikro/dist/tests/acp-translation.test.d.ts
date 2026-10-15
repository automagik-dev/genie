/**
 * Deterministic translation gate — wish mikro-acp-adapter, Group 2.
 *
 * Feeds a synthetic AgentEvent sequence (root iterations + 2 Recurse spawns
 * incl. sibling branches + bridged child completions + a repl tool call +
 * EmitDone) through `translateEvent` and asserts the EXACT SessionUpdate
 * sequence: types, tool-call node identity (keyed by child correlationId),
 * and per-node metrics presence. This is the deterministic proof; the live
 * `smoke-acp.mjs --recursive` run is the integration proof.
 */
export {};
//# sourceMappingURL=acp-translation.test.d.ts.map