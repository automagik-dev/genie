#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PRIME_ROOT = "/home/genie/.local/lib/node_modules/prime-agent";
const PINNED_PRIME_VERSION = "0.8.1";
const BWS_PROJECT_ID = "09229871-62e6-4331-9ede-b4a7012ec521";
const PROVIDER = Object.freeze({ name: "GMICloud", slug: "gmicloud", tag: "gmicloud/fp8", quantization: "fp8" });
const MODELS = Object.freeze([
  { id: "z-ai/glm-5.3", promptRate: 1.4, completionRate: 4.4 },
  { id: "z-ai/glm-5.3-flash", promptRate: 0.075, completionRate: 0.25 },
]);
const REQUIRED_PARAMETERS = Object.freeze(["reasoning", "temperature", "seed", "response_format", "max_tokens"]);
const REPEATS = 3;
const MAX_INPUT_TOKENS = 1_024;
const MAX_COMPLETION_TOKENS = 4_096;
const TIMEOUT_MS = 90_000;
const ROUTING = Object.freeze({
  only: [PROVIDER.slug],
  order: [PROVIDER.slug],
  allow_fallbacks: false,
  require_parameters: true,
  quantizations: [PROVIDER.quantization],
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function packageVersion(path) {
  return JSON.parse(readFileSync(path, "utf8")).version;
}

function manifest() {
  const frozen = {
    version: "glm-provider-stability-probe-v1",
    baseSha: spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim(),
    harnessSha256: null,
    primeVersion: PINNED_PRIME_VERSION,
    wire: "OpenRouter OpenAI chat completions",
    provider: PROVIDER,
    routing: ROUTING,
    models: MODELS,
    repeats: REPEATS,
    cells: MODELS.length * REPEATS,
    retries: 0,
    reasoning: "high",
    temperature: 0,
    maxInputTokens: MAX_INPUT_TOKENS,
    maxCompletionTokens: MAX_COMPLETION_TOKENS,
    timeoutMs: TIMEOUT_MS,
    responseFormat: { type: "json_object" },
    rawAnswersPersisted: false,
    billingAuthority: "OpenRouter /api/v1/key usage delta; response usage reconciles",
  };
  const source = readFileSync(SCRIPT_PATH, "utf8");
  frozen.harnessSha256 = sha256(source.replace(/const SELF_SHA = "[a-f0-9]*";/, 'const SELF_SHA = "";'));
  return frozen;
}

function parseFlags(args) {
  const out = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith("--") || args[index + 1] === undefined) throw new Error(`invalid argument: ${args[index] ?? ""}`);
    out[args[index].slice(2)] = args[index + 1];
  }
  return out;
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

async function keyUsage(key) {
  const response = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` } });
  if (!response.ok) throw new Error(`OpenRouter key usage lookup failed: ${response.status}`);
  const body = await response.json();
  if (!Number.isFinite(body?.data?.usage)) throw new Error("OpenRouter key usage response lacks numeric usage");
  return body.data.usage;
}

async function endpoints(modelId) {
  const response = await fetch(`https://openrouter.ai/api/v1/models/${modelId}/endpoints`);
  if (!response.ok) throw new Error(`OpenRouter endpoint discovery failed for ${modelId}: ${response.status}`);
  return (await response.json()).data?.endpoints ?? [];
}

async function preflight() {
  const frozen = manifest();
  const [key, ...rows] = await Promise.all([openRouterKey(), ...MODELS.map((model) => endpoints(model.id))]);
  const checks = Object.fromEntries(MODELS.map((model, index) => {
    const endpoint = rows[index].find((entry) => entry.tag === PROVIDER.tag);
    return [model.id, {
      present: Boolean(endpoint),
      healthy: endpoint?.status === 0,
      quantization: endpoint?.quantization ?? null,
      requiredParameters: Object.fromEntries(REQUIRED_PARAMETERS.map((parameter) => [parameter, endpoint?.supported_parameters?.includes(parameter) ?? false])),
      uptimeLast5m: endpoint?.uptime_last_5m ?? null,
      uptimeLast30m: endpoint?.uptime_last_30m ?? null,
      uptimeLast1d: endpoint?.uptime_last_1d ?? null,
    }];
  }));
  const installedPrimeVersion = packageVersion(join(PRIME_ROOT, "package.json"));
  const pass = installedPrimeVersion === frozen.primeVersion && Boolean(key) && MODELS.every((model) => {
    const check = checks[model.id];
    return check.present && check.healthy && check.quantization === PROVIDER.quantization && Object.values(check.requiredParameters).every(Boolean);
  });
  return { pass, manifestSha256: sha256(stable(frozen)), credentialNamesPresent: { OPENROUTER_API_KEY: Boolean(key) }, checks };
}

function safeDiagnostic(value) {
  if (!value) return null;
  return String(value).replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED]").slice(0, 500);
}

function classify(status, message) {
  const text = String(message ?? "").toLowerCase();
  if (status === 429 || text.includes("rate limit")) return "rate-limit";
  if (status === 408 || text.includes("timeout") || text.includes("timed out")) return "timeout";
  if (status === 401 || status === 403) return "auth";
  if (status === 400 || status === 404 || text.includes("no endpoints") || text.includes("provider")) return "provider-incompatibility";
  if (text.includes("abort")) return "abort";
  return "transport-error";
}

async function generationMetadata(responseId, key) {
  if (!responseId) return null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(responseId)}`, { headers: { Authorization: `Bearer ${key}` } });
    if (response.ok) {
      const body = await response.json();
      if (body?.data) return body.data;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500 * (attempt + 1)));
  }
  return null;
}

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function responseText(body) {
  const content = body?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

function parseMarker(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value.marker : null;
  } catch {
    return null;
  }
}

function worstCellCost(model) {
  return ((MAX_INPUT_TOKENS * model.promptRate) + (MAX_COMPLETION_TOKENS * model.completionRate)) / 1_000_000;
}

async function run(options) {
  const frozen = manifest();
  const digest = sha256(stable(frozen));
  if (options.manifestSha !== digest) throw new Error(`manifest digest mismatch: expected ${digest}`);
  if (options.authorizedCalls !== frozen.cells) throw new Error(`authorized calls must equal ${frozen.cells}`);
  if (!(options.authorizedUsd > 0)) throw new Error("authorized USD must be positive");
  const key = await openRouterKey();
  const usageStart = await keyUsage(key);
  const report = {
    version: frozen.version,
    manifest: frozen,
    manifestSha256: digest,
    authorizedCalls: options.authorizedCalls,
    authorizedUsd: options.authorizedUsd,
    startedAt: new Date().toISOString(),
    complete: false,
    records: [],
    keyUsageStartUsd: usageStart,
    keyUsageCurrentUsd: usageStart,
    keyUsageDeltaUsd: 0,
  };
  for (let repeat = 1; repeat <= REPEATS; repeat += 1) {
    for (const model of MODELS) {
      if (report.keyUsageDeltaUsd + worstCellCost(model) > options.authorizedUsd) throw new Error("remaining authorization cannot cover next cell");
      const marker = `GMI-${repeat}-${sha256(model.id).slice(0, 8)}`;
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const started = performance.now();
      let record;
      try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            model: model.id,
            provider: ROUTING,
            messages: [
              { role: "system", content: "Return only the requested JSON object. Do not add prose or markdown." },
              { role: "user", content: `Return exactly {\"marker\":\"${marker}\"}.` },
            ],
            reasoning: { effort: "high" },
            temperature: 0,
            seed: 53_000 + repeat,
            max_tokens: MAX_COMPLETION_TOKENS,
            response_format: { type: "json_object" },
          }),
        });
        const body = await response.json();
        if (!response.ok) {
          const message = body?.error?.message ?? `HTTP ${response.status}`;
          record = { model: model.id, repeat, ok: false, category: classify(response.status, message), status: response.status, diagnostic: safeDiagnostic(message), diagnosticSha256: sha256(String(message)), wallMs: Math.round(performance.now() - started), route: PROVIDER.tag };
        } else {
          const text = responseText(body);
          const generation = await generationMetadata(body.id, key);
          const actualProvider = generation?.provider_name ?? generation?.provider ?? null;
          const markerPass = parseMarker(text) === marker;
          record = {
            model: model.id,
            repeat,
            ok: markerPass && (!actualProvider || actualProvider === PROVIDER.name),
            category: markerPass ? null : "invalid-marker",
            status: response.status,
            stopReason: body?.choices?.[0]?.finish_reason ?? null,
            markerPass,
            answerSha256: sha256(text),
            responseIdSha256: body.id ? sha256(body.id) : null,
            actualProvider,
            routeVerified: actualProvider ? actualProvider === PROVIDER.name : true,
            routeVerification: actualProvider ? "generation-metadata" : "request-pin-no-fallback",
            usage: body.usage ?? null,
            actualCostUsd: Number(generation?.total_cost ?? body?.usage?.cost ?? 0),
            wallMs: Math.round(performance.now() - started),
            route: PROVIDER.tag,
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        record = { model: model.id, repeat, ok: false, category: classify(null, message), status: null, diagnostic: safeDiagnostic(message), diagnosticSha256: sha256(message), wallMs: Math.round(performance.now() - started), route: PROVIDER.tag };
      } finally {
        clearTimeout(deadline);
      }
      report.records.push(record);
      report.keyUsageCurrentUsd = await keyUsage(key);
      report.keyUsageDeltaUsd = report.keyUsageCurrentUsd - report.keyUsageStartUsd;
      await atomicWrite(options.output, report);
      process.stderr.write(`${model.id} repeat-${repeat}: ${record.ok ? "PASS" : record.category}\n`);
      if (report.keyUsageDeltaUsd > options.authorizedUsd) throw new Error("key usage delta exceeded authorization");
    }
  }
  report.complete = report.records.length === frozen.cells;
  report.completedAt = new Date().toISOString();
  report.successByModel = Object.fromEntries(MODELS.map((model) => {
    const rows = report.records.filter((record) => record.model === model.id);
    return [model.id, { attempts: rows.length, successes: rows.filter((record) => record.ok).length }];
  }));
  report.stable = report.complete && report.records.every((record) => record.ok);
  await atomicWrite(options.output, report);
  if (!report.stable) process.exitCode = 1;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "manifest") return void process.stdout.write(`${JSON.stringify(manifest())}\n`);
  if (command === "preflight") return void process.stdout.write(`${JSON.stringify(await preflight())}\n`);
  if (command === "run") {
    const flags = parseFlags(args);
    return void await run({ output: resolve(flags.output), manifestSha: flags["manifest-sha"], authorizedCalls: Number(flags["authorized-calls"]), authorizedUsd: Number(flags["authorized-usd"]) });
  }
  throw new Error("usage: probe-glm-provider.mjs manifest|preflight|run");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
