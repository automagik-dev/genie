import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
	type AgentEvent,
	createToolRegistry,
	loadAgentSpec,
	loadPluginTools,
	runAgent,
} from "../src/sdk/index.js";

// tests/ compiles to dist/tests/. From there the examples/ root sits
// two levels up; resolve once here for every test in this file.
const testDir = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_DIR = join(testDir, "..", "..", "examples", "agents", "hello-world");

async function drain(
	stream: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
	const out: AgentEvent[] = [];
	for await (const ev of stream) out.push(ev);
	return out;
}

describe("example: hello-world (G4)", () => {
	it("loads agent.yaml + tools/greet.mjs and dispatches a greeting", async () => {
		const spec = await loadAgentSpec(EXAMPLE_DIR);
		assert.deepEqual([...spec.tools], ["greet"]);
		assert.equal(spec.shape, "single-step");

		const registry = createToolRegistry();
		const result = await loadPluginTools(spec, registry);
		assert.deepEqual([...result.loaded], ["greet"]);
		assert.equal(result.missing.length, 0);
		assert.deepEqual(registry.describe("greet"), {
			description: "Greet a person by name.",
			parameters: {
				type: "object",
				properties: {
					name: { type: "string", description: "Name to greet." },
				},
			},
		});

		const driver = async function* (req: {
			history: ReadonlyArray<{ content: string }>;
		}) {
			yield {
				kind: "tool_call" as const,
				tool: "greet",
				args: { name: req.history[0]?.content ?? "stranger" },
			};
			yield { kind: "emit_done" as const, payload: { ok: true } };
		};

		const events = await drain(
			runAgent({
				agentId: "hello-world",
				sessionId: `hello-${Date.now()}`,
				input: "Stéfani",
				driver,
				toolRegistry: registry,
				maxIterations: 2,
			}),
		);

		const after = events.find((e) => e.type === "ToolCallAfter") as
			| { tool: string; result: unknown; ok: boolean }
			| undefined;
		assert.ok(after);
		assert.equal(after?.tool, "greet");
		assert.equal(after?.ok, true);
		assert.deepEqual(after?.result, { greeting: "Hello, Stéfani!" });

		const close = events.find((e) => e.type === "SessionClose") as
			| { reason: string }
			| undefined;
		assert.equal(close?.reason, "complete");
	});
});
