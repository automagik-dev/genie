import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEmitter, makeEvent, } from "../src/sdk/index.js";
function iterStart(sessionId, iteration) {
    return makeEvent("IterationStart", {
        sessionId,
        iteration,
    });
}
async function collect(iter, count) {
    const out = [];
    for (let i = 0; i < count; i++) {
        const { value, done } = await iter.next();
        if (done)
            break;
        out.push(value);
    }
    return out;
}
describe("SDK emitter — async-iterator contract (Wish B Group 1)", () => {
    it("delivers emitted events to a subscriber in order", async () => {
        const em = createEmitter();
        const sub = em.subscribe();
        em.emit(iterStart("s1", 1));
        em.emit(iterStart("s1", 2));
        em.emit(iterStart("s1", 3));
        const got = await collect(sub, 3);
        assert.equal(got.length, 3);
        assert.equal(got[0].iteration, 1);
        assert.equal(got[2].iteration, 3);
    });
    it("buffers events emitted before the first subscribe()", async () => {
        const em = createEmitter();
        em.emit(iterStart("s1", 1));
        em.emit(iterStart("s1", 2));
        const sub = em.subscribe();
        const got = await collect(sub, 2);
        assert.equal(got.length, 2);
    });
    it("pre-subscribe buffer only replays to the first subscriber (no double-deliver)", async () => {
        const em = createEmitter();
        em.emit(iterStart("s1", 1));
        const first = em.subscribe();
        const firstEvents = await collect(first, 1);
        assert.equal(firstEvents.length, 1);
        // Second subscriber should NOT receive the pre-subscribe event.
        const second = em.subscribe();
        em.emit(iterStart("s1", 2));
        const secondEvents = await collect(second, 1);
        assert.equal(secondEvents.length, 1);
        assert.equal(secondEvents[0].iteration, 2);
    });
    it("fan-outs post-subscribe events to every active subscriber", async () => {
        const em = createEmitter();
        const a = em.subscribe();
        const b = em.subscribe();
        em.emit(iterStart("s1", 7));
        const [ea] = await collect(a, 1);
        const [eb] = await collect(b, 1);
        assert.ok(ea && eb);
        assert.equal(ea.iteration, 7);
        assert.equal(eb.iteration, 7);
    });
    it("close() terminates pending iterator pulls with done:true", async () => {
        const em = createEmitter();
        const sub = em.subscribe();
        const pending = sub.next();
        em.close();
        const result = await pending;
        assert.equal(result.done, true);
        assert.equal(em.closed, true);
    });
    it("close() is idempotent + post-close emits are dropped silently", async () => {
        const em = createEmitter();
        em.close();
        em.close(); // second close must not throw
        em.emit(iterStart("s1", 1)); // dropped
        const sub = em.subscribe();
        const { done } = await sub.next();
        assert.equal(done, true);
    });
    it("await-then-emit flow works (pull before push)", async () => {
        const em = createEmitter();
        const sub = em.subscribe();
        const pull = sub.next();
        // Emit after subscriber has called .next() — the pending promise
        // must resolve with the event.
        queueMicrotask(() => em.emit(iterStart("s1", 99)));
        const res = await pull;
        assert.equal(res.done, false);
        assert.equal(res.value.iteration, 99);
    });
    it("is directly iterable via `for await`", async () => {
        const em = createEmitter();
        em.emit(iterStart("s1", 1));
        em.emit(iterStart("s1", 2));
        em.close();
        const collected = [];
        for await (const ev of em) {
            collected.push(ev);
        }
        assert.equal(collected.length, 2);
    });
    it("caps the pre-subscribe backlog so a no-subscriber run stays bounded", async () => {
        // Gap 2 regression: on the default (internal-emitter) path nobody
        // subscribes, so without a cap every event — incl. untruncated REPL
        // code/stdout — would accumulate for the whole run. The backlog is
        // bounded; a late subscriber still replays the retained opening events.
        const em = createEmitter();
        const TOTAL = 5000;
        for (let i = 0; i < TOTAL; i++)
            em.emit(iterStart("s1", i));
        const sub = em.subscribe();
        em.close();
        const got = await collect(sub, TOTAL);
        assert.ok(got.length < TOTAL, `backlog must be capped, got ${got.length} of ${TOTAL}`);
        assert.ok(got.length > 0, "opening events are still retained");
        // The retained events are the run's OPENING events, in order.
        assert.equal(got[0].iteration, 0);
    });
    it("iterator.return() cleanly exits the subscriber", async () => {
        const em = createEmitter();
        const sub = em.subscribe();
        em.emit(iterStart("s1", 1));
        const first = await sub.next();
        assert.equal(first.done, false);
        // Simulate early break from `for await` — the runtime calls return().
        const retRes = await (sub.return ? sub.return() : Promise.resolve({
            value: undefined,
            done: true,
        }));
        assert.equal(retRes.done, true);
        // Next pull after return() should also yield done:true.
        const after = await sub.next();
        assert.equal(after.done, true);
    });
});
//# sourceMappingURL=sdk-emitter.test.js.map