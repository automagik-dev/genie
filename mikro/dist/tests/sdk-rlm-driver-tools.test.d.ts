/**
 * mikro#78 — tool-dispatch driver tests.
 *
 * Covers the multi-turn native-function-calling loop added to
 * rlmDriver when a `tools` config is present. The legacy one-shot
 * path is covered by `sdk-rlm-driver.test.ts`; this file is purely
 * the tool-dispatch surface.
 *
 * All tests are hermetic — they inject a `toolsLlm` mock in place of
 * `completeSimple` so no live LLM is called. A separate LIVE smoke
 * is deferred to the integration suite (gated on GEMINI_API_KEY).
 */
export {};
//# sourceMappingURL=sdk-rlm-driver-tools.test.d.ts.map