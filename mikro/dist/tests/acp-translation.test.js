/**
 * Deterministic translation gate — wish mikro-acp-adapter, Group 2.
 *
 * Feeds a synthetic AgentEvent sequence (root iterations + 2 Recurse spawns
 * incl. sibling branches + bridged child completions + a repl tool call +
 * EmitDone) through `translateEvent` and asserts the EXACT SessionUpdate
 * sequence: types, tool-call node identity (keyed by child correlationId),
 * and per-node metrics presence. This is the deterministic proof; the live
 * `smoke-acp.mjs --recursive` run is the integration proof.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeEvent } from "../src/sdk/events.js";
import { createTranslationContext, NODE_META_KEY, recurseNodeId, translateEvent, } from "../src/acp/session.js";
const ROOT = "root-corr";
/** Drive a whole event sequence through one context; return flat updates. */
function drive(events) {
    const ctx = createTranslationContext("acp-sess-1");
    const updates = [];
    for (const ev of events) {
        for (const u of translateEvent(ev, ctx))
            updates.push(u);
    }
    return { updates, ctx };
}
function childMetrics(depth, cost, input, output) {
    return {
        depth,
        parentDepth: depth - 1,
        latencyMs: 1234,
        toolCalls: 0,
        costUsd: cost,
        tokens: { input, output },
    };
}
describe("acp translation — full recursive sequence", () => {
    const events = [
        makeEvent("AgentStart", {
            agentId: "station/qwen",
            sessionId: ROOT,
            correlationId: ROOT,
            config: {},
        }),
        makeEvent("SessionOpen", {
            sessionId: ROOT,
            correlationId: ROOT,
            resumed: false,
        }),
        makeEvent("IterationStart", {
            sessionId: ROOT,
            correlationId: ROOT,
            iteration: 0,
        }),
        makeEvent("ToolCallBefore", {
            sessionId: ROOT,
            correlationId: ROOT,
            iteration: 0,
            tool: "repl",
            args: "x = 17 * 23",
        }),
        makeEvent("ToolCallAfter", {
            sessionId: ROOT,
            correlationId: ROOT,
            iteration: 0,
            tool: "repl",
            result: "391",
            durationMs: 42,
            ok: true,
        }),
        makeEvent("IterationOutput", {
            sessionId: ROOT,
            correlationId: ROOT,
            iteration: 0,
            output: "Let me delegate the two sub-questions.",
            metrics: childMetrics(0, 0.001, 100, 20),
        }),
        // two sibling spawns of the same parent
        makeEvent("Recurse", {
            sessionId: ROOT,
            correlationId: "childA",
            parentRunId: ROOT,
            iteration: 1,
            depth: 1,
            parentDepth: 0,
            query: "What is 17*23? Reply with just the number.",
        }),
        makeEvent("Recurse", {
            sessionId: ROOT,
            correlationId: "childB",
            parentRunId: ROOT,
            iteration: 1,
            depth: 1,
            parentDepth: 0,
            query: "What is 5*5? Reply with just the number.",
        }),
        // bridged child completions (arrive as IterationOutput keyed by child id)
        makeEvent("IterationOutput", {
            sessionId: "childA",
            correlationId: "childA",
            parentRunId: ROOT,
            iteration: 1,
            output: "391",
            metrics: childMetrics(1, 0.0005, 50, 5),
        }),
        makeEvent("IterationOutput", {
            sessionId: "childB",
            correlationId: "childB",
            parentRunId: ROOT,
            iteration: 1,
            output: "25",
            metrics: childMetrics(1, 0.0004, 48, 4),
        }),
        // root wraps up
        makeEvent("IterationOutput", {
            sessionId: ROOT,
            correlationId: ROOT,
            iteration: 2,
            output: "Combining the child answers now.",
            metrics: childMetrics(0, 0.002, 200, 40),
        }),
        makeEvent("EmitDone", {
            sessionId: ROOT,
            correlationId: ROOT,
            payload: { answer: "17*23 = 391 and 5*5 = 25.", iterations: 3 },
        }),
    ];
    const { updates, ctx } = drive(events);
    it("emits the exact SessionUpdate type sequence", () => {
        const types = updates.map((u) => u.sessionUpdate);
        assert.deepEqual(types, [
            "tool_call", // repl before
            "tool_call_update", // repl after
            "agent_thought_chunk", // root iter0 reasoning
            "tool_call", // Recurse childA
            "tool_call", // Recurse childB
            "tool_call_update", // childA completion
            "tool_call_update", // childB completion
            "agent_thought_chunk", // root iter2 reasoning
            "agent_message_chunk", // EmitDone final answer
        ]);
    });
    it("gives the repl tool call a stable paired id + execute kind", () => {
        const before = updates[0];
        const after = updates[1];
        assert.equal(before.kind, "execute");
        assert.equal(before.status, "in_progress");
        assert.equal(before.toolCallId, after.toolCallId, "before/after share toolCallId");
        assert.equal(after.status, "completed");
    });
    it("keys each recursion node by child correlationId", () => {
        const recurseNodes = updates.filter((u) => u.sessionUpdate === "tool_call" && u.toolCallId.startsWith("rlm:"));
        assert.equal(recurseNodes.length, 2);
        assert.equal(recurseNodes[0].toolCallId, recurseNodeId("childA"));
        assert.equal(recurseNodes[1].toolCallId, recurseNodeId("childB"));
        assert.equal(recurseNodes[0].kind, "think");
        // nested-or-flat: depth is encoded in the title
        assert.match(recurseNodes[0].title, /^rlm_query \[d1\]/);
    });
    it("resolves child completions onto their own nodes with metrics", () => {
        const updatesById = new Map();
        for (const u of updates) {
            if (u.sessionUpdate === "tool_call_update")
                updatesById.set(u.toolCallId, u);
        }
        for (const child of ["childA", "childB"]) {
            const node = updatesById.get(recurseNodeId(child));
            assert.ok(node, `completion update for ${child}`);
            assert.equal(node.status, "completed");
            const meta = (node._meta ?? {});
            const nodeMeta = meta[NODE_META_KEY];
            assert.ok(nodeMeta, "node _meta present");
            assert.equal(nodeMeta.correlationId, child);
            assert.equal(nodeMeta.parentRunId, ROOT);
            assert.equal(typeof nodeMeta.costUsd, "number");
            assert.equal(typeof nodeMeta.latencyMs, "number");
            assert.ok(nodeMeta.tokens, "per-node tokens present");
        }
    });
    it("sends the final answer once via agent_message_chunk", () => {
        const answers = updates.filter((u) => u.sessionUpdate === "agent_message_chunk");
        assert.equal(answers.length, 1);
        const chunk = answers[0];
        assert.equal(chunk.content.type, "text");
        if (chunk.content.type === "text")
            assert.equal(chunk.content.text, "17*23 = 391 and 5*5 = 25.");
    });
    it("counts zero unknown events for known variants", () => {
        assert.equal(ctx.ignoredCount, 0);
    });
});
describe("acp translation — answer dedupe", () => {
    it("streams Message chunks then emits only the EmitDone delta", () => {
        const events = [
            makeEvent("Message", {
                sessionId: ROOT,
                correlationId: ROOT,
                role: "assistant",
                content: "The answer ",
            }),
            makeEvent("Message", {
                sessionId: ROOT,
                correlationId: ROOT,
                role: "assistant",
                content: "is 42",
            }),
            // EmitDone repeats the whole streamed answer + a trailing period
            makeEvent("EmitDone", {
                sessionId: ROOT,
                correlationId: ROOT,
                payload: { answer: "The answer is 42.", iterations: 1 },
            }),
        ];
        const { updates } = drive(events);
        const texts = updates
            .filter((u) => u.sessionUpdate === "agent_message_chunk")
            .map((u) => {
            const c = u.content;
            return c.type === "text" ? c.text : "";
        });
        // two streamed chunks + exactly the delta "." — never the full repeat
        assert.deepEqual(texts, ["The answer ", "is 42", "."]);
    });
    it("drops a non-assistant Message and an exact EmitDone repeat", () => {
        const events = [
            makeEvent("Message", {
                sessionId: ROOT,
                role: "system",
                content: "you are a helpful agent",
            }),
            makeEvent("Message", {
                sessionId: ROOT,
                role: "assistant",
                content: "done",
            }),
            makeEvent("EmitDone", {
                sessionId: ROOT,
                payload: { answer: "done", iterations: 1 },
            }),
        ];
        const { updates } = drive(events);
        const answers = updates.filter((u) => u.sessionUpdate === "agent_message_chunk");
        assert.equal(answers.length, 1); // system dropped, EmitDone repeat deduped
    });
});
describe("acp translation — errors + forward-compat", () => {
    it("marks a known recursion node failed on a child Error", () => {
        const events = [
            makeEvent("Recurse", {
                sessionId: ROOT,
                correlationId: "childX",
                parentRunId: ROOT,
                iteration: 0,
                depth: 1,
                parentDepth: 0,
                query: "boom",
            }),
            makeEvent("Error", {
                sessionId: "childX",
                correlationId: "childX",
                parentRunId: ROOT,
                phase: "recurse",
                error: { name: "ChildRlmError", message: "child failed" },
            }),
        ];
        const { updates } = drive(events);
        const failed = updates.find((u) => u.sessionUpdate === "tool_call_update");
        assert.ok(failed);
        assert.equal(failed.toolCallId, recurseNodeId("childX"));
        assert.equal(failed.status, "failed");
    });
    it("surfaces a root-level Error as an agent_message_chunk", () => {
        const events = [
            makeEvent("Error", {
                sessionId: ROOT,
                correlationId: ROOT,
                phase: "iteration",
                error: { name: "EmptyResponses", message: "aborted" },
            }),
        ];
        const { updates } = drive(events);
        assert.equal(updates.length, 1);
        assert.equal(updates[0].sessionUpdate, "agent_message_chunk");
    });
    it("ignores and counts an unknown event type without crashing", () => {
        const ctx = createTranslationContext("acp-sess-1");
        const fake = { type: "SomeFutureEvent", timestamp: "t", sessionId: ROOT };
        const updates = translateEvent(fake, ctx);
        assert.deepEqual(updates, []);
        assert.equal(ctx.ignoredCount, 1);
    });
});
describe("acp translation — payload hygiene (truncation + redaction)", () => {
    /** Extract the concatenated text from a tool-call update's content blocks. */
    function contentText(u) {
        const blocks = u.content ?? [];
        return blocks
            .map((b) => (b.type === "content" && b.content.type === "text" ? b.content.text : ""))
            .join("");
    }
    it("bounds oversized repl stdout in both content and rawOutput", () => {
        // A repl cell that emits ~200KB of stdout must not cross the web boundary
        // whole: content is width-bounded and rawOutput is replaced with a marker.
        const big = "A".repeat(200_000);
        const events = [
            makeEvent("ToolCallBefore", {
                sessionId: ROOT,
                correlationId: ROOT,
                iteration: 0,
                tool: "repl",
                args: "print('x' * 200000)",
            }),
            makeEvent("ToolCallAfter", {
                sessionId: ROOT,
                correlationId: ROOT,
                iteration: 0,
                tool: "repl",
                result: big,
                durationMs: 5,
                ok: true,
            }),
        ];
        const { updates } = drive(events);
        const after = updates.find((u) => u.sessionUpdate === "tool_call_update");
        assert.ok(after);
        const text = contentText(after);
        // Bounded far below the original 200K, with a self-describing marker.
        assert.ok(text.length < 20_000, `content bounded (was ${text.length})`);
        assert.match(text, /mikro: truncated \d+ of 200000 chars/);
        // rawOutput becomes a truncation marker rather than the whole 200KB blob.
        const raw = after.rawOutput;
        assert.equal(raw["mikro/truncated"], true);
        assert.equal(typeof raw.originalChars, "number");
    });
    it("redacts a hostile keyword-repeat payload in bounded time (ReDoS guard)", () => {
        // Regression: redactSecrets used to run on the FULL untruncated payload,
        // and its keyword pattern backtracked superlinearly on a long keyword-
        // substring run with no `[:=]` delimiter — 400KB of "auth" froze the
        // synchronous stdio drain loop for ~15s. Truncate-then-redact + bounded
        // `[\w.-]{0,64}` runs make this O(MAX_PAYLOAD_CHARS). ~500KB must be fast.
        const hostile = "token".repeat(100_000); // 500_000 chars, all keyword runs
        const events = [
            makeEvent("ToolCallBefore", {
                sessionId: ROOT,
                correlationId: ROOT,
                iteration: 0,
                tool: "repl",
                args: hostile,
            }),
            makeEvent("ToolCallAfter", {
                sessionId: ROOT,
                correlationId: ROOT,
                iteration: 0,
                tool: "repl",
                result: hostile,
                durationMs: 5,
                ok: true,
            }),
        ];
        const t0 = Date.now();
        const { updates } = drive(events);
        const elapsedMs = Date.now() - t0;
        // Coarse bound: the fixed path is ~15ms; the vulnerable path was ~19_700ms.
        // 1s leaves ample margin against CI jitter while still failing hard on the
        // superlinear regression (which was three orders of magnitude slower).
        assert.ok(elapsedMs < 1_000, `translation must not block the event loop (took ${elapsedMs}ms)`);
        // Structural cap: whatever crosses the boundary is width-bounded, proving
        // redaction operated on a truncated slice, not the full 500KB payload.
        const after = updates.find((u) => u.sessionUpdate === "tool_call_update");
        assert.ok(after);
        assert.ok(contentText(after).length < 20_000, "content capped");
        const raw = after.rawOutput;
        assert.equal(raw["mikro/truncated"], true);
    });
    it("redacts a secret in the retained head of an oversized payload (no leak past truncation)", () => {
        // A secret living just before the width cap, inside an oversized payload,
        // must still be redacted: truncate-then-redact redacts the bounded head
        // slice (cap + overlap) BEFORE the final hard cap, so nothing recognizable
        // survives in what crosses the boundary.
        const head = "A".repeat(16_000); // < MAX_PAYLOAD_CHARS (16_384)
        const tail = "A".repeat(5_000); // pushes total well past the cap
        const leak = `${head} password=hunter2straddling ${tail}`;
        const events = [
            makeEvent("ToolCallBefore", {
                sessionId: ROOT,
                correlationId: ROOT,
                iteration: 0,
                tool: "repl",
                args: "print(secret)",
            }),
            makeEvent("ToolCallAfter", {
                sessionId: ROOT,
                correlationId: ROOT,
                iteration: 0,
                tool: "repl",
                result: leak,
                durationMs: 5,
                ok: true,
            }),
        ];
        const { updates } = drive(events);
        const after = updates.find((u) => u.sessionUpdate === "tool_call_update");
        const text = contentText(after);
        assert.ok(!text.includes("hunter2straddling"), "straddling secret redacted");
        assert.match(text, /\[REDACTED\]/, "redaction marker present at the cut");
    });
    it("redacts secrets in tool-call content and raw fields", () => {
        const leak = "export API_KEY=sk-verysecretvalue1234567890 and password=hunter2";
        const events = [
            makeEvent("ToolCallBefore", {
                sessionId: ROOT,
                correlationId: ROOT,
                iteration: 0,
                tool: "repl",
                args: leak,
            }),
            makeEvent("ToolCallAfter", {
                sessionId: ROOT,
                correlationId: ROOT,
                iteration: 0,
                tool: "repl",
                result: leak,
                durationMs: 5,
                ok: true,
            }),
        ];
        const { updates } = drive(events);
        const before = updates[0];
        const after = updates[1];
        for (const [label, text] of [
            ["before content", contentText(before)],
            ["after content", contentText(after)],
            ["before rawInput", JSON.stringify(before.rawInput)],
            ["after rawOutput", JSON.stringify(after.rawOutput)],
            ["before title", before.title],
        ]) {
            assert.ok(!text.includes("hunter2"), `${label} redacts password value`);
            assert.ok(!text.includes("sk-verysecretvalue1234567890"), `${label} redacts api key value`);
            assert.match(text, /\[REDACTED\]/, `${label} carries redaction marker`);
        }
    });
});
//# sourceMappingURL=acp-translation.test.js.map