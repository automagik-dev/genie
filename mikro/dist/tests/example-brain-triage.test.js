import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createToolRegistry, loadAgentSpec, loadPythonPlugins, runAgent, } from "../src/sdk/index.js";
const testDir = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_DIR = join(testDir, "..", "..", "examples", "agents", "brain-triage");
function pythonAvailable() {
    try {
        execFileSync("python3", ["--version"], { stdio: "ignore" });
        return true;
    }
    catch {
        return false;
    }
}
async function drain(stream) {
    const out = [];
    for await (const ev of stream)
        out.push(ev);
    return out;
}
describe("example: brain-triage (G4, skip when no python3)", { skip: !pythonAvailable() }, () => {
    it("loads agent.yaml + tools/search_corpus.py via Python subprocess", async () => {
        const spec = await loadAgentSpec(EXAMPLE_DIR);
        assert.deepEqual([...spec.tools], ["search_corpus"]);
        const registry = createToolRegistry();
        const py = await loadPythonPlugins(spec, registry, {
            timeoutMs: 10_000,
        });
        assert.deepEqual([...py.loaded], ["search_corpus"]);
        const driver = async function* (req) {
            yield {
                kind: "tool_call",
                tool: "search_corpus",
                args: { query: req.history[0]?.content ?? "", limit: 2 },
            };
            yield {
                kind: "emit_done",
                payload: {
                    query: req.history[0]?.content ?? "",
                    best_match_id: "case-001",
                    confidence: 0.82,
                    reason: "top hit from token overlap",
                },
            };
        };
        const events = await drain(runAgent({
            agentId: "brain-triage",
            sessionId: `triage-${Date.now()}`,
            input: "carol divorcio",
            driver,
            toolRegistry: registry,
            maxIterations: 2,
        }));
        const after = events.find((e) => e.type === "ToolCallAfter");
        assert.ok(after);
        assert.equal(after?.tool, "search_corpus");
        assert.equal(after?.ok, true);
        const result = after?.result;
        assert.equal(result.query, "carol divorcio");
        assert.ok(Array.isArray(result.hits));
        assert.ok(result.hits.length > 0, "expected at least one hit for 'carol divorcio'");
        // The token-overlap scorer puts case-001 (Carol divórcio) at rank 1.
        assert.equal(result.hits[0]?.id, "case-001");
        const close = events.find((e) => e.type === "SessionClose");
        assert.equal(close?.reason, "complete");
    });
    it("python plugin handles an empty-query fall-through", async () => {
        const spec = await loadAgentSpec(EXAMPLE_DIR);
        const registry = createToolRegistry();
        await loadPythonPlugins(spec, registry, { timeoutMs: 5_000 });
        const handler = registry.get("search_corpus");
        assert.ok(handler);
        const result = (await handler({ query: "   " }, {
            tool: "search_corpus",
            sessionId: "s",
            iteration: 1,
            signal: new AbortController().signal,
        }));
        assert.equal(result.reason, "empty query");
        assert.deepEqual(result.hits, []);
    });
});
//# sourceMappingURL=example-brain-triage.test.js.map