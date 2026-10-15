#!/usr/bin/env node
/**
 * Headless event-stream subscriber — Wish B live-tui Group 2.
 *
 * The reference consumer of the live event stream and the terminal
 * acceptance gate. It subscribes to a `createEmitter()` bus BEFORE the run
 * starts (the contractual `rlmLoop({ emitter })` seam), logs ONE COMPACT
 * JSON LINE PER EVENT to stdout (so `"type"` is greppable), and after the
 * stream closes reconstructs the recursion tree by `correlationId` /
 * `parentRunId` (NOT depth — depth cannot disambiguate sibling branches).
 * The tree is printed to stderr so stdout stays a pure event log.
 *
 * The same subscription shape is what the mikro-acp adapter (web client) and
 * pi's native TUI consume — this ships events, not a renderer.
 *
 * Modes:
 *   • REAL  (MIKRO_HEADLESS_REAL=1): loads the project config from cwd and
 *     runs the real `rlmLoop(prompt, null, config, { emitter })`. Requires a
 *     working model endpoint / provider credentials.
 *   • STUB  (default): drives the recursion bridge deterministically to
 *     emit a >=2-level recursive run with SIBLING branches at two levels —
 *     what a collector aggregating the process tree would observe. Proves
 *     the stream + ancestry with no credentials.
 *
 * Usage:
 *   node scripts/watch-headless.mjs -- "<a recursive prompt>"
 *   node scripts/watch-headless.mjs -- "<prompt>" | grep -c '"type":"Recurse"'
 */

import { fileURLToPath, pathToFileURL } from "node:url";

const sdkUrl = new URL("../dist/src/sdk/index.js", import.meta.url);
const { createEmitter, createRecursionBridge, makeEvent } = await import(sdkUrl);

// ── args: everything after `--` (or all args) is the prompt ──────────
const argv = process.argv.slice(2);
const dashIdx = argv.indexOf("--");
const promptParts = dashIdx === -1 ? argv : argv.slice(dashIdx + 1);
const prompt = promptParts.join(" ").trim() || "Decompose this into sub-questions and recurse.";

/** Project a full AgentEvent down to a compact, greppable one-liner. */
function compact(ev) {
	const base = { type: ev.type, correlationId: ev.correlationId, parentRunId: ev.parentRunId };
	switch (ev.type) {
		case "Recurse":
			return { ...base, depth: ev.depth, parentDepth: ev.parentDepth, iteration: ev.iteration, query: preview(ev.query, 80) };
		case "IterationOutput":
			return { ...base, iteration: ev.iteration, responseModel: ev.responseModel, metrics: ev.metrics, output: preview(ev.output, 80) };
		case "IterationStart":
			return { ...base, iteration: ev.iteration };
		case "ToolCallBefore":
			return { ...base, iteration: ev.iteration, tool: ev.tool };
		case "ToolCallAfter":
			return { ...base, iteration: ev.iteration, tool: ev.tool, ok: ev.ok, durationMs: ev.durationMs };
		case "Error":
			return { ...base, phase: ev.phase, error: ev.error?.message };
		case "EmitDone":
			return { ...base, payload: ev.payload };
		default:
			return base;
	}
}

function preview(s, n) {
	const str = String(s ?? "");
	return str.length > n ? `${str.slice(0, n)}…` : str;
}

/** Consume the stream: print a compact line per event, keep events for the tree. */
async function drain(stream) {
	const events = [];
	for await (const ev of stream) {
		events.push(ev);
		process.stdout.write(`${JSON.stringify(compact(ev))}\n`);
	}
	return events;
}

/**
 * Reconstruct the recursion tree keyed on correlationId. Each RecurseEvent
 * is an edge parentRunId -> correlationId; each bridged IterationOutput
 * carries the child node's metrics. Siblings of one parent are distinct
 * because each spawn mints its own uuidv7 correlationId.
 */
function reconstructTree(events) {
	const children = new Map(); // parentRunId -> [correlationId]
	const label = new Map(); // correlationId -> descriptor
	const roots = new Set();

	for (const ev of events) {
		if (ev.type === "Recurse") {
			const id = ev.correlationId;
			const parent = ev.parentRunId ?? "(root)";
			if (!children.has(parent)) children.set(parent, []);
			children.get(parent).push(id);
			label.set(id, { query: preview(ev.query, 60), depth: ev.depth });
			roots.add(parent);
		}
		if (ev.type === "IterationOutput" && ev.metrics && ev.correlationId) {
			const prev = label.get(ev.correlationId) ?? {};
			label.set(ev.correlationId, {
				...prev,
				cost: ev.metrics.costUsd,
				tokens: ev.metrics.tokens,
				latencyMs: ev.metrics.latencyMs,
			});
		}
	}

	// A root is any parent that is not itself a child of something else.
	const asChild = new Set([...label.keys()]);
	const treeRoots = [...roots].filter((r) => !asChild.has(r));

	const lines = [];
	const walk = (id, indent) => {
		const meta = label.get(id);
		const desc = meta
			? `${meta.query ?? ""}  [depth=${meta.depth ?? "?"}${meta.cost !== undefined ? `, cost=$${meta.cost}` : ""}${meta.tokens ? `, tok=${meta.tokens.input}/${meta.tokens.output}` : ""}${meta.latencyMs !== undefined ? `, ${meta.latencyMs}ms` : ""}]`
			: "";
		lines.push(`${"  ".repeat(indent)}${indent === 0 ? "" : "└─ "}${id} ${desc}`.trimEnd());
		for (const c of children.get(id) ?? []) walk(c, indent + 1);
	};
	for (const r of treeRoots) walk(r, 0);
	return lines.join("\n");
}

async function runStub(emitter) {
	// Deterministic >=2-level recursion with sibling branches at two levels,
	// modelling what a collector aggregating the process tree observes:
	//   (root) ─ A ─ A1
	//          │   └ A2
	//          └ B
	const mkResult = (input, output, cost) => ({
		answer: `stub answer ${input}/${output}`,
		usage: { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: cost, llmCalls: 1 },
	});
	let rootIter = 2;
	const root = createRecursionBridge({ emitter, sessionId: "root", currentIteration: () => rootIter });
	const a = createRecursionBridge({ emitter, sessionId: "A", currentIteration: () => 1 });

	// Bracket the root run with the same lifecycle events a real run emits.
	emitter.emit(makeEvent("AgentStart", { agentId: "stub/model", sessionId: "root", correlationId: "root", config: { prompt } }));
	emitter.emit(makeEvent("SessionOpen", { sessionId: "root", correlationId: "root", resumed: false }));
	emitter.emit(makeEvent("IterationStart", { sessionId: "root", correlationId: "root", iteration: rootIter }));

	root.onChildStart({ correlationId: "A", prompt: "sub-question A: gather sources", depth: 1 });
	root.onChildStart({ correlationId: "B", prompt: "sub-question B: cross-check", depth: 1 });
	a.onChildStart({ correlationId: "A1", prompt: "A subtask 1: fetch", depth: 2 });
	a.onChildStart({ correlationId: "A2", prompt: "A subtask 2: summarize", depth: 2 });

	a.onChildEnd({ correlationId: "A1", depth: 2, result: mkResult(10, 5, 0.01), durationMs: 12 });
	a.onChildEnd({ correlationId: "A2", depth: 2, result: mkResult(20, 8, 0.02), durationMs: 21 });
	root.onChildEnd({ correlationId: "A", depth: 1, result: mkResult(40, 20, 0.05), durationMs: 130 });
	root.onChildEnd({ correlationId: "B", depth: 1, result: mkResult(0, 0, 0), durationMs: 8, isError: true, errorMessage: "child mikro exited with code 1" });

	emitter.emit(makeEvent("EmitDone", { sessionId: "root", correlationId: "root", payload: { answer: "stub synthesis of A + B" } }));
	emitter.emit(makeEvent("SessionClose", { sessionId: "root", correlationId: "root", reason: "complete" }));
	emitter.close();
}

async function runReal(emitter) {
	const cwd = process.cwd();
	// Recursive children spawn process.execPath + process.argv[1]; here argv[1]
	// is this subscriber script, so point it at the real CLI instead.
	process.argv[1] = fileURLToPath(new URL("../dist/src/cli.js", import.meta.url));
	const { rlmLoop } = await import(new URL("../dist/src/rlm.js", import.meta.url));
	const { loadConfig } = await import(new URL("../dist/src/config.js", import.meta.url));
	const config = await loadConfig(cwd);
	// Fire the run WITHOUT awaiting first so the subscriber (already attached)
	// streams live; the emitter closes when the run finishes.
	const done = rlmLoop(prompt, null, config, { emitter, output: "json" });
	return done;
}

// ── main ─────────────────────────────────────────────────────────────
const emitter = createEmitter();
const events = drain(emitter); // subscribe BEFORE the run starts

const real = process.env.MIKRO_HEADLESS_REAL === "1";
process.stderr.write(`# watch-headless: mode=${real ? "REAL" : "STUB"} prompt=${JSON.stringify(preview(prompt, 60))}\n`);

let runPromise;
try {
	runPromise = real ? runReal(emitter) : runStub(emitter);
} catch (err) {
	process.stderr.write(`# watch-headless: run failed to start: ${err?.message ?? err}\n`);
	emitter.close();
	runPromise = Promise.resolve();
}

const collected = await events;
await Promise.resolve(runPromise).catch(() => {});

// Reconstruct + print the tree to stderr (stdout stays a pure event log).
const recurseCount = collected.filter((e) => e.type === "Recurse").length;
process.stderr.write(`\n# recursion tree (${recurseCount} spawn${recurseCount === 1 ? "" : "s"}, keyed on correlationId):\n`);
process.stderr.write(`${reconstructTree(collected)}\n`);
