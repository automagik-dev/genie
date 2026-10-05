/**
 * Gemini 3 native integration module.
 *
 * Provides:
 *   - GeminiConfig interface and defaults
 *   - onPayload hook builder for injecting Gemini-specific params
 *   - Provider detection (isGoogleProvider)
 *   - Feature flag resolution (what's enabled, what's not)
 *   - Structured output config
 *   - Future flag stubs (computer-use, maps, file-search)
 */
import type { GeminiConfig, MediaResolutionConfig } from "./config.js";
/** Check if the provider is Google (gemini). */
export declare function isGoogleProvider(provider: string): boolean;
export type ThinkingLevel = "minimal" | "low" | "medium" | "high";
/**
 * Every accepted level, ascending. Exported so the several places that reject a
 * bad level (`--thinking`, `gemini.thinking-level`, `agent.yaml` `thinking:`)
 * can name the allowed set from one source instead of three literals.
 *
 * Narrower than pi-ai's own `ThinkingLevel`, which also has `xhigh` and `max`.
 * Those two are only reachable on models that declare an explicit
 * `thinkingLevelMap` entry for them, so mikro does not accept them yet.
 */
export declare const THINKING_LEVELS: readonly ThinkingLevel[];
export declare function isValidThinkingLevel(level: string): level is ThinkingLevel;
/** Check future flags and return warnings for any that are enabled. */
export declare function checkFutureFlags(gemini: GeminiConfig): string[];
/**
 * Build the onPayload hook that injects Gemini-specific params into API requests.
 * This is called once per run and returns a function compatible with pi/ai's
 * onPayload option.
 *
 * The hook only modifies the payload when the provider is Google.
 */
export declare function buildGeminiOnPayload(gemini: GeminiConfig, provider: string, outputSchema?: Record<string, unknown> | null): ((payload: unknown) => unknown | undefined) | undefined;
export interface GeminiStats {
    thinkingLevel: ThinkingLevel | null;
    thoughtSignaturesCirculated: number;
    webSearchCalls: number;
    fetchUrlCalls: number;
    codeExecutions: {
        local: number;
        serverSide: number;
    };
    imageGenerations: number;
    mediaResolution: MediaResolutionConfig | null;
    geminiToolsUsed: string[];
    batchApi: boolean;
}
export declare function createGeminiStats(): GeminiStats;
export declare const DEFAULT_GEMINI_CONFIG: GeminiConfig;
//# sourceMappingURL=gemini.d.ts.map