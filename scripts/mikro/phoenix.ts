/**
 * Phoenix span emitter for mikro microagent runs — one AGENT span per attempt,
 * posted to project `cc-mikro` with the same OpenInference shape
 * `scripts/observability/backfill.ts` uses for Claude Code sessions, so a run's
 * USD, tokens and latency sit beside the Opus turns it is meant to replace.
 *
 * Best-effort by design: a Phoenix that is down or refusing never fails a run;
 * the caller gets 'failed' and a stderr line. `PHOENIX_DISABLED=1` skips it.
 * Env: PHOENIX_ENDPOINT (or PHOENIX_COLLECTOR_ENDPOINT; default the local
 * loopback the README documents), PHOENIX_API_KEY (optional), MIKRO_PHOENIX_PROJECT.
 */
import { createHash } from 'node:crypto';

export const MIKRO_PHOENIX_PROJECT = process.env.MIKRO_PHOENIX_PROJECT ?? 'cc-mikro';

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
      ...Object.fromEntries(Object.entries(input.tags).map(([k, v]) => [`metadata.tag.${k}`, v])),
    },
  };
}

function endpoint(): string {
  return (process.env.PHOENIX_ENDPOINT ?? process.env.PHOENIX_COLLECTOR_ENDPOINT ?? 'http://127.0.0.1:6006').replace(
    /\/+$/,
    '',
  );
}

export async function postRunSpan(input: RunSpanInput): Promise<'posted' | 'skipped' | 'failed'> {
  if (process.env.PHOENIX_DISABLED === '1') return 'skipped';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (process.env.PHOENIX_API_KEY) headers.authorization = `Bearer ${process.env.PHOENIX_API_KEY}`;
  try {
    const res = await fetch(`${endpoint()}/v1/projects/${encodeURIComponent(MIKRO_PHOENIX_PROJECT)}/spans`, {
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
