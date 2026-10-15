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
/** Absolute max number of validate attempts. Fail on the 2nd. */
export const MAX_VALIDATE_ATTEMPTS = 2;
/**
 * Extract the first JSON schema fenced block from a `VALIDATE.md`
 * markdown file. Accepts ```json, ```jsonc, and bare ``` fences.
 * Returns `null` when no block is present or the block is not valid
 * JSON — the caller decides whether that is fatal or abstains.
 */
export function parseValidateMd(markdown) {
    const fence = /```(?:json[cC]?|jsonc)?\s*\n([\s\S]*?)```|```\s*\n([\s\S]*?)```/m;
    const match = fence.exec(markdown);
    if (!match)
        return { schema: null, rawBlock: null };
    const body = (match[1] ?? match[2] ?? "").trim();
    if (body.length === 0)
        return { schema: null, rawBlock: null };
    try {
        const parsed = JSON.parse(body);
        if (!parsed || typeof parsed !== "object") {
            return { schema: null, rawBlock: body };
        }
        return { schema: parsed, rawBlock: body };
    }
    catch {
        return { schema: null, rawBlock: body };
    }
}
function describePath(path) {
    if (path.length === 0)
        return "<root>";
    return path
        .map((p) => (typeof p === "number" ? `[${p}]` : `.${p}`))
        .join("")
        .replace(/^\./, "");
}
function typeOfValue(value) {
    if (value === null)
        return "null";
    if (Array.isArray(value))
        return "array";
    if (Number.isInteger(value))
        return "integer";
    return typeof value;
}
function checkType(expected, actual) {
    if (expected === "number")
        return actual === "integer" || actual === "number";
    return expected === actual;
}
/**
 * Recursively check `value` against `schema`. Accumulates errors
 * instead of throwing — callers want the full list for retry-hint
 * synthesis, not just the first failure.
 */
export function validateAgainstSchema(value, schema, schemaSource) {
    const errors = [];
    function walk(v, s, path) {
        const where = describePath(path);
        if (s.type) {
            const actual = typeOfValue(v);
            if (!checkType(s.type, actual)) {
                errors.push(`${where}: expected ${s.type}, got ${actual}`);
                return; // type mismatch — don't descend
            }
        }
        if (s.enum && !s.enum.some((opt) => Object.is(opt, v))) {
            errors.push(`${where}: value not in enum (${s.enum.join(", ")})`);
        }
        if (s.type === "object" && v && typeof v === "object" && !Array.isArray(v)) {
            const obj = v;
            if (s.required) {
                for (const key of s.required) {
                    if (!(key in obj))
                        errors.push(`${where}: missing required "${key}"`);
                }
            }
            if (s.properties) {
                for (const [key, childSchema] of Object.entries(s.properties)) {
                    if (key in obj) {
                        walk(obj[key], childSchema, [...path, key]);
                    }
                }
            }
        }
        if (s.type === "array" && Array.isArray(v) && s.items) {
            v.forEach((item, idx) => walk(item, s.items, [...path, idx]));
        }
    }
    walk(value, schema, []);
    return { ok: errors.length === 0, errors, schemaSource };
}
/**
 * Retry policy. The SDK calls this after each failed validate to
 * decide whether to prepend the schema hint and loop once more, or
 * surface the terminal failure. First failure (attempt 1) → retry.
 * Second failure (attempt 2) → stop.
 */
export function shouldRetry(result, attempt) {
    if (result.ok)
        return false;
    return attempt < MAX_VALIDATE_ATTEMPTS;
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
export const RETRY_HINT_FINAL = {
    lead: "Your previous FINAL answer did not match VALIDATE.md:",
    reemit: "Re-emit the corrected payload as `FINAL(<compact single-line JSON>)` — the whole JSON on one line, with no prose and no code fence around it. If the payload lives in a REPL variable, make that variable a `json.dumps(...)` string before calling `FINAL_VAR(name)`.",
};
/**
 * Build the retry hint prepended to the next iteration's user turn
 * when validation fails. Keeps the language stable so the LLM learns
 * the shape over repeated runs.
 *
 * `surface` is optional and additive: omitted, the output is byte-identical
 * to what the SDK's `emit_done` pipeline has always produced (pinned by
 * `tests/sdk-validate.test.ts`).
 */
export function buildRetryHint(result, surface) {
    if (result.ok)
        return "";
    const lines = [];
    lines.push(surface?.lead ??
        "Your previous `emit_done` payload did not match VALIDATE.md:");
    for (const err of result.errors)
        lines.push(`  - ${err}`);
    if (result.schemaSource) {
        lines.push("");
        lines.push("Schema (JSON):");
        lines.push(result.schemaSource);
    }
    lines.push("");
    lines.push(surface?.reemit ?? "Emit a corrected payload.");
    return lines.join("\n");
}
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
export function buildOutputSchemaSection(rawBlock) {
    return [
        "## Output Schema",
        "",
        "Your FINAL answer MUST be a single JSON value matching this schema:",
        "",
        "```json",
        rawBlock,
        "```",
        "",
        "Deliver it in exactly one of these two forms — nothing else is read back:",
        "",
        '1. `FINAL(<compact single-line JSON>)` — the whole payload on ONE line, e.g. `FINAL({"verdict": "pass", "notes": []})`. The FINAL parser is line-based, so a pretty-printed payload is lost.',
        '2. `FINAL_VAR(name)`, where `name` is a REPL variable holding a JSON **string** built with `json.dumps(...)` — e.g. `payload = json.dumps({"verdict": "pass"})` inside a ```repl``` block, then `FINAL_VAR(payload)` in a separate later step.',
        "",
        "Never hand `FINAL_VAR` a bare Python dict: its `str()` repr uses single quotes and is not valid JSON. Do not wrap the payload in a markdown code fence, and do not put prose around it.",
    ].join("\n");
}
//# sourceMappingURL=validate.js.map