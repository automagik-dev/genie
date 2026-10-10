import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createEmitter, createFileSessionStore, isSessionState, pauseAgent, resumeAgent, } from "../src/sdk/index.js";
function fixtureState(sessionId, overrides = {}) {
    return {
        sessionId,
        iteration: 3,
        history: [
            { role: "user", content: "what is 2+2" },
            { role: "assistant", content: "4" },
        ],
        budget: { spent: 0.012, limit: 1.0, currency: "usd" },
        createdAt: "2026-04-22T15:00:00.000Z",
        updatedAt: "2026-04-22T15:01:00.000Z",
        ...overrides,
    };
}
async function collectUpTo(iter, n) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const { value, done } = await iter.next();
        if (done)
            break;
        out.push(value);
    }
    return out;
}
describe("SDK session — file-backed store (Wish B Group 2)", () => {
    let dir = "";
    before(async () => {
        dir = await mkdtemp(join(tmpdir(), "mikro-session-"));
    });
    after(async () => {
        if (dir)
            await rm(dir, { recursive: true, force: true });
    });
    it("save + load roundtrips a session unchanged", async () => {
        const store = createFileSessionStore(dir);
        const state = fixtureState("s-roundtrip");
        await store.save(state);
        const loaded = await store.load("s-roundtrip");
        assert.ok(loaded);
        assert.deepEqual(loaded, state);
    });
    it("load returns null for an unknown session", async () => {
        const store = createFileSessionStore(dir);
        assert.equal(await store.load("never-existed"), null);
    });
    it("delete is idempotent + subsequent load returns null", async () => {
        const store = createFileSessionStore(dir);
        await store.save(fixtureState("s-del"));
        await store.delete("s-del");
        await store.delete("s-del"); // idempotent
        assert.equal(await store.load("s-del"), null);
    });
    it("list enumerates saved sessions by id", async () => {
        const store = createFileSessionStore(dir);
        await store.save(fixtureState("s-list-a"));
        await store.save(fixtureState("s-list-b"));
        const ids = await store.list();
        assert.ok(ids.includes("s-list-a"));
        assert.ok(ids.includes("s-list-b"));
    });
    it("save is atomic — no .tmp files linger after success", async () => {
        const store = createFileSessionStore(dir);
        await store.save(fixtureState("s-atomic"));
        const entries = await readdir(dir);
        assert.equal(entries.some((e) => e.includes(".tmp-")), false, "tmp files must be cleaned up by rename");
    });
    it("isSessionState rejects malformed payloads", () => {
        assert.equal(isSessionState(null), false);
        assert.equal(isSessionState({}), false);
        assert.equal(isSessionState({ sessionId: "", iteration: 1, history: [] }), false, "empty sessionId rejected");
        assert.equal(isSessionState({
            sessionId: "ok",
            iteration: "three",
            history: [],
            budget: { spent: 0, limit: 1, currency: "usd" },
            createdAt: "t",
            updatedAt: "t",
        }), false, "non-integer iteration rejected");
    });
    it("save throws on non-SessionState input", async () => {
        const store = createFileSessionStore(dir);
        await assert.rejects(store.save({ sessionId: "bad" }), /invalid SessionState/);
    });
});
describe("resumeAgent + pauseAgent — public API (Wish B Group 2)", () => {
    let dir = "";
    before(async () => {
        dir = await mkdtemp(join(tmpdir(), "mikro-resume-"));
    });
    after(async () => {
        if (dir)
            await rm(dir, { recursive: true, force: true });
    });
    it("resumeAgent returns null for a fresh id + emits SessionOpen{resumed:false}", async () => {
        const store = createFileSessionStore(dir);
        const em = createEmitter();
        const sub = em.subscribe();
        const result = await resumeAgent("fresh-id", store, em);
        assert.equal(result, null);
        const [event] = await collectUpTo(sub, 1);
        assert.ok(event);
        assert.equal(event?.type, "SessionOpen");
        assert.equal(event?.resumed, false);
    });
    it("pauseAgent persists state + emits SessionClose with the given reason", async () => {
        const store = createFileSessionStore(dir);
        const em = createEmitter();
        const sub = em.subscribe();
        const state = fixtureState("s-pause");
        await pauseAgent(state, store, "pause", em);
        const [event] = await collectUpTo(sub, 1);
        assert.equal(event?.type, "SessionClose");
        assert.equal(event?.reason, "pause");
        const reloaded = await store.load("s-pause");
        assert.ok(reloaded);
        assert.equal(reloaded?.sessionId, "s-pause");
    });
    it("resumeAgent finds a prior snapshot + emits SessionOpen{resumed:true}", async () => {
        const store = createFileSessionStore(dir);
        await store.save(fixtureState("s-existing"));
        const em = createEmitter();
        const sub = em.subscribe();
        const result = await resumeAgent("s-existing", store, em);
        assert.ok(result);
        assert.equal(result?.sessionId, "s-existing");
        const [event] = await collectUpTo(sub, 1);
        assert.equal(event?.type, "SessionOpen");
        assert.equal(event?.resumed, true);
    });
    it("budget is preserved across pause → resume (WISH.md G2 criterion 4)", async () => {
        const store = createFileSessionStore(dir);
        const original = fixtureState("s-budget", {
            budget: { spent: 0.42, limit: 1.0, currency: "usd" },
        });
        await pauseAgent(original, store, "pause");
        const loaded = await resumeAgent("s-budget", store);
        assert.ok(loaded);
        assert.deepEqual(loaded?.budget, original.budget);
    });
    it("pauseAgent updates updatedAt + saves stamped state", async () => {
        const store = createFileSessionStore(dir);
        const state = fixtureState("s-stamp", {
            updatedAt: "2020-01-01T00:00:00.000Z",
        });
        await pauseAgent(state, store, "complete");
        const loaded = await store.load("s-stamp");
        assert.ok(loaded);
        // updatedAt should be newer than the fixture's 2020 value.
        assert.notEqual(loaded?.updatedAt, "2020-01-01T00:00:00.000Z");
        assert.ok(new Date(loaded?.updatedAt ?? 0).getTime() > Date.now() - 60_000);
    });
});
//# sourceMappingURL=sdk-session.test.js.map