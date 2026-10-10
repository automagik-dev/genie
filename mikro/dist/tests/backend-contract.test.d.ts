/**
 * Backend contract — the `RuntimeBackend` seam must be host-invisible.
 *
 * One harness drives every backend through the *real* server-side turn
 * pipeline (`runTurn` → cost footer → `sessionResult`) with the same request
 * and a stubbed engine, then asserts each backend's host-visible results are
 * equal:
 *
 *   1. the `structuredContent` `{answer, session_id}` envelope and its
 *      mirrored text block (same string, byte for byte, on both channels);
 *   2. the cost-footer field set — label, model, iterations, tokens in/out,
 *      cost, budget-hit presence, session id — parsed out of the text block;
 *   3. the `isError` classification, which must equal `isFailedRun`'s verdict
 *      on the backend's result;
 *   4. the progress-notification sequence.
 *
 * Deliberately NOT compared: tool schemas. `genericToolSchema` /
 * `agentToolSchema` / `toolOutputSchema` take no backend argument, so a
 * schema comparison passes by construction and can never fail — comparing
 * them would be theater.
 *
 * Two deliberate exclusions from byte equality:
 *
 *   - the elapsed-seconds footer field: wall-clock timing is a property of
 *     the machine, not of the backend, and two runs never take the same
 *     milliseconds. The field's *presence* and numeric shape are asserted on
 *     every record; its *value* is never compared across backends.
 *   - the heartbeat: the idle `working Ns` ticks are server-side (shared by
 *     every backend by construction, `src/mcp/server.ts`) and fire at 15s —
 *     the stub runs here finish in microseconds, so the compared sequences
 *     are the backend-driven messages, which is what can diverge.
 *
 * The legacy backend is registered twice, so the pairwise comparison has
 * real teeth from day one. Group 2 registers the prime backend too — fed its
 * own stub *engine* — and every assertion below becomes a live cross-backend
 * gate. The prime stub is an engine seam, not the stub binary: two scenarios
 * (empty-response abort, budget-truncated run) carry `budgetHit` reasons the
 * prime backend can only *produce*, not derive from a scripted JSONL stream,
 * so the binary-level spawn machinery stays in `tests/prime-backend.test.ts`
 * and this harness proves the host-visible surface alone.
 */
export {};
//# sourceMappingURL=backend-contract.test.d.ts.map