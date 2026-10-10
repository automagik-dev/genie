import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildStats } from "../src/output.js";
const BASE_RESULT = {
    answer: "test",
    references: [],
    usage: {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalCost: 0.01,
        llmCalls: 2,
    },
    iterations: 3,
    model: "google/gemini-3.1-flash-lite-preview",
    budgetHit: null,
};
describe("Gemini stats in buildStats", () => {
    it("includes gemini stats when thinking level is set", () => {
        const stats = buildStats(BASE_RESULT, {
            time_ms: 1000,
            thinking_level: "medium",
        });
        assert.ok(stats.gemini);
        assert.equal(stats.gemini.thinking_level, "medium");
    });
    it("includes gemini stats with batteries used", () => {
        const stats = buildStats(BASE_RESULT, {
            time_ms: 1000,
            thinking_level: "low",
            gemini_batteries_used: ["web_search", "fetch_url"],
            web_search_calls: 3,
            fetch_url_calls: 1,
        });
        assert.ok(stats.gemini);
        assert.deepEqual(stats.gemini.gemini_batteries_used, ["web_search", "fetch_url"]);
        assert.equal(stats.gemini.web_search_calls, 3);
        assert.equal(stats.gemini.fetch_url_calls, 1);
    });
    it("includes thought signature count", () => {
        const stats = buildStats(BASE_RESULT, {
            time_ms: 1000,
            thinking_level: "high",
            thought_signatures_circulated: 5,
        });
        assert.ok(stats.gemini);
        assert.equal(stats.gemini.thought_signatures_circulated, 5);
    });
    it("omits gemini section when no Gemini features used", () => {
        const stats = buildStats(BASE_RESULT, {
            time_ms: 1000,
        });
        assert.equal(stats.gemini, undefined);
    });
    it("includes code execution server-side stats", () => {
        const stats = buildStats(BASE_RESULT, {
            time_ms: 1000,
            thinking_level: "medium",
            code_executions_server_side: 2,
        });
        assert.ok(stats.gemini);
        assert.equal(stats.gemini.code_executions_server_side, 2);
    });
    it("includes image generation count", () => {
        const stats = buildStats(BASE_RESULT, {
            time_ms: 1000,
            thinking_level: "low",
            image_generations: 3,
        });
        assert.ok(stats.gemini);
        assert.equal(stats.gemini.image_generations, 3);
    });
    it("triggers gemini stats on web_search_calls alone", () => {
        const stats = buildStats(BASE_RESULT, {
            time_ms: 1000,
            web_search_calls: 2,
        });
        assert.ok(stats.gemini);
        assert.equal(stats.gemini.web_search_calls, 2);
    });
    it("triggers gemini stats on code_executions_server_side alone", () => {
        const stats = buildStats(BASE_RESULT, {
            time_ms: 1000,
            code_executions_server_side: 1,
        });
        assert.ok(stats.gemini);
        assert.equal(stats.gemini.code_executions_server_side, 1);
    });
    it("includes both cache and gemini stats simultaneously", () => {
        const resultWithCache = {
            ...BASE_RESULT,
            usage: {
                ...BASE_RESULT.usage,
                cacheReadTokens: 500,
                cacheWriteTokens: 200,
            },
        };
        const stats = buildStats(resultWithCache, {
            time_ms: 1000,
            cache_enabled: true,
            thinking_level: "low",
        });
        assert.ok(stats.cache);
        assert.ok(stats.gemini);
        assert.equal(stats.cache.enabled, true);
        assert.equal(stats.gemini.thinking_level, "low");
    });
});
//# sourceMappingURL=gemini-stats.test.js.map