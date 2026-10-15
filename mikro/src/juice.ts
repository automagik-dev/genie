import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Reference-only project identity. Never serialize a resolved credential. */
export interface JuiceProjectConfig {
  origin: string;
  project: string;
  keyAlias: string;
  keyEpoch: string;
  keyFile: string;
}

export class JuiceError extends Error {
  constructor(readonly code: "config" | "credential" | "permissions" | "transport" | "http" | "response",
    readonly status?: number) {
    super(`Juice operation failed (${code}${status === undefined ? "" : `; HTTP ${status}`}).`);
    this.name = "JuiceError";
  }
}

function fail(code: JuiceError["code"]): never { throw new JuiceError(code); }

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("response");
  return value as Record<string, unknown>;
}

function identity(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

export function juiceOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { return fail("config"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") fail("config");
  return url.origin;
}

export function parseJuiceProject(value: unknown): JuiceProjectConfig | undefined {
  if (value === undefined) return undefined;
  const raw = record(value);
  const allowed = ["origin", "project", "key-alias", "key-epoch", "key-file"];
  if (Object.keys(raw).some((key) => !allowed.includes(key)) || typeof raw.origin !== "string"
    || !identity(raw.project) || !identity(raw["key-alias"]) || !identity(raw["key-epoch"])
    || typeof raw["key-file"] !== "string" || !isAbsolute(raw["key-file"])) fail("config");
  return { origin: juiceOrigin(raw.origin), project: raw.project, keyAlias: raw["key-alias"],
    keyEpoch: raw["key-epoch"], keyFile: raw["key-file"] };
}

async function rejectRepositoryStorage(path: string): Promise<void> {
  let cursor = resolve(dirname(path));
  for (;;) {
    try {
      await lstat(join(cursor, ".git"));
      fail("permissions");
    } catch (error) {
      if (error instanceof JuiceError) throw error;
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) fail("permissions");
    }
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

/** Reject aliases/symlinks, foreign ownership and permissive modes, rather than chmod operator files. */
async function privateDirectory(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
      || (process.getuid && stat.uid !== process.getuid()) || await realpath(path) !== resolve(path)) fail("permissions");
  } catch (error) {
    if (error instanceof JuiceError) throw error;
    return fail("permissions");
  }
}

export async function readPrivateKeyFile(path: string, signal?: AbortSignal): Promise<string> {
  if (!isAbsolute(path)) fail("credential");
  await rejectRepositoryStorage(path);
  await privateDirectory(dirname(path));
  let handle;
  try {
    signal?.throwIfAborted();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096 || (stat.mode & 0o777) !== 0o600
      || (process.getuid && stat.uid !== process.getuid())) fail("permissions");
    const key = (await handle.readFile({ encoding: "utf8" })).trim();
    signal?.throwIfAborted();
    if (!key || /\s|[\u0000-\u001f\u007f]/.test(key)) fail("credential");
    return key;
  } catch (error) {
    if (error instanceof JuiceError) throw error;
    return fail("credential");
  } finally { await handle?.close(); }
}

async function send(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  try {
    const response = await fetch(url, { ...init, redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new JuiceError("http", response.status);
    }
    return response;
  } catch (error) {
    if (error instanceof JuiceError) throw error;
    return fail("transport");
  }
}

async function json(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return fail("response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 1_048_576) return fail("response");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { return fail("response"); }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** One atomic PATCH. A failed call retains the private key for an idempotent explicit rerun. */
export async function provisionJuiceProject(project: JuiceProjectConfig,
  management: { keyFile?: string; keyEnv?: string }, signal?: AbortSignal): Promise<{ project: string; keyAlias: string; keyEpoch: string; keyFile: string }> {
  const origin = juiceOrigin(project.origin);
  if (!identity(project.project) || !identity(project.keyAlias) || !identity(project.keyEpoch)
    || !isAbsolute(project.keyFile) || Boolean(management.keyFile) === Boolean(management.keyEnv)) fail("config");
  const managementKey = await resolveKeyReference(management, signal);
  await rejectRepositoryStorage(project.keyFile);
  const parent = dirname(project.keyFile);
  try { await mkdir(parent, { mode: 0o700 }); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) fail("permissions");
  }
  await privateDirectory(parent);
  let handle;
  try {
    handle = await open(project.keyFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(`sk-juice-${randomBytes(32).toString("base64url")}\n`);
    await handle.sync();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) fail("credential");
  } finally { await handle?.close(); }
  const key = await readPrivateKeyFile(project.keyFile, signal);
  const response = await send(`${origin}/v0/management/api-keys`, { method: "PATCH",
    headers: { Authorization: `Bearer ${managementKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ old: key, new: key }) }, signal);
  await response.body?.cancel().catch(() => {});
  return { project: project.project, keyAlias: project.keyAlias, keyEpoch: project.keyEpoch, keyFile: project.keyFile };
}

export async function resolveKeyReference(reference: { keyFile?: string; keyEnv?: string }, signal?: AbortSignal): Promise<string> {
  if (Boolean(reference.keyFile) === Boolean(reference.keyEnv)) fail("config");
  if (reference.keyFile) return readPrivateKeyFile(reference.keyFile, signal);
  if (!reference.keyEnv || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference.keyEnv)) fail("config");
  signal?.throwIfAborted();
  const key = process.env[reference.keyEnv]?.trim();
  if (!key || /\s|[\u0000-\u001f\u007f]/.test(key)) fail("credential");
  return key;
}

export interface JuiceCatalog {
  version: 1;
  project: string;
  keyAlias: string;
  keyEpoch: string;
  url: string;
  fetchedAt: string;
  contentSha256: string;
  models: { id: string; ownedBy: string | null }[];
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function publicText(value: unknown, secrets: readonly string[]): string | null {
  if (typeof value !== "string" || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)
    || secrets.some((secret) => secret && value.includes(secret)) || /(?:sk-[\w-]{12,}|bearer\s|api[_-]?key\s*[:=])/i.test(value)) return null;
  return value;
}

function projectOrigin(project: JuiceProjectConfig): string {
  if (!identity(project.project) || !identity(project.keyAlias) || !identity(project.keyEpoch)
    || !isAbsolute(project.keyFile)) fail("config");
  return juiceOrigin(project.origin);
}

export async function fetchJuiceCatalog(project: JuiceProjectConfig, signal?: AbortSignal): Promise<JuiceCatalog> {
  const key = await readPrivateKeyFile(project.keyFile, signal);
  const url = `${projectOrigin(project)}/v1/models`;
  const reply = record(await json(await send(url, { headers: { Authorization: `Bearer ${key}` } }, signal)));
  if (!Array.isArray(reply.data) || reply.data.length > 10_000) fail("response");
  const models = reply.data.map((entry) => {
    const model = record(entry);
    const id = publicText(model.id, [key]);
    if (!id || !id.trim()) return fail("response");
    return { id, ownedBy: publicText(model.owned_by, [key]) };
  });
  if (new Set(models.map((model) => model.id)).size !== models.length) fail("response");
  return { version: 1, project: project.project, keyAlias: project.keyAlias, keyEpoch: project.keyEpoch,
    url, fetchedAt: new Date().toISOString(), contentSha256: sha256(models), models };
}

export interface KeeperQuery { range: string; unit?: "hour" | "day"; start?: string; end?: string }

function queryString(query: KeeperQuery): string {
  if (typeof query.range !== "string" || Object.keys(query).some((name) => !["range", "unit", "start", "end"].includes(name))) fail("config");
  if (query.range === "custom") {
    if (!["hour", "day"].includes(query.unit ?? "") || !query.start || !query.end) fail("config");
    const pattern = query.unit === "day" ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:00:00(?:Z|[+-]\d{2}:\d{2})$/;
    if (!pattern.test(query.start) || !pattern.test(query.end) || !Number.isFinite(Date.parse(query.start))
      || !Number.isFinite(Date.parse(query.end)) || Date.parse(query.start) > Date.parse(query.end)) fail("config");
  } else if (!/^(?:today|yesterday|(?:[5-9]|1\d|2[0-4])h|(?:[1-9]|[12]\d|30)d)$/.test(query.range)
    || query.unit || query.start || query.end) fail("config");
  return new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === "string")).toString();
}

type SafeJson = null | string | number | boolean | SafeJson[] | { [key: string]: SafeJson };

/** Only aggregates: discard unexpected credential/payload fields, redact values, preserve missing data. */
function sanitize(value: unknown, secrets: readonly string[], depth = 0, costAvailable?: boolean): SafeJson {
  if (depth > 20) fail("response");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return publicText(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, secrets, depth + 1, costAvailable));
  const raw = record(value);
  const knownCost = typeof raw.cost_available === "boolean" ? raw.cost_available : costAvailable;
  const knownLatency = raw.supported === true && typeof raw.total_points === "number"
    && Number.isSafeInteger(raw.total_points) && raw.total_points > 0;
  const out: { [key: string]: SafeJson } = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!/^[a-zA-Z0-9_]{1,80}$/.test(name) || publicText(name, secrets) === null
      || /(?:password|secret|cookie|authorization|credential|payload|prompt|response_body|request_body|session_token|display_key|auth_files|ai_provider)/i.test(name)
      || name === "api_key" || name === "apiKey") continue;
    const unknownCost = knownCost !== true && /(?:cost|usd)/i.test(name) && name !== "cost_available"
      && (entry === null || typeof entry !== "object" || Array.isArray(entry));
    const unknownLatency = Object.hasOwn(raw, "supported") && !knownLatency && /(?:ttft|latency).*ms$/.test(name);
    out[name] = unknownCost || unknownLatency ? null : sanitize(entry, secrets, depth + 1, knownCost);
  }
  return out;
}

export interface KeeperSnapshot {
  version: 1;
  project: string;
  keyAlias: string;
  keyEpoch: string;
  fetchedAt: string;
  keeperVersion: string;
  capabilities: { aggregateUsage: true; requestEvents: false; payloadExport: false; canonicalBilling: false };
  query: KeeperQuery;
  sources: { url: string; fetchedAt: string; timezone: string | null; rangeStart: string | null;
    rangeEnd: string | null; contentSha256: string; data: SafeJson }[];
  contentSha256: string;
}

export async function fetchKeeperSnapshot(project: JuiceProjectConfig, query: KeeperQuery,
  analyze: boolean, signal?: AbortSignal): Promise<KeeperSnapshot> {
  const params = queryString(query);
  const base = `${projectOrigin(project)}/keeper/api/v1`;
  const key = await readPrivateKeyFile(project.keyFile, signal);
  const intent = { "X-CPA-Usage-Keeper-Request": "fetch" };
  let cookie: string | undefined;
  let failure: unknown;
  try {
    const login = await send(`${base}/auth/api-key-login`, { method: "POST",
      headers: { ...intent, "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: key }) }, signal);
    const cookies = login.headers.getSetCookie();
    cookie = cookies.map((entry) => entry.split(";", 1)[0]).find((entry) => /^cpa_usage_keeper_session=[^;\s]+$/.test(entry));
    await login.body?.cancel().catch(() => {});
    if (!cookie) fail("response");
    const secrets = [key, cookie, cookie.slice(cookie.indexOf("=") + 1)];
    const headers = { ...intent, Cookie: cookie };
    const session = record(await json(await send(`${base}/auth/session`, { headers }, signal)));
    if (session.authenticated !== true || session.role !== "api_key_viewer") fail("response");
    const versionReply = record(await json(await send(`${base}/version`, { headers }, signal)));
    const keeperVersion = publicText(versionReply.version, secrets);
    if (!keeperVersion) fail("response");
    const sources: KeeperSnapshot["sources"] = [];
    const routes = analyze ? ["key-overview", "key-analysis", "key-analysis/latency"] : ["key-overview"];
    for (const route of routes) {
      const url = `${base}/${route}?${params}`;
      const raw = record(await json(await send(url, { headers }, signal)));
      if (route === "key-overview") {
        const usage = record(raw.usage);
        record(raw.summary);
        record(raw.series);
        if (typeof usage.total_tokens !== "number" || !Number.isSafeInteger(usage.total_tokens) || usage.total_tokens < 0) fail("response");
      } else if (route === "key-analysis") {
        record(raw.cost_breakdown);
        if (!Array.isArray(raw.model_composition)) fail("response");
      } else if (typeof raw.supported !== "boolean" || !Array.isArray(raw.points)) fail("response");
      const allowed = route === "key-overview" ? ["usage", "summary", "series", "timezone"]
        : route === "key-analysis" ? ["granularity", "timezone", "range_start", "range_end", "token_usage", "model_usage", "api_key_composition", "model_composition", "heatmap", "cost_breakdown", "model_efficiency"]
        : ["supported", "unsupported_reason", "points", "density", "total_points", "sampled", "p95_ttft_ms", "p95_latency_ms", "max_ttft_ms", "max_latency_ms"];
      const summary = raw.summary && typeof raw.summary === "object" && !Array.isArray(raw.summary)
        ? record(raw.summary) : undefined;
      const costAvailable = typeof summary?.cost_available === "boolean" ? summary.cost_available : undefined;
      const data = sanitize(Object.fromEntries(allowed.filter((name) => Object.hasOwn(raw, name)).map((name) => [name, raw[name]])),
        secrets, 0, costAvailable);
      // Latency has no returned timezone/range; never synthesize them from the query.
      sources.push({ url, fetchedAt: new Date().toISOString(), timezone: publicText(raw.timezone, secrets),
        rangeStart: publicText(raw.range_start, secrets), rangeEnd: publicText(raw.range_end, secrets),
        contentSha256: sha256(data), data });
    }
    return { version: 1, project: project.project, keyAlias: project.keyAlias, keyEpoch: project.keyEpoch,
      fetchedAt: new Date().toISOString(), keeperVersion,
      capabilities: { aggregateUsage: true, requestEvents: false, payloadExport: false, canonicalBilling: false },
      query: { ...query }, sources, contentSha256: sha256(sources) };
  } catch (error) { failure = error; throw error; }
  finally {
    if (cookie) {
      try {
        const logout = await send(`${base}/auth/logout`, { method: "POST", headers: { ...intent, Cookie: cookie } });
        await logout.body?.cancel().catch(() => {});
      }
      catch (error) { if (failure === undefined) throw error; }
      finally { cookie = undefined; }
    }
  }
}
