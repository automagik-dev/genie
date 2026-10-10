import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { formatBenchmarkTable, saveBenchmarkResults, aggregateTotals, calculateSavings, calculateCostSavings, } from "../src/benchmark.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
async function loadDataset() {
    // From dist/tests/ -> ../../src/benchmark-data.json
    const jsonPath = join(__dirname, "..", "..", "src", "benchmark-data.json");
    const raw = await readFile(jsonPath, "utf-8");
    return JSON.parse(raw);
}
// ─── Dataset Validation ──────────────────────────────────
describe("benchmark-data.json", () => {
    it("has valid structure for all entries", async () => {
        const dataset = await loadDataset();
        assert.ok(Array.isArray(dataset), "dataset should be an array");
        assert.ok(dataset.length >= 5, `dataset should have at least 5 entries, got ${dataset.length}`);
        for (const entry of dataset) {
            assert.ok(typeof entry.id === "string" && entry.id.length > 0, `entry must have non-empty id`);
            assert.ok(typeof entry.name === "string" && entry.name.length > 0, `entry ${entry.id} must have non-empty name`);
            assert.ok(typeof entry.question === "string" && entry.question.length > 0, `entry ${entry.id} must have non-empty question`);
            assert.ok(typeof entry.context === "string" && entry.context.length > 0, `entry ${entry.id} must have non-empty context`);
            assert.ok(typeof entry.category === "string" && entry.category.length > 0, `entry ${entry.id} must have non-empty category`);
        }
    });
    it("covers required categories", async () => {
        const dataset = await loadDataset();
        const categories = new Set(dataset.map((d) => d.category));
        assert.ok(categories.has("extraction"), "should have extraction category");
        assert.ok(categories.has("summarization"), "should have summarization category");
        assert.ok(categories.has("reasoning"), "should have reasoning category");
        assert.ok(categories.has("comparison"), "should have comparison category");
        assert.ok(categories.has("synthesis"), "should have synthesis category");
    });
    it("has unique ids", async () => {
        const dataset = await loadDataset();
        const ids = dataset.map((d) => d.id);
        const uniqueIds = new Set(ids);
        assert.equal(ids.length, uniqueIds.size, "all ids must be unique");
    });
});
// ─── Savings Calculation ─────────────────────────────────
describe("calculateSavings", () => {
    it("computes correct percentage", () => {
        assert.equal(calculateSavings(100, 70), 30);
        assert.equal(calculateSavings(200, 100), 50);
    });
    it("returns 0 for zero direct tokens", () => {
        assert.equal(calculateSavings(0, 100), 0);
    });
    it("handles equal tokens", () => {
        assert.equal(calculateSavings(100, 100), 0);
    });
    it("handles RLM using more tokens (negative savings)", () => {
        const result = calculateSavings(100, 150);
        assert.ok(result < 0, "savings should be negative when RLM uses more");
        assert.equal(result, -50);
    });
});
describe("calculateCostSavings", () => {
    it("computes correct percentage", () => {
        const result = calculateCostSavings(1.0, 0.7);
        assert.ok(Math.abs(result - 30) < 0.001, `expected ~30, got ${result}`);
    });
    it("returns 0 for zero direct cost", () => {
        assert.equal(calculateCostSavings(0, 0.5), 0);
    });
    it("handles equal cost", () => {
        assert.equal(calculateCostSavings(0.5, 0.5), 0);
    });
});
// ─── Table Formatting ────────────────────────────────────
function makeMockResults() {
    return {
        timestamp: "2025-01-15T10:30:00.000Z",
        mode: "cost",
        model: "google/gemini-2.0-flash",
        runs: [
            {
                questionId: "cost-001",
                questionName: "API extraction",
                direct: {
                    tokens_input: 10000,
                    tokens_output: 2450,
                    cost: 0.0012,
                    latency_ms: 2300,
                    answer: "Direct answer",
                },
                rlm: {
                    tokens_input: 6000,
                    tokens_output: 2200,
                    cost: 0.0008,
                    latency_ms: 4100,
                    iterations: 3,
                    answer: "RLM answer",
                },
                savings: {
                    tokens_pct: 34.1,
                    cost_pct: 33.3,
                },
            },
            {
                questionId: "cost-002",
                questionName: "Summary test",
                direct: {
                    tokens_input: 20000,
                    tokens_output: 5000,
                    cost: 0.0025,
                    latency_ms: 3500,
                    answer: "Direct summary",
                },
                rlm: {
                    tokens_input: 12000,
                    tokens_output: 4000,
                    cost: 0.0016,
                    latency_ms: 6200,
                    iterations: 5,
                    answer: "RLM summary",
                },
                savings: {
                    tokens_pct: 36.0,
                    cost_pct: 36.0,
                },
            },
        ],
        totals: {
            direct: { tokens: 37450, cost: 0.0037, latency_ms: 5800 },
            rlm: { tokens: 24200, cost: 0.0024, latency_ms: 10300, avg_iterations: 4.0 },
            savings: { tokens_pct: 35.4, cost_pct: 35.1 },
        },
    };
}
describe("formatBenchmarkTable", () => {
    it("contains expected header", () => {
        const table = formatBenchmarkTable(makeMockResults());
        assert.ok(table.includes("mikro benchmark"), "should contain header");
        assert.ok(table.includes("cost comparison"), "should contain mode label");
        assert.ok(table.includes("Question"), "should contain Question column");
        assert.ok(table.includes("Mode"), "should contain Mode column");
        assert.ok(table.includes("Tokens"), "should contain Tokens column");
        assert.ok(table.includes("Cost"), "should contain Cost column");
        assert.ok(table.includes("Latency"), "should contain Latency column");
        assert.ok(table.includes("Iters"), "should contain Iters column");
    });
    it("contains row data for each run", () => {
        const table = formatBenchmarkTable(makeMockResults());
        assert.ok(table.includes("API extraction"), "should contain first question name");
        assert.ok(table.includes("Summary test"), "should contain second question name");
        assert.ok(table.includes("Direct"), "should contain Direct mode");
        assert.ok(table.includes("RLM"), "should contain RLM mode");
        assert.ok(table.includes("Savings"), "should contain Savings mode");
    });
    it("contains box-drawing characters", () => {
        const table = formatBenchmarkTable(makeMockResults());
        assert.ok(table.includes("┌"), "should contain top-left corner");
        assert.ok(table.includes("┐"), "should contain top-right corner");
        assert.ok(table.includes("└"), "should contain bottom-left corner");
        assert.ok(table.includes("┘"), "should contain bottom-right corner");
        assert.ok(table.includes("│"), "should contain vertical bar");
        assert.ok(table.includes("─"), "should contain horizontal bar");
        assert.ok(table.includes("├"), "should contain left tee");
        assert.ok(table.includes("┤"), "should contain right tee");
    });
    it("contains TOTALS row", () => {
        const table = formatBenchmarkTable(makeMockResults());
        assert.ok(table.includes("TOTALS"), "should contain TOTALS label");
    });
    it("uses oolong label for oolong mode", () => {
        const results = makeMockResults();
        results.mode = "oolong";
        const table = formatBenchmarkTable(results);
        assert.ok(table.includes("oolong accuracy"), "should contain oolong mode label");
    });
});
// ─── Aggregation ─────────────────────────────────────────
describe("aggregateTotals", () => {
    it("sums tokens and costs correctly", () => {
        const runs = [
            {
                questionId: "q1",
                questionName: "Q1",
                direct: { tokens_input: 100, tokens_output: 50, cost: 0.01, latency_ms: 1000, answer: "" },
                rlm: { tokens_input: 60, tokens_output: 30, cost: 0.006, latency_ms: 2000, iterations: 2, answer: "" },
                savings: { tokens_pct: 40, cost_pct: 40 },
            },
            {
                questionId: "q2",
                questionName: "Q2",
                direct: { tokens_input: 200, tokens_output: 100, cost: 0.02, latency_ms: 1500, answer: "" },
                rlm: { tokens_input: 120, tokens_output: 80, cost: 0.012, latency_ms: 3000, iterations: 4, answer: "" },
                savings: { tokens_pct: 33.3, cost_pct: 40 },
            },
        ];
        const totals = aggregateTotals(runs);
        assert.equal(totals.direct.tokens, 450, "direct tokens: 100+50+200+100");
        assert.equal(totals.rlm.tokens, 290, "rlm tokens: 60+30+120+80");
        assert.equal(totals.direct.latency_ms, 2500, "direct latency sum");
        assert.equal(totals.rlm.latency_ms, 5000, "rlm latency sum");
        assert.equal(totals.rlm.avg_iterations, 3, "avg iterations: (2+4)/2");
        // Check cost sums (use approximate due to floating point)
        assert.ok(Math.abs(totals.direct.cost - 0.03) < 0.0001, "direct cost should be ~0.03");
        assert.ok(Math.abs(totals.rlm.cost - 0.018) < 0.0001, "rlm cost should be ~0.018");
    });
    it("handles empty runs", () => {
        const totals = aggregateTotals([]);
        assert.equal(totals.direct.tokens, 0);
        assert.equal(totals.rlm.tokens, 0);
        assert.equal(totals.direct.cost, 0);
        assert.equal(totals.rlm.cost, 0);
        assert.equal(totals.rlm.avg_iterations, 0);
        assert.equal(totals.savings.tokens_pct, 0);
        assert.equal(totals.savings.cost_pct, 0);
    });
    it("computes savings percentages from aggregated totals", () => {
        const runs = [
            {
                questionId: "q1",
                questionName: "Q1",
                direct: { tokens_input: 100, tokens_output: 0, cost: 0.10, latency_ms: 100, answer: "" },
                rlm: { tokens_input: 50, tokens_output: 0, cost: 0.05, latency_ms: 200, iterations: 1, answer: "" },
                savings: { tokens_pct: 50, cost_pct: 50 },
            },
        ];
        const totals = aggregateTotals(runs);
        assert.equal(totals.savings.tokens_pct, 50);
        assert.equal(totals.savings.cost_pct, 50);
    });
});
// ─── Results Saving ──────────────────────────────────────
describe("saveBenchmarkResults", () => {
    it("writes results as parseable JSON file", async () => {
        const tempDir = await mkdtemp(join(tmpdir(), "mikro-bench-test-"));
        // Override homedir by setting env for the save call
        const origHome = process.env.HOME;
        process.env.HOME = tempDir;
        try {
            const results = makeMockResults();
            const savedPath = await saveBenchmarkResults(results);
            assert.ok(savedPath.endsWith(".json"), "saved file should be .json");
            assert.ok(savedPath.includes("benchmark-cost"), "saved file should include mode");
            const content = await readFile(savedPath, "utf-8");
            const parsed = JSON.parse(content);
            assert.equal(parsed.mode, "cost");
            assert.equal(parsed.runs.length, 2);
            assert.equal(parsed.model, "google/gemini-2.0-flash");
        }
        finally {
            process.env.HOME = origHome;
            await rm(tempDir, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=benchmark.test.js.map