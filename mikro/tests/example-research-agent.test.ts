import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type AgentEvent,
	createToolRegistry,
	loadAgentSpec,
	loadPluginTools,
	parseValidateMd,
	type PermissionHook,
	runAgent,
	type ToolHandler,
} from "../src/sdk/index.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_DIR = join(testDir, "..", "..", "examples", "agents", "research-agent");

async function drain(
	stream: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
	const out: AgentEvent[] = [];
	for await (const ev of stream) out.push(ev);
	return out;
}

// Hermetic fake fetch — swap in for `fetch-url` so the smoke test
// doesn't hit the network. Uses registry.override so the plugin
// file load happens (exercising the real .mjs discovery path) and
// THEN we replace it.
const fakeFetch: ToolHandler = async (args) => {
	const { url } = args as { url: string };
	return {
		url,
		status: 200,
		text: "Example Domain — IANA reserved domain (RFC 6761 / RFC 2606).",
	};
};

describe("example: research-agent (G4)", () => {
	it("loads agent.yaml + tools + validates a good payload", async () => {
		const spec = await loadAgentSpec(EXAMPLE_DIR);
		assert.deepEqual(new Set(spec.tools), new Set(["fetch-url"]));

		const registry = createToolRegistry();
		const loadResult = await loadPluginTools(spec, registry);
		assert.ok(loadResult.loaded.includes("fetch-url"));

		// Swap the real fetch for the fake so the test stays hermetic.
		registry.override("fetch-url", fakeFetch);

		const validateMd = await readFile(join(EXAMPLE_DIR, "VALIDATE.md"), "utf8");
		const { schema, rawBlock } = parseValidateMd(validateMd);
		assert.ok(schema, "VALIDATE.md must parse to a schema");

		const driver = async function* () {
			yield {
				kind: "tool_call" as const,
				tool: "fetch-url",
				args: { url: "https://example.com" },
			};
			yield {
				kind: "emit_done" as const,
				payload: {
					summary: "Example.com is an IANA reserved domain.",
					citations: [
						{ url: "https://example.com", note: "Primary source" },
					],
				},
			};
		};

		const events = await drain(
			runAgent({
				agentId: "research",
				sessionId: `research-${Date.now()}`,
				input: "What is example.com?",
				driver,
				toolRegistry: registry,
				validateSchema: schema ?? undefined,
				validateSchemaSource: rawBlock ?? undefined,
				maxIterations: 3,
			}),
		);

		const validation = events.find((e) => e.type === "Validation") as
			| { status: string; attempt: number }
			| undefined;
		assert.equal(validation?.status, "pass");
		const close = events.find((e) => e.type === "SessionClose") as
			| { reason: string }
			| undefined;
		assert.equal(close?.reason, "complete");
	});

	it("permission hook blocks localhost fetches", async () => {
		const spec = await loadAgentSpec(EXAMPLE_DIR);
		const registry = createToolRegistry();
		await loadPluginTools(spec, registry);
		registry.override("fetch-url", fakeFetch);

		const denyInternal: PermissionHook = (ctx) => {
			if (ctx.tool !== "fetch-url") return { decision: "allow" };
			const args = ctx.args as { url?: string } | null;
			const url = args?.url ?? "";
			if (/^https?:\/\/(localhost|127\.|10\.|192\.168\.)/.test(url)) {
				return { decision: "deny", reason: "internal host blocked" };
			}
			return { decision: "allow" };
		};

		const driver = async function* () {
			yield {
				kind: "tool_call" as const,
				tool: "fetch-url",
				args: { url: "http://localhost:3000/admin" },
			};
			yield {
				kind: "emit_done" as const,
				payload: {
					summary: "insufficient evidence",
					citations: [],
				},
			};
		};

		const events = await drain(
			runAgent({
				agentId: "research-deny",
				sessionId: `research-deny-${Date.now()}`,
				input: "poke internal",
				driver,
				toolRegistry: registry,
				permissionHooks: [denyInternal],
				maxIterations: 2,
			}),
		);

		const denial = events.find(
			(e) =>
				e.type === "Error" &&
				(e as { phase: string }).phase === "tool-denied",
		);
		assert.ok(denial, "expected Error{phase:tool-denied}");
		const after = events.find((e) => e.type === "ToolCallAfter") as
			| { ok: boolean }
			| undefined;
		assert.equal(after?.ok, false);
	});

	it("validate retry-with-hint triggers when payload is malformed", async () => {
		const spec = await loadAgentSpec(EXAMPLE_DIR);
		const registry = createToolRegistry();
		await loadPluginTools(spec, registry);
		registry.override("fetch-url", fakeFetch);

		const validateMd = await readFile(join(EXAMPLE_DIR, "VALIDATE.md"), "utf8");
		const { schema, rawBlock } = parseValidateMd(validateMd);
		assert.ok(schema);

		let iterationSeen = 0;
		let retryHintSeen = "";
		const driver = async function* (req: { iteration: number; retryHint?: string }) {
			iterationSeen = req.iteration;
			if (req.retryHint) retryHintSeen = req.retryHint;
			if (req.iteration === 1) {
				// Missing `citations` — should fail validate.
				yield {
					kind: "emit_done" as const,
					payload: { summary: "bare summary" },
				};
			} else {
				yield {
					kind: "emit_done" as const,
					payload: {
						summary: "corrected summary",
						citations: [],
					},
				};
			}
		};

		const events = await drain(
			runAgent({
				agentId: "research-retry",
				sessionId: `research-retry-${Date.now()}`,
				input: "prompt",
				driver,
				toolRegistry: registry,
				validateSchema: schema ?? undefined,
				validateSchemaSource: rawBlock ?? undefined,
				maxIterations: 3,
			}),
		);

		const validations = events.filter((e) => e.type === "Validation") as Array<{
			status: string;
		}>;
		assert.equal(validations[0]?.status, "fail");
		assert.equal(validations[1]?.status, "pass");
		assert.equal(iterationSeen, 2);
		assert.match(retryHintSeen, /VALIDATE\.md/);
	});
});
