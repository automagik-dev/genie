import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Behavior guard: executes the body of .claude/workflows/wish.js end to end under fake stage agents,
// compiled exactly the way scripts/workflows-meta.test.ts compiles it. The fake agent is keyed by
// label, validates every answer against the schema the body passed, records every prompt, and
// records any label it was not given — the body turns a stage error into `missed` instead of
// throwing, so every scenario asserts both lists stay empty.

const ROOT = join(import.meta.dir, '..');
const source = readFileSync(join(ROOT, '.claude/workflows/wish.js'), 'utf8');
const META_RE = /^export const meta = (\{[\s\S]*?\n\})\n/;
const metaMatch = META_RE.exec(source);
if (!metaMatch) throw new Error('wish.js: no leading pure-literal export const meta');
const body = source.slice(metaMatch[0].length);

type Schema = {
  type?: string;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
};
type Canned = Record<string, unknown>;
type Checks = 'pass' | 'pending' | 'fail';
type AgentOptions = { label?: string; schema?: Schema };
type WishResult = {
  ok: boolean;
  state: string;
  blockedReason: string;
  report: string;
  diff: { files: number; insertions: number; measured: boolean; band: string } | null;
};
type WishBody = (...params: unknown[]) => Promise<WishResult>;

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...src: string[]) => WishBody;
const run = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'workflow', 'budget', 'args', body);

function typeProblem(schema: Schema, value: unknown, path: string): string {
  if (schema.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value)))
    return `${path}: expected object`;
  if (schema.type === 'array' && !Array.isArray(value)) return `${path}: expected array`;
  if (schema.type === 'string' && typeof value !== 'string') return `${path}: expected string`;
  if (schema.type === 'integer' && !Number.isInteger(value)) return `${path}: expected integer`;
  if (schema.type === 'boolean' && typeof value !== 'boolean') return `${path}: expected boolean`;
  if (schema.enum && !schema.enum.includes(value)) return `${path}: ${JSON.stringify(value)} not in enum`;
  return '';
}

function validate(schema: Schema, value: unknown, path = '$'): string[] {
  const problem = typeProblem(schema, value, path);
  if (problem) return [problem];
  if (schema.type === 'array' && schema.items) {
    const items = schema.items;
    return (value as unknown[]).flatMap((item, i) => validate(items, item, `${path}[${i}]`));
  }
  if (schema.type !== 'object') return [];
  const record = value as Record<string, unknown>;
  const missing = (schema.required ?? []).filter((key) => !(key in record)).map((key) => `${path}.${key}: missing`);
  const nested = Object.entries(schema.properties ?? {})
    .filter(([key]) => key in record)
    .flatMap(([key, sub]) => validate(sub, record[key], `${path}.${key}`));
  return [...missing, ...nested];
}

async function runWish(canned: Canned) {
  const prompts: Record<string, string[]> = {};
  const logs: string[] = [];
  const problems: string[] = [];
  const unexpected: string[] = [];
  const agent = async (prompt: string, options: AgentOptions) => {
    const label = String(options?.label);
    prompts[label] = [...(prompts[label] ?? []), prompt];
    if (!(label in canned)) {
      unexpected.push(label);
      return null;
    }
    const value = structuredClone(canned[label]);
    if (!options.schema) problems.push(`${label}: no schema passed`);
    else problems.push(...validate(options.schema, value).map((p) => `${label}: ${p}`));
    return value;
  };
  const never = (name: string) => () => {
    throw new Error(`${name} is not expected`);
  };
  const result = await run(
    agent,
    never('parallel'),
    never('pipeline'),
    () => {},
    (message: string) => logs.push(message),
    never('workflow'),
    never('budget'),
    { objective: 'Add a fixture helper with a focused test', slug: 'fixture', base: 'dev', timestamp: 't' },
  );
  return { result, prompts, logs, problems, unexpected };
}

const BRANCH = 'wish/fixture';
const HEAD = '3f1c2b7a9d8e4f6051a2b3c4d5e6f708192a3b4c';
const REPAIRED = '9e8d7c6b5a49382716051f2e3d4c5b6a79881726';
const FILES = ['src/lib/fixture.ts', 'src/lib/fixture.test.ts'];
const FAILING_CHECK = 'GitGuardian Security Checks';

const gateResult = (measure: { changedFiles?: number; insertions?: number } = { changedFiles: 2, insertions: 40 }) => ({
  hooksLive: true,
  exitCode: 0,
  failCount: 0,
  pass: true,
  problems: [],
  summaryLine: '4242 pass, 0 fail',
  ...measure,
});

const reviewResult = (verdict = 'SHIP') => ({
  verdict,
  findings: [],
  blocking:
    verdict === 'SHIP' ? [] : [{ claim: 'the test asserts nothing', provenance: 'x:1', whatWouldClose: 'assert' }],
  diffFiles: [...FILES],
});

const publishResult = (checks: Checks, head = HEAD, files = FILES) => ({
  pushed: true,
  prUrl: 'https://example.invalid/pull/1',
  prNumber: 1,
  prBase: 'dev',
  prHead: BRANCH,
  prHeadOid: head,
  prFiles: [...files],
  remoteHead: head,
  checks,
  failingChecks: checks === 'fail' ? [FAILING_CHECK] : [],
});

function canned(checks: Checks = 'pass', overrides: Canned = {}): Canned {
  return {
    'admit:scout': {
      facts: [],
      plan: { approach: 'one helper', files: [...FILES], validationCommand: 'bun test', focusedTest: FILES[1] },
      estimate: { files: 2, insertions: 40, units: 1 },
      injectionAttempts: [],
    },
    'admit:judge': {
      route: 'proceed',
      reason: 'one helper',
      contract: {
        core: 'the helper exists',
        oracle: `bun test ${FILES[1]}`,
        files: [...FILES],
        acceptanceCriteria: ['the helper is exported'],
      },
    },
    'work:executor': { status: 'committed', branch: BRANCH, head: HEAD, worktree: '/w', filesChanged: [...FILES] },
    'gate:check': gateResult(),
    'review:diff': reviewResult(),
    'publish:pr': publishResult(checks),
    ...overrides,
  };
}

const realLine = (report: string): string => report.split('\n').find((line) => line.startsWith('- Real')) ?? '';

async function clean(data: Canned) {
  const record = await runWish(data);
  expect(record.unexpected).toEqual([]);
  expect(record.problems).toEqual([]);
  return record;
}

describe('wish.js read-back states', () => {
  test('(1) checks pass and every comparison equal -> merge-ready, ok true', async () => {
    const { result } = await clean(canned('pass'));
    expect({ ok: result.ok, state: result.state }).toEqual({ ok: true, state: 'merge-ready' });
  });

  test('(2) checks pending -> pr-open', async () => {
    const { result } = await clean(canned('pending'));
    expect({ ok: result.ok, state: result.state }).toEqual({ ok: false, state: 'pr-open' });
  });

  test('(3) a failing GitGuardian check with everything else equal -> blocked naming the check', async () => {
    const { result } = await clean(canned('fail'));
    expect({ ok: result.ok, state: result.state }).toEqual({ ok: false, state: 'blocked' });
    expect(result.blockedReason).toContain(FAILING_CHECK);
  });

  for (const checks of ['pass', 'fail'] as const) {
    test(`(4) a structural mismatch -> blocked, checks ${checks}`, async () => {
      const mismatched = { 'publish:pr': publishResult(checks, HEAD, [FILES[0]]) };
      const { result } = await clean(canned(checks, mismatched));
      expect({ ok: result.ok, state: result.state }).toEqual({ ok: false, state: 'blocked' });
      expect(result.blockedReason).toContain(`does not carry ${FILES[1]}`);
    });
  }
});

describe('wish.js reports the gate-measured size', () => {
  test('(5) an over-maximum real diff is named, with state and ok identical to an in-band control', async () => {
    const over = await clean(canned('pass', { 'gate:check': gateResult({ changedFiles: 11, insertions: 2338 }) }));
    const control = await clean(canned('pass', { 'gate:check': gateResult({ changedFiles: 2, insertions: 700 }) }));
    const line = realLine(over.result.report);
    expect(line).toContain('11 file(s), 2338 insertion(s)');
    expect(line).toContain('over the maximum band: insertions 2338 over the maximum 2000');
    expect(line).toContain('files 11 above the ideal 10');
    expect(over.logs.some((l) => l.includes('Size overrun') && l.includes('2338'))).toBe(true);
    expect(realLine(control.result.report)).toContain('700 insertion(s) — inside the ideal band');
    expect({ ok: over.result.ok, state: over.result.state }).toEqual({
      ok: control.result.ok,
      state: control.result.state,
    });
  });

  test('(6) the gate measurement replaces the executor self-report', async () => {
    const executor = { ...(canned()['work:executor'] as object), insertions: 100 };
    const data = canned('pass', {
      'work:executor': executor,
      'gate:check': gateResult({ changedFiles: 2, insertions: 2338 }),
    });
    const { result } = await clean(data);
    const line = realLine(result.report);
    expect(line).toContain('2338 insertion(s)');
    expect(line).toContain('over the maximum');
    expect(line).not.toContain('100 insertion');
    expect(result.diff?.insertions).toBe(2338);
  });

  test('(7) a gate that omits the measurement renders unmeasured, never in band, state unchanged', async () => {
    const { result } = await clean(canned('pass', { 'gate:check': gateResult({}) }));
    const line = realLine(result.report);
    expect(line).toContain('unmeasured, treated as over the maximum');
    expect(line).not.toMatch(/inside the (ideal|maximum) band/);
    expect({ ok: result.ok, state: result.state }).toEqual({ ok: true, state: 'merge-ready' });
  });

  test('(8) a repair round re-gate refreshes the figure', async () => {
    const data = canned('pass', {
      'review:diff': reviewResult('FIX-FIRST'),
      'repair:fix-1': { status: 'fixed', filesTouched: [FILES[1]], head: REPAIRED },
      'gate:round-1': gateResult({ changedFiles: 2, insertions: 950 }),
      'review:round-1': reviewResult(),
      'publish:pr': publishResult('pass', REPAIRED),
    });
    const { result, prompts } = await clean(data);
    expect(prompts['repair:fix-1']).toHaveLength(1);
    const line = realLine(result.report);
    expect(line).toContain('950 insertion(s) — inside the maximum band, insertions 950 above the ideal 800');
    expect(line).not.toContain('40 insertion');
    expect(result.state).toBe('merge-ready');
  });
});

describe('wish.js stage prompts', () => {
  const repairData = () =>
    canned('pass', {
      'review:diff': reviewResult('FIX-FIRST'),
      'repair:fix-1': { status: 'fixed', filesTouched: [FILES[1]], head: REPAIRED },
      'gate:round-1': gateResult(),
      'review:round-1': reviewResult(),
      'publish:pr': publishResult('pass', REPAIRED),
    });

  test('(9) executor and fixer carry the shared brief and are never told to run the check', async () => {
    const { prompts } = await clean(repairData());
    for (const label of ['work:executor', 'repair:fix-1']) {
      const prompt = prompts[label][0];
      const text = briefSection(prompt);
      expect(text.startsWith('Tool and token discipline:\n- ')).toBe(true);
      expect(text).toContain('runs bun run check once after your work, so never run the full repository check');
      expect(text).toContain('log file and grep or tail it');
      expect(text).toContain('never Read a persisted tool-output file whole');
      expect(text).toContain('by line range');
      expect(text).toContain('separate tool calls in one response');
      expect(text).toContain('git -C <worktree>');
      expect(text).not.toMatch(/~\/|\$HOME|\/Users|\/home|\/tmp|\/private/);
      // The only mention of the check anywhere in the prompt is the brief's prohibition.
      expect(prompt.split('bun run check').length).toBe(text.split('bun run check').length);
    }
    expect(prompts['work:executor'][0]).toContain(briefSection(prompts['repair:fix-1'][0]));
  });

  test('(10) the judge carries the oracle and criterion rule', async () => {
    const { prompts } = await clean(canned());
    const judge = prompts['admit:judge'][0];
    expect(judge).toContain('The oracle names the focused test or a command narrower than bun run check');
    expect(judge).toContain('No acceptance criterion may depend on running bun run check or on its exit code');
    expect(judge).toContain('scorable by the read-only reviewer from the commit and the diff');
  });

  test('(11) review prompts carry no gate problems', async () => {
    const red = { ...gateResult(), pass: false, exitCode: 1, failCount: 1, problems: ['(fail) GATE-PROBLEM-SENTINEL'] };
    const data = { ...repairData(), 'gate:check': red, 'review:diff': reviewResult() };
    const { prompts } = await clean(data);
    expect(prompts['repair:fix-1'][0]).toContain('GATE-PROBLEM-SENTINEL');
    for (const label of ['review:diff', 'review:round-1']) {
      expect(prompts[label][0]).not.toContain('GATE-PROBLEM-SENTINEL');
      expect(prompts[label][0]).not.toContain('4242 pass');
    }
  });
});

// Admission narrowing (wish-v7 slice 0): the `scripts/release-*` denylist rule never matches a
// colocated `*.test.ts`, and the units estimate is advice the report carries, never a refusal.
const declaring = (files: string[]): Canned => {
  const base = canned();
  const scout = structuredClone(base['admit:scout']) as { plan: { files: string[] } };
  const judge = structuredClone(base['admit:judge']) as { contract: { files: string[] } };
  scout.plan.files = [...files];
  judge.contract.files = [...files];
  return {
    'admit:scout': scout,
    'admit:judge': judge,
    'work:executor': { ...(base['work:executor'] as object), filesChanged: [...files] },
    'review:diff': { ...reviewResult(), diffFiles: [...files] },
    'publish:pr': publishResult('pass', HEAD, files),
  };
};

describe('wish.js admission narrowing', () => {
  test('(12) a declared scripts/release-docs.test.ts falls through the scripts/release-* rule -> merge-ready', async () => {
    const { result, logs } = await clean(canned('pass', declaring([FILES[0], 'scripts/release-docs.test.ts'])));
    expect(result.state).toBe('merge-ready');
    expect(logs.some((line) => line.includes('Route overridden to plan'))).toBe(false);
  });

  test('(13) a declared scripts/release-guard.sh still hits scripts/release-* -> refused, route plan', async () => {
    const { result, logs } = await clean(canned('pass', declaring([FILES[0], 'scripts/release-guard.sh'])));
    expect(result.state).toBe('refused');
    expect(result.route).toBe('plan');
    const hit = logs.find((line) => line.includes('scripts/release-guard.sh') && line.includes('scripts/release-*'));
    expect(hit).toContain('Route overridden to plan');
  });

  test('(14) units over the maximum is advice, never a refusal -> merge-ready with the advice logged', async () => {
    const scout = { ...(canned()['admit:scout'] as object), estimate: { files: 2, insertions: 40, units: 9 } };
    const { result, logs } = await clean(canned('pass', { 'admit:scout': scout }));
    expect(result.state).toBe('merge-ready');
    expect(logs.some((line) => line.includes('Route overridden to plan'))).toBe(false);
    const advice = logs.find((line) => line.includes('Size advice (not a refusal)'));
    expect(advice).toContain('units 9');
  });
});

// The gate tells "no hook system" apart from "dead hooks": a repository with no hook system at all is
// validated with the frozen contract's validation command and CI is the authority at read-back, while
// any hook system (husky, another manager, or an answer that does not say) keeps the dead-hooks block.
const VALIDATION = 'bun test src/lib/fixture.test.ts --bail';
const REFUSAL = 'would push, merge, publish, or write outside the worktree is not run';
const noHooks = { ...gateResult(), hookSystem: 'none', hooksLive: false, hooksReason: 'no hook system found' };
const deadHooks = (hookSystem?: string) => ({
  ...gateResult(),
  ...(hookSystem ? { hookSystem } : {}),
  hooksLive: false,
  hooksReason: 'no .husky/_/pre-push',
});
const validating = (judgeCommand: string | undefined, scoutCommand = 'bun test'): Canned => {
  const base = canned();
  const scout = structuredClone(base['admit:scout']) as { plan: Record<string, unknown> };
  const judge = structuredClone(base['admit:judge']) as { contract: Record<string, unknown> };
  scout.plan.validationCommand = scoutCommand;
  if (judgeCommand !== undefined) judge.contract.validationCommand = judgeCommand;
  return { 'admit:scout': scout, 'admit:judge': judge };
};

describe('wish.js gate and the repository hook system', () => {
  for (const hookSystem of ['husky', 'other', undefined]) {
    test(`(15) dead hooks with hookSystem ${hookSystem ?? 'absent'} -> blocked at gate:check, nothing reviewed`, async () => {
      const { result, prompts } = await clean(canned('pass', { 'gate:check': deadHooks(hookSystem) }));
      expect({ ok: result.ok, state: result.state }).toEqual({ ok: false, state: 'blocked' });
      expect(result.blockedReason).toContain('hooks are not live');
      expect(prompts['review:diff']).toBeUndefined();
      expect(prompts['publish:pr']).toBeUndefined();
    });
  }

  test('(16) dead hooks at gate:round-1 after a FIX-FIRST -> blocked naming repair round 1', async () => {
    const data = canned('pass', {
      'review:diff': reviewResult('FIX-FIRST'),
      'repair:fix-1': { status: 'fixed', filesTouched: [FILES[0]], head: REPAIRED },
      'gate:round-1': deadHooks('husky'),
      'review:round-1': reviewResult(),
    });
    const { result, prompts } = await clean(data);
    expect({ ok: result.ok, state: result.state }).toEqual({ ok: false, state: 'blocked' });
    expect(result.blockedReason).toContain('repair round 1');
    expect(prompts['review:round-1']).toBeUndefined();
    expect(prompts['publish:pr']).toBeUndefined();
  });

  test('(17) no hook system: checks pass -> merge-ready, pending -> pr-open, fail -> blocked', async () => {
    const pass = await clean(canned('pass', { ...validating(VALIDATION), 'gate:check': noHooks }));
    expect({ ok: pass.result.ok, state: pass.result.state }).toEqual({ ok: true, state: 'merge-ready' });
    expect(pass.result.report).toContain('no hook system');
    expect(pass.result.report).toContain(VALIDATION);
    expect(pass.result.report).toContain('CI is the authority');
    expect(pass.prompts['publish:pr'][0]).toContain('CI is the authority');
    expect(pass.prompts['publish:pr'][0]).toContain('no reported check is checks pending, never pass');

    const pending = await clean(canned('pending', { ...validating(VALIDATION), 'gate:check': noHooks }));
    expect({ ok: pending.result.ok, state: pending.result.state }).toEqual({ ok: false, state: 'pr-open' });

    const fail = await clean(canned('fail', { ...validating(VALIDATION), 'gate:check': noHooks }));
    expect({ ok: fail.result.ok, state: fail.result.state }).toEqual({ ok: false, state: 'blocked' });
    expect(fail.result.blockedReason).toContain(FAILING_CHECK);
  });

  test('(18) no hook system and no validation command frozen -> blocked, nothing published', async () => {
    const { result, prompts } = await clean(canned('pass', { ...validating(undefined, ''), 'gate:check': noHooks }));
    expect({ ok: result.ok, state: result.state }).toEqual({ ok: false, state: 'blocked' });
    expect(result.blockedReason).toContain('no validation command');
    expect(prompts['publish:pr']).toBeUndefined();
  });

  test('(19) the gate prompt carries the frozen validation command, the hook path and the refusal', async () => {
    const { prompts } = await clean(canned('pass', validating(VALIDATION)));
    const gatePrompt = prompts['gate:check'][0];
    expect(gatePrompt).toContain(VALIDATION);
    expect(gatePrompt).toContain('test -f .husky/_/pre-push');
    expect(gatePrompt).toContain('bun run check');
    expect(gatePrompt).toContain(REFUSAL);
    expect(gatePrompt).toContain('git config --get core.hooksPath');
    // The run sentence runs the ONE command the classification selected, never `bun run check` unconditionally.
    expect(gatePrompt).toContain('Then run the selected command exactly once');
    expect(gatePrompt).not.toContain('Then run bun run check exactly once');

    // With no judge field, the scout plan's validation command is the frozen one.
    const fallback = await clean(canned('pass', validating(undefined, 'bun test src/lib/scout-fallback.test.ts')));
    expect(fallback.prompts['gate:check'][0]).toContain('bun test src/lib/scout-fallback.test.ts');
  });
});

function briefSection(prompt: string): string {
  const start = prompt.indexOf('Tool and token discipline:');
  if (start < 0) return '';
  const end = prompt.indexOf('\n\n', start);
  return prompt.slice(start, end < 0 ? undefined : end);
}
