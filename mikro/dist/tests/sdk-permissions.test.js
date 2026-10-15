import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALLOW, composeHooks, runPermissionChain, } from "../src/sdk/index.js";
const CTX = {
    tool: "read_file",
    args: { path: "/etc/hosts" },
    sessionId: "s1",
    iteration: 1,
    history: [{ role: "user", content: "peek at hosts" }],
};
describe("SDK permissions — hook chain (Wish B Group 2)", () => {
    it("empty chain → ALLOW sentinel", async () => {
        const result = await runPermissionChain([], CTX);
        assert.equal(result, ALLOW);
        assert.equal(result.decision, "allow");
    });
    it("single allow → ALLOW sentinel", async () => {
        const hook = () => ({ decision: "allow" });
        const result = await runPermissionChain([hook], CTX);
        assert.equal(result.decision, "allow");
    });
    it("deny short-circuits + returns reason", async () => {
        const allow = () => ({ decision: "allow" });
        const deny = () => ({
            decision: "deny",
            reason: "/etc is off-limits",
        });
        const trailing = () => {
            throw new Error("should not run");
        };
        const result = await runPermissionChain([allow, deny, trailing], CTX);
        assert.equal(result.decision, "deny");
        assert.equal(result.reason, "/etc is off-limits");
    });
    it("modify rewrites args for subsequent hooks", async () => {
        const seen = [];
        const redact = () => ({
            decision: "modify",
            modifiedArgs: { path: "<redacted>" },
            reason: "redacted path",
        });
        const audit = (ctx) => {
            seen.push(ctx.args);
            return { decision: "allow" };
        };
        const result = await runPermissionChain([redact, audit], CTX);
        // Final decision is the modify (no subsequent deny) — return the
        // latest modify so the caller has access to modifiedArgs.
        assert.equal(result.decision, "modify");
        assert.deepEqual(result.modifiedArgs, {
            path: "<redacted>",
        });
        // Audit hook should have observed the redacted args.
        assert.deepEqual(seen[0], { path: "<redacted>" });
    });
    it("deny after modify still wins over the modify", async () => {
        const redact = () => ({
            decision: "modify",
            modifiedArgs: { path: "<redacted>" },
        });
        const deny = () => ({
            decision: "deny",
            reason: "policy",
        });
        const result = await runPermissionChain([redact, deny], CTX);
        assert.equal(result.decision, "deny");
    });
    it("composeHooks works as a single hook", async () => {
        const composed = composeHooks(() => ({ decision: "allow" }), () => ({ decision: "modify", modifiedArgs: { x: 1 } }), () => ({ decision: "allow" }));
        const result = await composed(CTX);
        assert.equal(result.decision, "modify");
    });
    it("supports async hooks (returns Promise)", async () => {
        const hook = async (ctx) => {
            await new Promise((r) => setTimeout(r, 1));
            return { decision: "deny", reason: ctx.tool };
        };
        const result = await runPermissionChain([hook], CTX);
        assert.equal(result.decision, "deny");
        assert.equal(result.reason, "read_file");
    });
    it("hook order matters — first matching decision wins", async () => {
        const order = [];
        const a = () => {
            order.push("a");
            return { decision: "allow" };
        };
        const b = () => {
            order.push("b");
            return { decision: "deny", reason: "b" };
        };
        const c = () => {
            order.push("c");
            return { decision: "deny", reason: "c" };
        };
        const result = await runPermissionChain([a, b, c], CTX);
        assert.deepEqual(order, ["a", "b"]);
        assert.equal(result.reason, "b");
    });
    it("decision shapes satisfy the PermissionDecision union", () => {
        // Pure type check — if these compile, the union is usable.
        const d1 = { decision: "allow" };
        const d2 = { decision: "deny", reason: "nope" };
        const d3 = {
            decision: "modify",
            modifiedArgs: {},
            reason: "redacted",
        };
        assert.ok(d1 && d2 && d3);
    });
});
//# sourceMappingURL=sdk-permissions.test.js.map