/**
 * Phoenix span emitter for mikro microagent runs — one AGENT span per attempt,
 * in the same OpenInference shape `scripts/observability/backfill.ts` uses for
 * Claude Code sessions, so a run's USD, tokens and latency sit beside the Opus
 * turns it is meant to replace.
 *
 * OFF until configured. genie and Phoenix are both open source and genie
 * presumes no one's setup: nothing is posted unless the operator names BOTH
 * the project (`MIKRO_PHOENIX_PROJECT`, genie-specific, so a `PHOENIX_*` set
 * for another tool never turns this on) and the endpoint (`PHOENIX_ENDPOINT`
 * or `PHOENIX_COLLECTOR_ENDPOINT`). There is no default endpoint and no
 * default project; unconfigured, a run makes no network call and prints
 * nothing. `PHOENIX_DISABLED=1` still skips a configured target.
 *
 * Best-effort when configured: a Phoenix that is down or refusing never fails
 * a run; the caller gets 'failed' and a stderr line. `PHOENIX_API_KEY` is sent
 * as a bearer token when set.
 */
import { createHash } from 'node:crypto';

export interface PhoenixTarget {
  endpoint: string;
  project: string;
}

/** The configured target, or null when posting is off (unconfigured, half-configured or disabled). */
export function resolvePhoenixTarget(env: NodeJS.ProcessEnv = process.env): PhoenixTarget | null {
  if (env.PHOENIX_DISABLED === '1') return null;
  const project = env.MIKRO_PHOENIX_PROJECT?.trim();
  const endpoint = (env.PHOENIX_ENDPOINT || env.PHOENIX_COLLECTOR_ENDPOINT)?.trim();
  if (!project || !endpoint) return null;
  return { endpoint: endpoint.replace(/\/+$/, ''), project };
}

export interface RunSpanInput {
  agent: string;
  runId: string;
  traceId: string;
  attempt: number;
  startMs: number;
  endMs: number;
  model: string;
  iterations: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  ok: boolean;
  errors: string[];
  tags: Record<string, string>;
  prompt: string;
  answer: string;
  /** Candidate count of the deterministic facts file this attempt was handed, when it was handed one. */
  factsCandidates?: number;
}

const hex = (seed: string, chars: number) => createHash('sha256').update(seed).digest('hex').slice(0, chars);
const clip = (text: string, max = 4000) => (text.length > max ? `${text.slice(0, max)}…` : text);

export function buildRunSpan(input: RunSpanInput) {
  return {
    name: `mikro:${input.agent}`,
    context: { trace_id: hex(`trace:${input.traceId}`, 32), span_id: hex(`span:${input.runId}:${input.attempt}`, 16) },
    parent_id: null,
    span_kind: 'AGENT',
    start_time: new Date(input.startMs).toISOString(),
    end_time: new Date(input.endMs).toISOString(),
    status_code: input.ok ? 'OK' : 'ERROR',
    attributes: {
      'openinference.span.kind': 'AGENT',
      'llm.model_name': input.model,
      'llm.provider': input.model.split('/')[0] ?? 'unknown',
      'llm.token_count.prompt': input.tokensIn,
      'llm.token_count.completion': input.tokensOut,
      'llm.token_count.total': input.tokensIn + input.tokensOut,
      'input.value': clip(input.prompt),
      'input.mime_type': 'text/plain',
      'output.value': clip(input.answer),
      'output.mime_type': 'text/plain',
      'metadata.agent': input.agent,
      'metadata.run_id': input.runId,
      'metadata.attempt': input.attempt,
      'metadata.iterations': input.iterations,
      'metadata.cost_usd': input.costUsd,
      'metadata.ok': input.ok,
      'metadata.errors': input.errors.join(' | ').slice(0, 2000),
      ...(input.factsCandidates === undefined ? {} : { 'metadata.facts_candidates': input.factsCandidates }),
      ...Object.fromEntries(Object.entries(input.tags).map(([k, v]) => [`metadata.tag.${k}`, v])),
    },
  };
}

export async function postRunSpan(
  input: RunSpanInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<'posted' | 'skipped' | 'failed'> {
  const target = resolvePhoenixTarget(env);
  if (!target) return 'skipped';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (env.PHOENIX_API_KEY) headers.authorization = `Bearer ${env.PHOENIX_API_KEY}`;
  try {
    const res = await fetch(`${target.endpoint}/v1/projects/${encodeURIComponent(target.project)}/spans`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ data: [buildRunSpan(input)] }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      process.stderr.write(`phoenix: POST spans ${res.status} ${(await res.text()).slice(0, 200)}\n`);
      return 'failed';
    }
    return 'posted';
  } catch (error) {
    process.stderr.write(`phoenix: unreachable (${error instanceof Error ? error.message : String(error)})\n`);
    return 'failed';
  }
}
