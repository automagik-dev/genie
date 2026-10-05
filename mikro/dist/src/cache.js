/**
 * Cache utilities for CAG (Context-Augmented Generation) mode.
 *
 * When --cache is enabled, full context content is embedded directly
 * in the system prompt instead of being externalized to the REPL.
 * This enables provider-level prompt caching (Gemini, Anthropic, etc.)
 * for repeated queries over the same context.
 */
import { createHash } from "node:crypto";
import { appendStopProtocol, isStructuredOutputMode } from "./stop-protocol.js";
import { buildOutputSchemaSection } from "./sdk/validate.js";
// Provider context window limits (approximate token counts)
export const PROVIDER_LIMITS = {
    anthropic: 200000,
    openai: 128000,
    google: 1000000, // Gemini supports 1M+
    "amazon-bedrock": 128000,
};
/**
 * Estimate token count from context.
 * Uses chars / 4 with a 20% safety margin (i.e., multiplied by 1.2).
 */
export function estimateTokens(context) {
    let totalChars;
    if (context.type === "list") {
        const items = context.content;
        totalChars = items.reduce((sum, item) => sum + item.path.length + item.content.length, 0);
    }
    else {
        totalChars = context.content.length;
    }
    // chars / 4, then 20% safety margin
    return Math.ceil((totalChars / 4) * 1.2);
}
/**
 * Validate that a loaded context fits within a provider's context window.
 * Returns validation status with estimated token count and the limit.
 */
export function validateContextSize(context, provider) {
    const tokens = estimateTokens(context);
    const limit = PROVIDER_LIMITS[provider] ?? 128000;
    if (tokens > limit) {
        return {
            valid: false,
            estimatedTokens: tokens,
            limit,
            message: `Context is ~${tokens} tokens, provider limit is ${limit}. Reduce with context.exclude or split into collections.`,
        };
    }
    return { valid: true, estimatedTokens: tokens, limit };
}
/**
 * Compute a stable SHA256 content hash from context.
 * Sorts file paths alphabetically before hashing to ensure determinism.
 * Returns the first 12 hex characters of the hash.
 */
export function computeContentHash(context) {
    const hash = createHash("sha256");
    if (context.type === "list") {
        const items = context.content;
        // Sort by path for deterministic ordering
        const sorted = [...items].sort((a, b) => a.path.localeCompare(b.path));
        for (const item of sorted) {
            hash.update(item.path);
            hash.update("\0"); // separator
            hash.update(item.content);
            hash.update("\0");
        }
    }
    else {
        hash.update(context.content);
    }
    return hash.digest("hex").slice(0, 12);
}
/**
 * Build a session ID from an optional prefix and content hash.
 * Format: "{prefix}-{hash}" or just "{hash}" if no prefix.
 */
export function buildSessionId(prefix, hash) {
    if (prefix) {
        return `${prefix}-${hash}`;
    }
    return hash;
}
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
export function buildCachedSystemPrompt(config, context) {
    let system = config.system ?? "";
    // Same defect, same fix as `buildSystemPrompt` (`src/rlm.ts`): a pack's own
    // SYSTEM.md replaces the template, so the FINAL contract has to come from
    // the runtime. Placed before the criteria block for the same reason.
    system = appendStopProtocol(system, config);
    // Append criteria if present
    if (config.criteria) {
        system +=
            "\n\n## Output Criteria\n\nWhen providing your FINAL answer, follow these criteria:\n" +
                config.criteria;
    }
    // Same disclosure, same position as `buildSystemPrompt` (`src/rlm.ts`):
    // after the stop-protocol and criteria appends, so its literal `FINAL(`
    // examples are invisible to the stop protocol's `config.system` sentinel.
    // The `## Context Files` block below still comes last. Skipped in
    // structured-output mode, same as the stop protocol — that path never
    // parses FINAL().
    if (config.validate && !isStructuredOutputMode(config)) {
        system += "\n\n" + buildOutputSchemaSection(config.validate.rawBlock);
    }
    if (!context) {
        return system;
    }
    // Append full context content
    system += "\n\n## Context Files\n";
    if (context.type === "list") {
        const items = context.content;
        for (const item of items) {
            system += `\n### ${item.path}\n\`\`\`\n${item.content}\n\`\`\`\n`;
        }
    }
    else {
        // String or dict context — embed as a single block
        const content = context.content;
        system += `\n### context\n\`\`\`\n${content}\n\`\`\`\n`;
    }
    return system;
}
//# sourceMappingURL=cache.js.map