import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createToolRegistry,
	type ToolHandler,
	toolRegistryAsResolver,
	UnknownToolError,
} from "../src/sdk/index.js";

const ok: ToolHandler = async () => "ok";

describe("createToolRegistry — registry contract (G3a)", () => {
	it("register + get + has roundtrip", () => {
		const r = createToolRegistry();
		assert.equal(r.has("x"), false);
		assert.equal(r.get("x"), undefined);
		r.register("x", ok);
		assert.equal(r.has("x"), true);
		assert.equal(typeof r.get("x"), "function");
	});

	it("list reflects registration order", () => {
		const r = createToolRegistry();
		r.register("b", ok);
		r.register("a", ok);
		r.register("c", ok);
		assert.deepEqual([...r.list()], ["b", "a", "c"]);
	});

	it("rejects empty tool names", () => {
		const r = createToolRegistry();
		assert.throws(() => r.register("", ok), /non-empty/);
	});

	it("register overrides an existing handler (same name)", () => {
		const r = createToolRegistry();
		const first: ToolHandler = async () => "first";
		const second: ToolHandler = async () => "second";
		r.register("dup", first);
		r.register("dup", second);
		assert.equal(r.get("dup"), second);
	});

	it("override only replaces when the name already exists", () => {
		const r = createToolRegistry();
		r.register("a", ok);
		assert.equal(r.override("a", async () => "new"), true);
		assert.equal(r.override("b", async () => "new"), false);
		assert.equal(r.has("b"), false);
	});
});

describe("toolRegistryAsResolver — shim to ToolResolver (G3a)", () => {
	it("dispatches to the registered handler + passes args through", async () => {
		const r = createToolRegistry();
		const seen: unknown[] = [];
		r.register("echo", async (args) => {
			seen.push(args);
			return args;
		});
		const resolver = toolRegistryAsResolver(r);
		const result = await resolver("echo", { hi: 1 }, new AbortController().signal);
		assert.deepEqual(result, { hi: 1 });
		assert.deepEqual(seen[0], { hi: 1 });
	});

	it("throws UnknownToolError for missing tools", async () => {
		const r = createToolRegistry();
		const resolver = toolRegistryAsResolver(r);
		await assert.rejects(
			resolver("missing", {}, new AbortController().signal),
			(err: unknown) => {
				assert.ok(err instanceof UnknownToolError);
				assert.equal((err as UnknownToolError).toolName, "missing");
				return true;
			},
		);
	});
});
