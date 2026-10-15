import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEmitter, createMetricsRecorder, runAgent, } from "../src/sdk/index.js";
describe("createMetricsRecorder — per-depth tally (G3a)", () => {
    it("start resets latency baseline + counters", () => {
        const r = createMetricsRecorder();
        r.start(0, -1);
        r.incrToolCalls();
        r.incrToolCalls();
        r.addCost(0.01);
        const s1 = r.snapshot();
        assert.equal(s1.depth, 0);
        assert.equal(s1.parentDepth, -1);
        assert.equal(s1.toolCalls, 2);
        assert.equal(s1.costUsd, 0.01);
        // Second iteration — start() should reset.
        r.start(1, 0);
        const s2 = r.snapshot();
        assert.equal(s2.depth, 1);
        assert.equal(s2.parentDepth, 0);
        assert.equal(s2.toolCalls, 0);
        assert.equal(s2.costUsd, undefined);
    });
    it("addTokens accumulates + preserves cached when supplied", () => {
        const r = createMetricsRecorder();
        r.start(0, -1);
        r.addTokens(100, 50);
        r.addTokens(10, 5, 8);
        const s = r.snapshot();
        assert.deepEqual(s.tokens, { input: 110, output: 55, cached: 8 });
    });
    it("clamps cacheHitRatio to [0, 1]", () => {
        const r = createMetricsRecorder();
        r.start(0, -1);
        r.setCacheHitRatio(-0.3);
        assert.equal(r.snapshot().cacheHitRatio, 0);
        r.setCacheHitRatio(1.4);
        assert.equal(r.snapshot().cacheHitRatio, 1);
        r.setCacheHitRatio(0.7);
        assert.equal(r.snapshot().cacheHitRatio, 0.7);
    });
    it("ignores non-finite numbers silently", () => {
        const r = createMetricsRecorder();
        r.start(0, -1);
        r.addCost(Number.NaN);
        r.setCacheHitRatio(Number.POSITIVE_INFINITY);
        const s = r.snapshot();
        assert.equal(s.costUsd, undefined);
        assert.equal(s.cacheHitRatio, undefined);
    });
    it("snapshot returns a fresh object each call", () => {
        const r = createMetricsRecorder();
        r.start(0, -1);
        const a = r.snapshot();
        const b = r.snapshot();
        assert.notEqual(a, b);
        assert.deepEqual(a, b);
    });
});
describe("runAgent — emits IterationOutput.metrics (G3a)", () => {
    async function drain(stream) {
        const out = [];
        for await (const ev of stream)
            out.push(ev);
        return out;
    }
    it("default run attaches depth / parentDepth / latencyMs / toolCalls", async () => {
        const driver = async function* () {
            yield { kind: "emit_done", payload: { ok: true } };
        };
        const events = await drain(runAgent({
            agentId: "m",
            sessionId: "s",
            input: "go",
            driver,
        }));
        const out = events.find((e) => e.type === "IterationOutput");
        assert.ok(out);
        assert.ok(out?.metrics);
        assert.equal(out?.metrics?.depth, 0);
        assert.equal(out?.metrics?.parentDepth, -1);
        assert.equal(typeof out?.metrics?.latencyMs, "number");
        assert.equal(out?.metrics?.toolCalls, 0);
    });
    it("depth / parentDepth from config propagate to the metrics snapshot", async () => {
        const driver = async function* () {
            yield { kind: "emit_done", payload: {} };
        };
        const events = await drain(runAgent({
            agentId: "m",
            sessionId: "s",
            input: "go",
            driver,
            depth: 2,
            parentDepth: 1,
        }));
        const out = events.find((e) => e.type === "IterationOutput");
        assert.equal(out?.metrics?.depth, 2);
        assert.equal(out?.metrics?.parentDepth, 1);
    });
    it("toolCalls counter increments with tool_call steps (incl. denies)", async () => {
        const driver = async function* () {
            yield { kind: "tool_call", tool: "a", args: {} };
            yield { kind: "tool_call", tool: "b", args: {} };
            yield { kind: "emit_done", payload: {} };
        };
        const events = await drain(runAgent({
            agentId: "m",
            sessionId: "s",
            input: "go",
            driver,
            // Deny "a", allow "b" — both still increment the counter.
            permissionHooks: [
                (ctx) => (ctx.tool === "a"
                    ? { decision: "deny", reason: "nope" }
                    : { decision: "allow" }),
            ],
            toolResolver: async () => null,
        }));
        const out = events.find((e) => e.type === "IterationOutput");
        assert.equal(out?.metrics?.toolCalls, 2);
    });
    it("custom recorder can inject consumer-supplied cost + tokens", async () => {
        const rec = createMetricsRecorder();
        const driver = async function* () {
            rec.addCost(0.0005);
            rec.addTokens(42, 11);
            yield { kind: "emit_done", payload: {} };
        };
        const events = await drain(runAgent({
            agentId: "m",
            sessionId: "s",
            input: "go",
            driver,
            metricsRecorder: rec,
        }));
        const out = events.find((e) => e.type === "IterationOutput");
        assert.equal(out?.metrics?.costUsd, 0.0005);
        assert.deepEqual(out?.metrics?.tokens, { input: 42, output: 11 });
    });
});
// Silence unused-var warning for the imported createEmitter — it's re-exported
// so this file also exercises the public index surface.
void createEmitter;
//# sourceMappingURL=sdk-metrics.test.js.map