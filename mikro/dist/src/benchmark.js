/**
 * Benchmark runner for mikro — compares RLM vs direct LLM on cost/tokens/latency.
 *
 * Two modes:
 * - cost: built-in curated dataset, measures cost savings
 * - oolong: Oolong Synth from HuggingFace, measures accuracy
 */
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { llmComplete } from "./llm.js";
import { rlmLoop } from "./rlm.js";
const execFileAsync = promisify(execFile);
// ─── Dataset Loading ─────────────────────────────────────
async function loadBuiltinDataset() {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const jsonPath = join(thisDir, "benchmark-data.json");
    const raw = await readFile(jsonPath, "utf-8");
    return JSON.parse(raw);
}
// ─── Savings Calculation ─────────────────────────────────
export function calculateSavings(directTokens, rlmTokens) {
    if (directTokens <= 0)
        return 0;
    return ((directTokens - rlmTokens) / directTokens) * 100;
}
export function calculateCostSavings(directCost, rlmCost) {
    if (directCost <= 0)
        return 0;
    return ((directCost - rlmCost) / directCost) * 100;
}
// ─── Cost Benchmark ──────────────────────────────────────
export async function runCostBenchmark(config, options) {
    const dataset = await loadBuiltinDataset();
    const runs = [];
    for (const q of dataset) {
        const ctx = {
            type: "string",
            content: q.context,
            metadata: `benchmark context for "${q.name}" (${q.context.length} chars)`,
        };
        // Direct LLM call
        const directMessages = [
            {
                role: "user",
                content: `Context:\n${q.context}\n\nQuestion: ${q.question}`,
            },
        ];
        const directStart = Date.now();
        const directResp = await llmComplete(directMessages, config.model);
        const directLatency = Date.now() - directStart;
        // RLM call
        const rlmStart = Date.now();
        const rlmResult = await rlmLoop(q.question, ctx, config, {
            maxIterations: config.budget.maxTokens ? 5 : 10,
            timeout: 120_000,
            verbose: false,
            output: "text",
            cache: false,
        });
        const rlmLatency = Date.now() - rlmStart;
        const directTotalTokens = directResp.usage.inputTokens + directResp.usage.outputTokens;
        const rlmTotalTokens = rlmResult.usage.inputTokens + rlmResult.usage.outputTokens;
        runs.push({
            questionId: q.id,
            questionName: q.name,
            direct: {
                tokens_input: directResp.usage.inputTokens,
                tokens_output: directResp.usage.outputTokens,
                cost: directResp.usage.totalCost,
                latency_ms: directLatency,
                answer: directResp.text,
            },
            rlm: {
                tokens_input: rlmResult.usage.inputTokens,
                tokens_output: rlmResult.usage.outputTokens,
                cost: rlmResult.usage.totalCost,
                latency_ms: rlmLatency,
                iterations: rlmResult.iterations,
                answer: rlmResult.answer,
            },
            savings: {
                tokens_pct: calculateSavings(directTotalTokens, rlmTotalTokens),
                cost_pct: calculateCostSavings(directResp.usage.totalCost, rlmResult.usage.totalCost),
            },
        });
        if (options?.outputFormat !== "json") {
            process.stderr.write(`  completed: ${q.name}\n`);
        }
    }
    const totals = aggregateTotals(runs);
    return {
        timestamp: new Date().toISOString(),
        mode: "cost",
        model: `${config.model.provider}/${config.model.model}`,
        runs,
        totals,
    };
}
// ─── Oolong Benchmark ────────────────────────────────────
async function ensureBenchVenv() {
    const venvDir = join(homedir(), ".mikro", ".bench-venv");
    const pythonBin = join(venvDir, "bin", "python");
    try {
        await stat(pythonBin);
        return pythonBin;
    }
    catch {
        // Create venv and install datasets
        process.stderr.write("mikro benchmark: setting up Python venv for HuggingFace datasets...\n");
        await mkdir(join(homedir(), ".mikro"), { recursive: true });
        // Try uv first (preferred), fall back to python3 -m venv + pip
        try {
            await execFileAsync("uv", ["venv", venvDir]);
            await execFileAsync("uv", ["pip", "install", "--python", pythonBin, "datasets"]);
        }
        catch {
            await execFileAsync("python3", ["-m", "venv", venvDir]);
            await execFileAsync(join(venvDir, "bin", "pip"), ["install", "datasets"]);
        }
        process.stderr.write("mikro benchmark: Python venv ready.\n");
        return pythonBin;
    }
}
function findLoadDatasetScript() {
    // The script is at python/load_dataset.py relative to package root
    // From dist/src/benchmark.js, package root is ../../
    const thisDir = dirname(fileURLToPath(import.meta.url));
    return join(thisDir, "..", "..", "python", "load_dataset.py");
}
export async function runOolongBenchmark(config, options) {
    const samples = options?.samples ?? 5;
    const idx = options?.idx;
    const pythonBin = await ensureBenchVenv();
    const scriptPath = findLoadDatasetScript();
    // Load dataset via Python subprocess
    const args = [scriptPath, String(samples)];
    if (idx !== undefined) {
        args.push(String(idx));
    }
    process.stderr.write(`mikro benchmark: loading Oolong Synth dataset (${idx !== undefined ? `idx=${idx}` : `${samples} samples`})...\n`);
    const { stdout } = await execFileAsync(pythonBin, args, { maxBuffer: 50 * 1024 * 1024 });
    const dataset = JSON.parse(stdout);
    process.stderr.write(`mikro benchmark: loaded ${dataset.length} samples.\n`);
    const runs = [];
    for (const q of dataset) {
        const ctx = {
            type: "string",
            content: q.context,
            metadata: `oolong context (${q.context.length} chars)`,
        };
        // Direct LLM call
        const directMessages = [
            {
                role: "user",
                content: `Context:\n${q.context}\n\nQuestion: ${q.question}`,
            },
        ];
        const directStart = Date.now();
        const directResp = await llmComplete(directMessages, config.model);
        const directLatency = Date.now() - directStart;
        // RLM call
        const rlmStart = Date.now();
        const rlmResult = await rlmLoop(q.question, ctx, config, {
            maxIterations: 10,
            timeout: 120_000,
            verbose: false,
            output: "text",
            cache: false,
        });
        const rlmLatency = Date.now() - rlmStart;
        const directTotalTokens = directResp.usage.inputTokens + directResp.usage.outputTokens;
        const rlmTotalTokens = rlmResult.usage.inputTokens + rlmResult.usage.outputTokens;
        runs.push({
            questionId: q.id,
            questionName: q.name,
            direct: {
                tokens_input: directResp.usage.inputTokens,
                tokens_output: directResp.usage.outputTokens,
                cost: directResp.usage.totalCost,
                latency_ms: directLatency,
                answer: directResp.text,
            },
            rlm: {
                tokens_input: rlmResult.usage.inputTokens,
                tokens_output: rlmResult.usage.outputTokens,
                cost: rlmResult.usage.totalCost,
                latency_ms: rlmLatency,
                iterations: rlmResult.iterations,
                answer: rlmResult.answer,
            },
            savings: {
                tokens_pct: calculateSavings(directTotalTokens, rlmTotalTokens),
                cost_pct: calculateCostSavings(directResp.usage.totalCost, rlmResult.usage.totalCost),
            },
        });
        process.stderr.write(`  completed: ${q.name}\n`);
    }
    const totals = aggregateTotals(runs);
    return {
        timestamp: new Date().toISOString(),
        mode: "oolong",
        model: `${config.model.provider}/${config.model.model}`,
        runs,
        totals,
    };
}
// ─── Aggregation ─────────────────────────────────────────
export function aggregateTotals(runs) {
    if (runs.length === 0) {
        return {
            direct: { tokens: 0, cost: 0, latency_ms: 0 },
            rlm: { tokens: 0, cost: 0, latency_ms: 0, avg_iterations: 0 },
            savings: { tokens_pct: 0, cost_pct: 0 },
        };
    }
    const directTokens = runs.reduce((sum, r) => sum + r.direct.tokens_input + r.direct.tokens_output, 0);
    const directCost = runs.reduce((sum, r) => sum + r.direct.cost, 0);
    const directLatency = runs.reduce((sum, r) => sum + r.direct.latency_ms, 0);
    const rlmTokens = runs.reduce((sum, r) => sum + r.rlm.tokens_input + r.rlm.tokens_output, 0);
    const rlmCost = runs.reduce((sum, r) => sum + r.rlm.cost, 0);
    const rlmLatency = runs.reduce((sum, r) => sum + r.rlm.latency_ms, 0);
    const avgIterations = runs.reduce((sum, r) => sum + r.rlm.iterations, 0) / runs.length;
    return {
        direct: { tokens: directTokens, cost: directCost, latency_ms: directLatency },
        rlm: { tokens: rlmTokens, cost: rlmCost, latency_ms: rlmLatency, avg_iterations: avgIterations },
        savings: {
            tokens_pct: calculateSavings(directTokens, rlmTokens),
            cost_pct: calculateCostSavings(directCost, rlmCost),
        },
    };
}
// ─── Table Formatting ────────────────────────────────────
function padRight(str, len) {
    if (str.length >= len)
        return str.slice(0, len);
    return str + " ".repeat(len - str.length);
}
function padLeft(str, len) {
    if (str.length >= len)
        return str.slice(0, len);
    return " ".repeat(len - str.length) + str;
}
function formatTokens(n) {
    return n.toLocaleString("en-US");
}
function formatCost(n) {
    return `$${n.toFixed(4)}`;
}
function formatLatency(ms) {
    if (ms < 1000)
        return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}
function formatPct(n) {
    const sign = n > 0 ? "" : "";
    return `${sign}${n.toFixed(1)}%`;
}
export function formatBenchmarkTable(results) {
    const colW = { name: 22, mode: 10, tokens: 12, cost: 10, latency: 10, iters: 8 };
    const lines = [];
    const modeLabel = results.mode === "cost" ? "cost comparison" : "oolong accuracy";
    lines.push(`mikro benchmark — ${modeLabel} (RLM vs Direct LLM)`);
    lines.push("");
    // Header
    const hr = "─";
    lines.push(`┌${hr.repeat(colW.name)}┬${hr.repeat(colW.mode)}┬${hr.repeat(colW.tokens)}┬${hr.repeat(colW.cost)}┬${hr.repeat(colW.latency)}┬${hr.repeat(colW.iters)}┐`);
    lines.push(`│${padRight(" Question", colW.name)}│${padRight(" Mode", colW.mode)}│${padRight(" Tokens", colW.tokens)}│${padRight(" Cost", colW.cost)}│${padRight(" Latency", colW.latency)}│${padRight(" Iters", colW.iters)}│`);
    lines.push(`├${hr.repeat(colW.name)}┼${hr.repeat(colW.mode)}┼${hr.repeat(colW.tokens)}┼${hr.repeat(colW.cost)}┼${hr.repeat(colW.latency)}┼${hr.repeat(colW.iters)}┤`);
    // Rows
    for (const run of results.runs) {
        const directTokens = run.direct.tokens_input + run.direct.tokens_output;
        const rlmTokens = run.rlm.tokens_input + run.rlm.tokens_output;
        lines.push(`│${padRight(` ${run.questionName}`, colW.name)}│${padRight(" Direct", colW.mode)}│${padLeft(formatTokens(directTokens) + " ", colW.tokens)}│${padLeft(formatCost(run.direct.cost) + " ", colW.cost)}│${padLeft(formatLatency(run.direct.latency_ms) + " ", colW.latency)}│${padRight(" -", colW.iters)}│`);
        lines.push(`│${padRight("", colW.name)}│${padRight(" RLM", colW.mode)}│${padLeft(formatTokens(rlmTokens) + " ", colW.tokens)}│${padLeft(formatCost(run.rlm.cost) + " ", colW.cost)}│${padLeft(formatLatency(run.rlm.latency_ms) + " ", colW.latency)}│${padLeft(String(run.rlm.iterations) + " ", colW.iters)}│`);
        lines.push(`│${padRight("", colW.name)}│${padRight(" Savings", colW.mode)}│${padLeft(formatPct(run.savings.tokens_pct) + " ", colW.tokens)}│${padLeft(formatPct(run.savings.cost_pct) + " ", colW.cost)}│${padRight(" -", colW.latency)}│${padRight("", colW.iters)}│`);
    }
    // Footer with totals
    lines.push(`├${hr.repeat(colW.name)}┼${hr.repeat(colW.mode)}┼${hr.repeat(colW.tokens)}┼${hr.repeat(colW.cost)}┼${hr.repeat(colW.latency)}┼${hr.repeat(colW.iters)}┤`);
    lines.push(`│${padRight(" TOTALS", colW.name)}│${padRight(" Direct", colW.mode)}│${padLeft(formatTokens(results.totals.direct.tokens) + " ", colW.tokens)}│${padLeft(formatCost(results.totals.direct.cost) + " ", colW.cost)}│${padLeft(formatLatency(results.totals.direct.latency_ms) + " ", colW.latency)}│${padRight(" -", colW.iters)}│`);
    lines.push(`│${padRight("", colW.name)}│${padRight(" RLM", colW.mode)}│${padLeft(formatTokens(results.totals.rlm.tokens) + " ", colW.tokens)}│${padLeft(formatCost(results.totals.rlm.cost) + " ", colW.cost)}│${padLeft(formatLatency(results.totals.rlm.latency_ms) + " ", colW.latency)}│${padLeft(results.totals.rlm.avg_iterations.toFixed(1) + " ", colW.iters)}│`);
    lines.push(`│${padRight("", colW.name)}│${padRight(" Savings", colW.mode)}│${padLeft(formatPct(results.totals.savings.tokens_pct) + " ", colW.tokens)}│${padLeft(formatPct(results.totals.savings.cost_pct) + " ", colW.cost)}│${padRight(" -", colW.latency)}│${padRight("", colW.iters)}│`);
    lines.push(`└${hr.repeat(colW.name)}┴${hr.repeat(colW.mode)}┴${hr.repeat(colW.tokens)}┴${hr.repeat(colW.cost)}┴${hr.repeat(colW.latency)}┴${hr.repeat(colW.iters)}┘`);
    return lines.join("\n");
}
// ─── Results Persistence ─────────────────────────────────
export async function saveBenchmarkResults(results) {
    const benchDir = join(homedir(), ".mikro", "benchmarks");
    await mkdir(benchDir, { recursive: true });
    const ts = results.timestamp.replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
    const filename = `benchmark-${results.mode}-${ts}.json`;
    const filepath = join(benchDir, filename);
    await writeFile(filepath, JSON.stringify(results, null, 2), "utf-8");
    return filepath;
}
//# sourceMappingURL=benchmark.js.map