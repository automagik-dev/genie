import { afterAll, test as bunTest, describe, expect } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { designReviewDigest, designReviewViolations } from '../skills/brainstorm/references/design-review-evidence.mjs';

// Behavior guard: executes the body of .claude/workflows/brainstorm.js across runs under fake agents
// keyed by label, compiled the way scripts/workflows-meta.test.ts compiles it. Every `ledger:*` agent
// is NOT a fake: it executes the JSON steps the script wrote into its prompt against the REAL
// round-ledger.mjs and design-review-evidence.mjs, on a temporary DRAFT, so the seam between the
// workflow and the ledger is exercised end to end. Every other answer is validated against the
// schema the body passed, and a label without a fake is recorded as unexpected.

const ROOT = join(import.meta.dir, '..');
const LEDGER = join(ROOT, 'skills', 'brainstorm', 'references', 'round-ledger.mjs');
const EVIDENCE = join(ROOT, 'skills', 'brainstorm', 'references', 'design-review-evidence.mjs');
const REVIEW_CONTRACT = join(ROOT, 'skills', 'review', 'SKILL.md');
const SLUG = 'idea';
const DISSENT_KEY = 'dissent';
const STATES = ['round', 'done', 'answered', 'blocked', 'failed'];
// A scenario spawns node a dozen times per run; a loaded host must not trip the 5 s default.
const FLOW_TIMEOUT = 30_000;

const source = readFileSync(join(ROOT, '.claude', 'workflows', 'brainstorm.js'), 'utf8');
const META_RE = /^export const meta = (\{[\s\S]*?\n\})\n/;
const metaMatch = META_RE.exec(source);
if (!metaMatch) throw new Error('brainstorm.js: no leading pure-literal export const meta');
const body = source.slice(metaMatch[0].length);

type Out = Record<string, any>;
type Schema = {
  type?: string;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
};
type AgentOptions = { label?: string; schema?: Schema; model?: string; effort?: string; phase?: string };
type Call = { label: string; prompt: string; options: AgentOptions };
type Env = { repo: string; draft: string; design: string };
type FakeFn = (call: Call, env: Env) => unknown;
type Fakes = Record<string, unknown>;
type Result = {
  state: string;
  round: number;
  wrs: { score: number; bar: string } | null;
  questions: Out[];
  plan: Out;
  draft: string;
  design: string;
  route: string;
  notes: string[];
  notConvened: string[];
};

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...src: string[]
) => (...params: unknown[]) => Promise<Result>;
const run = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'workflow', 'budget', 'args', body);

function typeProblem(schema: Schema, value: unknown, path: string): string {
  if (schema.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value)))
    return `${path}: expected object`;
  if (schema.type === 'array' && !Array.isArray(value)) return `${path}: expected array`;
  if (schema.type === 'string' && typeof value !== 'string') return `${path}: expected string`;
  if (schema.type === 'integer' && !Number.isInteger(value)) return `${path}: expected integer`;
  if (schema.type === 'boolean' && typeof value !== 'boolean') return `${path}: expected boolean`;
  if (schema.enum && !schema.enum.includes(value)) return `${path}: ${JSON.stringify(value)} not in enum`;
  if (schema.minimum !== undefined && (value as number) < schema.minimum) return `${path}: below ${schema.minimum}`;
  if (schema.maximum !== undefined && (value as number) > schema.maximum) return `${path}: above ${schema.maximum}`;
  const length = Array.isArray(value) ? value.length : 0;
  if (schema.minItems !== undefined && length < schema.minItems) return `${path}: fewer than ${schema.minItems} items`;
  if (schema.maxItems !== undefined && length > schema.maxItems) return `${path}: more than ${schema.maxItems} items`;
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

const test = (name: string, fn: () => Promise<void> | void) => bunTest(name, fn, FLOW_TIMEOUT);

// ---------------------------------------------------------------- the real ledger agent

let dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** What a ledger agent does: run the steps the script wrote, verbatim, and report each one. */
function executeLedger(prompt: string): Out {
  const match = /```json\n([\s\S]*?)\n```/.exec(prompt);
  if (!match) throw new Error('a ledger prompt carries no JSON step block');
  const spec = JSON.parse(match[1] as string) as { precondition?: string; steps: Out[] };
  const out: Out = { runs: [] };
  if (spec.precondition !== undefined) {
    const exists = existsSync(spec.precondition) && statSync(spec.precondition).isFile();
    out.precondition = { path: spec.precondition, exists };
    if (!exists) return out;
  }
  const exits: Record<string, number> = {};
  for (const step of spec.steps) {
    const blocked = (step.onlyAfter ?? []).some((name: string) => exits[name] !== 0);
    if (blocked || (step.ifExists && !existsSync(step.ifExists))) {
      exits[step.step] = -1;
      out.runs.push({ step: step.step, exitCode: -1, stdout: '', stderr: '', skipped: true });
      continue;
    }
    if (step.append !== undefined) {
      const current = readFileSync(step.to, 'utf8');
      appendFileSync(step.to, `${current.endsWith('\n') ? '' : '\n'}\n${step.append}\n`);
      exits[step.step] = 0;
      out.runs.push({ step: step.step, exitCode: 0, stdout: '', stderr: '' });
      continue;
    }
    // Every payload arrives already packed in argv: the agent passes the arguments through and writes nothing.
    const argv = step.argv as string[];
    const result = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' });
    exits[step.step] = result.exitCode ?? -1;
    out.runs.push({
      step: step.step,
      exitCode: result.exitCode ?? -1,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    });
  }
  return out;
}

// ---------------------------------------------------------------- the harness

const seenStates = new Set<string>();

function newEnv(): Env {
  const repo = tempDir('genie-bs-repo-');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'helper.ts'), 'export const helper = 1;\n');
  const dir = join(repo, '.genie', 'brainstorms', SLUG);
  return { repo, draft: join(dir, 'DRAFT.md'), design: join(dir, 'DESIGN.md') };
}

function pick(fakes: Fakes, label: string): unknown {
  if (label in fakes) return fakes[label];
  const prefix = Object.keys(fakes).find((key) => key.endsWith('*') && label.startsWith(key.slice(0, -1)));
  return prefix === undefined ? undefined : fakes[prefix];
}

async function runBrainstorm(env: Env, fakes: Fakes, args: Out = {}) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const problems: string[] = [];
  const unexpected: string[] = [];
  const agent = async (prompt: string, options: AgentOptions) => {
    const label = String(options?.label);
    const call = { label, prompt, options };
    calls.push(call);
    if (label.startsWith('ledger:')) {
      const report = executeLedger(prompt);
      problems.push(...validate(options.schema ?? {}, report).map((p) => `${label}: ${p}`));
      return report;
    }
    let fake = pick(fakes, label);
    if (Array.isArray(fake)) fake = fake.shift();
    if (fake === undefined) {
      unexpected.push(label);
      return null;
    }
    const answer = typeof fake === 'function' ? await (fake as FakeFn)(call, env) : structuredClone(fake);
    if (answer instanceof Error) throw answer;
    if (answer === null || answer === undefined) return null;
    if (!options.schema) problems.push(`${label}: no schema passed`);
    else problems.push(...validate(options.schema, answer).map((p) => `${label}: ${p}`));
    return answer;
  };
  const parallel = (thunks: Array<() => Promise<unknown>>) =>
    Promise.all(thunks.map((thunk) => thunk().catch(() => null)));
  const never = (name: string) => () => {
    throw new Error(`${name} is not expected`);
  };
  const result = await run(
    agent,
    parallel,
    never('pipeline'),
    () => {},
    (message: string) => logs.push(message),
    never('workflow'),
    never('budget'),
    {
      slug: SLUG,
      request: 'Add one small helper to the repository',
      repo: env.repo,
      tools: { ledger: LEDGER, evidence: EVIDENCE, reviewContract: REVIEW_CONTRACT },
      councilCeiling: 1,
      repairBudget: 2,
      timestamp: '2026-10-01T00:00:00Z',
      ...args,
    },
  );
  seenStates.add(result.state);
  return { result, calls, labels: calls.map((c) => c.label), logs, problems, unexpected };
}

/** A run whose every agent answered within its schema and whose every label had a fake. */
async function clean(env: Env, fakes: Fakes, args: Out = {}) {
  const record = await runBrainstorm(env, fakes, args);
  expect(record.unexpected).toEqual([]);
  expect(record.problems).toEqual([]);
  return record;
}

function blockOf(path: string): Out {
  const match = /```ledger\n([\s\S]*?)\n```/.exec(readFileSync(path, 'utf8'));
  if (!match) throw new Error(`no ledger block in ${path}`);
  return JSON.parse(match[1] as string);
}

// The one transport the workflow's steps use: percent-packed JSON, which the ledger CLI requires of every JSON flag.
const pack = (value: unknown): string =>
  `packed:${encodeURIComponent(JSON.stringify(value)).replace(
    /[!'()*~]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  )}`;

function cli(...args: string[]): Out {
  const result = Bun.spawnSync(['node', LEDGER, ...args], { stdout: 'pipe', stderr: 'pipe' });
  return { code: result.exitCode, out: JSON.parse(result.stdout.toString()) };
}

// ---------------------------------------------------------------- canned agents

const wrsAt = (each: number) =>
  Object.fromEntries(
    ['problem', 'scope', 'decisions', 'risks', 'criteria'].map((key) => [key, { score: each, evidence: 'seen' }]),
  );

function question(n: number, overrides: Out = {}): Out {
  return {
    kind: 'decision',
    question: `Decision ${n}: keep the helper small?`,
    header: `Q${n}`,
    multiSelect: false,
    options: [
      { label: 'Yes (Recommended)', description: 'the smallest change', value: 'yes' },
      { label: 'No', description: 'dissent: grow it now', value: 'no' },
    ],
    ...overrides,
  };
}

function plan(overrides: Out = {}): Out {
  return {
    wrs: wrsAt(12),
    mode: 'round',
    size: 'M',
    scope: ['the helper'],
    scouts: [],
    council: { convene: false, reason: 'nothing is contested' },
    reason: 'ask the owner the open decision',
    questions: [question(1)],
    ...overrides,
  };
}

const answerTo = (entry: Out, label: string) => ({ id: entry.id, question: entry.question, answer: label });

const LENS = (key: string) => ({ key, brief: `the ${key} view of the decision` });
const lensReport = {
  position: 'keep it small',
  verdict: 'support',
  confidence: 'medium',
  keyEvidence: ['src/helper.ts:1'],
  risks: [],
  unknowns: [],
};
const elenchusFor = (call: Call) => {
  const keys = [...call.prompt.matchAll(/"lens": "([^"]+)"/g)].map((m) => m[1]);
  return { questions: keys.map((lens) => ({ lens, questions: [`What would falsify the ${lens} position?`] })) };
};
const lensAnswer = { answers: ['the helper test'], revisedPosition: 'keep it small', changedMind: false };
const proposal = (ids: string[], questions: Out[] = []) => ({
  reading: 'the lenses agree the helper stays small',
  decisions: ids.map((id, i) => ({
    id,
    decision: `Decision ${i + 1}`,
    recommended: 'keep it small',
    why: 'lens:dissent',
  })),
  consensus: 'small',
  dissent: [{ lens: 'dissent', position: 'grow it now' }],
  questions,
});

function councilFakes(ids: string[] = ['P1', 'P2']): Fakes {
  return {
    'lens:*': lensReport,
    'socrates:elenchus': elenchusFor,
    'answer:*': lensAnswer,
    'socrates:proposal': proposal(ids, [question(7)]),
  };
}

const DESIGN_TEXT = `# Design: one helper

| Field | Value |
|-------|-------|
| **Slug** | idea |
| **WRS** | 100/100 |
| **Size** | M |

## Problem

The repository needs one small helper.

## Scope

### IN
| # | Deliverable | Files changed | Source |
|---|-------------|---------------|--------|
| 1 | The helper | \`src/helper.ts\` | R1-1 |

### OUT
- A second helper (Source: R1-1).

## Approach

Write the helper and its test.

## Decisions

| # | Decision | Rationale | Source |
|---|----------|-----------|--------|
| 1 | One helper | The smallest change | R1-1 |

## Success Criteria

- [ ] The helper exists. **Proof:** \`src/helper.ts\`.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** PENDING
- **Reviewed content SHA-256:** PENDING
- **Reviewer:** PENDING
- **Reviewed at:** PENDING
<!-- genie-design-review:end -->
`;

const writeDesign =
  (text = DESIGN_TEXT) =>
  (_call: Call, env: Env) => {
    writeFileSync(env.design, text);
    return { written: true, summary: 'one helper' };
  };

/** The repair a FIX-FIRST asks for, cited as `reviewer HIGH-1` so check-design must resolve it. */
const repairCiting = (finding: string) => (_call: Call, env: Env) => {
  const text = readFileSync(env.design, 'utf8');
  const row = '| 1 | One helper | The smallest change | R1-1 |\n';
  writeFileSync(
    env.design,
    text.replace(row, `${row}| 2 | Name it plainly | The review asked | reviewer ${finding} |\n`),
  );
  return { status: 'repaired', summary: `addressed ${finding}` };
};

const reviewOf =
  (verdict: string, findings: Array<[string, string]> = [], digest?: string) =>
  (_call: Call, env: Env) => ({
    verdict,
    reviewedSha256: digest ?? designReviewDigest(readFileSync(env.design, 'utf8')),
    reviewer: 'review-agent-test',
    criteria: [{ id: 'C1', criterion: 'the helper is scoped', met: verdict === 'SHIP' }],
    findings: findings.map(([id, severity]) => ({
      id,
      severity,
      claim: `${id} is open`,
      evidence: 'DESIGN.md:1',
      correction: 'name it',
    })),
  });

/** Run 1 asks one question; the returned env has the DRAFT and the R1-1 entry to answer. */
async function askedOnce(questions: Out[] = [question(1)]) {
  const env = newEnv();
  const first = await clean(env, { 'lead:plan': plan({ questions }) });
  expect(first.result.state).toBe('round');
  return { env, asked: first.result.questions };
}

/** Run 2 answers R1-1 and crystallizes at WRS 100. */
const crystallizePlan = (overrides: Out = {}) =>
  plan({ wrs: wrsAt(20), mode: 'crystallize', questions: [], ...overrides });

// ---------------------------------------------------------------- rounds across runs

describe('rounds across runs', () => {
  test('run 1 asks with ids and the recommended option first, and records the raise', async () => {
    const env = newEnv();
    const { result, labels } = await clean(env, { 'lead:plan': plan({ questions: [question(1), question(2)] }) });
    expect(result.state).toBe('round');
    expect(result.round).toBe(1);
    expect(labels).toEqual(['ledger:apply', 'lead:plan', 'ledger:commit']);
    expect(result.questions.map((q) => q.id)).toEqual(['R1-1', 'R1-2']);
    expect(result.questions[0]).toEqual({
      id: 'R1-1',
      kind: 'decision',
      question: 'Decision 1: keep the helper small?',
      header: 'Q1',
      multiSelect: false,
      options: [
        { label: 'Yes (Recommended)', description: 'the smallest change' },
        { label: 'No', description: 'dissent: grow it now' },
      ],
    });
    expect(result.wrs?.bar).toBe('██████░░░░ 60/100');
    expect(result.draft).toBe(env.draft);
    const block = blockOf(env.draft);
    expect(block.asked.map((q: Out) => q.id)).toEqual(['R1-1', 'R1-2']);
    expect(block.size).toEqual([{ value: 'M', by: 'lead', round: 1 }]);
    expect(block.scopeIn).toEqual([{ item: 'the helper', by: 'lead', round: 1 }]);
    expect(readFileSync(env.draft, 'utf8')).toContain('## Asked\n\n- **R1-1** (round 1, decision)');
  });

  test('answers from run 1 land in Settled in run 2, and a skipped question is shown again (L-a)', async () => {
    const { env, asked } = await askedOnce([question(1), question(2)]);
    const second = await clean(
      env,
      { 'lead:plan': plan({ questions: [question(3)] }) },
      {
        answers: [answerTo(asked[0], 'Yes (Recommended)')],
      },
    );
    expect(second.result.state).toBe('round');
    expect(second.result.round).toBe(2);
    const settled = blockOf(env.draft).settled;
    expect(settled).toEqual([
      expect.objectContaining({ id: 'R1-1', value: 'yes', provenance: 'owner picked "Yes (Recommended)"', round: 2 }),
    ]);
    expect(second.result.questions.map((q) => q.id)).toEqual(['R1-2', 'R2-1']);
    expect(second.result.notes).toContain('R1-2 was not answered; it stays Asked and is shown again.');
    const leadPrompt = second.calls.find((c) => c.label === 'lead:plan')?.prompt ?? '';
    expect(leadPrompt).toContain('"id": "R1-1"');
    // The settled question lives in the DRAFT the lead reads; only the still-open one rides the state.
    expect(leadPrompt).not.toContain(question(1).question);
    expect(leadPrompt).toContain(question(2).question);
    expect(readFileSync(env.draft, 'utf8')).toContain('- **R1-1** (round 2, decision)');
  });

  test('a plain answer cannot change a Settled id; a reopen question quoting old → new can', async () => {
    const { env, asked } = await askedOnce();
    await clean(env, { 'lead:plan': plan({ questions: [] }) }, { answers: [answerTo(asked[0], 'Yes (Recommended)')] });

    const plain = await runBrainstorm(env, {}, { answers: [{ ...answerTo(asked[0], 'No') }] });
    expect(plain.result.state).toBe('blocked');
    expect(plain.labels).toEqual(['ledger:apply']);
    expect(plain.result.notes.join('\n')).toContain(
      'R1-1 is Settled; it changes only through a question whose reopens',
    );

    const reopenText = 'R1-1 was "Yes (Recommended)" → grow the helper now?';
    const reopen = question(9, { question: reopenText, header: 'Reopen', reopens: 'R1-1' });
    const asking = await clean(env, { 'lead:plan': plan({ questions: [reopen] }) });
    const reopenId = asking.result.questions[0].id;
    await clean(
      env,
      { 'lead:plan': plan({ questions: [] }) },
      { answers: [answerTo(asking.result.questions[0], 'No')] },
    );
    const settled = Object.fromEntries(blockOf(env.draft).settled.map((entry: Out) => [entry.id, entry]));
    expect(settled['R1-1']).toMatchObject({ value: 'yes', reopenedBy: reopenId });
    expect(settled[reopenId]).toMatchObject({ value: 'no', reopens: 'R1-1' });
  });

  test('a header longer than 12 characters is cut to 12 before it is asked', async () => {
    const env = newEnv();
    const long = question(1, { header: 'Architecture choice' });
    const { result } = await clean(env, { 'lead:plan': plan({ questions: [long] }) });
    expect(result.questions[0].header).toBe('Architecture');
    expect(blockOf(env.draft).asked[0].header).toBe('Architecture');
  });

  test('the lead writes downgrade values exactly; an unapproved downgrade is held, an approved one recorded', async () => {
    const env = newEnv();
    await clean(env, { 'lead:plan': plan({ size: 'G', questions: [] }) });
    const held = await clean(env, { 'lead:plan': plan({ size: 'M', questions: [] }) });
    expect(held.result.state).toBe('round');
    expect(held.result.notes.join('\n')).toContain('Not recorded: size:M lowers what the owner approved');
    expect(blockOf(env.draft).size.map((s: Out) => s.value)).toEqual(['G']);
    const prompt = held.calls.find((c) => c.label === 'lead:plan')?.prompt ?? '';
    expect(prompt).toContain('size:<P|M|G>');
    expect(prompt).toContain('scope-drop:<the item exactly as Scope IN spells it>');

    const shrink = question(5, {
      question: 'Shrink the size to M?',
      header: 'Size',
      options: [
        { label: 'Shrink to M (Recommended)', description: 'one wish', value: 'size:M' },
        { label: 'Keep G', description: 'grouped', value: 'keep' },
      ],
    });
    const asked = await clean(env, { 'lead:plan': plan({ size: 'G', questions: [shrink] }) });
    await clean(
      env,
      { 'lead:plan': plan({ size: 'M', questions: [] }) },
      {
        answers: [answerTo(asked.result.questions[0], 'Shrink to M (Recommended)')],
      },
    );
    const size = blockOf(env.draft).size;
    expect(size.at(-1)).toMatchObject({ value: 'M', by: 'owner', approvedBy: asked.result.questions[0].id });

    // The approval is spent: raised back to G, a second shrink to M waits for a new answer.
    await clean(env, { 'lead:plan': plan({ size: 'G', questions: [] }) });
    const again = await clean(env, { 'lead:plan': plan({ size: 'M', questions: [] }) });
    expect(again.result.state).toBe('round');
    expect(again.result.notes.join('\n')).toContain('Not recorded: size:M lowers what the owner approved');
    expect(blockOf(env.draft).size.map((s: Out) => s.value)).toEqual(['G', 'M', 'G']);
  });
});

// ---------------------------------------------------------------- the payload transport

describe('the ledger payload transport', () => {
  const JSON_FLAGS = ['--answers', '--questions', '--scope', '--decided', '--findings'];
  const stepsOf = (calls: Call[]): Out[] =>
    calls
      .filter((call) => call.label.startsWith('ledger:'))
      .flatMap(
        (call) =>
          (JSON.parse((/```json\n([\s\S]*?)\n```/.exec(call.prompt) as RegExpExecArray)[1]) as { steps: Out[] }).steps,
      );

  test('no step hands the agent JSON to re-type: every payload is packed into argv, no file is named', async () => {
    const env = newEnv();
    const { calls } = await clean(env, { 'lead:plan': plan({ questions: [question(1)] }) });
    const steps = stepsOf(calls);
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(step.files).toBeUndefined();
      const argv = step.argv as string[];
      expect(argv.join(' ')).not.toContain('@{');
      for (const [index, arg] of argv.entries()) {
        if (JSON_FLAGS.includes(argv[index - 1] as string)) expect(arg).toMatch(/^packed:[A-Za-z0-9%._-]*$/);
      }
    }
    const flags = steps.flatMap((step) => step.argv as string[]).filter((arg) => JSON_FLAGS.includes(arg));
    expect(flags).toContain('--answers');
    expect(flags).toContain('--questions');
  });

  // One command-line argument holds 128 KiB on Linux (MAX_ARG_STRLEN), and a packed payload is what an
  // owner's words become in it: past the script's cap the run refuses by name before any agent is asked to
  // spawn it, instead of failing as E2BIG halfway through a round.
  test('an answer too large for one argument is refused by name before any agent runs', async () => {
    const { env, asked } = await askedOnce();
    for (const pad of ['a'.repeat(200_000), 'é'.repeat(40_000)]) {
      const refused = await runBrainstorm(env, {}, { answers: [answerTo(asked[0], pad)] });
      expect(refused.calls).toEqual([]);
      expect(refused.result.state).toBe('failed');
      expect(refused.result.notes.join('\n')).toContain('payload too large: the --answers argument of step apply is');
      expect(refused.result.notes.join('\n')).toContain('98304');
    }
    expect(blockOf(env.draft).settled).toEqual([]);
  });

  test('an answer just under the cap still settles, and the state apply returns stays small', async () => {
    const { env, asked } = await askedOnce();
    const words = 'x'.repeat(90_000);
    const run = await clean(env, { 'lead:plan': plan({ questions: [] }) }, { answers: [answerTo(asked[0], words)] });
    expect(run.result.state).toBe('round');
    expect(blockOf(env.draft).settled[0].answer).toBe(words);
    const lead = run.calls.find((c) => c.label === 'lead:plan')?.prompt ?? '';
    expect(lead).not.toContain('xxxxxxxx');
  });

  test('a question with quotes, a backslash, an arrow and an emoji reaches the DRAFT byte for byte', async () => {
    const text = 'Keep the "helper" as-is? It\'s C:\\tmp\\x (yes!) *really*~ → “small” 🧞';
    const env = newEnv();
    const { result } = await clean(env, { 'lead:plan': plan({ questions: [question(1, { question: text })] }) });
    expect(result.state).toBe('round');
    expect(blockOf(env.draft).asked[0].question).toBe(text);
  });

  test('a state that does not survive the transport names itself, never the generic start failure', async () => {
    const env = newEnv();
    const wrapper = join(tempDir('genie-bs-wrapper-'), 'mangled-state.mjs');
    writeFileSync(
      wrapper,
      [
        `import { runRoundLedger } from ${JSON.stringify(pathToFileURL(LEDGER).href)};`,
        'const argv = process.argv.slice(2);',
        'const { exitCode, output } = runRoundLedger(argv);',
        "if (argv[0] === 'apply') output.state = '{\"round\":1}';",
        'process.stdout.write(`${JSON.stringify(output, null, 2)}\\n`);',
        'process.exitCode = exitCode;',
        '',
      ].join('\n'),
    );
    const { result, labels } = await clean(
      env,
      {},
      { tools: { ledger: wrapper, evidence: EVIDENCE, reviewContract: REVIEW_CONTRACT } },
    );
    expect(labels).toEqual(['ledger:apply']);
    expect(result.state).toBe('failed');
    expect(result.notes.join('\n')).toContain('transport');
    expect(result.notes.join('\n')).not.toContain('The round ledger failed to start');
  });
});

// ---------------------------------------------------------------- scouts

describe('scouts', () => {
  test('a normal round caps scouts at 11, logs the drop, and stays at 15 agents', async () => {
    const env = newEnv();
    const scouts = Array.from({ length: 14 }, (_, i) => ({
      brief: `read area ${i}`,
      tier: i === 0 ? 'reasoner' : 'worker',
      effort: 'low',
      why: 'facts',
    }));
    const { result, calls, labels } = await clean(env, {
      'lead:plan': plan({ scouts, questions: [] }),
      'scout:*': { findings: [{ claim: 'the helper is absent', provenance: 'src:1' }], unknowns: [] },
      'lead:compose': { questions: [question(1)], wrs: wrsAt(14) },
    });
    const scoutLabels = labels.filter((label) => label.startsWith('scout:'));
    expect(scoutLabels).toEqual(Array.from({ length: 11 }, (_, i) => `scout:${i}`));
    expect(labels.length).toBe(15);
    expect(result.notes.join('\n')).toContain('the last 3 were dropped');
    expect(result.plan.scouts.filter((s: Out) => !s.ran).length).toBe(3);
    expect(result.questions.map((q) => q.id)).toEqual(['R1-1']);
    expect(result.wrs?.score).toBe(70);
    const model = (label: string) => calls.find((c) => c.label === label)?.options.model;
    expect([model('scout:0'), model('scout:1'), model('lead:plan'), model('ledger:apply')]).toEqual([
      'opus',
      'sonnet',
      'opus',
      'sonnet',
    ]);
    expect(calls.find((c) => c.label === 'scout:0')?.options.effort).toBe('low');
  });

  test('a scout tier outside worker and reasoner is clamped to worker, never the judge tier', async () => {
    const env = newEnv();
    const record = await runBrainstorm(env, {
      'lead:plan': plan({ scouts: [{ brief: 'read', tier: 'judge', effort: 'medium', why: 'x' }], questions: [] }),
      'scout:*': { findings: [], unknowns: [] },
      'lead:compose': { questions: [question(1)] },
    });
    expect(record.problems).toEqual(['lead:plan: $.scouts[0].tier: "judge" not in enum']);
    expect(record.calls.find((c) => c.label === 'scout:0')?.options.model).toBe('sonnet');
  });
});

// ---------------------------------------------------------------- the council

describe('the Socratic council', () => {
  test('the plan schema bounds lenses to 3-5, and the script adds dissent when it is missing', async () => {
    const env = newEnv();
    const { result, calls, labels } = await clean(env, {
      'lead:plan': plan({
        council: {
          convene: true,
          decision: 'helper or module?',
          reason: 'contested',
          expectedSpend: '1M',
          lenses: ['scope', 'cost', 'risk'].map(LENS),
        },
        questions: [],
      }),
      ...councilFakes(),
    });
    const schema = calls[1]?.options.schema as Schema;
    const lenses = schema.properties?.council?.properties?.lenses as Schema;
    expect([lenses.minItems, lenses.maxItems]).toEqual([3, 5]);
    expect(
      validate(
        lenses,
        Array.from({ length: 6 }, (_, i) => LENS(`l${i}`)),
      ),
    ).toEqual(['$: more than 5 items']);
    expect(validate(lenses, [LENS('a'), LENS('b')])).toEqual(['$: fewer than 3 items']);

    expect(labels.filter((l) => l.startsWith('lens:'))).toEqual([
      'lens:scope',
      'lens:cost',
      'lens:risk',
      'lens:dissent',
    ]);
    expect(result.notes).toContain('The plan named no dissent lens; the script added one.');
    expect(result.plan.council).toMatchObject({ convened: true, dissentInserted: true, recorded: true });
    const model = (label: string) => calls.find((c) => c.label === label)?.options.model;
    expect([
      model('socrates:elenchus'),
      model('socrates:proposal'),
      model('lens:dissent'),
      model('answer:scope'),
    ]).toEqual(['fable', 'fable', 'opus', 'opus']);
    expect(blockOf(env.draft).councils).toEqual([{ run: 'round-1', round: 1, decided: ['P1', 'P2'] }]);
    expect(result.questions.map((q) => q.question)).toEqual(['Decision 7: keep the helper small?']);
    const draft = readFileSync(env.draft, 'utf8');
    expect(draft).toContain('## Council round-1');
    expect(draft).toContain('- **P1** Decision 1: keep it small.');
    expect(draft).toContain('- run round-1 · round 1 · decided P1, P2');
  });

  test('a council round runs no scouts and stays at 15 agents; dissent replaces the fifth lens', async () => {
    const env = newEnv();
    const { result, labels } = await clean(env, {
      'lead:plan': plan({
        scouts: [{ brief: 'read', tier: 'worker', effort: 'low', why: 'x' }],
        council: { convene: true, decision: 'd', reason: 'r', lenses: ['a', 'b', 'c', 'd', 'e'].map(LENS) },
        questions: [],
      }),
      ...councilFakes(),
    });
    expect(labels.filter((l) => l.startsWith('scout:'))).toEqual([]);
    expect(labels.length).toBe(15);
    expect(labels.filter((l) => l.startsWith('lens:'))).toEqual([
      'lens:a',
      'lens:b',
      'lens:c',
      'lens:d',
      'lens:dissent',
    ]);
    expect(result.notes).toContain('The plan named no dissent lens; the script added one, replacing e.');
    expect(result.notes.join('\n')).toContain('A council round runs no scouts');
  });

  test('P1: Socrates numbers decisions after the existing P ids, and commit records them as --decided', async () => {
    const env = newEnv();
    cli('apply', '--draft', env.draft);
    cli(
      'council',
      '--draft',
      env.draft,
      '--round',
      '1',
      '--run',
      'seed',
      '--ceiling',
      '3',
      '--decided',
      pack(['P1', 'P2']),
    );
    const council = { convene: true, decision: 'd', reason: 'r', lenses: ['a', 'b', DISSENT_KEY].map(LENS) };
    const { calls } = await clean(
      env,
      { 'lead:plan': plan({ council, questions: [] }), ...councilFakes(['P3', 'P4']) },
      {
        councilCeiling: 3,
      },
    );
    expect(calls.find((c) => c.label === 'socrates:proposal')?.prompt).toContain('numbered P3, P4 and on');
    expect(blockOf(env.draft).councils.map((c: Out) => c.decided)).toEqual([
      ['P1', 'P2'],
      ['P3', 'P4'],
    ]);

    const again = newEnv();
    cli('apply', '--draft', again.draft);
    cli(
      'council',
      '--draft',
      again.draft,
      '--round',
      '1',
      '--run',
      'seed',
      '--ceiling',
      '3',
      '--decided',
      pack(['P1']),
    );
    const reused = await clean(
      again,
      { 'lead:plan': plan({ council, questions: [] }), ...councilFakes(['P1', 'P7']) },
      {
        councilCeiling: 3,
      },
    );
    expect(blockOf(again.draft).councils[1].decided).toEqual(['P2', 'P3']);
    expect(reused.result.notes.join('\n')).toContain('were renumbered from P2');
  });

  test('past the ceiling: no lens runs without an approval; a declined answer is no approval; convene is', async () => {
    const env = newEnv();
    cli('apply', '--draft', env.draft);
    cli('council', '--draft', env.draft, '--round', '1', '--run', 'seed', '--ceiling', '1');
    const wanting = plan({
      council: {
        convene: true,
        decision: 'helper or module?',
        reason: 'contested',
        lenses: ['a', 'b', DISSENT_KEY].map(LENS),
      },
      questions: [question(1)],
    });

    const first = await clean(env, { 'lead:plan': wanting });
    expect(first.labels).toEqual(['ledger:apply', 'lead:plan', 'ledger:commit']);
    const approval = first.result.questions[0];
    expect(approval).toMatchObject({ kind: 'council-approval', header: 'Council' });
    expect(approval.options.map((o: Out) => o.label)).toEqual(["Don't convene (Recommended)", 'Convene anyway']);
    expect(blockOf(env.draft).asked[0].options.map((o: Out) => o.value)).toEqual(['decline', 'convene']);
    expect(first.result.questions.length).toBe(2);

    const declined = await clean(
      env,
      { 'lead:plan': wanting },
      { answers: [answerTo(approval, "Don't convene (Recommended)")] },
    );
    expect(declined.labels.some((l) => l.startsWith('lens:'))).toBe(false);
    const askedAgain = declined.result.questions.find((q) => q.kind === 'council-approval');
    expect(askedAgain).toBeDefined();

    const approved = await clean(
      env,
      { 'lead:plan': wanting, ...councilFakes(['P1']) },
      {
        answers: [answerTo(askedAgain as Out, 'Convene anyway')],
      },
    );
    expect(approved.labels.filter((l) => l.startsWith('lens:'))).toEqual(['lens:a', 'lens:b', 'lens:dissent']);
    expect(blockOf(env.draft).councils[1]).toMatchObject({ approvedBy: askedAgain?.id, decided: ['P1'] });

    // The approval is spent: the next council past the ceiling asks again and sends no lens.
    const after = await clean(env, { 'lead:plan': { ...wanting, questions: [] } });
    expect(after.labels.some((l) => l.startsWith('lens:'))).toBe(false);
    const approvals = after.result.questions.filter((q) => q.kind === 'council-approval');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.id).not.toBe(askedAgain?.id);
  });

  const wantingCouncil = (questions: Out[] = []) =>
    plan({
      council: {
        convene: true,
        decision: 'helper or module?',
        reason: 'contested',
        lenses: ['a', 'b', DISSENT_KEY].map(LENS),
      },
      questions,
    });
  const silentProposal: Fakes = {
    'lens:*': lensReport,
    'socrates:elenchus': elenchusFor,
    'answer:*': lensAnswer,
    'socrates:proposal': null,
  };

  test('HIGH-1: a convening whose proposal returns nothing still counts, so the next one asks first', async () => {
    const env = newEnv();
    const first = await clean(env, { 'lead:plan': wantingCouncil([question(1)]), ...silentProposal });
    expect(first.result.state).toBe('round');
    expect(first.result.notConvened).toEqual(['socrates:proposal']);
    expect(blockOf(env.draft).councils).toEqual([{ run: 'round-1', round: 1, decided: [] }]);
    expect(first.result.questions.map((q) => q.question)).toEqual(['Decision 1: keep the helper small?']);
    expect(first.result.notes).toContain(
      'The convening is recorded with no decision, so it counts against the ceiling.',
    );

    const next = await clean(env, { 'lead:plan': wantingCouncil() });
    expect(next.labels.some((l) => l.startsWith('lens:'))).toBe(false);
    expect(next.result.questions.map((q) => q.kind)).toEqual(['decision', 'council-approval']);
    expect(next.result.questions[1]?.question).toContain(
      '1 of the 1 council(s) this brainstorm allows without asking are used (all by a convening that decided nothing).',
    );
  });

  test('HIGH-1: an approved convening spends its approval even when Socrates names nothing', async () => {
    const env = newEnv();
    cli('apply', '--draft', env.draft);
    cli('council', '--draft', env.draft, '--round', '1', '--run', 'seed', '--ceiling', '1');
    const asking = await clean(env, { 'lead:plan': wantingCouncil() });
    const approval = asking.result.questions[0] as Out;
    const paid = await clean(
      env,
      { 'lead:plan': wantingCouncil(), ...silentProposal },
      {
        answers: [answerTo(approval, 'Convene anyway')],
      },
    );
    expect(paid.labels.filter((l) => l.startsWith('lens:'))).toEqual(['lens:a', 'lens:b', 'lens:dissent']);
    expect(blockOf(env.draft).councils[1]).toMatchObject({ approvedBy: approval.id, decided: [] });
    const after = await clean(env, { 'lead:plan': wantingCouncil() });
    expect(after.labels.some((l) => l.startsWith('lens:'))).toBe(false);
    expect(after.result.questions.map((q) => q.kind)).toEqual(['council-approval']);
  });

  test('an open approval question is shown again, never asked twice', async () => {
    const env = newEnv();
    cli('apply', '--draft', env.draft);
    cli('council', '--draft', env.draft, '--round', '1', '--run', 'seed', '--ceiling', '1');
    const first = await clean(env, { 'lead:plan': wantingCouncil() });
    const approval = first.result.questions[0] as Out;
    const second = await clean(env, { 'lead:plan': wantingCouncil() });
    expect(second.labels.some((l) => l.startsWith('lens:'))).toBe(false);
    expect(second.result.questions.map((q) => q.id)).toEqual([approval.id]);
    expect(second.result.notes.join('\n')).toContain(`${approval.id} already asks the owner and is shown again`);
  });

  test('a council the ledger refuses leaves no council note in the DRAFT', async () => {
    const env = newEnv();
    cli('apply', '--draft', env.draft);
    // A recorded run id that this round's convening would reuse makes the ledger refuse the council step.
    cli('council', '--draft', env.draft, '--round', '1', '--run', 'round-2', '--ceiling', '3', '--decided', pack([]));
    const { result, labels } = await clean(
      env,
      { 'lead:plan': wantingCouncil(), ...councilFakes(['P1']) },
      {
        councilCeiling: 3,
      },
    );
    expect(labels.filter((l) => l.startsWith('lens:'))).toEqual(['lens:a', 'lens:b', 'lens:dissent']);
    expect(result.state).toBe('blocked');
    expect(result.notes.join('\n')).toContain('council run round-2 is already recorded');
    expect(readFileSync(env.draft, 'utf8')).not.toContain('## Council round-2');
    expect(blockOf(env.draft).councils).toHaveLength(1);
  });

  test('a reopened approval approves nothing: a new approval question, no lens', async () => {
    const env = newEnv();
    cli('apply', '--draft', env.draft);
    cli('council', '--draft', env.draft, '--round', '1', '--run', 'seed', '--ceiling', '1');
    const approvalQuestion = {
      kind: 'council-approval',
      question: 'Convene the council anyway?',
      header: 'Council',
      multiSelect: false,
      options: [
        { label: "Don't convene (Recommended)", description: 'no spend', value: 'decline' },
        { label: 'Convene anyway', description: 'about 1M tokens', value: 'convene' },
      ],
    };
    expect(cli('ask', '--draft', env.draft, '--round', '1', '--questions', pack([approvalQuestion])).code).toBe(0);
    const approve = [{ id: 'R1-1', question: approvalQuestion.question, answer: 'Convene anyway' }];
    expect(cli('apply', '--draft', env.draft, '--answers', pack(approve)).code).toBe(0);
    const reopenText = 'R1-1 was "Convene anyway" → hold the council after all?';
    const reopen = {
      kind: 'decision',
      question: reopenText,
      header: 'Reopen',
      multiSelect: false,
      reopens: 'R1-1',
      options: [
        { label: 'Hold it', description: '', value: 'hold' },
        { label: 'Keep it', description: '', value: 'keep' },
      ],
    };
    expect(cli('ask', '--draft', env.draft, '--round', '2', '--questions', pack([reopen])).code).toBe(0);
    const hold = [{ id: 'R2-1', question: reopenText, answer: 'Hold it' }];
    expect(cli('apply', '--draft', env.draft, '--answers', pack(hold)).code).toBe(0);
    expect(blockOf(env.draft).settled.find((e: Out) => e.id === 'R1-1').reopenedBy).toBe('R2-1');

    const { result, labels } = await clean(env, { 'lead:plan': wantingCouncil() });
    expect(labels.some((l) => l.startsWith('lens:'))).toBe(false);
    expect(result.questions.map((q) => q.kind)).toEqual(['council-approval']);
  });

  test('at the cap of 3 no council is convened and no approval question is asked', async () => {
    const env = newEnv();
    cli('apply', '--draft', env.draft);
    for (const run of ['s1', 's2', 's3'])
      cli('council', '--draft', env.draft, '--round', '1', '--run', run, '--ceiling', '3');
    const { result, labels } = await clean(env, {
      'lead:plan': plan({ council: { convene: true, decision: 'd', reason: 'r', lenses: ['a', 'b', 'c'].map(LENS) } }),
    });
    expect(labels).toEqual(['ledger:apply', 'lead:plan', 'ledger:commit']);
    expect(result.questions.map((q) => q.kind)).toEqual(['decision']);
    expect(result.notes).toContain(
      '3 councils are recorded, the cap of 3: no council is convened and no approval question is asked.',
    );
  });
});

// ---------------------------------------------------------------- crystallize, review, repair

describe('crystallize, review and the repair budget', () => {
  test('WRS 100 with nothing open: design, check, review, SHIP stamp -> done, no scouts, at most 11 agents', async () => {
    const { env, asked } = await askedOnce();
    const { result, labels } = await clean(
      env,
      {
        'lead:plan': crystallizePlan({ scouts: [{ brief: 'read', tier: 'worker', effort: 'low', why: 'x' }] }),
        'lead:design': writeDesign(),
        'review:design': reviewOf('SHIP'),
      },
      { answers: [answerTo(asked[0], 'Yes (Recommended)')] },
    );
    expect(result.state).toBe('done');
    expect(result.route).toBe('wish');
    expect(labels).toEqual([
      'ledger:apply',
      'lead:plan',
      'lead:design',
      'ledger:check',
      'review:design',
      'ledger:stamp',
    ]);
    expect(designReviewViolations(readFileSync(env.design, 'utf8'))).toEqual([]);
    expect(blockOf(env.draft).reviews).toEqual([
      expect.objectContaining({ verdict: 'SHIP', repaired: false, findings: ['C1'] }),
    ]);
    expect(result.design).toBe(env.design);

    const again = await clean(env, {});
    expect(again.result.state).toBe('done');
    expect(again.labels).toEqual(['ledger:apply']);
  });

  test('done only after a SHIP stamp: a SHIP whose digest no longer matches is blocked and recorded nowhere', async () => {
    const { env, asked } = await askedOnce();
    const { result } = await clean(
      env,
      {
        'lead:plan': crystallizePlan(),
        'lead:design': writeDesign(),
        'review:design': reviewOf('SHIP', [], 'b'.repeat(64)),
      },
      { answers: [answerTo(asked[0], 'Yes (Recommended)')] },
    );
    expect(result.state).toBe('blocked');
    expect(result.notes.join('\n')).toContain('could not be stamped');
    expect(blockOf(env.draft).reviews).toEqual([]);
    expect(designReviewViolations(readFileSync(env.design, 'utf8'))).not.toEqual([]);
  });

  test('done only after a verified stamp: a SHIP whose evidence names no reviewer does not verify -> blocked', async () => {
    const { env, asked } = await askedOnce();
    const pending = (call: Call, env2: Env) => ({ ...(reviewOf('SHIP')(call, env2) as Out), reviewer: 'PENDING' });
    const { result } = await clean(
      env,
      { 'lead:plan': crystallizePlan(), 'lead:design': writeDesign(), 'review:design': pending },
      { answers: [answerTo(asked[0], 'Yes (Recommended)')] },
    );
    expect(result.state).toBe('blocked');
    expect(result.notes.join('\n')).toContain('The SHIP stamp does not verify');
    expect(blockOf(env.draft).reviews).toEqual([]);
  });

  test('FIX-FIRST repairs once, the repaired design citing `reviewer HIGH-1` passes check-design, then a review-findings question', async () => {
    const { env, asked } = await askedOnce();
    const { result, calls, labels } = await clean(
      env,
      {
        'lead:plan': crystallizePlan(),
        'lead:design': writeDesign(),
        'review:design': [reviewOf('FIX-FIRST', [['HIGH-1', 'HIGH']]), reviewOf('FIX-FIRST', [['HIGH-2', 'HIGH']])],
        'lead:repair': repairCiting('HIGH-1'),
      },
      { answers: [answerTo(asked[0], 'Yes (Recommended)')] },
    );
    expect(result.state).toBe('round');
    expect(labels).toEqual([
      'ledger:apply',
      'lead:plan',
      'lead:design',
      'ledger:check',
      'review:design',
      'ledger:stamp',
      'lead:repair',
      'ledger:check',
      'review:design',
      'ledger:stamp',
      'ledger:commit',
    ]);
    expect(labels.length).toBeLessThanOrEqual(11);
    const checks = calls.filter((c) => c.label === 'ledger:check');
    expect(checks).toHaveLength(2);
    expect(readFileSync(env.design, 'utf8')).toContain('| reviewer HIGH-1 |');
    const second = cli('check-design', '--design', env.design, '--draft', env.draft, '--root', env.repo);
    expect(second.out.findings).toEqual([]);
    expect(blockOf(env.draft).reviews.map((r: Out) => [r.verdict, r.repaired, r.findings])).toEqual([
      ['FIX-FIRST', false, ['C1', 'HIGH-1']],
      ['FIX-FIRST', true, ['C1', 'HIGH-2']],
    ]);
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].kind).toBe('review-findings');
    expect(result.questions[0].options.map((o: Out) => o.label)).toEqual([
      'Repair again (Recommended)',
      'I settle them',
      'Stop',
    ]);
    expect(result.questions[0].question).toContain('HIGH-2 (HIGH) HIGH-2 is open');
  });

  async function fixFirstRound(budget = 2) {
    const { env, asked } = await askedOnce();
    const first = await clean(
      env,
      {
        'lead:plan': crystallizePlan(),
        'lead:design': writeDesign(),
        'review:design': [reviewOf('FIX-FIRST', [['HIGH-1', 'HIGH']]), reviewOf('FIX-FIRST', [['HIGH-2', 'HIGH']])],
        'lead:repair': repairCiting('HIGH-1'),
      },
      { answers: [answerTo(asked[0], 'Yes (Recommended)')], repairBudget: budget },
    );
    return { env, choice: first.result.questions[0] as Out };
  }

  test('a run resumed by "repair again" starts at the repair and ends done on SHIP', async () => {
    const { env, choice } = await fixFirstRound();
    const { result, labels, calls } = await clean(
      env,
      { 'lead:repair': repairCiting('HIGH-2'), 'review:design': reviewOf('SHIP') },
      { answers: [answerTo(choice, 'Repair again (Recommended)')] },
    );
    expect(labels).toEqual(['ledger:apply', 'lead:repair', 'ledger:check', 'review:design', 'ledger:stamp']);
    expect(calls.find((c) => c.label === 'lead:repair')?.prompt).toContain('HIGH-2 (HIGH) HIGH-2 is open');
    expect(result.state).toBe('done');
    expect(blockOf(env.draft).reviews.at(-1)).toMatchObject({ verdict: 'SHIP', repaired: true });
  });

  test('a FIX-FIRST after the budget is spent ends blocked', async () => {
    const { env, choice } = await fixFirstRound();
    const { result, labels } = await clean(
      env,
      { 'lead:repair': repairCiting('HIGH-2'), 'review:design': reviewOf('FIX-FIRST', [['HIGH-3', 'HIGH']]) },
      { answers: [answerTo(choice, 'Repair again (Recommended)')] },
    );
    expect(result.state).toBe('blocked');
    expect(labels).not.toContain('lead:plan');
    expect(result.notes.join('\n')).toContain('The repair budget is spent (2 of 2)');
  });

  test('the owner saying stop ends blocked with nothing dispatched after apply', async () => {
    const { env, choice } = await fixFirstRound();
    const { result, labels } = await clean(env, {}, { answers: [answerTo(choice, 'Stop')] });
    expect(result.state).toBe('blocked');
    expect(labels).toEqual(['ledger:apply']);
  });

  test('"I settle them" returns to a lead round that carries the findings', async () => {
    const { env, choice } = await fixFirstRound();
    const { result, calls } = await clean(
      env,
      { 'lead:plan': plan({ questions: [question(4)] }) },
      {
        answers: [answerTo(choice, 'I settle them')],
      },
    );
    expect(result.state).toBe('round');
    expect(calls.find((c) => c.label === 'lead:plan')?.prompt).toContain(
      'The owner chose to settle the open design-review findings',
    );
    expect(calls.find((c) => c.label === 'lead:plan')?.prompt).toContain(
      'findings not yet answered in Settled to the owner as a question; once all are, plan the design.',
    );
  });

  test('NEW-1: "I settle them" reaches the lead only until it asks the first question after it', async () => {
    const { env, choice } = await fixFirstRound();
    const settling = await clean(
      env,
      { 'lead:plan': plan({ questions: [question(4)] }) },
      {
        answers: [answerTo(choice, 'I settle them')],
      },
    );
    const asked = settling.result.questions[0] as Out;
    const SETTLE_LINE = 'The owner chose to settle the open design-review findings';
    for (const answers of [[], [answerTo(asked, 'Yes (Recommended)')]]) {
      const later = await clean(env, { 'lead:plan': plan({ questions: [] }) }, { answers });
      expect(later.labels.slice(0, 2)).toEqual(['ledger:apply', 'lead:plan']);
      expect(later.calls.find((c) => c.label === 'lead:plan')?.prompt).not.toContain(SETTLE_LINE);
    }
  });

  test('a reopened review-findings answer is not acted on', async () => {
    const { env, choice } = await fixFirstRound();
    const stop = cli('apply', '--draft', env.draft, '--answers', pack([answerTo(choice, 'Stop')]));
    expect(stop.code).toBe(0);
    const reopenText = `${choice.id} was "Stop" → go on with the brainstorm?`;
    const reopen = {
      kind: 'decision',
      question: reopenText,
      header: 'Reopen',
      multiSelect: false,
      reopens: choice.id,
      options: [
        { label: 'Go on', description: '', value: 'go-on' },
        { label: 'Stay stopped', description: '', value: 'stay' },
      ],
    };
    const asked = cli('ask', '--draft', env.draft, '--round', String(stop.out.round), '--questions', pack([reopen]));
    expect(asked.code).toBe(0);
    const goOn = [{ id: asked.out.asked[0].id, question: reopenText, answer: 'Go on' }];
    expect(cli('apply', '--draft', env.draft, '--answers', pack(goOn)).code).toBe(0);

    const { result, labels } = await clean(env, { 'lead:plan': plan({ questions: [] }) });
    expect(result.state).toBe('round');
    expect(labels.slice(0, 2)).toEqual(['ledger:apply', 'lead:plan']);
  });

  test('with a repair budget of 0 the first FIX-FIRST ends blocked with no repair', async () => {
    const { env, asked } = await askedOnce();
    const { result, labels } = await clean(
      env,
      {
        'lead:plan': crystallizePlan(),
        'lead:design': writeDesign(),
        'review:design': reviewOf('FIX-FIRST', [['HIGH-1', 'HIGH']]),
      },
      { answers: [answerTo(asked[0], 'Yes (Recommended)')], repairBudget: 0 },
    );
    expect(result.state).toBe('blocked');
    expect(labels).not.toContain('lead:repair');
  });

  test('a BLOCKED review ends blocked', async () => {
    const { env, asked } = await askedOnce();
    const { result } = await clean(
      env,
      {
        'lead:plan': crystallizePlan(),
        'lead:design': writeDesign(),
        'review:design': reviewOf('BLOCKED', [['HIGH-1', 'HIGH']]),
      },
      { answers: [answerTo(asked[0], 'Yes (Recommended)')] },
    );
    expect(result.state).toBe('blocked');
    expect(blockOf(env.draft).reviews.map((r: Out) => r.verdict)).toEqual(['BLOCKED']);
  });

  test('an uncited row becomes one owner question instead of a review', async () => {
    const { env, asked } = await askedOnce();
    const uncited = DESIGN_TEXT.replace(
      '| One helper | The smallest change | R1-1 |',
      '| One helper | The smallest change | R1-9 |',
    );
    const { result, labels } = await clean(
      env,
      { 'lead:plan': crystallizePlan(), 'lead:design': writeDesign(uncited) },
      { answers: [answerTo(asked[0], 'Yes (Recommended)')] },
    );
    expect(result.state).toBe('round');
    expect(labels).not.toContain('review:design');
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]).toMatchObject({ kind: 'decision', header: 'Traceability' });
    expect(result.questions[0].question).toContain('R1-9 is not a Settled id');
  });

  test('crystallize at WRS 100 with a question still open stays a round', async () => {
    const { env } = await askedOnce();
    const { result, labels } = await clean(env, { 'lead:plan': crystallizePlan() });
    expect(result.state).toBe('round');
    expect(labels).not.toContain('lead:design');
    expect(result.notes.join('\n')).toContain('asked to write the design at WRS 100 with 1 question(s) open');
    expect(result.questions.map((q) => q.id)).toEqual(['R1-1']);
  });

  test('a review-findings answer is spent once a review is recorded after it', async () => {
    const { env, choice } = await fixFirstRound(3);
    const again = await clean(
      env,
      { 'lead:repair': repairCiting('HIGH-2'), 'review:design': reviewOf('FIX-FIRST', [['HIGH-3', 'HIGH']]) },
      { answers: [answerTo(choice, 'Repair again (Recommended)')], repairBudget: 3 },
    );
    expect(again.result.state).toBe('round');
    expect(again.result.questions.map((q) => q.kind)).toEqual(['review-findings']);
    const later = await clean(env, { 'lead:plan': plan({ questions: [] }) }, { repairBudget: 3 });
    expect(later.labels.slice(0, 2)).toEqual(['ledger:apply', 'lead:plan']);
    expect(later.labels).not.toContain('lead:repair');
  });

  test('LOW-1: "Repair again" settled in a run that ended blocked is acted on in the next run', async () => {
    const { env, choice } = await fixFirstRound();
    const bogus = { id: 'R9-9', question: 'Never asked?', answer: 'yes' };
    const blocked = await clean(env, {}, { answers: [answerTo(choice, 'Repair again (Recommended)'), bogus] });
    expect(blocked.result.state).toBe('blocked');
    expect(blocked.labels).toEqual(['ledger:apply']);
    const next = await clean(env, { 'lead:repair': repairCiting('HIGH-2'), 'review:design': reviewOf('SHIP') });
    expect(next.labels).toEqual(['ledger:apply', 'lead:repair', 'ledger:check', 'review:design', 'ledger:stamp']);
    expect(next.result.state).toBe('done');
  });

  test('LOW-1: "Stop" settled in a run that ended blocked still stops the next run', async () => {
    const { env, choice } = await fixFirstRound();
    const bogus = { id: 'R9-9', question: 'Never asked?', answer: 'yes' };
    await clean(env, {}, { answers: [answerTo(choice, 'Stop'), bogus] });
    const next = await clean(env, {});
    expect(next.result.state).toBe('blocked');
    expect(next.labels).toEqual(['ledger:apply']);
    expect(next.result.notes.join('\n')).toContain(
      `The owner chose to stop on the open review findings (${choice.id})`,
    );
  });

  test('crystallize is refused below WRS 100, and the round goes on', async () => {
    const env = newEnv();
    const { result, labels } = await clean(env, { 'lead:plan': plan({ mode: 'crystallize' }) });
    expect(result.state).toBe('round');
    expect(labels).not.toContain('lead:design');
    expect(result.notes.join('\n')).toContain('asked to write the design at WRS 60');
  });
});

// ---------------------------------------------------------------- the closed state set

describe('the closed state set', () => {
  test('answered: the owner ends without a design', async () => {
    const end = question(1, {
      kind: 'end-without-design',
      question: 'End this brainstorm without a design?',
      header: 'End',
      options: [
        { label: 'End it (Recommended)', description: 'the spike answered it', value: 'end' },
        { label: 'Keep going', description: 'write a design', value: 'continue' },
      ],
    });
    const { env, asked } = await askedOnce([end]);
    const { result, labels } = await clean(env, {}, { answers: [answerTo(asked[0], 'End it (Recommended)')] });
    expect(result.state).toBe('answered');
    expect(labels).toEqual(['ledger:apply']);
  });

  test('failed (P2): a missing review contract ends the run naming its path, before anything is applied', async () => {
    const env = newEnv();
    const missing = join(env.repo, 'no-review', 'SKILL.md');
    const { result, labels } = await clean(
      env,
      {},
      {
        tools: { ledger: LEDGER, evidence: EVIDENCE, reviewContract: missing },
      },
    );
    expect(result.state).toBe('failed');
    expect(labels).toEqual(['ledger:apply']);
    expect(result.notes.join('\n')).toContain(missing);
    expect(existsSync(env.draft)).toBe(false);
  });

  test('failed: a spine agent that returns nothing', async () => {
    const env = newEnv();
    const { result } = await clean(env, { 'lead:plan': null });
    expect(result.state).toBe('failed');
    expect(result.notConvened).toEqual(['lead:plan']);
  });

  test('failed: intake without tool paths dispatches nothing', async () => {
    const env = newEnv();
    const { result, labels } = await clean(env, {}, { tools: {} });
    expect(result.state).toBe('failed');
    expect(labels).toEqual([]);
    expect(result.notes[0]).toContain('tools.ledger, tools.evidence, tools.reviewContract');
  });

  test('every state was reached by the scenarios above', () => {
    expect([...seenStates].sort()).toEqual([...STATES].sort());
  });
});
