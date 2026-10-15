#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PRIME_ROOT = "/home/genie/.local/lib/node_modules/prime-agent";
const PRIME_AI_ROOT = join(PRIME_ROOT, "node_modules/@earendil-works/pi-ai");
const PINNED_PRIME_VERSION = "0.8.1";
const PINNED_PRIME_AI_VERSION = "0.8.1";
const PINNED_PRIME_AI_PACKAGE_SHA256 = "794ea86b13fe4c241c73aa8580cda0dedb0f3d20ee879bc93c50616cc0016f79";
const BWS_PROJECT_ID = "09229871-62e6-4331-9ede-b4a7012ec521";
const ROUTE = Object.freeze({
  gateway: "openrouter",
  allowFallbacks: false,
});
const MAX_INPUT_TOKENS = 32_768;
const MAX_COMPLETION_TOKENS = 8_192;
const TIMEOUT_MS = 60_000;
const REASONING = "low";
const THINKING_LEVEL_MAP = Object.freeze({
  off: null,
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
});
const CASES_PER_FAMILY = 10;
const CAMPAIGN_SEED = 0x53f1a9c7;
const SYSTEM = [
  "Solve the supplied synthetic reasoning problem using only its stated rules and data.",
  "Return exactly one JSON object with the requested keys and value types.",
  "Do not add prose, markdown, fields, or assumptions.",
].join(" ");

const MODELS = Object.freeze([
  { id: "z-ai/glm-5.3", providerName: "GMICloud", providerSlug: "gmicloud", tag: "gmicloud/fp8", quantization: "fp8", promptRate: 1.4, completionRate: 4.4 },
  { id: "z-ai/glm-5.3-flash", providerName: "DeepInfra", providerSlug: "deepinfra", tag: "deepinfra/fp8", quantization: "fp8", promptRate: 0.075, completionRate: 0.25 },
  { id: "deepseek/deepseek-v4-flash-0731", providerName: "OpenInference", providerSlug: "open-inference", tag: "open-inference/fp8", quantization: "fp8", promptRate: 0.05, completionRate: 0.16 },
  { id: "deepseek/deepseek-v4-pro-0813", providerName: "GMICloud", providerSlug: "gmicloud", tag: "gmicloud/fp8", quantization: "fp8", promptRate: 1.122, completionRate: 3.366 },
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function rng(seed) {
  let state = seed >>> 0;
  return {
    int(min, max) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return min + Math.floor((state / 0x100000000) * (max - min + 1));
    },
    shuffle(values) {
      const out = [...values];
      for (let index = out.length - 1; index > 0; index -= 1) {
        const other = this.int(0, index);
        [out[index], out[other]] = [out[other], out[index]];
      }
      return out;
    },
  };
}

function comparePath(left, right) {
  return left.join(">") < right.join(">") ? -1 : left.join(">") > right.join(">") ? 1 : 0;
}

function shortestPathCase(seed) {
  const random = rng(seed);
  const nodes = Array.from({ length: 11 }, (_, index) => String.fromCharCode(65 + index));
  const edges = [];
  for (let from = 0; from < nodes.length - 1; from += 1) {
    edges.push({ from: nodes[from], to: nodes[from + 1], cost: random.int(3, 15) });
    for (let gap = 2; gap <= 4 && from + gap < nodes.length; gap += 1) {
      if (random.int(0, 99) < 68) edges.push({ from: nodes[from], to: nodes[from + gap], cost: random.int(7, 31) });
    }
  }
  const best = new Map([[nodes[0], { cost: 0, path: [nodes[0]] }]]);
  for (const node of nodes) {
    const current = best.get(node);
    if (!current) continue;
    for (const edge of edges.filter((candidate) => candidate.from === node)) {
      const candidate = { cost: current.cost + edge.cost, path: [...current.path, edge.to] };
      const prior = best.get(edge.to);
      if (!prior || candidate.cost < prior.cost || (candidate.cost === prior.cost && comparePath(candidate.path, prior.path) < 0)) {
        best.set(edge.to, candidate);
      }
    }
  }
  const answer = best.get(nodes.at(-1));
  return {
    family: "shortest-path",
    prompt: [
      "Find the minimum-cost directed path from A to K.",
      "All listed edges point forward. If costs tie, choose the lexicographically smallest full node sequence.",
      ...random.shuffle(edges).map((edge) => `${edge.from}->${edge.to} cost=${edge.cost}`),
      'Return shape: {"path":["string"],"total_cost":integer}',
    ].join("\n"),
    expected: { path: answer.path, total_cost: answer.cost },
  };
}

function criticalPathCase(seed) {
  const random = rng(seed);
  const names = Array.from({ length: 10 }, (_, index) => `T${index + 1}`);
  const tasks = names.map((id, index) => ({ id, duration: random.int(2, 13), deps: index === 0 ? [] : [] }));
  for (let index = 1; index < tasks.length; index += 1) {
    tasks[index].deps.push(tasks[random.int(0, index - 1)].id);
    for (let prior = 0; prior < index; prior += 1) {
      if (!tasks[index].deps.includes(tasks[prior].id) && random.int(0, 99) < 24) tasks[index].deps.push(tasks[prior].id);
    }
    tasks[index].deps.sort();
  }
  const best = new Map();
  for (const task of tasks) {
    let prefix = { duration: 0, path: [] };
    for (const dep of task.deps) {
      const candidate = best.get(dep);
      if (candidate.duration > prefix.duration || (candidate.duration === prefix.duration && comparePath(candidate.path, prefix.path) < 0)) prefix = candidate;
    }
    best.set(task.id, { duration: prefix.duration + task.duration, path: [...prefix.path, task.id] });
  }
  const terminal = tasks.filter((task) => !tasks.some((candidate) => candidate.deps.includes(task.id)));
  let answer = { duration: -1, path: [] };
  for (const task of terminal) {
    const candidate = best.get(task.id);
    if (candidate.duration > answer.duration || (candidate.duration === answer.duration && comparePath(candidate.path, answer.path) < 0)) answer = candidate;
  }
  return {
    family: "critical-path",
    prompt: [
      "Tasks run as early as dependencies permit with unlimited workers. Compute project duration and one critical path.",
      "A task's finish time is its duration plus the maximum finish time among its dependencies (zero if none).",
      "Choose the lexicographically smallest full path if multiple critical paths tie.",
      ...random.shuffle(tasks).map((task) => `${task.id}: duration=${task.duration}; deps=${task.deps.length ? task.deps.join(",") : "none"}`),
      'Return shape: {"critical_path":["string"],"duration":integer}',
    ].join("\n"),
    expected: { critical_path: answer.path, duration: answer.duration },
  };
}

function ledgerCase(seed) {
  const random = rng(seed);
  const accounts = ["A", "B", "C", "D"];
  const initial = Object.fromEntries(accounts.map((account) => [account, random.int(80, 180)]));
  const events = [];
  const effects = new Map();
  let sequence = 10;
  for (let index = 0; index < 16; index += 1) {
    const id = `E${index + 1}`;
    const kind = random.int(0, 2);
    const amount = random.int(5, 37);
    const from = accounts[random.int(0, accounts.length - 1)];
    const to = accounts[(accounts.indexOf(from) + random.int(1, accounts.length - 1)) % accounts.length];
    const event = kind === 0
      ? { seq: sequence, id, op: "credit", account: from, amount }
      : kind === 1
        ? { seq: sequence, id, op: "debit", account: from, amount }
        : { seq: sequence, id, op: "transfer", from, to, amount };
    events.push(event);
    const effect = Object.fromEntries(accounts.map((account) => [account, 0]));
    if (event.op === "credit") effect[event.account] += amount;
    else if (event.op === "debit") effect[event.account] -= amount;
    else { effect[event.from] -= amount; effect[event.to] += amount; }
    effects.set(id, effect);
    sequence += random.int(2, 6);
  }
  for (let index = 0; index < 3; index += 1) {
    const target = `E${random.int(1, 12)}`;
    events.push({ seq: sequence, id: `R${index + 1}`, op: "reverse", target });
    sequence += random.int(2, 6);
  }
  const duplicated = events[random.int(0, 8)];
  events.push({ ...duplicated, seq: sequence });
  const balances = { ...initial };
  const seen = new Set();
  const reversed = new Set();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (event.op === "reverse") {
      if (reversed.has(event.target) || !effects.has(event.target)) continue;
      reversed.add(event.target);
      for (const account of accounts) balances[account] -= effects.get(event.target)[account];
    } else {
      for (const account of accounts) balances[account] += effects.get(event.id)[account];
    }
  }
  const render = (event) => event.op === "transfer"
    ? `seq=${event.seq} id=${event.id} transfer ${event.from}->${event.to} amount=${event.amount}`
    : event.op === "reverse"
      ? `seq=${event.seq} id=${event.id} reverse target=${event.target}`
      : `seq=${event.seq} id=${event.id} ${event.op} account=${event.account} amount=${event.amount}`;
  return {
    family: "event-ledger",
    prompt: [
      `Initial balances: ${accounts.map((account) => `${account}=${initial[account]}`).join(", ")}.`,
      "Process events by ascending seq. Apply only the first occurrence of an event id.",
      "credit adds, debit subtracts, transfer subtracts from source and adds to destination.",
      "A reverse negates its target's original effect once; later reversals of the same target do nothing.",
      ...random.shuffle(events).map(render),
      'Return shape: {"balances":{"A":integer,"B":integer,"C":integer,"D":integer},"reversed_targets":["string" sorted]}',
    ].join("\n"),
    expected: { balances, reversed_targets: [...reversed].sort() },
  };
}

function relationalCase(seed) {
  const random = rng(seed);
  const teams = ["blue", "green", "red"];
  const users = [];
  for (let id = 1; id <= 7; id += 1) {
    const team = teams[random.int(0, teams.length - 1)];
    users.push({ id: `U${id}`, rev: 1, team, active: random.int(0, 99) < 75 });
    users.push({ id: `U${id}`, rev: 2, team: random.int(0, 99) < 25 ? teams[random.int(0, 2)] : team, active: random.int(0, 99) < 72 });
  }
  const orders = Array.from({ length: 15 }, (_, index) => ({ id: `O${index + 1}`, user: `U${random.int(1, 7)}`, amount: random.int(12, 95) }));
  const statuses = [];
  for (const order of orders) {
    statuses.push({ order: order.id, seq: 1, status: random.int(0, 99) < 55 ? "pending" : "paid" });
    statuses.push({ order: order.id, seq: 2, status: ["paid", "cancelled", "refunded"][random.int(0, 2)] });
  }
  const latestUser = new Map();
  for (const user of users) if (!latestUser.has(user.id) || latestUser.get(user.id).rev < user.rev) latestUser.set(user.id, user);
  const latestStatus = new Map();
  for (const status of statuses) if (!latestStatus.has(status.order) || latestStatus.get(status.order).seq < status.seq) latestStatus.set(status.order, status);
  const totals = Object.fromEntries(teams.map((team) => [team, 0]));
  const included = [];
  for (const order of orders) {
    const user = latestUser.get(order.user);
    if (user.active && latestStatus.get(order.id).status === "paid") {
      totals[user.team] += order.amount;
      included.push(order.id);
    }
  }
  return {
    family: "relational-join",
    prompt: [
      "Use only the highest rev row for each user and the highest seq row for each order status.",
      "Include an order iff its latest status is paid and its latest user row is active. Sum included amounts by the latest user's team.",
      "USERS:", ...random.shuffle(users).map((u) => `${u.id} rev=${u.rev} team=${u.team} active=${u.active}`),
      "ORDERS:", ...random.shuffle(orders).map((o) => `${o.id} user=${o.user} amount=${o.amount}`),
      "STATUSES:", ...random.shuffle(statuses).map((s) => `${s.order} seq=${s.seq} status=${s.status}`),
      'Return shape: {"team_totals":{"blue":integer,"green":integer,"red":integer},"included_orders":["string" sorted]}',
    ].join("\n"),
    expected: { team_totals: totals, included_orders: included.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))) },
  };
}

function booleanCircuitCase(seed) {
  const random = rng(seed);
  const values = {};
  const inputs = Array.from({ length: 9 }, (_, index) => `x${index}`);
  for (const input of inputs) values[input] = random.int(0, 1);
  const gates = [];
  const refs = [...inputs];
  for (let index = 0; index < 18; index += 1) {
    const id = `g${index}`;
    const op = ["AND", "OR", "XOR", "NOT"][random.int(0, 3)];
    const left = refs[random.int(0, refs.length - 1)];
    const right = op === "NOT" ? null : refs[random.int(0, refs.length - 1)];
    const lv = values[left];
    const rv = right === null ? 0 : values[right];
    values[id] = op === "AND" ? (lv & rv) : op === "OR" ? (lv | rv) : op === "XOR" ? (lv ^ rv) : (lv ? 0 : 1);
    gates.push({ id, op, left, right });
    refs.push(id);
  }
  const outputs = gates.slice(-6).map((gate) => gate.id);
  return {
    family: "boolean-circuit",
    prompt: [
      "Evaluate this Boolean circuit in listed gate order. Values are integers 0 or 1.",
      `Inputs: ${inputs.map((id) => `${id}=${values[id]}`).join(" ")}`,
      ...gates.map((gate) => gate.right === null ? `${gate.id}=NOT(${gate.left})` : `${gate.id}=${gate.op}(${gate.left},${gate.right})`),
      `Return shape: {"outputs":{${outputs.map((id) => `"${id}":integer`).join(",")}}}`,
    ].join("\n"),
    expected: { outputs: Object.fromEntries(outputs.map((id) => [id, values[id]])) },
  };
}

function setCoverCase(seed) {
  const random = rng(seed);
  const universe = Array.from({ length: 9 }, (_, index) => String.fromCharCode(97 + index));
  const sets = [];
  for (let index = 0; index < 11; index += 1) {
    const members = random.shuffle(universe).slice(0, random.int(2, 5)).sort();
    sets.push({ id: `S${String(index + 1).padStart(2, "0")}`, cost: random.int(2, 14), members });
  }
  sets.push({ id: "S12", cost: 40, members: [...universe] });
  let winner = null;
  for (let mask = 1; mask < 2 ** sets.length; mask += 1) {
    const chosen = sets.filter((_, index) => mask & (1 << index));
    const covered = new Set(chosen.flatMap((item) => item.members));
    if (covered.size !== universe.length) continue;
    const candidate = { cost: chosen.reduce((sum, item) => sum + item.cost, 0), ids: chosen.map((item) => item.id) };
    if (!winner || candidate.cost < winner.cost
      || (candidate.cost === winner.cost && candidate.ids.length < winner.ids.length)
      || (candidate.cost === winner.cost && candidate.ids.length === winner.ids.length && candidate.ids.join(",") < winner.ids.join(","))) winner = candidate;
  }
  return {
    family: "weighted-set-cover",
    prompt: [
      `Choose sets whose union covers every element in U={${universe.join(",")}} with minimum total cost.`,
      "Tie-break first by fewer sets, then by lexicographically smallest sorted set-id list.",
      ...random.shuffle(sets).map((item) => `${item.id} cost=${item.cost} members={${item.members.join(",")}}`),
      'Return shape: {"sets":["string" sorted],"total_cost":integer}',
    ].join("\n"),
    expected: { sets: winner.ids, total_cost: winner.cost },
  };
}

const GENERATORS = [shortestPathCase, criticalPathCase, ledgerCase, relationalCase, booleanCircuitCase, setCoverCase];
const CASES = Object.freeze(GENERATORS.flatMap((generate, familyIndex) => Array.from({ length: CASES_PER_FAMILY }, (_, index) => {
  const seed = CAMPAIGN_SEED + familyIndex * 10_000 + index * 97;
  const generated = generate(seed);
  return { ...generated, id: `${generated.family}-${String(index + 1).padStart(2, "0")}`, seed };
})));

function taskPrompt(task) {
  return `${task.prompt}\nReturn only the JSON object.`;
}

function strictJson(answer) {
  const trimmed = answer.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    const value = JSON.parse(candidate);
    return value && typeof value === "object" && !Array.isArray(value) ? { ok: true, value, format: fenced ? "fenced" : "strict" } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function recoverJsonObject(answer) {
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < answer.length; index += 1) {
    const char = answer[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") { if (depth === 0) start = index; depth += 1; }
    else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        try {
          const value = JSON.parse(answer.slice(start, index + 1));
          if (value && typeof value === "object" && !Array.isArray(value)) return { ok: true, value, format: "recovered" };
        } catch { /* continue scanning */ }
        start = -1;
      }
    }
  }
  return { ok: false };
}

function leaves(value, prefix = "$") {
  if (Array.isArray(value)) return value.flatMap((item, index) => leaves(item, `${prefix}[${index}]`));
  if (value && typeof value === "object") return Object.keys(value).sort().flatMap((key) => leaves(value[key], `${prefix}.${key}`));
  return [[prefix, value]];
}

function score(expected, answer) {
  const strict = strictJson(answer);
  const parsed = strict.ok ? strict : recoverJsonObject(answer);
  if (!parsed.ok) return { semanticPass: false, formatPass: false, fieldAccuracy: 0, reason: "invalid-json", parsedFormat: "none" };
  const expectedLeaves = leaves(expected);
  const actual = new Map(leaves(parsed.value).map(([path, value]) => [path, stable(value)]));
  const correct = expectedLeaves.filter(([path, value]) => actual.get(path) === stable(value)).length;
  const semanticPass = stable(parsed.value) === stable(expected);
  return {
    semanticPass,
    formatPass: strict.ok && strict.format === "strict",
    fieldAccuracy: expectedLeaves.length === 0 ? 1 : correct / expectedLeaves.length,
    reason: semanticPass ? "exact" : "value-mismatch",
    parsedFormat: parsed.format,
  };
}

function git(...args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function packageVersion(root) {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
}

function sameRate(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 1e-9;
}

function manifest() {
  return {
    version: "mikro-model-benchmark-v2",
    baseSha: git("rev-parse", "HEAD"),
    harnessSha256: sha256(readFileSync(SCRIPT_PATH)),
    primeVersion: PINNED_PRIME_VERSION,
    primeAiVersion: PINNED_PRIME_AI_VERSION,
    primeAiPackageSha256: PINNED_PRIME_AI_PACKAGE_SHA256,
    runtime: "prime-agent-ai direct completeSimple",
    wire: "openai-completions",
    route: ROUTE,
    models: MODELS,
    systemSha256: sha256(SYSTEM),
    families: GENERATORS.map((generate) => generate(CAMPAIGN_SEED).family),
    casesPerFamily: CASES_PER_FAMILY,
    cases: CASES.map((task) => ({
      id: task.id,
      family: task.family,
      seed: task.seed,
      promptSha256: sha256(taskPrompt(task)),
      expectedSha256: sha256(stable(task.expected)),
    })),
    fullCalls: CASES.length * MODELS.length,
    probeCalls: MODELS.length,
    maxInputTokens: MAX_INPUT_TOKENS,
    maxCompletionTokens: MAX_COMPLETION_TOKENS,
    temperature: 0,
    reasoning: REASONING,
    retries: 0,
    cacheRetention: "none",
    timeoutMs: TIMEOUT_MS,
    rawAnswersPersisted: false,
    billingAuthority: "OpenRouter /api/v1/key usage delta; response usage is reconciliation only",
    scoring: {
      primary: "semantic exact JSON value equality",
      secondary: ["field accuracy", "strict JSON-only format", "reliability", "latency", "token use", "actual cost"],
      proseRecovery: "one balanced JSON object may be recovered for semantic scoring; format still fails",
      judgeModel: null,
    },
  };
}

function parseFlags(args) {
  const flags = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!key?.startsWith("--") || args[index + 1] === undefined) throw new Error(`invalid argument: ${key ?? ""}`);
    flags[key.slice(2)] = args[index + 1];
  }
  return flags;
}

function bwsSecret(key) {
  const result = spawnSync("bws", ["secret", "list", BWS_PROJECT_ID], { encoding: "utf8", maxBuffer: 10_000_000 });
  if (result.status !== 0) throw new Error(`BWS lookup failed for ${key}`);
  const row = JSON.parse(result.stdout).find((item) => item.key === key);
  if (!row?.value) throw new Error(`BWS secret ${key} is missing`);
  return row.value;
}

async function openRouterKey() {
  const sdk = await import(pathToFileURL(join(PRIME_ROOT, "dist/index.js")).href);
  const auth = await sdk.AuthStorage.create();
  return await auth.getApiKey("openrouter") ?? bwsSecret("OPENROUTER_API_KEY");
}

async function openRouterUsage(key) {
  const response = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw new Error(`OpenRouter key usage lookup failed: ${response.status}`);
  const body = await response.json();
  if (!Number.isFinite(body?.data?.usage)) throw new Error("OpenRouter key usage response lacks a numeric usage field");
  return body.data.usage;
}

async function endpointFor(model) {
  const response = await fetch(`https://openrouter.ai/api/v1/models/${model.id}/endpoints`);
  if (!response.ok) throw new Error(`OpenRouter endpoint discovery failed: ${response.status}`);
  const body = await response.json();
  return body.data.endpoints.find((endpoint) => endpoint.provider_name === model.providerName && endpoint.status === 0) ?? null;
}

async function modelCatalog() {
  const response = await fetch("https://openrouter.ai/api/v1/models");
  if (!response.ok) throw new Error(`OpenRouter model discovery failed: ${response.status}`);
  const body = await response.json();
  return new Map(body.data.map((model) => [model.id, model]));
}

async function preflight() {
  const frozen = manifest();
  const [endpointEntries, catalog] = await Promise.all([
    Promise.all(MODELS.map(async (model) => [model.id, await endpointFor(model)])),
    modelCatalog(),
  ]);
  const endpoints = Object.fromEntries(endpointEntries);
  const key = await openRouterKey();
  const routeChecks = Object.fromEntries(MODELS.map((model) => {
    const endpoint = endpoints[model.id];
    const parameters = new Set(endpoint?.supported_parameters ?? []);
    const supportedEfforts = catalog.get(model.id)?.reasoning?.supported_efforts ?? [];
    return [model.id, {
      present: Boolean(endpoint),
      tag: endpoint?.tag ?? null,
      quantization: endpoint?.quantization ?? null,
      promptRate: endpoint ? Number(endpoint.pricing.prompt) * 1_000_000 : null,
      completionRate: endpoint ? Number(endpoint.pricing.completion) * 1_000_000 : null,
      requiredParameters: Object.fromEntries(["reasoning", "temperature", "seed", "response_format"].map((name) => [name, parameters.has(name)])),
      supportedReasoningEfforts: supportedEfforts,
    }];
  }));
  const pass = packageVersion(PRIME_ROOT) === frozen.primeVersion
    && packageVersion(PRIME_AI_ROOT) === frozen.primeAiVersion
    && sha256(readFileSync(join(PRIME_AI_ROOT, "package.json"))) === frozen.primeAiPackageSha256
    && Boolean(key)
    && MODELS.every((model) => {
      const check = routeChecks[model.id];
      return check.present && check.tag === model.tag && check.quantization === model.quantization
        && sameRate(check.promptRate, model.promptRate) && sameRate(check.completionRate, model.completionRate)
        && Object.values(check.requiredParameters).every(Boolean)
        && ["low", "high", "max"].every((effort) => check.supportedReasoningEfforts.includes(effort));
    });
  return {
    pass,
    manifestSha256: sha256(stable(frozen)),
    baseSha: frozen.baseSha,
    credentialNamesPresent: { OPENROUTER_API_KEY: Boolean(key) },
    routeChecks,
    fullCalls: frozen.fullCalls,
    probeCalls: frozen.probeCalls,
  };
}

function modelDefinition(model, pi) {
  const base = pi.getModel("openrouter", model.id) ?? {
    id: model.id,
    name: model.id,
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    contextWindow: 1_048_576,
    maxTokens: 131_072,
  };
  return {
    ...base,
    cost: { input: model.promptRate, output: model.completionRate, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: THINKING_LEVEL_MAP,
    compat: {
      ...(base.compat ?? {}),
      maxTokensField: "max_tokens",
      openRouterRouting: {
        only: [model.providerSlug],
        order: [model.providerSlug],
        allow_fallbacks: false,
        require_parameters: true,
      },
    },
  };
}

function responseText(message) {
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
}

function safeDiagnostic(value) {
  if (!value) return null;
  return String(value)
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .slice(0, 1_000);
}

async function generationMetadata(responseId, key) {
  if (!responseId) return null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(responseId)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
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

function shuffled(values, seed) {
  return rng(seed).shuffle(values);
}

function cellKey(cell) {
  return `${cell.model.id}\u0000${cell.task.id}`;
}

async function runCampaign(options) {
  const frozen = manifest();
  const digest = sha256(stable(frozen));
  if (options.manifestSha !== digest) throw new Error(`manifest digest mismatch: expected ${digest}`);
  const tasks = options.mode === "probe" ? [CASES[0]] : CASES;
  const taskOrder = shuffled(tasks, CAMPAIGN_SEED);
  const cells = tasks.flatMap((task) => MODELS.map((model) => ({ task, model })));
  if (options.authorizedCalls !== cells.length) throw new Error(`authorized calls must equal ${cells.length}`);
  if (!(options.authorizedUsd > 0)) throw new Error("authorized USD must be positive");

  const key = await openRouterKey();
  const pi = await import(pathToFileURL(join(PRIME_AI_ROOT, "dist/index.js")).href);
  const keyUsageStartUsd = await openRouterUsage(key);
  let report = {
    version: frozen.version,
    manifest: frozen,
    manifestSha256: digest,
    stage: options.mode,
    authorizedCalls: options.authorizedCalls,
    authorizedUsd: options.authorizedUsd,
    startedAt: new Date().toISOString(),
    complete: false,
    records: [],
    actualSpendUsd: 0,
    keyUsageStartUsd,
    keyUsageCurrentUsd: keyUsageStartUsd,
    keyUsageDeltaUsd: 0,
  };
  if (options.resume && existsSync(options.output)) {
    const prior = JSON.parse(readFileSync(options.output, "utf8"));
    if (prior.manifestSha256 !== digest || prior.stage !== options.mode || prior.authorizedCalls !== options.authorizedCalls) {
      throw new Error("resume artifact does not match this campaign");
    }
    report = prior;
    report.keyUsageCurrentUsd = await openRouterUsage(key);
    report.keyUsageDeltaUsd = report.keyUsageCurrentUsd - report.keyUsageStartUsd;
  }
  const completed = new Set(report.records.map((record) => `${record.model}\u0000${record.task}`));
  try {
    for (const task of taskOrder) {
      const wave = MODELS.map((model) => ({ task, model })).filter((cell) => !completed.has(cellKey(cell)));
      if (wave.length === 0) continue;
      const worstWaveCost = wave.reduce((sum, cell) => sum
        + ((MAX_INPUT_TOKENS * cell.model.promptRate) + (MAX_COMPLETION_TOKENS * cell.model.completionRate)) / 1_000_000, 0);
      if (report.keyUsageDeltaUsd + worstWaveCost > options.authorizedUsd) {
        throw new Error("remaining authorization cannot cover the next paired wave at frozen limits");
      }
      const waveRecords = [];
      for (const cell of shuffled(wave, task.seed)) {
      const record = await (async () => {
      const prompt = taskPrompt(cell.task);
      const model = modelDefinition(cell.model, pi);
      let wire;
      const started = performance.now();
      let record;
      try {
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(), TIMEOUT_MS);
        let message;
        try {
          message = await pi.completeSimple(
          model,
          { systemPrompt: SYSTEM, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
          {
            apiKey: key,
            temperature: 0,
            maxTokens: MAX_COMPLETION_TOKENS,
            reasoning: REASONING,
            maxRetries: 0,
            cacheRetention: "none",
            timeoutMs: TIMEOUT_MS,
            signal: controller.signal,
            onPayload(payload) {
              if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("provider payload is not an object");
              const expectedRouting = model.compat.openRouterRouting;
              if (stable(payload.provider) !== stable(expectedRouting)) throw new Error("OpenRouter routing pin missing from provider payload");
              wire = {
                model: payload.model,
                provider: payload.provider,
                temperature: payload.temperature,
                reasoning: payload.reasoning,
                maxTokens: payload.max_completion_tokens ?? payload.max_tokens ?? null,
                seed: cell.task.seed,
                responseFormat: { type: "json_object" },
              };
              return { ...payload, seed: cell.task.seed, response_format: { type: "json_object" } };
            },
          },
          );
        } finally {
          clearTimeout(deadline);
        }
        const answer = responseText(message);
        const judged = score(cell.task.expected, answer);
        const generation = await generationMetadata(message.responseId, key);
        const actualProvider = generation?.provider_name ?? generation?.provider ?? null;
        const requestPinVerified = stable(wire?.provider) === stable(model.compat.openRouterRouting);
        const routeVerified = actualProvider ? actualProvider === cell.model.providerName : requestPinVerified;
        const routeVerification = actualProvider ? "generation-metadata" : "request-pin-no-fallback";
        const inputCompliant = message.usage.input <= MAX_INPUT_TOKENS;
        const outputCompliant = message.usage.output <= MAX_COMPLETION_TOKENS;
        const actualCost = Number(generation?.total_cost ?? message.usage.cost.total ?? 0);
        record = {
          model: cell.model.id,
          task: cell.task.id,
          family: cell.task.family,
          seed: cell.task.seed,
          ok: message.stopReason !== "error" && message.stopReason !== "aborted",
          stopReason: message.stopReason,
          providerError: safeDiagnostic(message.errorMessage),
          semanticPass: judged.semanticPass,
          formatPass: judged.formatPass,
          fieldAccuracy: judged.fieldAccuracy,
          scoreReason: judged.reason,
          parsedFormat: judged.parsedFormat,
          answerSha256: sha256(answer),
          promptSha256: sha256(prompt),
          expectedSha256: sha256(stable(cell.task.expected)),
          responseIdSha256: message.responseId ? sha256(message.responseId) : null,
          responseModel: message.responseModel ?? null,
          plannedProvider: cell.model.providerName,
          plannedProviderSlug: cell.model.providerSlug,
          plannedQuantization: cell.model.quantization,
          actualProvider,
          routeVerified,
          routeVerification,
          wireSha256: sha256(stable(wire)),
          wire,
          usage: message.usage,
          actualCostUsd: actualCost,
          wallMs: Math.round(performance.now() - started),
          inputCompliant,
          outputCompliant,
        };
      } catch (error) {
        record = {
          model: cell.model.id,
          task: cell.task.id,
          family: cell.task.family,
          seed: cell.task.seed,
          ok: false,
          semanticPass: false,
          formatPass: false,
          fieldAccuracy: 0,
          scoreReason: "runtime-error",
          errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
          errorSha256: sha256(error instanceof Error ? error.message : String(error)),
          promptSha256: sha256(prompt),
          expectedSha256: sha256(stable(cell.task.expected)),
          wallMs: Math.round(performance.now() - started),
        };
      }
      return record;
      })();
      waveRecords.push(record);
      }
      for (const record of waveRecords) {
        report.records.push(record);
        process.stderr.write(`${record.model} ${record.task}: ${record.semanticPass ? "PASS" : record.scoreReason}\n`);
        if (record.ok && (!record.inputCompliant || !record.outputCompliant || !record.routeVerified)) {
          throw new Error("a successful response violated the frozen input/output/route contract");
        }
      }
      report.actualSpendUsd = report.records.reduce((sum, item) => sum + (item.actualCostUsd ?? 0), 0);
      report.keyUsageCurrentUsd = await openRouterUsage(key);
      report.keyUsageDeltaUsd = report.keyUsageCurrentUsd - report.keyUsageStartUsd;
      await atomicWrite(options.output, report);
      if (report.keyUsageDeltaUsd > options.authorizedUsd) throw new Error("key usage delta exceeded authorization");
    }
    report.complete = report.records.length === cells.length;
    report.completedAt = new Date().toISOString();
    await atomicWrite(options.output, report);
    if (!report.complete || report.records.some((record) => !record.ok || !record.routeVerified)) process.exitCode = 1;
  } finally {
    delete process.env.OPENROUTER_API_KEY;
  }
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * fraction))];
}

function binomialCoefficient(n, k) {
  let result = 1;
  for (let index = 1; index <= k; index += 1) result = (result * (n - index + 1)) / index;
  return result;
}

function mcnemarExact(leftWins, rightWins) {
  const discordant = leftWins + rightWins;
  if (discordant === 0) return 1;
  const smaller = Math.min(leftWins, rightWins);
  let tail = 0;
  for (let index = 0; index <= smaller; index += 1) tail += binomialCoefficient(discordant, index) * (0.5 ** discordant);
  return Math.min(1, 2 * tail);
}

function summarize(report) {
  const byModel = {};
  for (const model of MODELS) {
    const rows = report.records.filter((record) => record.model === model.id);
    byModel[model.id] = {
      n: rows.length,
      ok: rows.filter((row) => row.ok).length,
      semanticPasses: rows.filter((row) => row.semanticPass).length,
      semanticRate: rows.length ? rows.filter((row) => row.semanticPass).length / rows.length : 0,
      formatPasses: rows.filter((row) => row.formatPass).length,
      meanFieldAccuracy: rows.length ? rows.reduce((sum, row) => sum + row.fieldAccuracy, 0) / rows.length : 0,
      routeVerified: rows.filter((row) => row.routeVerified).length,
      medianWallMs: percentile(rows.map((row) => row.wallMs), 0.5),
      p95WallMs: percentile(rows.map((row) => row.wallMs), 0.95),
      inputTokens: rows.reduce((sum, row) => sum + (row.usage?.input ?? 0), 0),
      outputTokens: rows.reduce((sum, row) => sum + (row.usage?.output ?? 0), 0),
      actualCostUsd: rows.reduce((sum, row) => sum + (row.actualCostUsd ?? 0), 0),
      byFamily: Object.fromEntries(GENERATORS.map((generate) => {
        const family = generate(CAMPAIGN_SEED).family;
        const familyRows = rows.filter((row) => row.family === family);
        return [family, { n: familyRows.length, semanticPasses: familyRows.filter((row) => row.semanticPass).length }];
      })),
    };
  }
  const pairwise = [];
  for (let left = 0; left < MODELS.length; left += 1) for (let right = left + 1; right < MODELS.length; right += 1) {
    const leftRows = new Map(report.records.filter((row) => row.model === MODELS[left].id).map((row) => [row.task, row]));
    const rightRows = new Map(report.records.filter((row) => row.model === MODELS[right].id).map((row) => [row.task, row]));
    let leftWins = 0;
    let rightWins = 0;
    let ties = 0;
    for (const task of CASES) {
      const l = Boolean(leftRows.get(task.id)?.semanticPass);
      const r = Boolean(rightRows.get(task.id)?.semanticPass);
      if (l && !r) leftWins += 1;
      else if (!l && r) rightWins += 1;
      else ties += 1;
    }
    pairwise.push({ left: MODELS[left].id, right: MODELS[right].id, leftWins, rightWins, ties, mcnemarExactP: mcnemarExact(leftWins, rightWins) });
  }
  return { version: report.version, manifestSha256: report.manifestSha256, complete: report.complete, calls: report.records.length, byModel, pairwise };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "manifest") {
    process.stdout.write(`${JSON.stringify(manifest())}\n`);
    return;
  }
  if (command === "score") {
    const flags = parseFlags(args);
    process.stdout.write(`${JSON.stringify(score(JSON.parse(flags.expected), flags.answer))}\n`);
    return;
  }
  if (command === "preflight") {
    process.stdout.write(`${JSON.stringify(await preflight())}\n`);
    return;
  }
  if (command === "run") {
    const flags = parseFlags(args);
    if (flags.mode !== "probe" && flags.mode !== "full") throw new Error("--mode must be probe or full");
    await runCampaign({
      mode: flags.mode,
      output: resolve(flags.output),
      manifestSha: flags["manifest-sha"],
      authorizedCalls: Number(flags["authorized-calls"]),
      authorizedUsd: Number(flags["authorized-usd"]),
      resume: flags.resume === "true",
    });
    return;
  }
  if (command === "summarize") {
    const flags = parseFlags(args);
    const report = JSON.parse(readFileSync(resolve(flags.input), "utf8"));
    process.stdout.write(`${JSON.stringify(summarize(report))}\n`);
    return;
  }
  throw new Error("usage: benchmark-models-v2.mjs manifest|score|preflight|run|summarize");
}

export { CASES, score, sha256, stable, taskPrompt };

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
