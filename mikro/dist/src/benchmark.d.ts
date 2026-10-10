/**
 * Benchmark runner for mikro — compares RLM vs direct LLM on cost/tokens/latency.
 *
 * Two modes:
 * - cost: built-in curated dataset, measures cost savings
 * - oolong: Oolong Synth from HuggingFace, measures accuracy
 */
import type { MikroConfig } from "./config.js";
export interface BenchmarkQuestion {
    id: string;
    name: string;
    question: string;
    context: string;
    category: string;
    expected?: string;
}
export interface BenchmarkRunResult {
    questionId: string;
    questionName: string;
    direct: {
        tokens_input: number;
        tokens_output: number;
        cost: number;
        latency_ms: number;
        answer: string;
    };
    rlm: {
        tokens_input: number;
        tokens_output: number;
        cost: number;
        latency_ms: number;
        iterations: number;
        answer: string;
    };
    savings: {
        tokens_pct: number;
        cost_pct: number;
    };
}
export interface BenchmarkResults {
    timestamp: string;
    mode: "cost" | "oolong";
    model: string;
    runs: BenchmarkRunResult[];
    totals: {
        direct: {
            tokens: number;
            cost: number;
            latency_ms: number;
        };
        rlm: {
            tokens: number;
            cost: number;
            latency_ms: number;
            avg_iterations: number;
        };
        savings: {
            tokens_pct: number;
            cost_pct: number;
        };
    };
}
export declare function calculateSavings(directTokens: number, rlmTokens: number): number;
export declare function calculateCostSavings(directCost: number, rlmCost: number): number;
export declare function runCostBenchmark(config: MikroConfig, options?: {
    outputFormat?: "table" | "json";
}): Promise<BenchmarkResults>;
export declare function runOolongBenchmark(config: MikroConfig, options?: {
    samples?: number;
    idx?: number;
}): Promise<BenchmarkResults>;
export declare function aggregateTotals(runs: BenchmarkRunResult[]): BenchmarkResults["totals"];
export declare function formatBenchmarkTable(results: BenchmarkResults): string;
export declare function saveBenchmarkResults(results: BenchmarkResults): Promise<string>;
//# sourceMappingURL=benchmark.d.ts.map