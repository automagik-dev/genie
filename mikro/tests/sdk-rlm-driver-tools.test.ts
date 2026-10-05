/**
 * mikro#78 — tool-dispatch driver tests.
 *
 * Covers the multi-turn native-function-calling loop added to
 * rlmDriver when a `tools` config is present. The legacy one-shot
 * path is covered by `sdk-rlm-driver.test.ts`; this file is purely
 * the tool-dispatch surface.
 *
 * All tests are hermetic — they inject a `toolsLlm` mock in place of
 * `completeSimple` so no live LLM is called. A separate LIVE smoke
 * is deferred to the integration suite (gated on GEMINI_API_KEY).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	AssistantMessage as PiAssistantMessage,
	Context as PiContext,
	ToolCall as PiToolCall,
} from "@earendil-works/pi-ai";
import type { ModelConfig } from "../src/config.js";
import {
	type AgentEvent,
	createToolRegistry,
	type IterationStep,
	NoExposableToolsError,
	rlmDriver,
	runAgent,
	type ToolCallOutcome,
	type ToolSchema,
} from "../src/sdk/index.js";

const MODEL: ModelConfig = {
	provider: "google",
	model: "gemini-2.5-flash",
};

function makeAssistant(
	blocks: PiAssistantMessage["content"],
	stopReason: PiAssistantMessage["stopReason"] = "stop",
): PiAssistantMessage {
	return {
		role: "assistant",
		content: blocks,
		api: "google-generative-ai",
		provider: "google",
		model: "gemini-2.5-flash",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: {
				input: 0.001,
				output: 0.002,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0.003,
			},
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function makeToolCall(
	id: string,
	name: string,
	args: Record<string, unknown>,
): PiToolCall {
	return { type: "toolCall", id, name, arguments: args };
}

async function drain(
	stream: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const ev of stream) events.push(ev);
	return events;
}

const SEARCH_SCHEMA: ToolSchema = {
	description: "Search the brain corpus for entries matching a query.",
	parameters: {
		type: "object",
		properties: {
			query: { type: "string", description: "Search query" },
		},
		required: ["query"],
	},
};

const READ_SCHEMA: ToolSchema = {
	description: "Read a specific brain entry by id.",
	parameters: {
		type: "object",
		properties: {
			id: { type: "string", description: "Entry id" },
		},
		required: ["id"],
	},
};

describe("rlmDriver tool-dispatch — step shape (hermetic)", () => {
	it("throws when supplied tools have no schemas", () => {
		const registry = createToolRegistry();
		registry.register("unused", async () => "irrelevant");

		assert.throws(
			() => rlmDriver({ model: MODEL, tools: { registry } }),
			(error: unknown) => {
				assert.ok(error instanceof NoExposableToolsError);
				assert.equal(error.name, "NoExposableToolsError");
				assert.equal(
					error.message,
					"rlmDriver: tools supplied but no exposed tool has a schema (handlers without schema: unused). Add tools/<name>.schema.json next to each plugin, call register(name, handler, schema), or omit `tools` to run one-shot.",
				);
				return true;
			},
		);
	});

	it("throws when expose selects only a schema-less handler", () => {
		const registry = createToolRegistry();
		registry.register("search_corpus", async () => [], SEARCH_SCHEMA);
		registry.register("x", async () => "irrelevant");

		assert.throws(
			() =>
				rlmDriver({
					model: MODEL,
					tools: { registry, expose: ["x"] },
				}),
			(error: unknown) => {
				assert.ok(error instanceof NoExposableToolsError);
				assert.match(error.message, /handlers without schema: x/);
				assert.match(error.message, /register\(name, handler, schema\)/);
				return true;
			},
		);
	});

	it("single tool call → yields tool_call step with name, args, id", async () => {
		const registry = createToolRegistry();
		registry.register("search_corpus", async () => [], SEARCH_SCHEMA);

		let llmCalls = 0;
		const toolsLlm = async (): Promise<PiAssistantMessage> => {
			llmCalls++;
			if (llmCalls === 1) {
				return makeAssistant(
					[makeToolCall("call_1", "search_corpus", { query: "gravity" })],
					"toolUse",
				);
			}
			return makeAssistant([{ type: "text", text: "Final answer: nothing found." }]);
		};

		const driver = rlmDriver({
			model: MODEL,
			tools: { registry },
			toolsLlm,
		});

		const steps: IterationStep[] = [];
		const iter = driver(
			{ sessionId: "s", iteration: 1, history: [{ role: "user", content: "find gravity" }] },
			new AbortController().signal,
		) as AsyncGenerator<IterationStep, void, ToolCallOutcome | undefined>;

		// First step should be the tool_call.
		let res = await iter.next();
		assert.ok(!res.done);
		assert.equal(res.value?.kind, "tool_call");
		assert.equal((res.value as { tool: string }).tool, "search_corpus");
		assert.deepEqual((res.value as { args: unknown }).args, { query: "gravity" });
		assert.equal((res.value as { id?: string }).id, "call_1");

		// Feed the outcome back; next we expect the final message + emit_done.
		res = await iter.next({
			tool: "search_corpus",
			ok: true,
			result: { hits: [] },
			durationMs: 3,
		});
		assert.ok(!res.done);
		assert.equal(res.value?.kind, "message");
		res = await iter.next();
		assert.ok(!res.done);
		assert.equal(res.value?.kind, "emit_done");
		res = await iter.next();
		assert.ok(res.done);

		assert.equal(llmCalls, 2);
	});

	it("multiple tool calls in one assistant response → yielded sequentially", async () => {
		const registry = createToolRegistry();
		registry.register("search_corpus", async () => [], SEARCH_SCHEMA);
		registry.register("read", async () => "", READ_SCHEMA);

		let llmCalls = 0;
		const toolsLlm = async (): Promise<PiAssistantMessage> => {
			llmCalls++;
			if (llmCalls === 1) {
				return makeAssistant(
					[
						makeToolCall("call_a", "search_corpus", { query: "foo" }),
						makeToolCall("call_b", "read", { id: "entry_1" }),
					],
					"toolUse",
				);
			}
			return makeAssistant([{ type: "text", text: "done" }]);
		};

		const driver = rlmDriver({
			model: MODEL,
			tools: { registry },
			toolsLlm,
		});

		const steps: IterationStep[] = [];
		const iter = driver(
			{ sessionId: "s", iteration: 1, history: [{ role: "user", content: "do both" }] },
			new AbortController().signal,
		) as AsyncGenerator<IterationStep, void, ToolCallOutcome | undefined>;

		// 1st: tool_call search_corpus
		let res = await iter.next();
		assert.equal(res.value?.kind, "tool_call");
		assert.equal((res.value as { tool: string }).tool, "search_corpus");
		steps.push(res.value as IterationStep);

		// 2nd: after outcome, tool_call read
		res = await iter.next({ tool: "search_corpus", ok: true, result: [], durationMs: 1 });
		assert.equal(res.value?.kind, "tool_call");
		assert.equal((res.value as { tool: string }).tool, "read");

		// 3rd: after outcome, message
		res = await iter.next({ tool: "read", ok: true, result: "body", durationMs: 2 });
		assert.equal(res.value?.kind, "message");
		// 4th: emit_done
		res = await iter.next();
		assert.equal(res.value?.kind, "emit_done");
	});

	it("tool error outcome → driver feeds error text back to LLM, not abort", async () => {
		const registry = createToolRegistry();
		registry.register("search_corpus", async () => {
			throw new Error("index unavailable");
		}, SEARCH_SCHEMA);

		const seenTurns: PiContext[] = [];
		let llmCalls = 0;
		const toolsLlm = async (ctx: PiContext): Promise<PiAssistantMessage> => {
			seenTurns.push({ ...ctx, messages: [...ctx.messages] });
			llmCalls++;
			if (llmCalls === 1) {
				return makeAssistant(
					[makeToolCall("c1", "search_corpus", { query: "x" })],
					"toolUse",
				);
			}
			return makeAssistant([{ type: "text", text: "apologies, the tool failed" }]);
		};

		const driver = rlmDriver({
			model: MODEL,
			tools: { registry },
			toolsLlm,
		});

		const events = await drain(
			runAgent({
				agentId: "t",
				sessionId: "s-tool-err",
				input: "search gravity",
				driver,
				toolRegistry: registry,
			}),
		);

		// Tool failure must NOT abort the run — driver feeds error back,
		// LLM produces a graceful response, run completes.
		const close = events.find((e) => e.type === "SessionClose") as
			| { reason: string }
			| undefined;
		assert.equal(close?.reason, "complete", "tool error should not abort");

		// Second LLM call should see a toolResult with isError=true.
		assert.equal(seenTurns.length, 2);
		const secondMsgs = seenTurns[1]?.messages ?? [];
		const errMsg = secondMsgs.find(
			(m) => m.role === "toolResult" && m.isError === true,
		);
		assert.ok(errMsg, "LLM must see the toolResult with isError");
	});

	it("permission-denied outcome → driver surfaces denial to LLM", async () => {
		const registry = createToolRegistry();
		let handlerCalled = false;
		registry.register("search_corpus", async () => {
			handlerCalled = true;
			return [];
		}, SEARCH_SCHEMA);

		let llmCalls = 0;
		const toolsLlm = async (ctx: PiContext): Promise<PiAssistantMessage> => {
			llmCalls++;
			if (llmCalls === 1) {
				return makeAssistant(
					[makeToolCall("c1", "search_corpus", { query: "blocked" })],
					"toolUse",
				);
			}
			return makeAssistant([{ type: "text", text: "cannot search, understood" }]);
		};

		const driver = rlmDriver({
			model: MODEL,
			tools: { registry },
			toolsLlm,
		});

		const events = await drain(
			runAgent({
				agentId: "t",
				sessionId: "s-deny",
				input: "search",
				driver,
				toolRegistry: registry,
				permissionHooks: [
					async () => ({ decision: "deny", reason: "access policy X" }),
				],
			}),
		);

		assert.equal(handlerCalled, false, "handler must NOT run on deny");
		const close = events.find((e) => e.type === "SessionClose") as
			| { reason: string }
			| undefined;
		assert.equal(close?.reason, "complete");
		// The ToolCallAfter event should carry ok:false + result:null for
		// the denied call.
		const afters = events.filter((e) => e.type === "ToolCallAfter") as Array<{
			ok: boolean;
			result: unknown;
		}>;
		assert.equal(afters[0]?.ok, false);
		assert.equal(afters[0]?.result, null);
	});

	it("emit_done tool call short-circuits → payload becomes the emit_done payload", async () => {
		const registry = createToolRegistry();
		registry.register("emit_done", async () => null, {
			description: "Signal completion",
			parameters: {
				type: "object",
				properties: { answer: { type: "string" } },
				required: ["answer"],
			},
		});

		const toolsLlm = async (): Promise<PiAssistantMessage> =>
			makeAssistant(
				[makeToolCall("c1", "emit_done", { answer: "42" })],
				"toolUse",
			);

		const driver = rlmDriver({
			model: MODEL,
			tools: { registry },
			toolsLlm,
		});

		const events = await drain(
			runAgent({
				agentId: "t",
				sessionId: "s-emit-done-tool",
				input: "what is the answer?",
				driver,
				toolRegistry: registry,
			}),
		);

		const emitDone = events.find((e) => e.type === "EmitDone") as
			| { payload: { answer: string } }
			| undefined;
		assert.ok(emitDone);
		assert.equal(emitDone?.payload?.answer, "42");
	});

	it("maxToolIterations cap → driver yields error when LLM keeps calling tools", async () => {
		const registry = createToolRegistry();
		registry.register("search_corpus", async () => [], SEARCH_SCHEMA);

		const toolsLlm = async (): Promise<PiAssistantMessage> =>
			makeAssistant(
				[makeToolCall("c_loop", "search_corpus", { query: "loop" })],
				"toolUse",
			);

		const driver = rlmDriver({
			model: MODEL,
			tools: { registry, maxToolIterations: 3 },
			toolsLlm,
		});

		const events = await drain(
			runAgent({
				agentId: "t",
				sessionId: "s-loop-cap",
				input: "loop forever",
				driver,
				toolRegistry: registry,
			}),
		);

		const err = events.find(
			(e) =>
				e.type === "Error" &&
				(e as { phase: string }).phase === "driver",
		) as { error: { message: string } } | undefined;
		assert.ok(err);
		assert.match(err?.error?.message ?? "", /maxToolIterations/);
	});

	it("expose allowlist limits tools offered to the LLM", async () => {
		const registry = createToolRegistry();
		registry.register("search_corpus", async () => [], SEARCH_SCHEMA);
		registry.register("read", async () => "", READ_SCHEMA);
		registry.register("propose_yaml", async () => null, {
			description: "Stage a yaml draft for review",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		});

		const seen: PiContext[] = [];
		const toolsLlm = async (ctx: PiContext): Promise<PiAssistantMessage> => {
			seen.push(ctx);
			return makeAssistant([{ type: "text", text: "ok" }]);
		};

		const driver = rlmDriver({
			model: MODEL,
			tools: {
				registry,
				expose: ["read", "propose_yaml"], // search_corpus is hidden
			},
			toolsLlm,
		});

		await drain(
			runAgent({
				agentId: "t",
				sessionId: "s-expose",
				input: "go",
				driver,
				toolRegistry: registry,
			}),
		);

		const offered = (seen[0]?.tools ?? []).map((t) => t.name);
		assert.deepEqual(offered, ["read", "propose_yaml"]);
	});

	it("interim text between tool calls surfaces as Message events", async () => {
		const registry = createToolRegistry();
		registry.register("search_corpus", async () => [], SEARCH_SCHEMA);

		let call = 0;
		const toolsLlm = async (): Promise<PiAssistantMessage> => {
			call++;
			if (call === 1) {
				return makeAssistant(
					[
						{ type: "text", text: "Let me search first." },
						makeToolCall("c1", "search_corpus", { query: "x" }),
					],
					"toolUse",
				);
			}
			return makeAssistant([{ type: "text", text: "Done searching." }]);
		};

		const driver = rlmDriver({
			model: MODEL,
			tools: { registry },
			toolsLlm,
		});

		const events = await drain(
			runAgent({
				agentId: "t",
				sessionId: "s-interim",
				input: "go",
				driver,
				toolRegistry: registry,
			}),
		);

		const messages = events.filter((e) => e.type === "Message") as Array<{
			content: string;
		}>;
		const contents = messages.map((m) => m.content);
		assert.ok(contents.includes("Let me search first."));
		assert.ok(contents.includes("Done searching."));
	});
});

describe("rlmDriver tier-2 integration — brain tools stub end-to-end", () => {
	it("search → read → propose_yaml → final answer pipeline works", async () => {
		// This is the "Tier 2 brain-consuming agent" pattern from
		// brain's runbook/custom-mikro-agents.md — the flow the issue
		// calls out as the killer use case. Stubs stand in for the
		// real brain_tools.py handlers.
		const registry = createToolRegistry();
		const searchCalls: unknown[] = [];
		const readCalls: unknown[] = [];
		const proposeCalls: unknown[] = [];

		registry.register(
			"search_corpus",
			async (args) => {
				searchCalls.push(args);
				return { hits: [{ id: "entry_42", score: 0.91 }] };
			},
			SEARCH_SCHEMA,
		);
		registry.register(
			"read",
			async (args) => {
				readCalls.push(args);
				return {
					id: "entry_42",
					title: "diego fernandes",
					body: "client since 2024-06",
				};
			},
			READ_SCHEMA,
		);
		registry.register(
			"propose_yaml",
			async (args) => {
				proposeCalls.push(args);
				return { staged: true, path: "_pending/2026-04-23/diego.md" };
			},
			{
				description: "Stage a yaml proposal under _pending/",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string" },
						content: { type: "string" },
					},
					required: ["path", "content"],
				},
			},
		);

		let turn = 0;
		const toolsLlm = async (): Promise<PiAssistantMessage> => {
			turn++;
			if (turn === 1) {
				return makeAssistant(
					[makeToolCall("c1", "search_corpus", { query: "diego" })],
					"toolUse",
				);
			}
			if (turn === 2) {
				return makeAssistant(
					[makeToolCall("c2", "read", { id: "entry_42" })],
					"toolUse",
				);
			}
			if (turn === 3) {
				return makeAssistant(
					[
						makeToolCall("c3", "propose_yaml", {
							path: "_pending/2026-04-23/diego.md",
							content: "name: Diego Fernandes",
						}),
					],
					"toolUse",
				);
			}
			return makeAssistant([
				{
					type: "text",
					text: "Staged proposal at _pending/2026-04-23/diego.md",
				},
			]);
		};

		const driver = rlmDriver({
			model: MODEL,
			tools: { registry },
			toolsLlm,
		});

		const events = await drain(
			runAgent({
				agentId: "tier2-test",
				sessionId: "s-tier2",
				input: "extract diego's contact entry",
				driver,
				toolRegistry: registry,
			}),
		);

		// All three tools were actually invoked.
		assert.deepEqual(searchCalls, [{ query: "diego" }]);
		assert.deepEqual(readCalls, [{ id: "entry_42" }]);
		assert.equal(proposeCalls.length, 1);

		// Run completed cleanly.
		const close = events.find((e) => e.type === "SessionClose") as
			| { reason: string }
			| undefined;
		assert.equal(close?.reason, "complete");

		// emit_done payload carries the final answer.
		const emitDone = events.find((e) => e.type === "EmitDone") as
			| { payload: { answer: string; toolCalls: number } }
			| undefined;
		assert.ok(emitDone);
		assert.match(
			emitDone?.payload?.answer ?? "",
			/_pending\/2026-04-23\/diego\.md/,
		);
		assert.equal(emitDone?.payload?.toolCalls, 3);

		// ToolCallBefore/After events bracket each dispatch, in order.
		const beforeNames = events
			.filter((e) => e.type === "ToolCallBefore")
			.map((e) => (e as { tool: string }).tool);
		assert.deepEqual(beforeNames, ["search_corpus", "read", "propose_yaml"]);
	});
});
