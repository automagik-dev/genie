import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPiOptions } from "../src/llm.js";
/**
 * The last leg of the temperature knob: `MikroConfig.temperature` →
 * `llmComplete({ temperature })` → the `temperature` key on the pi-ai options
 * object handed to `models.completeSimple`.
 *
 * `buildPiOptions` is the assertable seam — the exact object pi-ai receives,
 * minus the payload hooks, without a network call. Two properties matter and
 * neither is visible from a response body:
 *
 *  1. A pinned `0` arrives as `0`. Every guard between here and the yaml is
 *     written `!= null` precisely so greedy decoding survives; a truthiness
 *     check anywhere on the path degrades silently to "provider default".
 *  2. An unset temperature leaves **no key at all**. Not `undefined`, not
 *     `null` — absent. Some providers serialize a present-but-undefined key,
 *     and `null` goes on the wire as a value, so "absent knob ⇒ byte-for-byte
 *     the options object we sent before this feature existed" only holds if the
 *     assignment is conditional.
 */
describe("buildPiOptions — temperature", () => {
    it("forwards an exact zero as 0", () => {
        const opts = buildPiOptions({ temperature: 0 });
        assert.equal(opts.temperature, 0);
        assert.ok(Object.hasOwn(opts, "temperature"), "a pinned 0 must reach pi-ai as a present key");
    });
    it("forwards ordinary and boundary values unchanged", () => {
        assert.equal(buildPiOptions({ temperature: 0.7 }).temperature, 0.7);
        assert.equal(buildPiOptions({ temperature: 1 }).temperature, 1);
        assert.equal(buildPiOptions({ temperature: 2 }).temperature, 2);
    });
    it("omits the key entirely when temperature is undefined", () => {
        const opts = buildPiOptions({ maxTokens: 4096 });
        assert.equal(Object.hasOwn(opts, "temperature"), false, "an unset temperature must not appear on the options object");
    });
    it("omits the key entirely when temperature is null", () => {
        // `MikroConfig.temperature` is nullable and is passed through verbatim, so
        // null is the shape the root loop actually hands over for an unset knob.
        const opts = buildPiOptions({ temperature: null });
        assert.equal(Object.hasOwn(opts, "temperature"), false);
    });
    it("omits the key when no options are passed at all", () => {
        assert.equal(Object.hasOwn(buildPiOptions(), "temperature"), false);
        assert.equal(Object.hasOwn(buildPiOptions(undefined), "temperature"), false);
    });
    /**
     * Regression pin for the acceptance criterion "absent knob ⇒ byte-for-byte
     * today's options object". Enumerating the keys is the assertion: adding a
     * sampling knob must not have added anything to an un-pinned call.
     */
    it("leaves an un-pinned call's option keys exactly as they were", () => {
        assert.deepEqual(Object.keys(buildPiOptions()).sort(), ["maxTokens", "signal"]);
        assert.deepEqual(Object.keys(buildPiOptions({ thinkingLevel: "low" })).sort(), ["maxTokens", "reasoning", "signal"]);
    });
    it("carries temperature alongside the other options rather than replacing them", () => {
        const signal = new AbortController().signal;
        const opts = buildPiOptions({
            temperature: 0,
            thinkingLevel: "high",
            maxTokens: 2048,
            signal,
            cacheConfig: { enabled: true, retention: "long", sessionId: "s1" },
        });
        assert.equal(opts.temperature, 0);
        assert.equal(opts.reasoning, "high");
        assert.equal(opts.maxTokens, 2048);
        assert.equal(opts.signal, signal);
        assert.equal(opts.cacheRetention, "long");
        assert.equal(opts.sessionId, "s1");
    });
});
/**
 * `thinkingLevel` keeps its own truthiness guard on purpose — its levels are
 * strings and it has no falsy-but-meaningful value — so these pin that the
 * temperature work did not disturb it.
 */
describe("buildPiOptions — unchanged behaviour", () => {
    it("defaults maxTokens to 16384", () => {
        assert.equal(buildPiOptions().maxTokens, 16384);
    });
    it("omits cache options when the cache is disabled", () => {
        const opts = buildPiOptions({
            cacheConfig: { enabled: false, retention: "long", sessionId: "s1" },
        });
        assert.equal(Object.hasOwn(opts, "cacheRetention"), false);
        assert.equal(Object.hasOwn(opts, "sessionId"), false);
    });
    it("omits reasoning when no thinking level is given", () => {
        assert.equal(Object.hasOwn(buildPiOptions({ thinkingLevel: null }), "reasoning"), false);
    });
});
// ─── Call-site adoption (source-level) ────────────────────
/**
 * The plumbing contract, pinned at the source.
 *
 * `rlmLoop` has no injection seam for the LLM — the two `llmComplete()` calls
 * that make up the root loop (the per-iteration call and the forced-final
 * call) cannot be driven from a test, so nothing above `buildPiOptions` would
 * notice if a call site simply stopped passing `temperature`. The knob would
 * still parse, still validate, still reach `config.temperature`, and still be
 * dropped silently one line before it mattered.
 *
 * So this is a tripwire on the text of `src/rlm.ts`: every root-loop
 * `llmComplete()` option bag that pins the *other* per-call sampling knob
 * (`thinkingLevel`) must pin `temperature` too. The two travel together by
 * design — both are read off the ambient config, both apply to the root loop's
 * own calls and deliberately not to `llm_query()` sub-calls or recursive
 * children — so `thinkingLevel:` is the marker for "this is a root-loop call
 * that must carry the sampling config".
 *
 * Resolved from `dist/tests/` at run time, so `../../` is the repo root.
 */
describe("rlm.ts llmComplete() call-site adoption", () => {
    const source = readFileSync(new URL("../../src/rlm.ts", import.meta.url), "utf8")
        // Strip comments so prose naming these fields is not counted. Both call
        // sites carry an explanatory comment mentioning `temperature`.
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
    /** The argument text of every `llmComplete(...)` call, paren-balanced. */
    const callArgs = [];
    for (const match of source.matchAll(/(?<![\w$.])llmComplete\(/g)) {
        let depth = 1;
        let i = match.index + match[0].length;
        const start = i;
        while (i < source.length && depth > 0) {
            const ch = source[i];
            if (ch === "(")
                depth += 1;
            else if (ch === ")")
                depth -= 1;
            i += 1;
        }
        callArgs.push(source.slice(start, i - 1));
    }
    it("finds both root-loop llmComplete() call sites", () => {
        assert.equal(callArgs.length, 2, `expected exactly 2 llmComplete() calls in src/rlm.ts (the per-iteration ` +
            `root call and the forced-final call) but found ${callArgs.length}. A new ` +
            `root-loop model call must pass the ambient sampling config the same way; ` +
            `update this count with the reason if the loop legitimately grew one.`);
    });
    it("passes temperature wherever it passes thinkingLevel", () => {
        const withThinking = callArgs.filter((args) => /\bthinkingLevel\s*:/.test(args));
        const withBoth = withThinking.filter((args) => /\btemperature\s*:/.test(args));
        assert.equal(withThinking.length, 2, `expected both root-loop llmComplete() calls to pin thinkingLevel, found ` +
            `${withThinking.length}`);
        assert.equal(withBoth.length, withThinking.length, `every root-loop llmComplete() option bag that passes \`thinkingLevel:\` must ` +
            `also pass \`temperature:\` — ${withThinking.length} call site(s) pin the ` +
            `thinking level but only ${withBoth.length} pin the temperature. The loop has ` +
            `no LLM seam, so a dropped \`temperature:\` here is invisible to every other ` +
            `test: the knob would parse, validate and land on config.temperature, and then ` +
            `never reach pi-ai.`);
    });
    it("passes the ambient config's temperature, not a literal", () => {
        for (const args of callArgs) {
            assert.match(args, /\btemperature\s*:\s*config\.temperature\b/, `a root-loop llmComplete() call must forward \`config.temperature\` verbatim ` +
                `so that null/undefined stay "unset" and a pinned 0 survives; found a ` +
                `different expression in: ${args.slice(0, 200)}`);
        }
    });
});
//# sourceMappingURL=llm-temperature.test.js.map