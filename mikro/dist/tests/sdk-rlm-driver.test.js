import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createUsage } from "../src/llm.js";
import { formatRlmPrompt, rlmDriver, runAgent, } from "../src/sdk/index.js";
const MODEL = {
    provider: "anthropic",
    model: "claude-haiku-4-5",
};
function fakeLLM(text) {
    const seen = { prompts: [] };
    return {
        seen,
        fn: async (prompt) => {
            seen.prompts.push(prompt);
            return { text, usage: createUsage() };
        },
    };
}
function failingLLM(err) {
    return async () => {
        throw err;
    };
}
async function drain(stream) {
    const events = [];
    for await (const ev of stream)
        events.push(ev);
    return events;
}
describe("formatRlmPrompt — prompt synthesis", () => {
    it("includes system prompt when supplied", () => {
        const req = {
            sessionId: "s",
            iteration: 1,
            history: [{ role: "user", content: "hi" }],
        };
        const out = formatRlmPrompt({ model: MODEL, system: "You are a helpful assistant." }, req);
        assert.match(out, /You are a helpful assistant\./);
        assert.match(out, /User: hi/);
    });
    it("omits system block when not supplied", () => {
        const req = {
            sessionId: "s",
            iteration: 1,
            history: [{ role: "user", content: "hi" }],
        };
        const out = formatRlmPrompt({ model: MODEL }, req);
        assert.equal(out, "User: hi");
    });
    it("injects retryHint when runAgent supplied one", () => {
        const req = {
            sessionId: "s",
            iteration: 2,
            history: [{ role: "user", content: "hi" }],
            retryHint: "Your previous emit_done did not match VALIDATE.md: answer missing",
        };
        const out = formatRlmPrompt({ model: MODEL }, req);
        assert.match(out, /Retry hint from the validator/);
        assert.match(out, /VALIDATE\.md/);
    });
    it("folds multi-turn history with role labels", () => {
        const req = {
            sessionId: "s",
            iteration: 3,
            history: [
                { role: "user", content: "step one" },
                { role: "assistant", content: "ok step one done" },
                { role: "user", content: "step two" },
            ],
        };
        const out = formatRlmPrompt({ model: MODEL }, req);
        assert.match(out, /User: step one/);
        assert.match(out, /Assistant: ok step one done/);
        assert.match(out, /User: step two/);
    });
    it("custom retryHintFormatter is honoured", () => {
        const req = {
            sessionId: "s",
            iteration: 2,
            history: [{ role: "user", content: "hi" }],
            retryHint: "bad payload",
        };
        const out = formatRlmPrompt({
            model: MODEL,
            retryHintFormatter: (h) => `!!! ${h} !!!`,
        }, req);
        assert.match(out, /!!! bad payload !!!/);
    });
});
describe("rlmDriver — step shape (hermetic)", () => {
    it("yields message + emit_done for a non-empty response", async () => {
        const { fn } = fakeLLM("The answer is 42.");
        const driver = rlmDriver({ model: MODEL, llm: fn });
        const req = {
            sessionId: "s",
            iteration: 1,
            history: [{ role: "user", content: "what is the answer?" }],
        };
        const ac = new AbortController();
        const steps = [];
        for await (const step of driver(req, ac.signal))
            steps.push(step);
        assert.equal(steps.length, 2);
        assert.equal(steps[0]?.kind, "message");
        assert.equal(steps[0].content, "The answer is 42.");
        assert.equal(steps[1]?.kind, "emit_done");
        const payload = steps[1].payload;
        assert.equal(payload.answer, "The answer is 42.");
    });
    it("yields an error step when the LLM throws", async () => {
        const driver = rlmDriver({
            model: MODEL,
            llm: failingLLM(new Error("provider 429")),
        });
        const req = {
            sessionId: "s",
            iteration: 1,
            history: [{ role: "user", content: "hi" }],
        };
        const ac = new AbortController();
        const steps = [];
        for await (const step of driver(req, ac.signal))
            steps.push(step);
        assert.equal(steps.length, 1);
        assert.equal(steps[0]?.kind, "error");
        assert.equal(steps[0].error.message, "provider 429");
    });
    it("yields an error step when the LLM returns empty text", async () => {
        const { fn } = fakeLLM("   \n  ");
        const driver = rlmDriver({ model: MODEL, llm: fn });
        const req = {
            sessionId: "s",
            iteration: 1,
            history: [{ role: "user", content: "hi" }],
        };
        const steps = [];
        for await (const step of driver(req, new AbortController().signal)) {
            steps.push(step);
        }
        assert.equal(steps.length, 1);
        assert.equal(steps[0]?.kind, "error");
        assert.match(steps[0].error.message, /empty response/);
    });
});
describe("rlmDriver + runAgent — full wiring (hermetic)", () => {
    it("drives runAgent to a clean complete with event flow", async () => {
        const { fn, seen } = fakeLLM("42");
        const driver = rlmDriver({
            model: MODEL,
            system: "Return just a number.",
            llm: fn,
        });
        const events = await drain(runAgent({
            agentId: "test",
            sessionId: "s-rlm-smoke",
            input: "what is the answer?",
            driver,
            maxIterations: 3,
        }));
        const types = events.map((e) => e.type);
        assert.equal(types[0], "AgentStart");
        assert.ok(types.includes("IterationStart"));
        assert.ok(types.includes("Message"));
        assert.ok(types.includes("EmitDone"));
        assert.equal(types[types.length - 1], "SessionClose");
        const close = events.find((e) => e.type === "SessionClose");
        assert.equal(close?.reason, "complete");
        // The LLM was called once and saw the system+user composition.
        assert.equal(seen.prompts.length, 1);
        assert.match(seen.prompts[0] ?? "", /Return just a number\./);
        assert.match(seen.prompts[0] ?? "", /User: what is the answer\?/);
    });
    it("surfaces driver errors as Error{phase:driver} + SessionClose{error}", async () => {
        const driver = rlmDriver({
            model: MODEL,
            llm: failingLLM(new Error("network down")),
        });
        const events = await drain(runAgent({
            agentId: "test",
            sessionId: "s-rlm-err",
            input: "hi",
            driver,
            maxIterations: 1,
        }));
        const err = events.find((e) => e.type === "Error" &&
            e.phase === "driver");
        assert.ok(err);
        assert.match((err.error.message ?? "").toString(), /network down/);
        const close = events.find((e) => e.type === "SessionClose");
        assert.equal(close?.reason, "error");
    });
    it("retryHint from validate reaches the next prompt", async () => {
        // First call returns a payload missing `answer`; second call returns
        // one that passes. The driver must surface the retryHint from
        // runAgent's validate pipeline into the second LLM prompt.
        const prompts = [];
        let callCount = 0;
        const llm = async (p) => {
            prompts.push(p);
            callCount++;
            // Shape the response so `emit_done { answer: <text> }` matches the
            // schema. First iteration returns an empty-sounding response that
            // will FAIL the validate (answer too short); second wins.
            return { text: callCount === 1 ? "no" : "yes", usage: createUsage() };
        };
        const driver = rlmDriver({ model: MODEL, llm });
        const events = await drain(runAgent({
            agentId: "test",
            sessionId: "s-retry",
            input: "hi",
            driver,
            validateSchema: {
                type: "object",
                required: ["answer"],
                properties: {
                    answer: { type: "string", enum: ["yes", "maybe"] },
                },
            },
            validateSchemaSource: "{enum:[yes,maybe]}",
            maxIterations: 3,
        }));
        const validations = events.filter((e) => e.type === "Validation");
        assert.equal(validations[0]?.status, "fail");
        assert.equal(validations[1]?.status, "pass");
        assert.equal(prompts.length, 2);
        assert.match(prompts[1] ?? "", /Retry hint from the validator/);
    });
});
// ─── Smoke test — skipped unless GEMINI_API_KEY is set ────────────
// CI keeps hermetic. Operators can run it locally with a key to
// exercise the live-LLM path end-to-end.
const LIVE_API_KEY = process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.ANTHROPIC_API_KEY;
describe("rlmDriver + runAgent — LIVE LLM smoke (skip when no API key)", { skip: !LIVE_API_KEY }, () => {
    it("completes a one-shot run against a real model (<= 10s, tiny budget)", async () => {
        // Prefer Gemini if available (default for mikro); else Anthropic.
        const provider = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
            ? "google"
            : "anthropic";
        const model = provider === "google"
            ? "gemini-2.5-flash"
            : "claude-haiku-4-5";
        const driver = rlmDriver({
            model: { provider, model },
            system: "You are a terse calculator. Respond with ONLY a single number, no words.",
        });
        const events = await drain(runAgent({
            agentId: "live-smoke",
            sessionId: `live-${Date.now()}`,
            input: "What is 17 + 25?",
            driver,
            maxIterations: 1,
        }));
        const types = events.map((e) => e.type);
        // Every run must bracket with AgentStart + SessionClose.
        assert.equal(types[0], "AgentStart");
        assert.equal(types[types.length - 1], "SessionClose");
        // A real LLM SHOULD respond; if the API flaked, surface that
        // explicitly — we'd rather see a red test than a silent skip.
        const close = events.find((e) => e.type === "SessionClose");
        if (close?.reason === "error") {
            const err = events.find((e) => e.type === "Error");
            assert.fail(`live smoke failed: ${err?.error?.message ?? "<no error event>"}`);
        }
        assert.equal(close?.reason, "complete");
        const emitDone = events.find((e) => e.type === "EmitDone");
        assert.ok(emitDone, "EmitDone event must fire for a completed run");
        assert.ok(emitDone?.payload?.answer && emitDone.payload.answer.length > 0, "live LLM must produce a non-empty answer");
    });
});
//# sourceMappingURL=sdk-rlm-driver.test.js.map