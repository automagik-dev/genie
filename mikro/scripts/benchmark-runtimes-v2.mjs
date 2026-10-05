#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PRIME_ROOT = "/home/genie/.local/lib/node_modules/prime-agent";
const PINNED_PRIME_VERSION = "0.8.1";
const SELECTION_PATH = join(ROOT, ".genie/evidence/prime-runtime-benchmark/model-benchmark-sdk-v2-selection-lock.json");
const MODEL = Object.freeze({
  selectionId: "deepseek/deepseek-v4-pro-0813",
  provider: "deepseek",
  id: "deepseek-v4-pro",
  baseUrl: "https://api.deepseek.com",
  peakInputUsdPerMillion: 1.32,
  peakOutputUsdPerMillion: 3.96,
  peakCacheReadUsdPerMillion: 0.044,
  contextWindow: 1_000_000,
  providerOutputCap: 17_408,
});
const RUNTIMES = Object.freeze(["mikro", "prime-sdk"]);
const REPETITIONS = 3;
const MAX_ITERATIONS_BY_RUNTIME = Object.freeze({ mikro: 2, "prime-sdk": 3 });
const MAX_INPUT_TOKENS = 32_768;
const MAX_OUTPUT_TOKENS = 8_192;
const DEADLINE_MS = 180_000;
const REASONING = "low";
const SYSTEM = [
  "Act as a release-operations analyst.",
  "Use only the supplied prompt and context evidence.",
  "Return the exact requested JSON object with no unstated assumptions.",
].join(" ");

const JOURNEYS = Object.freeze([
  {
    id: "inline-incident-decision",
    context: null,
    prompt: [
      "Rules: severity critical outranks high; an unresolved security hold blocks release; among unblocked services sort by dependency depth descending then service id.",
      "Records: api severity=critical depth=2 security_hold=resolved; worker severity=high depth=3 security_hold=none; web severity=critical depth=1 security_hold=unresolved; scheduler severity=high depth=3 security_hold=none.",
      "Return releaseOrder and blocked, with service IDs only.",
    ].join("\n"),
    expected: { releaseOrder: ["scheduler", "worker", "api"], blocked: ["web"] },
  },
  {
    id: "multi-file-release-context",
    context: {
      type: "list",
      content: [
        { path: "services.md", content: "svc-a owner=u2 port=7443\nsvc-b owner=u1 port=8111\nsvc-c owner=u3 port=9222" },
        { path: "owners.md", content: "u1 name=Ada tier=gold\nu2 name=Lin tier=silver\nu3 name=Mei tier=gold" },
        { path: "policy.md", content: "Only gold owners are release-eligible. Sort eligible services by port ascending. Return owner names, not IDs. notes.tmp is non-authoritative." },
        { path: "notes.tmp", content: "svc-a is approved (decoy; non-authoritative)" },
      ],
      metadata: "Four context files; policy.md defines authority.",
    },
    prompt: "Apply policy.md to services.md and owners.md. Return eligible rows as service, owner, port and rejected service IDs.",
    expected: {
      eligible: [
        { service: "svc-b", owner: "Ada", port: 8111 },
        { service: "svc-c", owner: "Mei", port: 9222 },
      ],
      rejected: ["svc-a"],
    },
  },
  {
    id: "json-authority-context",
    context: {
      type: "dict",
      content: JSON.stringify({
        precedence: ["runtime", "defaults", "notes"],
        runtime: { timeout: 75, mode: "strict", region: "sa-east-1" },
        defaults: { timeout: 30, mode: "safe", region: "us-east-1" },
        notes: { timeout: 999, mode: "debug", region: "moon-1" },
      }),
      metadata: "JSON authority object.",
    },
    prompt: "Resolve timeout, mode, region and source using the precedence array. Return exact values.",
    expected: { timeout: 75, mode: "strict", region: "sa-east-1", source: "runtime" },
  },
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function schemaFor(value) {
  if (Array.isArray(value)) return { type: "array", items: value.length ? schemaFor(value[0]) : {} };
  if (value && typeof value === "object") {
    const properties = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, schemaFor(child)]));
    return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
  }
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number" };
  if (typeof value === "boolean") return { type: "boolean" };
  return { type: "string" };
}

function parseAnswer(answer) {
  const trimmed = answer.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    const value = JSON.parse(candidate);
    return value && typeof value === "object" && !Array.isArray(value) ? { ok: true, value } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function score(expected, answer) {
  const parsed = parseAnswer(answer);
  if (!parsed.ok) return { semanticPass: false, formatPass: false, reason: "invalid-json" };
  return stable(parsed.value) === stable(expected)
    ? { semanticPass: true, formatPass: true, reason: "exact" }
    : { semanticPass: false, formatPass: true, reason: "value-mismatch" };
}

function modelOverride() {
  return {
    cost: { input: MODEL.peakInputUsdPerMillion, output: MODEL.peakOutputUsdPerMillion, cacheRead: MODEL.peakCacheReadUsdPerMillion, cacheWrite: 0 },
    maxTokens: MODEL.providerOutputCap,
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: "max", max: "max" },
    compat: {
      supportsToolChoice: false,
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek",
    },
  };
}

function providers() {
  return [{
    id: MODEL.provider,
    name: "DeepSeek direct runtime benchmark",
    api: "openai-completions",
    baseUrl: MODEL.baseUrl,
    apiKeyEnv: ["DEEPSEEK_API_KEY"],
    headers: {},
    models: [{
      id: MODEL.id,
      name: MODEL.id,
      reasoning: true,
      thinkingLevelMap: modelOverride().thinkingLevelMap,
      input: ["text"],
      contextWindow: MODEL.contextWindow,
      maxTokens: MODEL.providerOutputCap,
      cost: modelOverride().cost,
      compat: modelOverride().compat,
    }],
  }];
}

function manifest() {
  return {
    version: "mikro-runtime-benchmark-v2",
    baseSha: git("rev-parse", "HEAD"),
    harnessSha256: sha256(readFileSync(SCRIPT_PATH)),
    primeSdkAdapterSha256: sha256(readFileSync(join(ROOT, "dist/src/mcp/backends/prime-sdk.js"))),
    legacyAdapterSha256: sha256(readFileSync(join(ROOT, "dist/src/mcp/backends/legacy.js"))),
    primeVersion: PINNED_PRIME_VERSION,
    selectedCircuit: MODEL,
    selectionEvidence: {
      path: ".genie/evidence/prime-runtime-benchmark/model-benchmark-sdk-v2-selection-lock.json",
      sha256: sha256(readFileSync(SELECTION_PATH)),
    },
    runtimes: RUNTIMES,
    excludedRuntime: {
      prime: {
        eligible: false,
        reasons: ["output.schema unsupported", "dict context unsupported", "budget.maxDepth unsupported"],
        evidence: "src/mcp/backends/prime.ts",
      },
    },
    journeys: JOURNEYS.map((journey) => ({
      id: journey.id,
      contextType: journey.context?.type ?? null,
      promptSha256: sha256(journey.prompt),
      contextSha256: journey.context ? sha256(stable(journey.context)) : null,
      expectedSha256: sha256(stable(journey.expected)),
    })),
    repetitions: REPETITIONS,
    probeCalls: RUNTIMES.length * JOURNEYS.length,
    fullCalls: RUNTIMES.length * JOURNEYS.length * REPETITIONS,
    providerCallsCeiling: JOURNEYS.length * REPETITIONS * Object.values(MAX_ITERATIONS_BY_RUNTIME).reduce((sum, value) => sum + value, 0),
    reasoning: REASONING,
    maxIterationsByRuntime: MAX_ITERATIONS_BY_RUNTIME,
    maxInputTokens: MAX_INPUT_TOKENS,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    deadlineMs: DEADLINE_MS,
    retries: 0,
    rawAnswersPersisted: false,
    selectionRule: "quality first; then reliability, median latency, and cost per successful journey; Prime SDK promotion requires no solve-rate loss versus Mikro",
  };
}

function git(...args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function parseFlags(args) {
  const out = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith("--") || args[index + 1] === undefined) throw new Error(`invalid argument: ${args[index] ?? ""}`);
    out[args[index].slice(2)] = args[index + 1];
  }
  return out;
}

function selectedRuntimes(raw) {
  if (raw === undefined) return RUNTIMES;
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  const unknown = values.filter((value) => !RUNTIMES.includes(value));
  if (!values.length || unknown.length || new Set(values).size !== values.length) throw new Error(`invalid runtimes: ${raw}`);
  return values;
}

function deepSeekKey() {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY is missing from the ephemeral run environment");
  return key;
}

async function deepSeekBalance(key) {
  const response = await fetch(`${MODEL.baseUrl}/user/balance`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
  if (!response.ok) throw new Error(`DeepSeek balance lookup failed: ${response.status}`);
  const body = await response.json();
  const balance = Number((body.balance_infos ?? []).find((entry) => entry.currency === "USD")?.total_balance);
  if (!body.is_available || !Number.isFinite(balance)) throw new Error("DeepSeek USD balance unavailable");
  return balance;
}

function pricingMultiplier(isoTimestamp) {
  const date = new Date(isoTimestamp);
  const day = date.getUTCDay();
  const hour = date.getUTCHours();
  return day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)) ? 1 : 0.5;
}

async function configurePrime(root) {
  const dir = join(root, "prime-agent-config");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, "models.json"), `${JSON.stringify({ providers: { deepseek: { modelOverrides: { [MODEL.id]: modelOverride() } } } }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(dir, "settings.json"), `${JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } } }, null, 2)}\n`, { mode: 0o600 });
  return dir;
}

function agent(runtime) {
  return {
    name: `runtime-v2-${runtime}`,
    toolName: `mikro_runtime_v2_${runtime.replaceAll("-", "_")}`,
    dir: ROOT,
    summary: "Runtime benchmark v2",
    spec: { dir: ROOT, schemaVersion: 1, model: `${MODEL.provider}/${MODEL.id}`, thinking: REASONING, budget: { maxIterations: MAX_ITERATIONS_BY_RUNTIME[runtime], maxCost: null, maxTokens: MAX_INPUT_TOKENS, maxDepth: 1 }, output: null, toolsApi: 1, shape: "single-step", tools: [], extras: {}, backend: runtime },
  };
}

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function cells(runtimes, mode) {
  const rows = [];
  const repetitions = mode === "probe" ? 1 : REPETITIONS;
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (const journey of JOURNEYS) for (const runtime of runtimes) rows.push({ runtime, journey, repetition });
  }
  return rows;
}

async function preflight() {
  const frozen = manifest();
  const key = deepSeekKey();
  const installedPrimeVersion = JSON.parse(readFileSync(join(PRIME_ROOT, "package.json"), "utf8")).version;
  const [catalogResponse, balance] = await Promise.all([
    fetch(`${MODEL.baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` } }),
    deepSeekBalance(key),
  ]);
  const catalog = await catalogResponse.json();
  const modelPresent = catalogResponse.ok && (catalog.data ?? []).some((entry) => entry.id === MODEL.id);
  return {
    pass: installedPrimeVersion === frozen.primeVersion && modelPresent && Number.isFinite(balance),
    manifestSha256: sha256(stable(frozen)),
    baseSha: frozen.baseSha,
    credentialNamesPresent: { DEEPSEEK_API_KEY: Boolean(key) },
    modelPresent,
    probeCalls: frozen.probeCalls,
    fullCalls: frozen.fullCalls,
    providerCallsCeiling: frozen.providerCallsCeiling,
  };
}

async function runCampaign(options) {
  const runtimes = selectedRuntimes(options.runtimes);
  const frozen = manifest();
  const digest = sha256(stable(frozen));
  if (options.manifestSha !== digest) throw new Error(`manifest digest mismatch: expected ${digest}`);
  const rows = cells(runtimes, options.mode);
  if (options.authorizedCalls !== rows.length) throw new Error(`authorized calls must equal ${rows.length}`);
  if (!(options.authorizedUsd > 0)) throw new Error("authorized USD must be positive");
  const key = deepSeekKey();
  const balanceStart = await deepSeekBalance(key);
  const runRoot = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "mikro-runtime-v2-"));
  const primeAgentDir = await configurePrime(runRoot);
  const previousAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
  const previousDeadline = process.env.MIKRO_MCP_RUN_TIMEOUT_MS;
  process.env.PRIME_AGENT_CODING_AGENT_DIR = primeAgentDir;
  process.env.MIKRO_MCP_RUN_TIMEOUT_MS = String(DEADLINE_MS);
  const [{ loadConfig }, { LegacyMikroBackend }, { PrimeSdkBackend }] = await Promise.all([
    import("../dist/src/config.js"),
    import("../dist/src/mcp/backends/legacy.js"),
    import("../dist/src/mcp/backends/prime-sdk.js"),
  ]);
  const base = await loadConfig(runRoot);
  const backends = {
    mikro: new LegacyMikroBackend(),
    "prime-sdk": new PrimeSdkBackend({ primeRoot: PRIME_ROOT, primeAgentDir }),
  };
  const report = { version: frozen.version, manifest: frozen, manifestSha256: digest, stage: options.mode, runtimes, authorizedCalls: options.authorizedCalls, authorizedUsd: options.authorizedUsd, startedAt: new Date().toISOString(), complete: false, records: [], deepSeekBalanceStartUsd: balanceStart, deepSeekBalanceCurrentUsd: balanceStart, deepSeekSpendDeltaUsd: 0 };
  try {
    for (const row of rows) {
      const config = {
        ...base,
        model: { provider: MODEL.provider, model: MODEL.id, subCallModel: MODEL.id, providers: providers() },
        providers: providers(),
        system: SYSTEM,
        criteria: "Return the exact requested object.",
        budget: { maxCost: null, maxTokens: MAX_INPUT_TOKENS, maxDepth: 1 },
        gemini: { ...(base.gemini ?? {}), thinkingLevel: REASONING },
        output: { schema: schemaFor(row.journey.expected) },
        tools: [],
      };
      const startedAt = new Date().toISOString();
      const started = performance.now();
      let record;
      try {
        const result = await backends[row.runtime].run(agent(row.runtime), { query: row.journey.prompt, context: row.journey.context, config, cwd: runRoot, maxIterations: MAX_ITERATIONS_BY_RUNTIME[row.runtime], maxOutputTokens: MAX_OUTPUT_TOKENS, maxRetries: 0 }, () => {});
        const judged = score(row.journey.expected, result.answer);
        record = { runtime: row.runtime, journey: row.journey.id, repetition: row.repetition, ok: true, ...judged, answerSha256: sha256(result.answer), expectedSha256: sha256(stable(row.journey.expected)), startedAt, pricingMultiplier: pricingMultiplier(startedAt), wallMs: Math.round(performance.now() - started), iterations: result.iterations, budgetHit: result.budgetHit ?? null, usage: result.usage, limitCompliant: result.usage.inputTokens <= MAX_INPUT_TOKENS && result.iterations <= MAX_ITERATIONS_BY_RUNTIME[row.runtime] };
      } catch (error) {
        record = { runtime: row.runtime, journey: row.journey.id, repetition: row.repetition, ok: false, semanticPass: false, formatPass: false, reason: "runtime-error", errorClass: error instanceof Error ? error.constructor.name : "UnknownError", errorSha256: sha256(error instanceof Error ? error.message : String(error)), startedAt, wallMs: Math.round(performance.now() - started) };
      }
      report.records.push(record);
      report.deepSeekBalanceCurrentUsd = await deepSeekBalance(key);
      report.deepSeekSpendDeltaUsd = report.deepSeekBalanceStartUsd - report.deepSeekBalanceCurrentUsd;
      await atomicWrite(options.output, report);
      process.stderr.write(`${record.runtime} ${record.journey} #${record.repetition}: ${record.semanticPass ? "PASS" : record.reason}\n`);
      if (report.deepSeekSpendDeltaUsd > options.authorizedUsd) throw new Error("DeepSeek spend exceeded authorization");
      if (record.ok && !record.limitCompliant) throw new Error("successful journey exceeded frozen limits");
    }
    report.complete = report.records.length === rows.length;
    const estimatedCostUsd = report.records.reduce((sum, record) => sum + ((record.usage?.totalCost ?? 0) * (record.pricingMultiplier ?? 1)), 0);
    report.billing = { authority: "deepseek-usd-balance", observedSpendUsd: report.deepSeekSpendDeltaUsd, estimatedCostUsd, status: Math.abs(report.deepSeekSpendDeltaUsd - estimatedCostUsd) <= Math.max(0.000001, estimatedCostUsd * 0.02) ? "reconciled" : "unsettled" };
    report.completedAt = new Date().toISOString();
    await atomicWrite(options.output, report);
    if (!report.complete || report.records.some((record) => !record.ok)) process.exitCode = 1;
  } finally {
    if (previousAgentDir === undefined) delete process.env.PRIME_AGENT_CODING_AGENT_DIR; else process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDir;
    if (previousDeadline === undefined) delete process.env.MIKRO_MCP_RUN_TIMEOUT_MS; else process.env.MIKRO_MCP_RUN_TIMEOUT_MS = previousDeadline;
    await rm(runRoot, { recursive: true, force: true });
  }
}

function summarize(report) {
  const byRuntime = Object.fromEntries(RUNTIMES.map((runtime) => {
    const rows = report.records.filter((record) => record.runtime === runtime);
    const latencies = rows.map((record) => record.wallMs).sort((a, b) => a - b);
    const solved = rows.filter((record) => record.semanticPass).length;
    const estimatedCostUsd = rows.reduce((sum, record) => sum + ((record.usage?.totalCost ?? 0) * (record.pricingMultiplier ?? 1)), 0);
    return [runtime, { n: rows.length, ok: rows.filter((record) => record.ok).length, solved, solveRate: rows.length ? solved / rows.length : 0, formatPasses: rows.filter((record) => record.formatPass).length, medianWallMs: latencies.length ? latencies[Math.floor((latencies.length - 1) / 2)] : null, p90WallMs: latencies.length ? latencies[Math.ceil(latencies.length * 0.9) - 1] : null, inputTokens: rows.reduce((sum, record) => sum + (record.usage?.inputTokens ?? 0), 0), outputTokens: rows.reduce((sum, record) => sum + (record.usage?.outputTokens ?? 0), 0), estimatedCostUsd, costPerSolveUsd: solved ? estimatedCostUsd / solved : null }];
  }));
  return { version: report.version, manifestSha256: report.manifestSha256, complete: report.complete, billing: report.billing, excludedRuntime: report.manifest.excludedRuntime, byRuntime };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "manifest") return void process.stdout.write(`${JSON.stringify(manifest())}\n`);
  if (command === "preflight") return void process.stdout.write(`${JSON.stringify(await preflight())}\n`);
  if (command === "score") {
    const flags = parseFlags(args);
    return void process.stdout.write(`${JSON.stringify(score(JSON.parse(flags.expected), flags.answer))}\n`);
  }
  if (command === "run") {
    const flags = parseFlags(args);
    if (flags.mode !== "probe" && flags.mode !== "full") throw new Error("--mode must be probe or full");
    return void await runCampaign({ mode: flags.mode, output: resolve(flags.output), manifestSha: flags["manifest-sha"], authorizedCalls: Number(flags["authorized-calls"]), authorizedUsd: Number(flags["authorized-usd"]), runtimes: flags.runtimes });
  }
  if (command === "summarize") {
    const flags = parseFlags(args);
    return void process.stdout.write(`${JSON.stringify(summarize(JSON.parse(readFileSync(resolve(flags.input), "utf8"))))}\n`);
  }
  throw new Error("usage: benchmark-runtimes-v2.mjs manifest|preflight|score|run|summarize");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
