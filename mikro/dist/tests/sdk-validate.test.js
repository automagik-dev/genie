import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_VALIDATE_ATTEMPTS, buildRetryHint, parseValidateMd, shouldRetry, validateAgainstSchema, } from "../src/sdk/index.js";
// Not re-exported from the SDK barrel: the FINAL surface belongs to the core
// loop, not to the SDK's public API. `buildRetryHint` itself is re-exported
// there and simply gained an optional second parameter.
import { RETRY_HINT_FINAL } from "../src/sdk/validate.js";
describe("SDK validate — schema check (Wish B Group 2)", () => {
    it("validateAgainstSchema passes a matching object", () => {
        const schema = {
            type: "object",
            required: ["answer"],
            properties: { answer: { type: "string" } },
        };
        const result = validateAgainstSchema({ answer: "42" }, schema);
        assert.equal(result.ok, true);
        assert.deepEqual([...result.errors], []);
    });
    it("flags wrong root type", () => {
        const schema = { type: "object" };
        const result = validateAgainstSchema([], schema);
        assert.equal(result.ok, false);
        assert.match(result.errors[0] ?? "", /expected object, got array/);
    });
    it("flags missing required fields", () => {
        const schema = {
            type: "object",
            required: ["a", "b"],
            properties: { a: { type: "string" }, b: { type: "number" } },
        };
        const result = validateAgainstSchema({ a: "x" }, schema);
        assert.equal(result.ok, false);
        assert.ok(result.errors.some((e) => /missing required "b"/.test(e)));
    });
    it("descends into nested object properties", () => {
        const schema = {
            type: "object",
            properties: {
                meta: {
                    type: "object",
                    required: ["id"],
                    properties: { id: { type: "string" } },
                },
            },
        };
        const result = validateAgainstSchema({ meta: {} }, schema);
        assert.equal(result.ok, false);
        assert.ok(result.errors.some((e) => /meta: missing required "id"/.test(e)));
    });
    it("checks array items against items schema", () => {
        const schema = {
            type: "array",
            items: { type: "string" },
        };
        const result = validateAgainstSchema(["ok", 123, "ok"], schema);
        assert.equal(result.ok, false);
        assert.ok(result.errors.some((e) => /\[1\]: expected string/.test(e)));
    });
    it("treats `number` as accepting integer OR number", () => {
        const schema = { type: "number" };
        assert.equal(validateAgainstSchema(3, schema).ok, true);
        assert.equal(validateAgainstSchema(3.14, schema).ok, true);
        assert.equal(validateAgainstSchema("3", schema).ok, false);
    });
    it("enforces integer strictly", () => {
        const schema = { type: "integer" };
        assert.equal(validateAgainstSchema(3, schema).ok, true);
        assert.equal(validateAgainstSchema(3.14, schema).ok, false);
    });
    it("checks enum membership", () => {
        const schema = { type: "string", enum: ["a", "b"] };
        assert.equal(validateAgainstSchema("a", schema).ok, true);
        const fail = validateAgainstSchema("z", schema);
        assert.equal(fail.ok, false);
        assert.ok(fail.errors.some((e) => /not in enum/.test(e)));
    });
});
describe("parseValidateMd — VALIDATE.md loader", () => {
    it("extracts a ```json fenced schema block", () => {
        const md = 'Schema below:\n\n```json\n{ "type": "object", "required": ["ok"] }\n```\n';
        const { schema, rawBlock } = parseValidateMd(md);
        assert.ok(schema);
        assert.equal(schema?.type, "object");
        assert.deepEqual([...(schema?.required ?? [])], ["ok"]);
        assert.ok(rawBlock && rawBlock.includes('"type": "object"'));
    });
    it("also accepts bare ``` fences", () => {
        const md = '```\n{"type":"string"}\n```';
        const { schema } = parseValidateMd(md);
        assert.equal(schema?.type, "string");
    });
    it("returns null schema when no fence is present", () => {
        const { schema, rawBlock } = parseValidateMd("no fence here");
        assert.equal(schema, null);
        assert.equal(rawBlock, null);
    });
    it("returns null schema when body isn't valid JSON but keeps raw block", () => {
        const md = "```json\nnot json\n```";
        const { schema, rawBlock } = parseValidateMd(md);
        assert.equal(schema, null);
        assert.ok(rawBlock?.includes("not json"));
    });
});
describe("shouldRetry + buildRetryHint — WISH.md G2 criterion 3", () => {
    it("passes do not retry", () => {
        assert.equal(shouldRetry({ ok: true, errors: [] }, 1), false);
    });
    it("first failure retries (attempt 1 → retry)", () => {
        assert.equal(shouldRetry({ ok: false, errors: ["boom"] }, 1), true);
    });
    it("second failure does not retry (attempt 2 → stop)", () => {
        assert.equal(shouldRetry({ ok: false, errors: ["boom"] }, MAX_VALIDATE_ATTEMPTS), false);
    });
    it("buildRetryHint returns empty for passes", () => {
        assert.equal(buildRetryHint({ ok: true, errors: [] }), "");
    });
    it("buildRetryHint includes every error + schema snippet", () => {
        const result = {
            ok: false,
            errors: ["<root>: expected object, got array", "missing required x"],
            schemaSource: '{ "type": "object" }',
        };
        const hint = buildRetryHint(result);
        assert.match(hint, /did not match VALIDATE\.md/);
        for (const e of result.errors)
            assert.ok(hint.includes(e));
        assert.ok(hint.includes('"type": "object"'));
        assert.match(hint, /Emit a corrected payload/);
    });
    it("MAX_VALIDATE_ATTEMPTS is 2 per spec", () => {
        assert.equal(MAX_VALIDATE_ATTEMPTS, 2);
    });
});
/**
 * The FINAL text protocol (`rlmLoop`) reuses the same hint builder as the
 * SDK's `emit_done` tool. Only the opening line and the re-emit instruction
 * are surface-specific; everything else — the error list, the quoted schema —
 * is shared, and the default output stays byte-identical (pinned above).
 */
describe("buildRetryHint — FINAL surface variant", () => {
    const failure = {
        ok: false,
        errors: ['verdict: value not in enum (pass, fail)'],
        schemaSource: '{ "type": "object", "required": ["verdict"] }',
    };
    it("omitting the surface leaves the emit_done output byte-identical", () => {
        assert.equal(buildRetryHint(failure), buildRetryHint(failure, undefined));
        assert.ok(buildRetryHint(failure).includes("`emit_done` payload"));
        assert.ok(buildRetryHint(failure).endsWith("Emit a corrected payload."));
    });
    it("names FINAL, never emit_done", () => {
        const hint = buildRetryHint(failure, RETRY_HINT_FINAL);
        assert.match(hint, /^Your previous FINAL answer did not match VALIDATE\.md:/);
        assert.ok(!hint.includes("emit_done"));
    });
    it("closes with the compact single-line FINAL re-emit instruction", () => {
        const hint = buildRetryHint(failure, RETRY_HINT_FINAL);
        assert.ok(hint.includes("FINAL(<compact single-line JSON>)"));
        assert.ok(hint.includes("json.dumps"));
        assert.ok(hint.includes("FINAL_VAR(name)"));
    });
    it("carries the shape errors and the schema, and nothing else", () => {
        const hint = buildRetryHint(failure, RETRY_HINT_FINAL);
        for (const e of failure.errors)
            assert.ok(hint.includes(e));
        assert.ok(hint.includes(failure.schemaSource));
        // The hint is shape-only by contract: no fixture, example answer, or
        // guidance about what the payload should *say*.
        for (const forbidden of ["example", "for instance", "fixture", "should say"]) {
            assert.ok(!hint.toLowerCase().includes(forbidden), `hint drifted into content guidance: ${forbidden}`);
        }
    });
    it("still returns empty for a pass, whatever the surface", () => {
        assert.equal(buildRetryHint({ ok: true, errors: [] }, RETRY_HINT_FINAL), "");
    });
});
//# sourceMappingURL=sdk-validate.test.js.map