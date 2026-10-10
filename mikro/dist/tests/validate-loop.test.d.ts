/**
 * VALIDATE.md enforcement on the FINAL channel (`rlmLoop`).
 *
 * The defect these tests pin: `src/sdk/validate.ts` shipped the schema check,
 * the retry policy and the hint text, and `runAgent()` wired them for the SDK
 * surface — but the core loop, which serves the CLI *and* the default MCP
 * backend, never validated anything. A pack's `VALIDATE.md` was inert there
 * and the first FINAL won, conforming or not.
 *
 * Local HTTP provider fixtures drive the actual Python/LLM boundary below.
 * They guard final schema checks, missing-variable feedback, model-call caps,
 * timeout recovery and failure usage without real external model inference.
 */
export {};
//# sourceMappingURL=validate-loop.test.d.ts.map