/**
 * Cache utilities for CAG (Context-Augmented Generation) mode.
 *
 * When --cache is enabled, full context content is embedded directly
 * in the system prompt instead of being externalized to the REPL.
 * This enables provider-level prompt caching (Gemini, Anthropic, etc.)
 * for repeated queries over the same context.
 */
import type { MikroConfig } from "./config.js";
import type { LoadedContext } from "./context.js";
export declare const PROVIDER_LIMITS: Record<string, number>;
/**
 * Estimate token count from context.
 * Uses chars / 4 with a 20% safety margin (i.e., multiplied by 1.2).
 */
export declare function estimateTokens(context: LoadedContext): number;
/** Result of context size validation against a provider's limit. */
export interface ValidationResult {
    valid: boolean;
    estimatedTokens: number;
    limit: number;
    message?: string;
}
/**
 * Validate that a loaded context fits within a provider's context window.
 * Returns validation status with estimated token count and the limit.
 */
export declare function validateContextSize(context: LoadedContext, provider: string): ValidationResult;
/**
 * Compute a stable SHA256 content hash from context.
 * Sorts file paths alphabetically before hashing to ensure determinism.
 * Returns the first 12 hex characters of the hash.
 */
export declare function computeContentHash(context: LoadedContext): string;
/**
 * Build a session ID from an optional prefix and content hash.
 * Format: "{prefix}-{hash}" or just "{hash}" if no prefix.
 */
export declare function buildSessionId(prefix: string | undefined, hash: string): string;
/**
 * Build a system prompt with FULL context content embedded.
 * This is the CAG mode system prompt — all context is in the system message
 * so the provider can cache it across turns/requests.
 *
 * Format:
 *   {system prompt}
 *
 *   ## Context Files
 *
 *   ### {path}
 *   ```
 *   {content}
 *   ```
 */
export declare function buildCachedSystemPrompt(config: MikroConfig, context: LoadedContext | null): string;
//# sourceMappingURL=cache.d.ts.map