/**
 * Durable ACP session store + disconnect-hardening gate — wish mikro-acp-adapter,
 * Group 3.
 *
 * Deterministic, no-LLM proofs for the three Group 3 invariants that a live
 * smoke cannot pin down precisely:
 *   1. RESTORE-ON-EMPTY: a session persisted by one `SessionStore` instance is
 *      rehydrated by a FRESH instance (simulating an agent-process restart) with
 *      its conversation history intact — the exact "Invalid params" bug fix.
 *   2. Bounded growth: per-turn field cap, per-file MAX_TURNS cap.
 *   3. Disconnect hardening: `abortActivePrompt` reuses the cooperative cancel
 *      path — aborts the turn AND closes the emitter — and is null-safe.
 *   4. Multi-turn threading: `buildConversationalQuery` folds prior turns in on a
 *      follow-up and is a pass-through on the first turn.
 *
 * The live `smoke-acp.mjs --multiturn` run is the end-to-end integration proof
 * (real LLM, real agent-process restart); this file is the fast unit proof.
 */
export {};
//# sourceMappingURL=acp-session-store.test.d.ts.map