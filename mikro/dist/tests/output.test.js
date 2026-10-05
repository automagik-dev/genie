import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildStats } from "../src/output.js";
const mockResult = {
    answer: "Test answer",
    references: ["file.md"],
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.05, llmCalls: 3 },
    iterations: 5,
    model: "anthropic/claude-sonnet-4-5",
    budgetHit: null,
};
describe("buildStats", () => {
    it("computes total_tokens correctly", () => {
        const stats = buildStats(mockResult, { time_ms: 1000 });
        assert.equal(stats.total_tokens, 1500);
    });
    it("includes budget_hit when provided", () => {
        const stats = buildStats(mockResult, {
            time_ms: 1000,
            budget_hit: "max-cost",
        });
        assert.equal(stats.budget_hit, "max-cost");
    });
    it("uses defaults for optional fields", () => {
        const stats = buildStats(mockResult, { time_ms: 500 });
        assert.equal(stats.tools_level, "core");
        assert.deepEqual(stats.batteries_used, []);
        assert.equal(stats.budget_hit, null);
        assert.equal(stats.run_id, "");
    });
    it("includes provided metadata", () => {
        const stats = buildStats(mockResult, {
            time_ms: 2000,
            tools_level: "full",
            batteries_used: ["describe_context", "map_query"],
            run_id: "abc-123",
        });
        assert.equal(stats.tools_level, "full");
        assert.deepEqual(stats.batteries_used, ["describe_context", "map_query"]);
        assert.equal(stats.run_id, "abc-123");
        assert.equal(stats.time_ms, 2000);
        assert.equal(stats.model, "anthropic/claude-sonnet-4-5");
        assert.equal(stats.iterations, 5);
    });
});
//# sourceMappingURL=output.test.js.map