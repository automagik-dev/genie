/**
 * The termination protocol must reach every FINAL-terminated run.
 *
 * The defect these tests pin: a pack's own `SYSTEM.md` *replaces* the
 * scaffolded template, and the ```repl``` / `FINAL()` contract lived only in
 * that template. An agent with a hand-written prompt was therefore never told
 * how to stop — it answered in prose, `detectFinal` never fired, and the run
 * burned to `max_iterations`. Both prompt builders now append the protocol
 * unless the prompt already teaches it or the config opts out.
 */
export {};
//# sourceMappingURL=rlm-stop-protocol.test.d.ts.map