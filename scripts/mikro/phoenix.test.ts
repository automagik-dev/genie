import { afterEach, describe, expect, test } from 'bun:test';
import { type RunSpanInput, postRunSpan, resolvePhoenixTarget } from './phoenix';

const INPUT: RunSpanInput = {
  agent: 'wish-context',
  runId: 'r1',
  traceId: 't1',
  attempt: 1,
  startMs: 0,
  endMs: 1,
  model: 'deepseek/flash',
  iterations: 1,
  tokensIn: 1,
  tokensOut: 1,
  costUsd: 0,
  ok: true,
  errors: [],
  tags: {},
  prompt: 'p',
  answer: 'a',
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function spyFetch(status = 202): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response('{}', { status });
  }) as typeof fetch;
  return urls;
}

describe('mikro Phoenix target — off until configured, nothing defaulted', () => {
  test('no configuration: no target, no network call', async () => {
    const urls = spyFetch();
    expect(resolvePhoenixTarget({})).toBeNull();
    expect(await postRunSpan(INPUT, {})).toBe('skipped');
    expect(urls).toEqual([]);
  });

  test('a PHOENIX_ENDPOINT set for another tool does not turn mikro posting on', async () => {
    const urls = spyFetch();
    const env = { PHOENIX_ENDPOINT: 'http://phoenix.example:6006', PHOENIX_PROJECT: 'someone-else' };
    expect(resolvePhoenixTarget(env)).toBeNull();
    expect(await postRunSpan(INPUT, env)).toBe('skipped');
    expect(urls).toEqual([]);
  });

  test('a project without an endpoint is not a target either', () => {
    expect(resolvePhoenixTarget({ MIKRO_PHOENIX_PROJECT: 'mine' })).toBeNull();
  });

  test('project + endpoint posts to exactly that project; PHOENIX_DISABLED=1 still wins', async () => {
    const urls = spyFetch();
    const env = { MIKRO_PHOENIX_PROJECT: 'my mikro', PHOENIX_COLLECTOR_ENDPOINT: 'https://px.example/' };
    expect(resolvePhoenixTarget(env)).toEqual({ endpoint: 'https://px.example', project: 'my mikro' });
    expect(await postRunSpan(INPUT, env)).toBe('posted');
    expect(urls).toEqual(['https://px.example/v1/projects/my%20mikro/spans']);
    expect(await postRunSpan(INPUT, { ...env, PHOENIX_DISABLED: '1' })).toBe('skipped');
    expect(urls).toHaveLength(1);
  });
});
