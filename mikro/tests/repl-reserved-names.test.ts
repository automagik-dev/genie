import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { REPL_RESERVED_NAMES } from "../src/repl.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function pythonReservedNames(source: string): string[] {
	const block = source.match(/RESERVED_NAMES\s*=\s*frozenset\(\{([\s\S]*?)\}\)/)?.[1];
	assert.ok(block, "repl_server.py must define RESERVED_NAMES as a frozenset literal");
	return [...block.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
}

function topLevelFunctionNames(source: string): string[] {
	return [...source.matchAll(/^def ([A-Za-z][A-Za-z0-9_]*)\s*\(/gm)].map(
		(match) => match[1],
	);
}

describe("REPL reserved names", () => {
	it("matches Python runtime and all battery top-level functions", async () => {
		const [server, batteries, gemini, pg] = await Promise.all([
			readFile(join(root, "python", "repl_server.py"), "utf8"),
			readFile(join(root, "python", "batteries.py"), "utf8"),
			readFile(join(root, "python", "gemini_batteries.py"), "utf8"),
			readFile(join(root, "python", "pg_batteries.py"), "utf8"),
		]);

		const expected = new Set([
			...pythonReservedNames(server),
			...topLevelFunctionNames(batteries),
			...topLevelFunctionNames(gemini),
			...topLevelFunctionNames(pg),
		]);

		assert.deepEqual([...REPL_RESERVED_NAMES].sort(), [...expected].sort());
		assert.equal(REPL_RESERVED_NAMES.has("call_tool"), true);
	});
});
