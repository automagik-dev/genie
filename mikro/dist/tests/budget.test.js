import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BudgetTracker } from "../src/budget.js";
describe("BudgetTracker", () => {
    it("never exceeds with null limits", () => {
        const bt = new BudgetTracker({ maxCost: null, maxTokens: null, maxDepth: null });
        const exceeded = bt.record(10000, 5000, 1.0);
        assert.equal(exceeded, false);
        assert.equal(bt.isExceeded(), false);
        assert.equal(bt.getState().budgetHit, null);
    });
    it("triggers on maxCost", () => {
        const bt = new BudgetTracker({ maxCost: 0.50, maxTokens: null, maxDepth: null });
        bt.record(1000, 500, 0.30);
        assert.equal(bt.isExceeded(), false);
        bt.record(1000, 500, 0.25);
        assert.equal(bt.isExceeded(), true);
        assert.equal(bt.getState().budgetHit, "max-cost");
    });
    it("triggers on maxTokens", () => {
        const bt = new BudgetTracker({ maxCost: null, maxTokens: 1000, maxDepth: null });
        bt.record(400, 200, 0.01);
        assert.equal(bt.isExceeded(), false);
        bt.record(300, 200, 0.01);
        assert.equal(bt.isExceeded(), true);
        assert.equal(bt.getState().budgetHit, "max-tokens");
    });
    it("triggers on maxDepth", () => {
        const bt = new BudgetTracker({ maxCost: null, maxTokens: null, maxDepth: 2 });
        assert.equal(bt.checkDepth(1), false);
        // depth >= maxDepth triggers
        assert.equal(bt.checkDepth(2), true);
        assert.equal(bt.getState().budgetHit, "max-depth");
    });
    it("record returns true when exceeded", () => {
        const bt = new BudgetTracker({ maxCost: 0.01, maxTokens: null, maxDepth: null });
        const first = bt.record(100, 50, 0.005);
        assert.equal(first, false);
        const second = bt.record(100, 50, 0.006);
        assert.equal(second, true);
    });
    it("getState returns running totals", () => {
        const bt = new BudgetTracker({ maxCost: null, maxTokens: null, maxDepth: null });
        bt.record(1000, 500, 0.10);
        bt.record(2000, 800, 0.20);
        const state = bt.getState();
        assert.equal(state.totalInputTokens, 3000);
        assert.equal(state.totalOutputTokens, 1300);
        // Use approximate comparison for floating point
        assert.ok(Math.abs(state.totalCost - 0.30) < 0.0001);
    });
    it("first budget hit is preserved", () => {
        const bt = new BudgetTracker({ maxCost: 0.10, maxTokens: 500, maxDepth: null });
        bt.record(300, 300, 0.15);
        // Both maxCost and maxTokens exceeded, but first one found wins
        assert.equal(bt.isExceeded(), true);
        assert.ok(bt.getState().budgetHit !== null);
    });
});
//# sourceMappingURL=budget.test.js.map