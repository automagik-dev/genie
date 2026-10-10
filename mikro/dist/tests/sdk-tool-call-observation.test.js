import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolRegistry, runAgent, } from "../src/sdk/index.js";
async function drain(stream) {
    const events = [];
    for await (const ev of stream)
        events.push(ev);
    return events;
}
describe("IterationStep tool_call_observation — observe-vs-dispatch (L2a)", () => {
    it("emits ToolCallObservation event for an observation step", async () => {
        const driver = async function* () {
            yield {
                kind: "tool_call_observation",
                tool: "external_tool",
                args: { q: "?" },
                status: "completed",
                result: { ok: true },
                durationMs: 42,
            };
            yield { kind: "emit_done", payload: {} };
        };
        const events = await drain(runAgent({
            agentId: "obs",
            sessionId: "s-obs",
            input: "test",
            driver,
            maxIterations: 1,
        }));
        const obs = events.find((e) => e.type === "ToolCallObservation");
        assert.ok(obs, "expected ToolCallObservation event");
        assert.equal(obs?.tool, "external_tool");
        assert.equal(obs?.status, "completed");
        assert.deepEqual(obs?.result, { ok: true });
        assert.equal(obs?.durationMs, 42);
    });
    it("does NOT emit ToolCallBefore/After for an observation (no SDK dispatch)", async () => {
        const driver = async function* () {
            yield {
                kind: "tool_call_observation",
                tool: "external_tool",
                args: {},
                status: "completed",
            };
            yield { kind: "emit_done", payload: {} };
        };
        const events = await drain(runAgent({
            agentId: "obs-no-dispatch",
            sessionId: "s",
            input: "test",
            driver,
            maxIterations: 1,
        }));
        assert.equal(events.some((e) => e.type === "ToolCallBefore"), false, "observations must not produce ToolCallBefore");
        assert.equal(events.some((e) => e.type === "ToolCallAfter"), false, "observations must not produce ToolCallAfter");
    });
    it("does NOT call the tool registry for an observation (guard check)", async () => {
        const calls = [];
        const registry = createToolRegistry();
        const handler = async (args) => {
            calls.push(JSON.stringify(args));
            return "from-registry";
        };
        registry.register("external_tool", handler);
        const driver = async function* () {
            yield {
                kind: "tool_call_observation",
                tool: "external_tool",
                args: { q: "x" },
                status: "completed",
                result: "from-driver",
            };
            yield { kind: "emit_done", payload: {} };
        };
        await drain(runAgent({
            agentId: "obs-no-reg",
            sessionId: "s",
            input: "test",
            driver,
            toolRegistry: registry,
            maxIterations: 1,
        }));
        assert.deepEqual(calls, [], "registry handler must not fire for observations");
    });
    it("does NOT invoke the permission chain for an observation (guard check)", async () => {
        let permissionCalls = 0;
        const hook = () => {
            permissionCalls++;
            return { decision: "deny", reason: "should not be asked" };
        };
        const driver = async function* () {
            yield {
                kind: "tool_call_observation",
                tool: "external_tool",
                args: {},
                status: "completed",
            };
            yield { kind: "emit_done", payload: {} };
        };
        await drain(runAgent({
            agentId: "obs-no-perm",
            sessionId: "s",
            input: "test",
            driver,
            permissionHooks: [hook],
            maxIterations: 1,
        }));
        assert.equal(permissionCalls, 0, "permission chain must not fire for observations");
    });
    it("status transitions (started/completed/failed) surface distinctly", async () => {
        const driver = async function* () {
            yield {
                kind: "tool_call_observation",
                tool: "t",
                args: {},
                status: "started",
            };
            yield {
                kind: "tool_call_observation",
                tool: "t",
                args: {},
                status: "completed",
                result: "ok",
            };
            yield {
                kind: "tool_call_observation",
                tool: "t2",
                args: {},
                status: "failed",
                error: { name: "Error", message: "bang" },
            };
            yield { kind: "emit_done", payload: {} };
        };
        const events = await drain(runAgent({
            agentId: "obs-status",
            sessionId: "s",
            input: "test",
            driver,
            maxIterations: 1,
        }));
        const observations = events.filter((e) => e.type === "ToolCallObservation");
        assert.equal(observations.length, 3);
        assert.equal(observations[0]?.status, "started");
        assert.equal(observations[1]?.status, "completed");
        assert.equal(observations[2]?.status, "failed");
        assert.equal(observations[2]?.error?.message, "bang");
    });
    it("observations can interleave with native SDK tool_call + message steps", async () => {
        const driver = async function* () {
            yield {
                kind: "message",
                role: "assistant",
                content: "thinking…",
            };
            yield {
                kind: "tool_call_observation",
                tool: "external",
                args: {},
                status: "completed",
            };
            yield { kind: "emit_done", payload: {} };
        };
        const events = await drain(runAgent({
            agentId: "obs-mixed",
            sessionId: "s",
            input: "test",
            driver,
            maxIterations: 1,
        }));
        const order = events.map((e) => e.type);
        // AgentStart, IterationStart, Message, ToolCallObservation, EmitDone,
        // IterationOutput, SessionClose — exact subset order we care about:
        const relevant = order.filter((t) => ["Message", "ToolCallObservation", "EmitDone"].includes(t));
        assert.deepEqual(relevant, [
            "Message",
            "ToolCallObservation",
            "EmitDone",
        ]);
    });
});
//# sourceMappingURL=sdk-tool-call-observation.test.js.map