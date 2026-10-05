import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { THINKING_LEVELS } from "../src/gemini.js";
import { loadAgentSpec, parseAgentSpec } from "../src/sdk/index.js";

describe("parseAgentSpec — agent.yaml parser (G3a)", () => {
	const DIR = "/tmp/fake-agent";

	it("parses the minimal wish-A shape (triage example)", () => {
		const text = `
schema_version: 1
tools_api: 1
shape: single-step
model: gemini-3.1-flash-lite-preview
tools:
  - read
  - emit_done
scope:
  reads:
    - Conversas/*
budget:
  max_cost: 0.01
  max_iterations: 5
`;
		const spec = parseAgentSpec(text, DIR);
		assert.equal(spec.dir, DIR);
		assert.equal(spec.schemaVersion, 1);
		assert.equal(spec.toolsApi, 1);
		assert.equal(spec.shape, "single-step");
		assert.equal(spec.model, "gemini-3.1-flash-lite-preview");
		assert.deepEqual([...spec.tools], ["read", "emit_done"]);
		assert.deepEqual([...(spec.scope?.reads ?? [])], ["Conversas/*"]);
		assert.equal(spec.budget?.maxCost, 0.01);
		assert.equal(spec.budget?.maxIterations, 5);
	});

	it("defaults schema_version / tools_api / shape when absent", () => {
		const text = `model: gemini-2.5-flash\n`;
		const spec = parseAgentSpec(text, DIR);
		assert.equal(spec.schemaVersion, 1);
		assert.equal(spec.toolsApi, 1);
		assert.equal(spec.shape, "single-step");
	});

	it("rejects invalid shape", () => {
		const text = `shape: multi-step\n`;
		assert.throws(() => parseAgentSpec(text, DIR), /shape must be one of/);
	});

	it("rejects non-mapping YAML", () => {
		assert.throws(
			() => parseAgentSpec("just a string\n", DIR),
			/mapping at the top level/,
		);
		assert.throws(() => parseAgentSpec("- a\n- b\n", DIR), /mapping at the top level/);
	});

	it("ignores empty tool names in the list", () => {
		const text = `tools:\n  - ok\n  - ""\n  - also-ok\n`;
		const spec = parseAgentSpec(text, DIR);
		assert.deepEqual([...spec.tools], ["ok", "also-ok"]);
	});

	it("preserves unrecognised keys in extras", () => {
		const text = `model: x\ncustom_flag: true\nnested:\n  a: 1\n`;
		const spec = parseAgentSpec(text, DIR);
		assert.equal(spec.extras.custom_flag, true);
		assert.deepEqual(spec.extras.nested, { a: 1 });
	});

	it("handles camelCase + snake_case equivalently for schema fields", () => {
		const a = parseAgentSpec(
			"schema_version: 2\ntools_api: 3\n",
			DIR,
		);
		const b = parseAgentSpec(
			"schemaVersion: 2\ntoolsApi: 3\n",
			DIR,
		);
		assert.equal(a.schemaVersion, 2);
		assert.equal(a.toolsApi, 3);
		assert.equal(b.schemaVersion, 2);
		assert.equal(b.toolsApi, 3);
	});

	it("returns undefined scope/budget when the sections are empty", () => {
		const spec = parseAgentSpec("tools: []\n", DIR);
		assert.equal(spec.scope, undefined);
		assert.equal(spec.budget, undefined);
	});
});

/**
 * `thinking:` — per-agent reasoning effort, the agent.yaml twin of
 * `mikro --thinking`.
 *
 * Validated rather than passed through because a bad level has no safe
 * fallback: pi-ai clamps an unrecognised value to *some* level the model
 * supports instead of rejecting it, so `thinking: hgih` would quietly run at
 * whatever effort that model floors at and look like it worked. The parser runs
 * at discovery time for `mikro mcp`, so failing here is what surfaces the typo.
 */
describe("parseAgentSpec — thinking:", () => {
	const DIR = "/tmp/fake-agent";

	it("accepts every valid ThinkingLevel", () => {
		for (const level of THINKING_LEVELS) {
			const spec = parseAgentSpec(`thinking: ${level}\n`, DIR);
			assert.equal(spec.thinking, level, `expected ${level} to parse`);
		}
	});

	it("leaves thinking undefined when the key is absent", () => {
		const spec = parseAgentSpec("shape: loop\n", DIR);
		assert.equal(spec.thinking, undefined);
	});

	it("rejects an invalid level and names the allowed set", () => {
		assert.throws(
			() => parseAgentSpec("thinking: hgih\n", DIR),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.match(err.message, /agent\.yaml: thinking must be one of/);
				// The message has to name the alternatives — "invalid" alone leaves
				// the author guessing at the spelling.
				for (const level of THINKING_LEVELS) {
					assert.match(err.message, new RegExp(level));
				}
				assert.match(err.message, /got "hgih"/);
				return true;
			},
		);
	});

	it("rejects levels pi-ai knows but mikro does not expose", () => {
		// pi-ai's own ThinkingLevel adds "xhigh" and "max", reachable only on
		// models that declare an explicit map entry for them. mikro's type is
		// narrower, so agent.yaml must not accept them either.
		for (const level of ["xhigh", "max", "off", "none"]) {
			assert.throws(
				() => parseAgentSpec(`thinking: ${level}\n`, DIR),
				/thinking must be one of/,
				`expected "${level}" to be rejected`,
			);
		}
	});

	it("does not leave thinking in the extras bag", () => {
		// Regression guard: before this field existed `thinking:` parsed fine,
		// landed on extras, and was read by nobody — an agent could declare a
		// level and silently not get it.
		const spec = parseAgentSpec("thinking: high\n", DIR);
		assert.equal(spec.extras.thinking, undefined);
		assert.deepEqual(Object.keys(spec.extras), []);
	});

	it("ignores a non-string thinking value rather than throwing", () => {
		// Type drift defaults silently everywhere else in this parser; only a
		// *string* that is not a level is a typo worth rejecting.
		assert.equal(parseAgentSpec("thinking: 3\n", DIR).thinking, undefined);
		assert.equal(parseAgentSpec("thinking: null\n", DIR).thinking, undefined);
	});
});

/**
 * `temperature:` — per-agent sampling temperature, the agent.yaml twin of
 * `mikro --temperature` and of mikro.yaml's top-level `temperature:`.
 *
 * Validated rather than ignored for the same reason as `thinking:` — a
 * declaration that quietly falls back to the ambient value looks exactly like a
 * working pin — with one extra hazard the other fields don't have: `0` is a
 * *meaningful* value here, so the parser must not treat it as absent.
 */
describe("parseAgentSpec — temperature:", () => {
	const DIR = "/tmp/fake-agent";

	it("parses an exact zero as zero, not as unset", () => {
		// Greedy decoding. The one value a truthiness check silently eats, and
		// the one a committee gate pinning sampling drift reaches for first.
		const spec = parseAgentSpec("temperature: 0\n", DIR);
		assert.equal(spec.temperature, 0);
		assert.notEqual(spec.temperature, undefined);
	});

	it("parses fractional and boundary values", () => {
		assert.equal(parseAgentSpec("temperature: 0.7\n", DIR).temperature, 0.7);
		assert.equal(parseAgentSpec("temperature: 1\n", DIR).temperature, 1);
		assert.equal(parseAgentSpec("temperature: 2\n", DIR).temperature, 2);
	});

	it("leaves temperature undefined when the key is absent", () => {
		assert.equal(parseAgentSpec("shape: loop\n", DIR).temperature, undefined);
	});

	it("treats an explicit null as unset", () => {
		assert.equal(parseAgentSpec("temperature: null\n", DIR).temperature, undefined);
	});

	it("rejects an out-of-range value and shows what it got", () => {
		assert.throws(
			() => parseAgentSpec("temperature: 2.5\n", DIR),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.match(
					err.message,
					/agent\.yaml: temperature must be a number between 0 and 2/,
				);
				assert.match(err.message, /got 2\.5/);
				return true;
			},
		);
		assert.throws(
			() => parseAgentSpec("temperature: -1\n", DIR),
			/agent\.yaml: temperature must be a number between 0 and 2/,
		);
	});

	it("rejects a non-number rather than defaulting to the ambient value", () => {
		// Unlike `thinking:`, type drift is NOT waved through here: a
		// `temperature: hot` that silently inherited the ambient temperature is
		// indistinguishable from a working pin, and pinning is the whole point.
		assert.throws(
			() => parseAgentSpec("temperature: hot\n", DIR),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.match(err.message, /agent\.yaml: temperature must be a number/);
				assert.match(err.message, /got "hot"/);
				return true;
			},
		);
	});

	it("rejects .inf, which YAML parses as a number but no range check catches", () => {
		// `Infinity >= 0 && Infinity <= 2` is false, so the range test alone
		// would happen to catch this one — but `NaN` fails *both* comparisons,
		// so the finite check is what actually holds the line. Pin both.
		assert.throws(
			() => parseAgentSpec("temperature: .inf\n", DIR),
			/agent\.yaml: temperature must be a number/,
		);
		assert.throws(
			() => parseAgentSpec("temperature: .nan\n", DIR),
			/agent\.yaml: temperature must be a number/,
		);
	});

	it("does not leave temperature in the extras bag", () => {
		// Regression guard, same as `thinking:` and `prompt:`: a key that parses
		// but lands on extras is read by nobody, so the agent declares a
		// temperature and silently does not get it.
		const spec = parseAgentSpec("temperature: 0\n", DIR);
		assert.equal(spec.extras.temperature, undefined);
		assert.deepEqual(Object.keys(spec.extras), []);
	});
});

/**
 * `prompt.append-stop-protocol:` — per-agent opt-out from the FINAL/repl
 * termination protocol mikro appends to a custom system prompt.
 *
 * Kebab-case is the documented spelling (it matches mikro.yaml); snake_case and
 * camelCase are accepted the way `budget:` accepts both of its own. A
 * non-boolean throws rather than defaulting, because silently keeping the
 * default here would look exactly like a working opt-out.
 */
describe("parseAgentSpec — prompt.append-stop-protocol:", () => {
	const DIR = "/tmp/fake-agent";

	it("accepts the kebab, snake and camel spellings", () => {
		for (const key of [
			"append-stop-protocol",
			"append_stop_protocol",
			"appendStopProtocol",
		]) {
			const spec = parseAgentSpec(`prompt:\n  ${key}: false\n`, DIR);
			assert.equal(
				spec.prompt?.appendStopProtocol,
				false,
				`expected ${key} to parse`,
			);
		}
	});

	it("parses an explicit true", () => {
		const spec = parseAgentSpec("prompt:\n  append-stop-protocol: true\n", DIR);
		assert.equal(spec.prompt?.appendStopProtocol, true);
	});

	it("leaves prompt undefined when the block is absent", () => {
		const spec = parseAgentSpec("shape: loop\n", DIR);
		assert.equal(spec.prompt, undefined);
	});

	it("leaves prompt undefined for an empty prompt block", () => {
		const spec = parseAgentSpec("prompt: {}\n", DIR);
		assert.equal(spec.prompt, undefined);
	});

	it("rejects a non-boolean value and shows what it got", () => {
		assert.throws(
			() => parseAgentSpec("prompt:\n  append-stop-protocol: yes please\n", DIR),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.match(
					err.message,
					/agent\.yaml: prompt\.append-stop-protocol must be true or false/,
				);
				assert.match(err.message, /got "yes please"/);
				return true;
			},
		);
	});

	it("does not leave prompt in the extras bag", () => {
		// Regression guard, same as `thinking:`: a key that parses but lands on
		// extras is read by nobody — the agent would declare the opt-out and
		// silently not get it.
		const spec = parseAgentSpec("prompt:\n  append-stop-protocol: false\n", DIR);
		assert.equal(spec.extras.prompt, undefined);
		assert.deepEqual(Object.keys(spec.extras), []);
	});
});

describe("loadAgentSpec — filesystem wrapper (G3a)", () => {
	let dir = "";
	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "agent-spec-"));
	});
	after(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("reads agent.yaml from the given dir + resolves to absolute", async () => {
		await writeFile(
			join(dir, "agent.yaml"),
			"model: gemini-2.5-flash\ntools: [a, b]\n",
			"utf8",
		);
		const spec = await loadAgentSpec(dir);
		assert.equal(spec.dir, dir);
		assert.equal(spec.model, "gemini-2.5-flash");
		assert.deepEqual([...spec.tools], ["a", "b"]);
	});

	it("throws a useful error when agent.yaml is missing", async () => {
		const missing = join(dir, "no-such-sub");
		await assert.rejects(loadAgentSpec(missing));
	});
});
