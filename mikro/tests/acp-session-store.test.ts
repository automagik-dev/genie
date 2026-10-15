/**
 * Durable ACP session store + disconnect-hardening gate — wish mikro-acp-adapter,
 * Group 3.
 *
 * Deterministic, no-LLM proofs for the three Group 3 invariants that a live
 * smoke cannot pin down precisely:
 *   1. RESTORE-ON-EMPTY: a session persisted by one `SessionStore` instance is
 *      rehydrated by a FRESH instance (simulating an agent-process restart) with
 *      its conversation history intact — the exact "Invalid params" bug fix.
 *   2. Bounded growth: per-turn field cap, per-file MAX_TURNS cap.
 *   3. Disconnect hardening: `abortActivePrompt` reuses the cooperative cancel
 *      path — aborts the turn AND closes the emitter — and is null-safe.
 *   4. Multi-turn threading: `buildConversationalQuery` folds prior turns in on a
 *      follow-up and is a pass-through on the first turn.
 *
 * The live `smoke-acp.mjs --multiturn` run is the end-to-end integration proof
 * (real LLM, real agent-process restart); this file is the fast unit proof.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	SessionStore,
	MAX_TURNS,
	MAX_SESSION_FILES,
	isValidSessionId,
	storeDir,
} from "../src/acp/session-store.js";
import { abortActivePrompt, buildConversationalQuery } from "../src/acp/agent.js";
import { createEmitter } from "../src/sdk/emitter.js";

let scratch: string;
const prevEnv = process.env.MIKRO_ACP_SESSIONS_DIR;

before(() => {
	scratch = mkdtempSync(join(tmpdir(), "mikro-acp-store-"));
	process.env.MIKRO_ACP_SESSIONS_DIR = scratch;
});

after(() => {
	if (prevEnv === undefined) delete process.env.MIKRO_ACP_SESSIONS_DIR;
	else process.env.MIKRO_ACP_SESSIONS_DIR = prevEnv;
	rmSync(scratch, { recursive: true, force: true });
});

describe("acp session store — restore-on-empty across a restart", () => {
	it("honors the MIKRO_ACP_SESSIONS_DIR override", () => {
		assert.equal(storeDir(), scratch);
	});

	it("a fresh store instance rehydrates a session persisted by another", async () => {
		const writer = new SessionStore();
		const id = "11111111-1111-1111-1111-111111111111";
		const created = await writer.create(id, "/abs/project", [], {
			provider: "station",
			model: "qwen3.5-2b-FLM",
		});
		await writer.appendTurn(created, "remember codeword BANANA47", "ok, BANANA47 noted");

		// Simulate an agent-process restart: a brand-new store, empty in-memory.
		const reader = new SessionStore();
		const restored = await reader.load(id);
		assert.ok(restored, "session must be restorable from disk after a restart");
		assert.equal(restored.cwd, "/abs/project");
		assert.equal(restored.turns.length, 1);
		assert.match(restored.turns[0].answer, /BANANA47/);
		assert.equal(restored.configSnapshot?.model, "qwen3.5-2b-FLM");
	});

	it("returns null for a never-created session (a genuine bad id)", async () => {
		const store = new SessionStore();
		const missing = await store.load("00000000-0000-0000-0000-000000000000");
		assert.equal(missing, null);
	});

	it("returns null for a corrupt session file rather than throwing", async () => {
		const { writeFileSync } = await import("node:fs");
		const id = "22222222-2222-2222-2222-222222222222";
		writeFileSync(join(scratch, `${id}.json`), "{ not json");
		const store = new SessionStore();
		assert.equal(await store.load(id), null);
	});
});

describe("acp session store — bounded growth", () => {
	it("caps a persisted turn field to a bounded length", async () => {
		const store = new SessionStore();
		const id = "33333333-3333-3333-3333-333333333333";
		const rec = await store.create(id, "/p", [], null);
		const huge = "x".repeat(200_000);
		await store.appendTurn(rec, huge, huge);
		const reloaded = await store.load(id);
		assert.ok(reloaded);
		// Far below the raw 200k input; marker appended.
		assert.ok(reloaded.turns[0].answer.length < 40_000);
		assert.match(reloaded.turns[0].answer, /truncated/);
	});

	it("retains only the most-recent MAX_TURNS turns", async () => {
		const store = new SessionStore();
		const id = "44444444-4444-4444-4444-444444444444";
		const rec = await store.create(id, "/p", [], null);
		for (let i = 0; i < MAX_TURNS + 5; i++) {
			await store.appendTurn(rec, `q${i}`, `a${i}`);
		}
		const reloaded = await store.load(id);
		assert.ok(reloaded);
		assert.equal(reloaded.turns.length, MAX_TURNS);
		// The oldest 5 dropped; the newest is retained.
		assert.equal(reloaded.turns[reloaded.turns.length - 1].query, `q${MAX_TURNS + 4}`);
		assert.equal(reloaded.turns[0].query, "q5");
	});

	it("prunes the store dir to MAX_SESSION_FILES, deleting the oldest by mtime", async () => {
		// Dedicated scratch dir so the cap experiment is isolated from other tests.
		const dir = mkdtempSync(join(tmpdir(), "mikro-acp-prune-"));
		const prev = process.env.MIKRO_ACP_SESSIONS_DIR;
		process.env.MIKRO_ACP_SESSIONS_DIR = dir;
		try {
			const store = new SessionStore();
			const idOf = (i: number) => `${String(i).padStart(8, "0")}-0000-0000-0000-000000000000`;

			// Fill to exactly the cap — no prune fires yet (entries <= MAX_SESSION_FILES).
			for (let i = 0; i < MAX_SESSION_FILES; i++) {
				await store.create(idOf(i), "/p", [], null);
			}
			assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, MAX_SESSION_FILES);

			// Stamp strictly-increasing mtimes so "oldest" is unambiguous: idOf(0) oldest.
			const base = Math.floor(Date.now() / 1000) - MAX_SESSION_FILES - 10;
			for (let i = 0; i < MAX_SESSION_FILES; i++) {
				const t = base + i;
				utimesSync(join(dir, `${idOf(i)}.json`), t, t);
			}

			// One more create tips over the cap → prune deletes the single oldest (idOf(0)).
			await store.create(idOf(MAX_SESSION_FILES), "/p", [], null);

			assert.equal(
				readdirSync(dir).filter((f) => f.endsWith(".json")).length,
				MAX_SESSION_FILES,
				"dir must be capped back to MAX_SESSION_FILES after the overflow create",
			);
			assert.equal(await store.load(idOf(0)), null, "the oldest-by-mtime session must be pruned");
			assert.ok(await store.load(idOf(1)), "the next-oldest must survive");
			assert.ok(await store.load(idOf(MAX_SESSION_FILES)), "the just-created newest must survive");
		} finally {
			if (prev === undefined) delete process.env.MIKRO_ACP_SESSIONS_DIR;
			else process.env.MIKRO_ACP_SESSIONS_DIR = prev;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("acp disconnect hardening — abortActivePrompt", () => {
	it("aborts the turn AND closes the emitter (cooperative cancel reuse)", () => {
		const abort = new AbortController();
		const emitter = createEmitter();
		const active = { sessionId: "s1", abort, emitter };
		assert.equal(abort.signal.aborted, false);
		assert.equal(emitter.closed, false);

		const hadActive = abortActivePrompt(active);
		assert.equal(hadActive, true);
		assert.equal(abort.signal.aborted, true, "turn must be aborted");
		assert.equal(emitter.closed, true, "emitter must be closed so drain unblocks");
	});

	it("is null-safe (no active prompt) and idempotent", () => {
		assert.equal(abortActivePrompt(null), false);
		const abort = new AbortController();
		const emitter = createEmitter();
		const active = { sessionId: "s2", abort, emitter };
		assert.equal(abortActivePrompt(active), true);
		// Second call must not throw and must keep state closed.
		assert.equal(abortActivePrompt(active), true);
		assert.equal(emitter.closed, true);
	});
});

describe("acp session store — path-traversal defense (final-gate finding)", () => {
	it("rejects non-UUID ids and accepts canonical UUID shapes", () => {
		assert.equal(isValidSessionId("11111111-1111-1111-1111-111111111111"), true);
		assert.equal(isValidSessionId("../escape"), false);
		assert.equal(isValidSessionId("../../../../tmp/pwned-write"), false);
		assert.equal(isValidSessionId(""), false);
		assert.equal(isValidSessionId("not-a-uuid"), false);
	});

	it("load('../escape') returns null and never reads a file outside the store dir", async () => {
		// Plant a StoredSession-shaped file OUTSIDE the store dir, one level up.
		const outside = join(dirname(scratch), "escape.json");
		writeFileSync(
			outside,
			JSON.stringify({
				version: 1,
				sessionId: "x",
				cwd: "/tmp",
				createdAt: "t",
				updatedAt: "t",
				mcpServers: [],
				configSnapshot: null,
				turns: [],
			}),
		);
		try {
			const store = new SessionStore();
			assert.equal(
				await store.load("../escape"),
				null,
				"a traversal id must not load the outside StoredSession-shaped file",
			);
		} finally {
			rmSync(outside, { force: true });
		}
	});

	it("rejects a poisoned internal-id record and never writes outside the store dir", async () => {
		// A valid-UUID-named file whose INTERNAL sessionId encodes traversal.
		const id = "55555555-5555-5555-5555-555555555555";
		const target = "/tmp/mikro-pwned-write";
		rmSync(`${target}.json`, { force: true });
		writeFileSync(
			join(scratch, `${id}.json`),
			JSON.stringify({
				version: 1,
				sessionId: `../../../../../../../../${target.slice(1)}`,
				cwd: "/p",
				createdAt: "t",
				updatedAt: "t",
				mcpServers: [],
				configSnapshot: null,
				turns: [],
			}),
		);
		const store = new SessionStore();
		// The internal-id mismatch is treated as corrupt → null.
		assert.equal(
			await store.load(id),
			null,
			"a record whose internal id != requested id must be refused",
		);
		// Defense in depth: even if a poisoned record reaches appendTurn, the
		// non-UUID internal id makes the write throw rather than escape the dir.
		const poisoned = {
			version: 1 as const,
			sessionId: `../../../../../../../../${target.slice(1)}`,
			cwd: "/p",
			createdAt: "t",
			updatedAt: "t",
			mcpServers: [],
			configSnapshot: null,
			turns: [] as { query: string; answer: string; timestamp: string }[],
		};
		await assert.rejects(
			() => store.appendTurn(poisoned, "q", "a"),
			/non-UUID sessionId/,
			"appendTurn on a poisoned record must throw, not write",
		);
		assert.equal(
			existsSync(`${target}.json`),
			false,
			"nothing may be written outside the store dir",
		);
	});
});

describe("acp multi-turn threading — buildConversationalQuery", () => {
	it("passes the query through unchanged on the first turn", () => {
		assert.equal(buildConversationalQuery([], "hello"), "hello");
	});

	it("folds prior turns into a follow-up prompt", () => {
		const turns = [{ query: "codeword is BANANA47", answer: "noted BANANA47" }];
		const out = buildConversationalQuery(turns, "what was the codeword?");
		assert.match(out, /BANANA47/, "prior-turn context must be present");
		assert.match(out, /what was the codeword\?/, "current query must be present");
		assert.match(out, /continuing conversation/i);
	});
});
