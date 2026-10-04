/**
 * Optional projection of exported lifecycle intervals into a Phoenix the
 * operator configured. genie and Phoenix are open source and genie presumes no
 * one's setup: there is no default endpoint and no default project. The target
 * is whatever the operator saved with `genie metrics export --endpoint <url>
 * --project <name> --save` (`<GENIE_HOME>/metrics/export.json`) or passed on
 * that invocation; with neither, `--phoenix` exits 2 and sends nothing.
 *
 * Ingestion truths (learned by `scripts/observability/backfill.ts`): POST
 * answers 202 from an in-memory queue, so queued is not stored; a batch holding
 * one already-stored span id is rejected whole. So every span id is
 * deterministic, only ids Phoenix does not hold are posted, and "done" means
 * every expected id read back.
 */

import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { metricsDir } from './metrics-capture.js';
import type { Interval } from './metrics-export.js';

export interface PhoenixExportTarget {
  endpoint: string;
  project: string;
  /** Name of the env var holding the API key — the key itself is never written to disk. */
  apiKeyEnv?: string;
}

export function exportTargetPath(): string {
  return join(metricsDir(), 'export.json');
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateTarget(value: unknown): PhoenixExportTarget | string {
  const raw = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const endpoint = typeof raw.endpoint === 'string' ? raw.endpoint.trim().replace(/\/+$/, '') : '';
  const project = typeof raw.project === 'string' ? raw.project.trim() : '';
  if (!/^https?:\/\/[^\s/]+/.test(endpoint)) return 'an http(s) endpoint';
  if (project === '') return 'a project name';
  if (raw.apiKeyEnv !== undefined && (typeof raw.apiKeyEnv !== 'string' || !ENV_NAME.test(raw.apiKeyEnv))) {
    return 'an env var NAME for the API key (not the key)';
  }
  return { endpoint, project, ...(raw.apiKeyEnv ? { apiKeyEnv: raw.apiKeyEnv as string } : {}) };
}

export function loadSavedTarget(): PhoenixExportTarget | null {
  const path = exportTargetPath();
  if (!existsSync(path)) return null;
  try {
    const target = validateTarget(JSON.parse(readFileSync(path, 'utf8')));
    return typeof target === 'string' ? null : target;
  } catch {
    return null;
  }
}

/** Write a private file under <GENIE_HOME>/metrics, creating the dir, and tighten a file that already existed wider. */
export function writePrivate(path: string, body: string): void {
  mkdirSync(metricsDir(), { recursive: true, mode: 0o700 });
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function saveTarget(target: PhoenixExportTarget): void {
  writePrivate(exportTargetPath(), `${JSON.stringify(target, null, 2)}\n`);
}

/**
 * Per-install salt, random and persisted on first use: span ids stay stable across re-exports on one
 * host (a hostname can change with the network on macOS, which would re-post every span as new) and
 * never collide across hosts. It also keys the repo hash, so a common path is not guessable from it.
 */
export function installSalt(): string {
  const path = join(metricsDir(), 'export-salt');
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (/^[0-9a-f]{12,}$/.test(existing)) return existing;
  } catch {
    // first export on this install
  }
  const salt = randomBytes(8).toString('hex');
  writePrivate(path, `${salt}\n`);
  return salt;
}

const hex = (seed: string, chars: number) => createHash('sha256').update(seed).digest('hex').slice(0, chars);

export interface PhoenixSpan {
  name: string;
  context: { trace_id: string; span_id: string };
  parent_id: null;
  span_kind: 'CHAIN';
  start_time: string;
  end_time: string;
  status_code: 'OK';
  attributes: Record<string, string | number | boolean>;
}

export function intervalSpan(interval: Interval, salt: string): PhoenixSpan {
  const usage = interval.usage;
  const prompt = usage ? usage.input + usage.cacheRead + usage.cacheWrite : null;
  const attributes: Record<string, string | number | boolean> = {
    'openinference.span.kind': 'CHAIN',
    'genie.export_id': salt,
    'genie.task': interval.task,
    'genie.repo': hex(`${salt}:${interval.db}`, 12),
    'genie.transition': interval.transition,
    'genie.from_event': interval.fromEvent,
    'genie.to_event': interval.toEvent,
    'genie.duration_ms': interval.durationMs,
    'genie.shared_session': interval.sharedSession,
    'genie.usage_known': usage !== null,
  };
  if (interval.session.id) attributes['session.id'] = interval.session.id;
  if (interval.session.source) attributes['genie.runtime'] = interval.session.source;
  if (usage && prompt !== null) {
    attributes['llm.token_count.prompt'] = prompt;
    attributes['llm.token_count.completion'] = usage.output;
    attributes['llm.token_count.total'] = prompt + usage.output;
    attributes['llm.token_count.prompt_details.cache_read'] = usage.cacheRead;
    attributes['llm.token_count.prompt_details.cache_write'] = usage.cacheWrite;
    attributes['genie.model_calls'] = usage.calls;
    if (usage.costUsd !== null) attributes['llm.cost.total'] = usage.costUsd;
  }
  if (interval.offload) {
    attributes['genie.offload.calls'] = interval.offload.calls;
    attributes['genie.offload.failed'] = interval.offload.failed;
    attributes['genie.offload.tokens'] = interval.offload.tokens;
    if (interval.offload.costUsd !== null) attributes['genie.offload.cost_usd'] = interval.offload.costUsd;
  }
  return {
    name: `genie:${interval.transition}`,
    context: {
      trace_id: hex(`${salt}:${interval.db}:${interval.task}`, 32),
      span_id: hex(`${salt}:${interval.db}:${interval.task}:${interval.fromEvent}:${interval.toEvent}`, 16),
    },
    parent_id: null,
    span_kind: 'CHAIN',
    start_time: new Date(interval.startAt).toISOString(),
    end_time: new Date(interval.endAt).toISOString(),
    status_code: 'OK',
    attributes,
  };
}

function headers(target: PhoenixExportTarget, env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = { 'content-type': 'application/json' };
  const key = target.apiKeyEnv ? env[target.apiKeyEnv] : undefined;
  if (key) out.authorization = `Bearer ${key}`;
  return out;
}

/** Span ids already stored under this install's export id; empty when the project does not exist yet. */
export async function storedSpanIds(
  target: PhoenixExportTarget,
  salt: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  do {
    const attr = encodeURIComponent(`genie.export_id:${salt}`);
    const url = `${target.endpoint}/v1/projects/${encodeURIComponent(target.project)}/spans?limit=1000&attribute=${attr}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetch(url, { headers: headers(target, env), signal: AbortSignal.timeout(30_000) });
    if (res.status === 404) return ids;
    if (!res.ok) throw new Error(`GET spans ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const page = (await res.json()) as {
      data?: Array<{ context?: { span_id?: string } }>;
      next_cursor?: string | null;
    };
    for (const span of page.data ?? []) if (span.context?.span_id) ids.add(span.context.span_id);
    cursor = page.next_cursor ?? null;
  } while (cursor);
  return ids;
}

async function postSpans(target: PhoenixExportTarget, spans: PhoenixSpan[], env: NodeJS.ProcessEnv): Promise<void> {
  for (let i = 0; i < spans.length; i += 200) {
    const res = await fetch(`${target.endpoint}/v1/projects/${encodeURIComponent(target.project)}/spans`, {
      method: 'POST',
      headers: headers(target, env),
      body: JSON.stringify({ data: spans.slice(i, i + 200) }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`POST spans ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

export interface ProjectionResult {
  expected: number;
  alreadyStored: number;
  posted: number;
  /** Expected ids still not readable when the wait ended — 0 means every span is stored. */
  missing: number;
}

export async function projectToPhoenix(
  target: PhoenixExportTarget,
  intervals: Interval[],
  options: { timeoutMs: number; pollMs?: number; env?: NodeJS.ProcessEnv } = { timeoutMs: 120_000 },
): Promise<ProjectionResult> {
  const env = options.env ?? process.env;
  const salt = installSalt();
  const spans = intervals.map((interval) => intervalSpan(interval, salt));
  const expected = new Set(spans.map((span) => span.context.span_id));
  const before = await storedSpanIds(target, salt, env);
  const fresh = spans.filter((span) => !before.has(span.context.span_id));
  if (fresh.length > 0) await postSpans(target, fresh, env);
  const deadline = Date.now() + options.timeoutMs;
  let missing = [...expected].filter((id) => !before.has(id)).length;
  while (missing > 0) {
    const stored = await storedSpanIds(target, salt, env);
    missing = [...expected].filter((id) => !stored.has(id)).length;
    if (missing === 0 || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 3000));
  }
  return {
    expected: expected.size,
    alreadyStored: [...expected].filter((id) => before.has(id)).length,
    posted: fresh.length,
    missing,
  };
}
