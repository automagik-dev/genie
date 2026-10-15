import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	createEmitter,
	createRecursionBridge,
	isAgentEvent,
	makeEvent,
	type AgentEvent,
	type RecurseEvent,
} from "../src/sdk/index.js";
import { rlmQuery, type RlmChildResult } from "../src/llm.js";

/** Drain every buffered event from a closed emitter. */
async function collect(
	stream: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
	const out: AgentEvent[] = [];
	for await (const ev of stream) out.push(ev);
	return out;
}

function childResult(cost: number, input: number, output: number): RlmChildResult {
	return {
		answer: `answer(${input}/${output})`,
		usage: {
			inputTokens: input,
			outputTokens: output,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalCost: cost,
			llmCalls: 1,
		},
	};
}

describe("recursion bridge — RecurseEvent production + correlationId ancestry", () => {
	it("emits one RecurseEvent per spawn and keys ancestry on correlationId across sibling branches", async () => {
		const emitter = createEmitter();
		const drained = collect(emitter); // subscribe + start draining before we drive

		// Model a >=2-level recursive run. The root run spawns two siblings
		// (A, B); child A is itself a run that spawns two grandchildren
		// (A1, A2). Sibling pairs share a depth — only correlationId can
		// disambiguate them. Each run has its own bridge (its own parent id),
		// exactly as separate processes would in a live run; we fan them into
		// one emitter to model a collector reconstructing the full tree.
		let rootIter = 3;
		const rootBridge = createRecursionBridge({
			emitter,
			sessionId: "root",
			currentIteration: () => rootIter,
		});
		const aBridge = createRecursionBridge({
			emitter,
			sessionId: "A",
			currentIteration: () => 0,
		});

		rootBridge.onChildStart({ correlationId: "A", prompt: "branch A", depth: 1 });
		rootBridge.onChildStart({ correlationId: "B", prompt: "branch B", depth: 1 });
		aBridge.onChildStart({ correlationId: "A1", prompt: "branch A1", depth: 2 });
		aBridge.onChildStart({ correlationId: "A2", prompt: "branch A2", depth: 2 });

		aBridge.onChildEnd({ correlationId: "A1", depth: 2, result: childResult(0.01, 10, 5), durationMs: 11 });
		aBridge.onChildEnd({ correlationId: "A2", depth: 2, result: childResult(0.02, 20, 8), durationMs: 22 });
		rootBridge.onChildEnd({ correlationId: "A", depth: 1, result: childResult(0.05, 40, 20), durationMs: 111 });
		rootBridge.onChildEnd({
			correlationId: "B",
			depth: 1,
			result: childResult(0, 0, 0),
			durationMs: 9,
			isError: true,
			errorMessage: "child mikro exited with code 1",
		});

		emitter.close();
		const all = await drained;

		// One RecurseEvent per spawn — four spawns.
		const recurses = all.filter((e): e is RecurseEvent => e.type === "Recurse");
		assert.equal(recurses.length, 4, "exactly one RecurseEvent per spawn");

		// Ancestry edges key on correlationId, NOT depth. Build parent map.
		const parentOf = new Map<string, string | undefined>();
		for (const r of recurses) {
			parentOf.set(r.correlationId as string, r.parentRunId);
		}
		assert.equal(parentOf.get("A"), "root");
		assert.equal(parentOf.get("B"), "root");
		assert.equal(parentOf.get("A1"), "A");
		assert.equal(parentOf.get("A2"), "A");

		// Siblings share a depth but are distinct nodes — depth alone cannot
		// disambiguate; correlationId does.
		const aRec = recurses.find((r) => r.correlationId === "A")!;
		const bRec = recurses.find((r) => r.correlationId === "B")!;
		assert.equal(aRec.depth, bRec.depth, "A and B are siblings at the same depth");
		assert.notEqual(aRec.correlationId, bRec.correlationId);
		assert.equal(aRec.iteration, 3, "Recurse carries the live parent iteration");

		// Reconstruct the tree by correlationId and assert grandchildren sit
		// two levels below root via A.
		const ancestry = (id: string): string[] => {
			const chain: string[] = [];
			let cur: string | undefined = id;
			while (cur && parentOf.has(cur)) {
				const p = parentOf.get(cur);
				if (p !== undefined) chain.push(p);
				cur = p;
			}
			return chain;
		};
		assert.deepEqual(ancestry("A1"), ["A", "root"]);
		assert.deepEqual(ancestry("A2"), ["A", "root"]);

		// Child-completion nodes carry bridged usage (cost/tokens/latency).
		const completions = all.filter((e) => e.type === "IterationOutput");
		assert.equal(completions.length, 4, "one bridged completion per child");
		const aComplete = completions.find((e) => e.correlationId === "A") as Extract<AgentEvent, { type: "IterationOutput" }>;
		assert.equal(aComplete.parentRunId, "root");
		assert.equal(aComplete.metrics?.costUsd, 0.05);
		assert.equal(aComplete.metrics?.tokens?.input, 40);
		assert.equal(aComplete.metrics?.tokens?.output, 20);
		assert.equal(aComplete.metrics?.latencyMs, 111);

		// A failed child additionally emits an Error node keyed by the same id.
		const errs = all.filter((e) => e.type === "Error");
		assert.equal(errs.length, 1);
		assert.equal(errs[0].correlationId, "B");

		// Every emitted event stays a valid, round-trippable AgentEvent.
		for (const ev of all) {
			assert.ok(isAgentEvent(JSON.parse(JSON.stringify(ev))), `${ev.type} round-trip`);
		}
	});

	it("attributes a spawn-error child completion to the child correlationId, not the parent", async () => {
		// Regression for the child.on("error") path in rlmQuery: it must pass
		// correlationId + depth to onChildEnd (mirroring the nonzero-exit path)
		// so the bridge keys the completion on the CHILD, not the parent. Before
		// the fix the fields were omitted and the bridge fell back to sessionId.
		const emitter = createEmitter();
		const drained = collect(emitter);
		const bridge = createRecursionBridge({
			emitter,
			sessionId: "parent-run",
			currentIteration: () => 0,
		});

		// Force child.on("error") by spawning into a cwd that does not exist —
		// the real spawn-failure path, no live model needed.
		await rlmQuery("q", "/nonexistent-mikro-spawn-dir-xyz", undefined, {
			onChildStart: ({ correlationId, prompt, depth }) => {
				bridge.onChildStart({ correlationId, prompt, depth });
				return undefined;
			},
			onChildEnd: (data) => bridge.onChildEnd(data),
		});

		emitter.close();
		const all = await drained;

		const recurse = all.find((e): e is RecurseEvent => e.type === "Recurse");
		const childId = recurse?.correlationId;
		assert.ok(childId && childId !== "parent-run", "child spawn minted its own correlationId");

		// The bridged completion + error are keyed to the CHILD, edged to the parent.
		const completion = all.find((e) => e.type === "IterationOutput");
		assert.equal(completion?.correlationId, childId, "completion attributed to child");
		assert.equal(completion?.parentRunId, "parent-run", "ancestry edge points at parent");

		const err = all.find((e) => e.type === "Error");
		assert.equal(err?.correlationId, childId, "spawn-error attributed to child, not parent");
		assert.notEqual(err?.correlationId, "parent-run");
	});

	it("RecurseEvent carries the optional correlation fields through makeEvent without a schema fork", () => {
		const ev = makeEvent<RecurseEvent>("Recurse", {
			sessionId: "root",
			correlationId: "child-7",
			parentRunId: "root",
			iteration: 1,
			depth: 2,
			parentDepth: 1,
			query: "nested",
		});
		const round = JSON.parse(JSON.stringify(ev));
		assert.equal(round.type, "Recurse");
		assert.equal(round.correlationId, "child-7");
		assert.equal(round.parentRunId, "root");
		assert.ok(isAgentEvent(round));
	});
});
