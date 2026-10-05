#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES, score, sha256, stable, taskPrompt } from "./benchmark-models-v2.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const FIXTURE_PATH = join(ROOT, "scripts/benchmark-models-v2.mjs");
const PRIME_ROOT = "/home/genie/.local/lib/node_modules/prime-agent";
const PINNED_PRIME_VERSION = "0.8.1";
const BWS_PROJECT_ID = "09229871-62e6-4331-9ede-b4a7012ec521";
const MODEL_MAX_TOKENS = 17_408;
const ROOT_OUTPUT_TOKENS = 8_192;
const INPUT_TOKEN_CAP = 32_768;
const DEADLINE_MS = 180_000;
const MAX_ITERATIONS = 2;
const REASONING = "low";
const TIMEOUT_ANSWER = "Error: RLM query timed out";
const MODEL_ROUTES = Object.freeze({
  "z-ai/glm-5.3": { provider: "GMICloud", slug: "gmicloud", tag: "gmicloud/fp8", quantization: "fp8" },
  "z-ai/glm-5.3-flash": { provider: "GMICloud", slug: "gmicloud", tag: "gmicloud/fp8", quantization: "fp8" },
  "deepseek/deepseek-v4-flash-0731": { provider: "DeepSeek", tag: "deepseek-direct", wireProvider: "deepseek", wireModel: "deepseek-v4-flash", quantization: "provider-managed" },
  "deepseek/deepseek-v4-pro-0813": { provider: "DeepSeek", tag: "deepseek-direct", wireProvider: "deepseek", wireModel: "deepseek-v4-pro", quantization: "provider-managed" },
});

function routeFor(modelId) {
  const route = MODEL_ROUTES[modelId];
  if (!route) throw new Error(`missing frozen route for ${modelId}`);
  return route;
}

function routingFor(modelId) {
  const route = routeFor(modelId);
  if (route.wireProvider === "deepseek") return null;
  return {
    only: [route.slug],
    order: [route.slug],
    allow_fallbacks: false,
    require_parameters: true,
    ...(route.quantization ? { quantizations: [route.quantization] } : {}),
  };
}
const SYSTEM = [
  "Solve the supplied synthetic reasoning problem using only its stated rules and data.",
  "Use the emit_done tool exactly once with the requested JSON object when complete.",
  "Do not add unstated assumptions.",
].join(" ");
const MODELS = Object.freeze([
  { id: "z-ai/glm-5.3", wireProvider: "openrouter", wireModel: "z-ai/glm-5.3", promptRate: 1.4, completionRate: 4.4, builtIn: true },
  { id: "z-ai/glm-5.3-flash", wireProvider: "openrouter", wireModel: "z-ai/glm-5.3-flash", promptRate: 0.075, completionRate: 0.25, builtIn: false },
  { id: "deepseek/deepseek-v4-flash-0731", wireProvider: "deepseek", wireModel: "deepseek-v4-flash", promptRate: 0.44, completionRate: 1.32, cacheReadRate: 0.014, builtIn: true },
  { id: "deepseek/deepseek-v4-pro-0813", wireProvider: "deepseek", wireModel: "deepseek-v4-pro", promptRate: 1.32, completionRate: 3.96, cacheReadRate: 0.044, builtIn: true },
]);
const THINKING_LEVEL_MAP = Object.freeze({ off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" });

function git(...args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function packageVersion(path) {
  return JSON.parse(readFileSync(path, "utf8")).version;
}

function manifest() {
  return {
    version: "mikro-prime-sdk-model-benchmark-v2",
    baseSha: git("rev-parse", "HEAD"),
    harnessSha256: sha256(readFileSync(SCRIPT_PATH)),
    fixtureHarnessSha256: sha256(readFileSync(FIXTURE_PATH)),
    primeSdkAdapterSha256: sha256(readFileSync(join(ROOT, "dist/src/mcp/backends/prime-sdk.js"))),
    primeVersion: PINNED_PRIME_VERSION,
    runtime: "Mikro PrimeSdkBackend using Prime Agent 0.8.1 in-process SDK",
    wire: "Prime AgentSession -> prime-agent-ai -> OpenRouter and direct DeepSeek OpenAI chat completions",
    routePolicy: "GLM via pinned OpenRouter FP8; DeepSeek via its official direct API",
    routes: MODEL_ROUTES,
    routesEnforced: true,
    commonUpstream: false,
    modelOnlyLeaderboardEligible: false,
    upstreamObservable: true,
    models: MODELS,
    cases: CASES.map((task) => ({ id: task.id, family: task.family, seed: task.seed, promptSha256: sha256(taskPrompt(task)), expectedSha256: sha256(stable(task.expected)) })),
    fullCalls: CASES.length * MODELS.length,
    probeCalls: MODELS.length,
    fullProviderCalls: CASES.length * MODELS.length * MAX_ITERATIONS,
    probeProviderCalls: MODELS.length * MAX_ITERATIONS,
    maxIterations: MAX_ITERATIONS,
    maxInputTokens: INPUT_TOKEN_CAP,
    rootOutputTokens: ROOT_OUTPUT_TOKENS,
    providerModelMaxTokens: MODEL_MAX_TOKENS,
    deadlineMs: DEADLINE_MS,
    retries: 0,
    reasoning: REASONING,
    temperature: 0,
    inferenceSeed: null,
    fixtureSeedPolicy: "deterministic task generation; provider sampling seed omitted for official DeepSeek compatibility",
    responseFormat: null,
    structuredOutputChannel: "Prime emit_done tool with output.schema validation",
    toolChoice: "omitted for all models; compliance with the sole emit_done tool is measured as reliability",
    payloadContractEvidence: "sanitized fields and metadata hash per provider call",
    rawAnswersPersisted: false,
    billingAuthority: "OpenRouter key usage delta per GLM calls; DeepSeek USD balance delta per direct calls",
    scoring: "semantic exact + field accuracy; deterministic; no judge model",
  };
}

function parseFlags(args) {
  const out = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith("--") || args[index + 1] === undefined) throw new Error(`invalid argument: ${args[index] ?? ""}`);
    out[args[index].slice(2)] = args[index + 1];
  }
  return out;
}

function selectedModels(raw) {
  if (raw === undefined) return MODELS;
  const ids = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error("--models must name at least one model");
  if (new Set(ids).size !== ids.length) throw new Error("--models must not contain duplicates");
  const selected = ids.map((id) => MODELS.find((model) => model.id === id));
  const unknown = ids.filter((_, index) => !selected[index]);
  if (unknown.length) throw new Error(`unknown model(s): ${unknown.join(", ")}`);
  return selected;
}

function bwsSecret(key) {
  const result = spawnSync("bws", ["secret", "list", BWS_PROJECT_ID], { encoding: "utf8", maxBuffer: 10_000_000 });
  if (result.status !== 0) throw new Error(`BWS lookup failed for ${key}`);
  const row = JSON.parse(result.stdout).find((item) => item.key === key);
  if (!row?.value) throw new Error(`BWS secret ${key} is missing`);
  return row.value;
}

async function openRouterKey() {
  const sdk = await import(`${PRIME_ROOT}/dist/index.js`);
  const auth = await sdk.AuthStorage.create();
  return await auth.getApiKey("openrouter") ?? bwsSecret("OPENROUTER_API_KEY");
}

function deepSeekKey() {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY is missing from the ephemeral run environment");
  return key;
}

async function deepSeekCatalog(key) {
  const response = await fetch("https://api.deepseek.com/models", { headers: { Authorization: `Bearer ${key}` } });
  if (!response.ok) throw new Error(`DeepSeek model discovery failed: ${response.status}`);
  const body = await response.json();
  return new Set((body.data ?? []).map((model) => model.id));
}

async function deepSeekBalance(key) {
  const response = await fetch("https://api.deepseek.com/user/balance", { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
  if (!response.ok) throw new Error(`DeepSeek balance lookup failed: ${response.status}`);
  const body = await response.json();
  const usd = (body.balance_infos ?? []).find((entry) => entry.currency === "USD");
  const balance = Number(usd?.total_balance);
  if (!body.is_available || !Number.isFinite(balance)) throw new Error("DeepSeek USD balance is unavailable");
  return balance;
}

async function keyUsage(key) {
  const response = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` } });
  if (!response.ok) throw new Error(`OpenRouter key usage lookup failed: ${response.status}`);
  const body = await response.json();
  if (!Number.isFinite(body?.data?.usage)) throw new Error("OpenRouter key usage response lacks numeric usage");
  return body.data.usage;
}

async function catalog() {
  const response = await fetch("https://openrouter.ai/api/v1/models");
  if (!response.ok) throw new Error(`OpenRouter model discovery failed: ${response.status}`);
  const body = await response.json();
  return new Map(body.data.map((model) => [model.id, model]));
}

async function endpoints(modelId) {
  const response = await fetch(`https://openrouter.ai/api/v1/models/${modelId}/endpoints`);
  if (!response.ok) throw new Error(`OpenRouter endpoint discovery failed for ${modelId}: ${response.status}`);
  const body = await response.json();
  return body.data?.endpoints ?? [];
}

function sameRate(left, right) {
  return Number.isFinite(left) && Math.abs(left - right) < 1e-9;
}

async function preflight() {
  const frozen = manifest();
  const directKey = deepSeekKey();
  const openRouterModels = MODELS.filter((model) => model.wireProvider === "openrouter");
  const [models, key, directModels, pi, ...endpointRows] = await Promise.all([
    catalog(),
    openRouterKey(),
    deepSeekCatalog(directKey),
    import(`${PRIME_ROOT}/node_modules/@earendil-works/pi-ai/dist/index.js`),
    ...openRouterModels.map((model) => endpoints(model.id)),
  ]);
  const requiredParameters = ["reasoning", "temperature", "max_tokens", "tools"];
  const checks = Object.fromEntries(MODELS.map((model) => {
    if (model.wireProvider === "deepseek") {
      const primeModel = pi.getModel("deepseek", model.wireModel);
      return [model.id, {
        wireProvider: model.wireProvider,
        wireModel: model.wireModel,
        directModelPresent: directModels.has(model.wireModel),
        primeBuiltInPresent: Boolean(primeModel),
        directBaseUrl: primeModel?.baseUrl ?? null,
        toolChoiceSupported: false,
        requiredParameters: true,
      }];
    }
    const index = openRouterModels.findIndex((candidate) => candidate.id === model.id);
    const remote = models.get(model.id);
    const efforts = remote?.reasoning?.supported_efforts ?? [];
    const route = routeFor(model.id);
    const upstreamEndpoint = endpointRows[index].find((endpoint) => endpoint.tag === route.tag);
    return [model.id, {
      catalogPresent: Boolean(remote),
      primeBuiltInPresent: Boolean(pi.getModel("openrouter", model.id)),
      expectedBuiltIn: model.builtIn,
      promptRate: remote ? Number(remote.pricing.prompt) * 1_000_000 : null,
      completionRate: remote ? Number(remote.pricing.completion) * 1_000_000 : null,
      selectedReasoning: efforts.includes(REASONING),
      upstreamPresent: Boolean(upstreamEndpoint),
      upstreamHealthy: upstreamEndpoint?.status === 0,
      upstreamTag: upstreamEndpoint?.tag ?? null,
      upstreamQuantization: upstreamEndpoint?.quantization ?? null,
      requiredParameters: requiredParameters.every((parameter) => upstreamEndpoint?.supported_parameters?.includes(parameter)),
    }];
  }));
  const installedPrimeVersion = packageVersion(join(PRIME_ROOT, "package.json"));
  const pass = installedPrimeVersion === frozen.primeVersion && Boolean(key) && MODELS.every((model) => {
    const check = checks[model.id];
    if (model.wireProvider === "deepseek") {
      return check.directModelPresent && check.primeBuiltInPresent
        && check.directBaseUrl === "https://api.deepseek.com"
        && check.toolChoiceSupported === false;
    }
    return check.catalogPresent && check.primeBuiltInPresent === check.expectedBuiltIn
      && sameRate(check.promptRate, model.promptRate) && sameRate(check.completionRate, model.completionRate)
      && check.selectedReasoning && check.upstreamPresent && check.upstreamHealthy
      && check.upstreamTag === routeFor(model.id).tag
      && (routeFor(model.id).quantization === null || check.upstreamQuantization === routeFor(model.id).quantization)
      && check.requiredParameters;
  });
  return { pass, manifestSha256: sha256(stable(frozen)), baseSha: frozen.baseSha, credentialNamesPresent: { OPENROUTER_API_KEY: Boolean(key), DEEPSEEK_API_KEY: Boolean(directKey) }, checks, fullCalls: frozen.fullCalls, probeCalls: frozen.probeCalls };
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

function modelsConfig() {
  const openRouterModels = MODELS.filter((model) => model.wireProvider === "openrouter");
  const overrides = Object.fromEntries(openRouterModels.filter((model) => model.builtIn).map((model) => [model.wireModel, {
    cost: { input: model.promptRate, output: model.completionRate, cacheRead: 0, cacheWrite: 0 },
    maxTokens: MODEL_MAX_TOKENS,
    thinkingLevelMap: THINKING_LEVEL_MAP,
    compat: { openRouterRouting: routingFor(model.id) },
  }]));
  const flash = openRouterModels.find((model) => !model.builtIn);
  const deepSeekOverrides = Object.fromEntries(MODELS.filter((model) => model.wireProvider === "deepseek").map((model) => [model.wireModel, {
    cost: { input: model.promptRate, output: model.completionRate, cacheRead: model.cacheReadRate, cacheWrite: 0 },
    maxTokens: MODEL_MAX_TOKENS,
    thinkingLevelMap: THINKING_LEVEL_MAP,
    compat: {
      supportsToolChoice: false,
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek",
    },
  }]));
  return {
    providers: {
      openrouter: {
        models: [{
          id: flash.id,
          name: flash.id,
          reasoning: true,
          thinkingLevelMap: THINKING_LEVEL_MAP,
          input: ["text"],
          cost: { input: flash.promptRate, output: flash.completionRate, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_048_576,
          maxTokens: MODEL_MAX_TOKENS,
          compat: { maxTokensField: "max_tokens", openRouterRouting: routingFor(flash.id) },
        }],
        modelOverrides: overrides,
      },
      deepseek: { modelOverrides: deepSeekOverrides },
    },
  };
}

async function configurePrime(root) {
  const dir = join(root, "prime-agent-config");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, "models.json"), `${JSON.stringify(modelsConfig(), null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(dir, "settings.json"), `${JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } } }, null, 2)}\n`, { mode: 0o600 });
  return dir;
}

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function shuffled(values, seed) {
  let state = seed >>> 0;
  const out = [...values];
  for (let index = out.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const other = Math.floor((state / 0x100000000) * (index + 1));
    [out[index], out[other]] = [out[other], out[index]];
  }
  return out;
}

function agent(model) {
  return {
    name: `model-benchmark-${model.id.replaceAll("/", "-")}`,
    toolName: `mikro_model_benchmark_${sha256(model.id).slice(0, 8)}`,
    dir: ROOT,
    summary: "Frozen model benchmark agent",
    spec: {
      dir: ROOT,
      schemaVersion: 1,
      model: `${model.wireProvider}/${model.wireModel}`,
      thinking: REASONING,
      budget: { maxIterations: MAX_ITERATIONS, maxCost: null, maxTokens: INPUT_TOKEN_CAP, maxDepth: null },
      output: null,
      toolsApi: 1,
      shape: "single-step",
      tools: [],
      extras: {},
      backend: "prime-sdk",
    },
  };
}

function worstCellCost(model) {
  return MAX_ITERATIONS * ((INPUT_TOKEN_CAP * model.promptRate) + (ROOT_OUTPUT_TOKENS * model.completionRate)) / 1_000_000;
}

function deepSeekPricingMultiplier(isoTimestamp) {
  const date = new Date(isoTimestamp);
  const day = date.getUTCDay();
  const hour = date.getUTCHours();
  const peak = day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
  return peak ? 1 : 0.5;
}

function reconcileBilling(report) {
  const openRouterResponseCostUsd = report.records
    .filter((record) => record.wireProvider === "openrouter")
    .reduce((sum, record) => sum + (record.usage?.totalCost ?? 0), 0);
  const openRouterDifferenceUsd = report.openRouterUsageDeltaUsd - openRouterResponseCostUsd;
  const openRouterToleranceUsd = Math.max(0.000001, openRouterResponseCostUsd * 0.02);
  const openRouterStatus = report.openRouterUsageStartUsd === null
    ? "not-used"
    : Math.abs(openRouterDifferenceUsd) <= openRouterToleranceUsd
      ? "reconciled"
      : openRouterDifferenceUsd < 0 ? "unsettled" : "contaminated";
  const deepSeekEstimatedCostUsd = report.records
    .filter((record) => record.wireProvider === "deepseek")
    .reduce((sum, record) => sum + ((record.usage?.totalCost ?? 0) * (record.deepSeekPricingMultiplier ?? 1)), 0);
  const deepSeekDifferenceUsd = report.deepSeekSpendDeltaUsd - deepSeekEstimatedCostUsd;
  const deepSeekToleranceUsd = Math.max(0.000001, deepSeekEstimatedCostUsd * 0.02);
  const deepSeekStatus = report.deepSeekBalanceStartUsd === null
    ? "not-used"
    : Math.abs(deepSeekDifferenceUsd) <= deepSeekToleranceUsd
      ? "reconciled"
      : deepSeekDifferenceUsd < 0 ? "unsettled" : "contaminated";
  report.totalAuthoritativeSpendUsd = report.openRouterUsageDeltaUsd + report.deepSeekSpendDeltaUsd;
  report.billing = {
    authority: "provider-native-account-deltas",
    status: [openRouterStatus, deepSeekStatus].every((status) => status === "reconciled" || status === "not-used") ? "reconciled" : "unsettled",
    openrouter: { status: openRouterStatus, responseUsageCostUsd: openRouterResponseCostUsd, differenceUsd: openRouterDifferenceUsd, toleranceUsd: openRouterToleranceUsd },
    deepseek: { status: deepSeekStatus, estimatedCostUsd: deepSeekEstimatedCostUsd, differenceUsd: deepSeekDifferenceUsd, toleranceUsd: deepSeekToleranceUsd, spendDeltaUsd: report.deepSeekSpendDeltaUsd },
  };
}

function billingContract() {
  const report = {
    records: [{ wireProvider: "deepseek", usage: { totalCost: 0.01 }, deepSeekPricingMultiplier: 0.5 }],
    openRouterUsageStartUsd: null,
    openRouterUsageDeltaUsd: 0,
    deepSeekBalanceStartUsd: 1,
    deepSeekSpendDeltaUsd: 0,
  };
  reconcileBilling(report);
  return report.billing;
}

function classifyRuntimeError(error) {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes("without calling `emit_done`")) return "structured-output-missing";
  if (message.includes("rate limit") || message.includes("429")) return "rate-limit";
  if (message.includes("timed out") || message.includes("timeout")) return "timeout";
  if (message.includes("abort")) return "aborted";
  if (message.includes("not support") || message.includes("unsupported") || message.includes("no endpoints")) return "provider-incompatible";
  if (message.includes("fetch") || message.includes("network") || message.includes("socket")) return "transport-error";
  return "runtime-error";
}

function controlledPayload(payload, cell, proofs) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("provider payload is not an object");
  }
  const source = payload;
  const directDeepSeek = cell.model.wireProvider === "deepseek";
  const transformed = { ...source, temperature: 0, max_tokens: ROOT_OUTPUT_TOKENS };
  if (directDeepSeek) {
    transformed.thinking = { type: "enabled" };
    transformed.reasoning_effort = REASONING;
    delete transformed.reasoning;
    delete transformed.tool_choice;
    delete transformed.provider;
  } else {
    transformed.reasoning = { effort: REASONING };
    delete transformed.tool_choice;
  }
  delete transformed.max_completion_tokens;
  delete transformed.response_format;
  delete transformed.seed;
  if (!directDeepSeek) {
    delete transformed.reasoning_effort;
    delete transformed.thinking;
  }
  const expectedRouting = routingFor(cell.model.id);
  const proof = {
    call: proofs.length + 1,
    maxTokensField: "max_tokens",
    maxTokens: transformed.max_tokens,
    reasoning: transformed.reasoning ?? null,
    thinking: transformed.thinking ?? null,
    reasoningEffort: transformed.reasoning_effort ?? null,
    temperature: transformed.temperature,
    inferenceSeed: transformed.seed ?? null,
    responseFormat: transformed.response_format ?? null,
    emitDoneToolPresent: Array.isArray(transformed.tools) && transformed.tools.some((tool) =>
      tool?.function?.name === "emit_done"
    ),
    toolChoice: transformed.tool_choice ?? null,
    provider: transformed.provider ?? null,
  };
  proof.contractPass = proof.maxTokens === ROOT_OUTPUT_TOKENS
    && proof.temperature === 0
    && proof.inferenceSeed === null
    && proof.responseFormat === null
    && proof.emitDoneToolPresent
    && (directDeepSeek
      ? proof.reasoning === null
        && proof.thinking?.type === "enabled"
        && proof.reasoningEffort === REASONING
        && proof.toolChoice === null
        && proof.provider === null
      : proof.reasoning?.effort === REASONING
        && proof.thinking === null
        && proof.reasoningEffort === null
        && proof.toolChoice === null
        && stable(proof.provider) === stable(expectedRouting));
  proof.sha256 = sha256(stable(proof));
  proofs.push(proof);
  if (!proof.contractPass) throw new Error("provider payload failed frozen wire contract");
  return transformed;
}

function payloadContracts() {
  return Object.fromEntries(MODELS.map((model) => {
    const proofs = [];
    const provider = routingFor(model.id);
    controlledPayload({
      tools: [{ type: "function", function: { name: "emit_done" } }],
      ...(provider ? { provider } : {}),
    }, { model, task: CASES[0] }, proofs);
    return [model.id, proofs[0]];
  }));
}

async function runCampaign(options) {
  const campaignModels = selectedModels(options.models);
  const frozen = manifest();
  const digest = sha256(stable(frozen));
  if (options.manifestSha !== digest) throw new Error(`manifest digest mismatch: expected ${digest}`);
  const tasks = options.mode === "probe" ? [CASES[0]] : CASES;
  const cells = shuffled(tasks.flatMap((task) => campaignModels.map((model) => ({ task, model }))), 0x9e3779b9);
  if (options.authorizedCalls !== cells.length) throw new Error(`authorized calls must equal ${cells.length}`);
  if (!(options.authorizedUsd > 0)) throw new Error("authorized USD must be positive");

  const usesOpenRouter = campaignModels.some((model) => model.wireProvider === "openrouter");
  const usesDeepSeek = campaignModels.some((model) => model.wireProvider === "deepseek");
  const openRouterApiKey = usesOpenRouter ? await openRouterKey() : null;
  const directApiKey = usesDeepSeek ? deepSeekKey() : null;
  const runRoot = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "mikro-sdk-model-benchmark-"));
  const primeAgentDir = await configurePrime(runRoot);
  const previous = {
    key: process.env.OPENROUTER_API_KEY,
    agentDir: process.env.PRIME_AGENT_CODING_AGENT_DIR,
    deadline: process.env.MIKRO_MCP_RUN_TIMEOUT_MS,
  };
  if (openRouterApiKey) process.env.OPENROUTER_API_KEY = openRouterApiKey;
  process.env.PRIME_AGENT_CODING_AGENT_DIR = primeAgentDir;
  process.env.MIKRO_MCP_RUN_TIMEOUT_MS = String(DEADLINE_MS);

  const [{ loadConfig }, { PrimeSdkBackend }] = await Promise.all([
    import("../dist/src/config.js"),
    import("../dist/src/mcp/backends/prime-sdk.js"),
  ]);
  const base = await loadConfig(runRoot);
  const openRouterUsageStart = openRouterApiKey ? await keyUsage(openRouterApiKey) : null;
  const directBalanceStart = directApiKey ? await deepSeekBalance(directApiKey) : null;
  let report = {
    version: frozen.version,
    manifest: frozen,
    manifestSha256: digest,
    stage: options.mode,
    models: campaignModels.map((model) => model.id),
    authorizedCalls: options.authorizedCalls,
    authorizedUsd: options.authorizedUsd,
    startedAt: new Date().toISOString(),
    complete: false,
    records: [],
    openRouterUsageStartUsd: openRouterUsageStart,
    openRouterUsageCurrentUsd: openRouterUsageStart,
    openRouterUsageDeltaUsd: 0,
    deepSeekBalanceStartUsd: directBalanceStart,
    deepSeekBalanceCurrentUsd: directBalanceStart,
    deepSeekSpendDeltaUsd: 0,
    totalAuthoritativeSpendUsd: 0,
  };
  if (options.resume && existsSync(options.output)) {
    const prior = JSON.parse(readFileSync(options.output, "utf8"));
    if (prior.manifestSha256 !== digest || prior.stage !== options.mode || prior.authorizedCalls !== options.authorizedCalls) throw new Error("resume artifact does not match campaign");
    report = prior;
    if (openRouterApiKey) {
      report.openRouterUsageCurrentUsd = await keyUsage(openRouterApiKey);
      report.openRouterUsageDeltaUsd = report.openRouterUsageCurrentUsd - report.openRouterUsageStartUsd;
    }
    if (directApiKey) {
      report.deepSeekBalanceCurrentUsd = await deepSeekBalance(directApiKey);
      report.deepSeekSpendDeltaUsd = report.deepSeekBalanceStartUsd - report.deepSeekBalanceCurrentUsd;
    }
    reconcileBilling(report);
  }
  const done = new Set(report.records.map((record) => `${record.model}\u0000${record.task}`));

  try {
    for (const cell of cells) {
      const keyId = `${cell.model.id}\u0000${cell.task.id}`;
      if (done.has(keyId)) continue;
      if (report.totalAuthoritativeSpendUsd + worstCellCost(cell.model) > options.authorizedUsd) throw new Error("remaining authorization cannot cover next cell at frozen limits");
      const prompt = taskPrompt(cell.task);
      const config = {
        ...base,
        model: { provider: cell.model.wireProvider, model: cell.model.wireModel, subCallModel: cell.model.wireModel, providers: [] },
        providers: [],
        system: SYSTEM,
        criteria: "Call emit_done with the exact requested object.",
        budget: { maxCost: null, maxTokens: INPUT_TOKEN_CAP, maxDepth: null },
        gemini: { ...(base.gemini ?? {}), thinkingLevel: REASONING },
        output: { schema: schemaFor(cell.task.expected) },
        tools: [],
      };
      const cellStartedAt = new Date().toISOString();
      const started = performance.now();
      const payloadProofs = [];
      const backend = new PrimeSdkBackend({
        primeRoot: PRIME_ROOT,
        primeAgentDir,
        providerPayloadTransform: (payload) => controlledPayload(payload, cell, payloadProofs),
      });
      let record;
      try {
        const result = await backend.run(agent(cell.model), {
          query: prompt,
          context: null,
          config,
          cwd: runRoot,
          maxIterations: MAX_ITERATIONS,
          maxOutputTokens: ROOT_OUTPUT_TOKENS,
          maxRetries: 0,
        }, () => {});
        const timedOut = result.answer === TIMEOUT_ANSWER;
        const judged = timedOut
          ? { semanticPass: false, formatPass: false, fieldAccuracy: 0, reason: "timeout", parsedFormat: "none" }
          : score(cell.task.expected, result.answer);
        record = {
          model: cell.model.id,
          wireProvider: cell.model.wireProvider,
          wireModel: cell.model.wireModel,
          startedAt: cellStartedAt,
          ...(cell.model.wireProvider === "deepseek" ? { deepSeekPricingMultiplier: deepSeekPricingMultiplier(cellStartedAt) } : {}),
          task: cell.task.id,
          family: cell.task.family,
          seed: cell.task.seed,
          ok: !timedOut,
          semanticPass: judged.semanticPass,
          formatPass: judged.formatPass,
          fieldAccuracy: judged.fieldAccuracy,
          scoreReason: judged.reason,
          parsedFormat: judged.parsedFormat,
          ...(timedOut ? { failureCategory: "timeout" } : {}),
          answerSha256: sha256(result.answer),
          promptSha256: sha256(prompt),
          expectedSha256: sha256(stable(cell.task.expected)),
          iterations: result.iterations,
          budgetHit: result.budgetHit ?? null,
          usage: result.usage,
          wallMs: Math.round(performance.now() - started),
          limitCompliant: result.usage.inputTokens <= INPUT_TOKEN_CAP && result.iterations <= MAX_ITERATIONS,
          route: routeFor(cell.model.id).tag,
          payloadContractPass: payloadProofs.length > 0 && payloadProofs.every((proof) => proof.contractPass),
          payloadProofs,
        };
      } catch (error) {
        record = {
          model: cell.model.id,
          wireProvider: cell.model.wireProvider,
          wireModel: cell.model.wireModel,
          startedAt: cellStartedAt,
          ...(cell.model.wireProvider === "deepseek" ? { deepSeekPricingMultiplier: deepSeekPricingMultiplier(cellStartedAt) } : {}),
          task: cell.task.id,
          family: cell.task.family,
          seed: cell.task.seed,
          ok: false,
          semanticPass: false,
          formatPass: false,
          fieldAccuracy: 0,
          scoreReason: classifyRuntimeError(error),
          failureCategory: classifyRuntimeError(error),
          errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
          errorSha256: sha256(error instanceof Error ? error.message : String(error)),
          promptSha256: sha256(prompt),
          expectedSha256: sha256(stable(cell.task.expected)),
          wallMs: Math.round(performance.now() - started),
          route: routeFor(cell.model.id).tag,
          payloadContractPass: payloadProofs.length > 0 && payloadProofs.every((proof) => proof.contractPass),
          payloadProofs,
        };
      }
      report.records.push(record);
      if (cell.model.wireProvider === "openrouter") {
        report.openRouterUsageCurrentUsd = await keyUsage(openRouterApiKey);
        report.openRouterUsageDeltaUsd = report.openRouterUsageCurrentUsd - report.openRouterUsageStartUsd;
      } else {
        report.deepSeekBalanceCurrentUsd = await deepSeekBalance(directApiKey);
        report.deepSeekSpendDeltaUsd = report.deepSeekBalanceStartUsd - report.deepSeekBalanceCurrentUsd;
      }
      reconcileBilling(report);
      await atomicWrite(options.output, report);
      process.stderr.write(`${record.model} ${record.task}: ${record.semanticPass ? "PASS" : record.scoreReason}\n`);
      if (report.totalAuthoritativeSpendUsd > options.authorizedUsd) throw new Error("provider account usage exceeded authorization");
      if (record.ok && !record.limitCompliant) throw new Error("successful cell violated frozen limits");
    }
    report.complete = report.records.length === cells.length;
    report.claimEligible = report.complete
      && report.billing?.status === "reconciled"
      && frozen.routesEnforced
      && report.records.every((record) => record.ok && record.semanticPass && record.formatPass && record.limitCompliant && record.payloadContractPass);
    report.completedAt = new Date().toISOString();
    await atomicWrite(options.output, report);
    if (!report.complete || report.records.some((record) => !record.ok || !record.semanticPass || !record.formatPass || !record.payloadContractPass)) process.exitCode = 1;
  } finally {
    if (previous.key === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previous.key;
    if (previous.agentDir === undefined) delete process.env.PRIME_AGENT_CODING_AGENT_DIR; else process.env.PRIME_AGENT_CODING_AGENT_DIR = previous.agentDir;
    if (previous.deadline === undefined) delete process.env.MIKRO_MCP_RUN_TIMEOUT_MS; else process.env.MIKRO_MCP_RUN_TIMEOUT_MS = previous.deadline;
    await rm(runRoot, { recursive: true, force: true });
  }
}

function summarize(report) {
  const byModel = Object.fromEntries(MODELS.map((model) => {
    const rows = report.records.filter((record) => record.model === model.id);
    return [model.id, {
      n: rows.length,
      ok: rows.filter((row) => row.ok).length,
      semanticPasses: rows.filter((row) => row.semanticPass).length,
      semanticRate: rows.length ? rows.filter((row) => row.semanticPass).length / rows.length : 0,
      meanFieldAccuracy: rows.length ? rows.reduce((sum, row) => sum + row.fieldAccuracy, 0) / rows.length : 0,
      medianWallMs: rows.length ? [...rows].sort((a, b) => a.wallMs - b.wallMs)[Math.floor((rows.length - 1) / 2)].wallMs : null,
      inputTokens: rows.reduce((sum, row) => sum + (row.usage?.inputTokens ?? 0), 0),
      outputTokens: rows.reduce((sum, row) => sum + (row.usage?.outputTokens ?? 0), 0),
    }];
  }));
  return { version: report.version, manifestSha256: report.manifestSha256, complete: report.complete, calls: report.records.length, totalAuthoritativeSpendUsd: report.totalAuthoritativeSpendUsd, byModel };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "manifest") return void process.stdout.write(`${JSON.stringify(manifest())}\n`);
  if (command === "models-config") return void process.stdout.write(`${JSON.stringify(modelsConfig())}\n`);
  if (command === "payload-contracts") return void process.stdout.write(`${JSON.stringify(payloadContracts())}\n`);
  if (command === "billing-contract") return void process.stdout.write(`${JSON.stringify(billingContract())}\n`);
  if (command === "preflight") return void process.stdout.write(`${JSON.stringify(await preflight())}\n`);
  if (command === "run") {
    const flags = parseFlags(args);
    if (flags.mode !== "probe" && flags.mode !== "full") throw new Error("--mode must be probe or full");
    await runCampaign({ mode: flags.mode, output: resolve(flags.output), manifestSha: flags["manifest-sha"], authorizedCalls: Number(flags["authorized-calls"]), authorizedUsd: Number(flags["authorized-usd"]), resume: flags.resume === "true", models: flags.models });
    return;
  }
  if (command === "summarize") {
    const flags = parseFlags(args);
    return void process.stdout.write(`${JSON.stringify(summarize(JSON.parse(readFileSync(resolve(flags.input), "utf8"))))}\n`);
  }
  throw new Error("usage: benchmark-models-sdk-v2.mjs manifest|models-config|payload-contracts|billing-contract|preflight|run|summarize");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
