/**
 * Validate primitive — Wish B Group 2.
 *
 * `emit_done` payloads are schema-checked against a `VALIDATE.md` file
 * living next to the agent definition. On failure, the SDK retries
 * once with the schema + error hint prepended to the next iteration's
 * prompt. A second failure is terminal and surfaces as a
 * `Validation { status: "fail", attempt: 2 }` event.
 *
 * This module ships the PURE pieces: VALIDATE.md parsing + JSON schema
 * check + retry-hint synthesis + retry policy + the schema-disclosure
 * section both prompt builders append. Wiring into the loop's emit_done
 * pipeline arrives with `runAgent()` (Group 2b / 3); the FINAL surface
 * (`rlmLoop`, `src/rlm.ts`) consumes the same primitives through
 * `RETRY_HINT_FINAL` and `buildOutputSchemaSection`.
 *
 * The schema implementation is a deliberately small JSON-Schema subset
 * — enough for Wish A/B agents (`type: object`, `properties`,
 * `required`, primitive `type`s, `items`). If a richer schema lands,
 * swap the checker for `ajv` without touching call sites.
 *
 * Spec: `.genie/wishes/rlmx-sdk-upgrade/WISH.md` L25, L142, L149.
 */
/** Minimal JSON-Schema subset we interpret. */
export interface ValidateSchema {
    readonly type?: "object" | "string" | "number" | "integer" | "boolean" | "array" | "null";
    readonly properties?: Readonly<Record<string, ValidateSchema>>;
    readonly required?: readonly string[];
    readonly items?: ValidateSchema;
    readonly enum?: readonly unknown[];
    readonly description?: string;
}
export interface ValidateResult {
    readonly ok: boolean;
    readonly errors: readonly string[];
    /** Original schema markdown snippet, used to build retry hints. */
    readonly schemaSource?: string;
}
/** Absolute max number of validate attempts. Fail on the 2nd. */
export declare const MAX_VALIDATE_ATTEMPTS = 2;
/**
 * Extract the first JSON schema fenced block from a `VALIDATE.md`
 * markdown file. Accepts ```json, ```jsonc, and bare ``` fences.
 * Returns `null` when no block is present or the block is not valid
 * JSON — the caller decides whether that is fatal or abstains.
 */
export declare function parseValidateMd(markdown: string): {
    schema: ValidateSchema | null;
    rawBlock: string | null;
};
/**
 * Recursively check `value` against `schema`. Accumulates errors
 * instead of throwing — callers want the full list for retry-hint
 * synthesis, not just the first failure.
 */
export declare function validateAgainstSchema(value: unknown, schema: ValidateSchema, schemaSource?: string): ValidateResult;
/**
 * Retry policy. The SDK calls this after each failed validate to
 * decide whether to prepend the schema hint and loop once more, or
 * surface the terminal failure. First failure (attempt 1) → retry.
 * Second failure (attempt 2) → stop.
 */
export declare function shouldRetry(result: ValidateResult, attempt: number): boolean;
/**
 * The two surface-specific lines of a retry hint.
 *
 * Everything else in the hint — the error list and the quoted schema — is
 * identical whatever emitted the bad payload. Only the opening line (which
 * names *what* the model emitted) and the closing instruction (which says
 * *how* to emit it again) differ between the SDK's `emit_done` tool and the
 * core loop's `FINAL()` text protocol.
 *
 * Deliberately only these two: the hint stays shape-only, so a surface may
 * restate the *idiom* but never the content it should have produced.
 */
export interface RetryHintSurface {
    /** Opening line naming the surface whose payload failed. */
    readonly lead: string;
    /** Closing line telling the model how to emit the correction. */
    readonly reemit: string;
}
/**
 * The `FINAL()` text-protocol variant, used by `rlmLoop` (`src/rlm.ts`).
 *
 * The re-emit line repeats the single-line constraint on purpose: the FINAL
 * parser is line-based (`FINAL_REGEX`, `src/parser.ts`), so a pretty-printed
 * payload is silently truncated, and `FINAL_VAR` of a bare Python dict yields
 * a single-quoted `str()` repr that is not JSON. Both are shape facts about
 * the channel, not hints about the answer.
 */
export declare const RETRY_HINT_FINAL: RetryHintSurface;
/**
 * Build the retry hint prepended to the next iteration's user turn
 * when validation fails. Keeps the language stable so the LLM learns
 * the shape over repeated runs.
 *
 * `surface` is optional and additive: omitted, the output is byte-identical
 * to what the SDK's `emit_done` pipeline has always produced (pinned by
 * `tests/sdk-validate.test.ts`).
 */
export declare function buildRetryHint(result: ValidateResult, surface?: RetryHintSurface): string;
/**
 * The "Output Schema" section both prompt builders append when the pack
 * ships a readable `VALIDATE.md`.
 *
 * Disclosure is not a nicety: without it a pack that never hand-edited its
 * SYSTEM.md would burn both validate attempts every run, because nothing
 * tells the model that its prose FINAL is being schema-checked — nor that
 * the two idioms below are the only ones the FINAL channel reads back.
 *
 * Written as an array of double-quoted lines rather than a template literal
 * so the markdown fences and the inline code spans need no escaping.
 */
export declare function buildOutputSchemaSection(rawBlock: string): string;
//# sourceMappingURL=validate.d.ts.map