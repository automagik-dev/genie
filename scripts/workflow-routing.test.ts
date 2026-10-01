import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Routing guard for .claude/workflows/*.js. A script that declares `const TIERS` opts in to
// per-stage model routing, and then EVERY `agent(` call must carry a `model` derived from TIERS.
// Scripts without `const TIERS` are reported as skipped, never failed. The contract is fixed:
//
// Declarations, right after `const MODEL = ...` (exact text, one line each):
//
//     const TIERS = { worker: { model: 'sonnet' }, reasoner: { model: 'opus' } }
//     const modelFor = (tier) => MODEL || TIERS[tier].model
//
// Per-call spelling, in the options object of every `agent(` call:
//
//     model: modelFor('worker')      or      model: modelFor('reasoner')
//
// wish.js only, for the gate and publish stages (precedence gateModel/publishModel > args.model > TIERS):
//
//     model: GATE_MODEL || modelFor('worker')      model: PUBLISH_MODEL || modelFor('worker')
//
// brainstorm.js only (brainstorm-workflow DESIGN, routing contract) adds two tiers. It declares the
// three-key table in place of the two-key one, plus the scout clamp, each on one line:
//
//     const TIERS = { worker: { model: 'sonnet' }, reasoner: { model: 'opus' }, judge: { model: 'fable' } }
//     const scoutTier = (t) => (t === 'reasoner' ? 'reasoner' : 'worker')
//
// and spells, on the labels its map marks `judge` and `lead-chosen` and nowhere else:
//
//     model: modelFor('judge')                 model: modelFor(scoutTier(<the lead's tier>))
//
// The lead-chosen spelling is accepted only while the clamp line is present verbatim and nothing
// else in the script rebinds `scoutTier`, so a scout can run on worker or reasoner and never judge.
// Any other variable tier (`modelFor(s.tier)`) fails.
//
// A routed script that still carries `...(MODEL ? { model: MODEL } : {})` fails.
//
// Each call's tier must also match its label in TIER_MAP (the routing contract's map, design D2).
// A key ending in `*` matches by prefix; a template-literal label is matched by its static prefix,
// the text before its first `${`, so `read:shard-${i}` needs a `read:shard-*` (or wider) key.

const WORKFLOWS = join(import.meta.dir, '..', '.claude', 'workflows');

type Tier = 'worker' | 'reasoner' | 'judge' | 'lead-chosen';

const BRAINSTORM = 'brainstorm.js';
const TIERS_LINE = /^const TIERS = \{ worker: \{ model: 'sonnet' \}, reasoner: \{ model: 'opus' \} \}$/m;
const JUDGE_TIERS_LINE =
  /^const TIERS = \{ worker: \{ model: 'sonnet' \}, reasoner: \{ model: 'opus' \}, judge: \{ model: 'fable' \} \}$/m;
const SCOUT_TIER_LINE = "const scoutTier = (t) => (t === 'reasoner' ? 'reasoner' : 'worker')";

const TIER_MAP: Record<string, Record<string, Tier>> = {
  'brainstorm.js': {
    'ledger:*': 'worker',
    'lead:*': 'reasoner',
    'lens:*': 'reasoner',
    'answer:*': 'reasoner',
    'review:*': 'reasoner',
    'socrates:*': 'judge',
    'scout:*': 'lead-chosen',
  },
  'wish.js': {
    'admit:scout': 'worker',
    'gate:*': 'worker',
    'publish:pr': 'worker',
    'admit:judge': 'reasoner',
    'work:executor': 'reasoner',
    'review:*': 'reasoner',
    'repair:fix-*': 'reasoner',
  },
  'workfly.js': {
    'discover:*': 'worker',
    'verify:static#*': 'worker',
    'design:spec': 'reasoner',
    'draft:script': 'reasoner',
    'verify:semantics#*': 'reasoner',
    'verify:fidelity#*': 'reasoner',
    'repair#*': 'reasoner',
  },
  'evidence-gate.js': {
    'verify:files': 'worker',
    'verify:*': 'worker',
    'report:write': 'worker',
    'synthesize:verdict': 'reasoner',
  },
  'council.js': { 'lens:*': 'reasoner', synthesis: 'reasoner' },
  'pm-ledger-verify.js': { 'verify:*': 'reasoner' },
  'docs-audit.js': { 'locate:docs-home': 'worker', 'audit:*': 'worker', 'consolidate:audit-table': 'reasoner' },
  'research-sweep.js': {
    'plan:shard': 'worker',
    'read:shard-*': 'worker',
    'synthesize:merge': 'reasoner',
    'attribute:recite': 'reasoner',
  },
  'skill-audit-sweep.js': {
    'signals:catalogue': 'worker',
    'characterize:shard-*': 'worker',
    'verdict:consolidate': 'reasoner',
    'verdict:restate': 'reasoner',
  },
  'skill-intake.js': {
    'facts:roster': 'worker',
    'overlap:closest-shipped': 'worker',
    'characterize:shard-*': 'worker',
    'judge:dispositions': 'reasoner',
    'judge:restate': 'reasoner',
  },
  'observability-review.js': {
    'measure:annotations': 'worker',
    'diagnose:sessions': 'reasoner',
    'propose:rules': 'reasoner',
  },
};

// The label of one call: a quoted literal whole, or a template literal up to its first `${`.
function callLabel(text: string): { label: string; template: boolean } | null {
  const m = /\blabel:\s*(?:'([^']*)'|"([^"]*)"|`([^`$]*)(\$\{)?)/.exec(text);
  if (!m) return null;
  return { label: m[1] ?? m[2] ?? m[3] ?? '', template: m[4] !== undefined };
}

// The tier TIER_MAP assigns a label: an exact key, else the longest `*` key whose prefix the label starts with.
// A template label matches a prefix key only, since its tail is not known statically.
function tierFor(map: Record<string, Tier>, label: string, template: boolean) {
  if (!template && map[label]) return map[label];
  const keys = Object.keys(map)
    .filter((key) => key.endsWith('*') && label.startsWith(key.slice(0, -1)))
    .sort((a, b) => b.length - a.length);
  return keys[0] === undefined ? undefined : map[keys[0]];
}

type Verdict = { status: 'skipped' } | { status: 'checked'; failures: string[] };

// Walks `src` from `from`, calling `visit(i, top)` on every character that is code — outside
// strings, the literal text of template literals, and comments. `top` is the innermost open
// template `${` (or `{` inside one), undefined at the top level. A true return stops the walk
// and returns `i`; the walk returns -1 when it reaches the end.
function walkCode(src: string, from: number, visit: (i: number, top: string | undefined) => boolean): number {
  const stack: string[] = [];
  for (let i = from; i < src.length; i++) {
    const c = src[i] as string;
    const top = stack[stack.length - 1];
    if (top === "'" || top === '"') {
      if (c === '\\') i++;
      else if (c === top) stack.pop();
    } else if (top === '`') {
      if (c === '\\') i++;
      else if (c === '`') stack.pop();
      else if (c === '$' && src[i + 1] === '{') {
        stack.push('${');
        i++;
      }
    } else if (top === '/*') {
      if (c === '*' && src[i + 1] === '/') {
        stack.pop();
        i++;
      }
    } else if (c === '/' && src[i + 1] === '*') {
      stack.push('/*');
      i++;
    } else if (c === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i) < 0 ? src.length : src.indexOf('\n', i);
    } else if (c === "'" || c === '"' || c === '`') {
      stack.push(c);
    } else if (c === '{' && top === '${') {
      stack.push('{');
    } else if (c === '}' && (top === '${' || top === '{')) {
      stack.pop();
    } else if (visit(i, top)) {
      return i;
    }
  }
  return -1;
}

// Text of every `agent(...)` call in code: from the opening paren to its balanced close. An
// `agent(` inside a string, a template literal's text or a comment is prose, never a call.
function agentCalls(src: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  walkCode(src, 0, (i) => {
    if (!src.startsWith('agent(', i) || /[\w.$]/.test(src[i - 1] ?? '')) return false;
    const before = src.slice(Math.max(0, src.lastIndexOf('\n', i)), i);
    if (/function\s*$/.test(before)) return false;
    const start = i + 'agent('.length;
    const end = closeParen(src, start);
    if (end >= 0) out.push({ line: src.slice(0, i).split('\n').length, text: src.slice(start, end) });
    return false;
  });
  return out;
}

function closeParen(src: string, from: number): number {
  let depth = 1;
  return walkCode(src, from, (i, top) => {
    if (src[i] === '(') depth++;
    return src[i] === ')' && top === undefined && --depth === 0;
  });
}

// `src` with every string, template-literal text and comment blanked to spaces (newlines and
// offsets kept), so a regex over it sees code only.
function codeOnly(src: string): string {
  const out = Array.from(src, (c) => (c === '\n' ? '\n' : ' '));
  walkCode(src, 0, (i) => {
    out[i] = src[i] as string;
    return false;
  });
  return out.join('');
}

// How a script binds the scout clamp that `modelFor(scoutTier(…))` relies on:
// - `ok`: an exact SCOUT_TIER_LINE is a code line (any occurrence, not only the first) and every
//   other code mention of `scoutTier` is a call;
// - `binding`: no such line, or a common shadowing form binds the name again;
// - `value`: the clamp is passed or stored as a value (`.map(scoutTier)`) instead of called.
type Clamp = 'ok' | 'binding' | 'value';

function clampState(src: string): Clamp {
  const declarations = new Set<number>();
  let offset = 0;
  for (const line of src.split('\n')) {
    if (line === SCOUT_TIER_LINE) declarations.add(offset + 'const '.length);
    offset += line.length + 1;
  }
  const code = codeOnly(src);
  let declared = false;
  let value = false;
  for (const m of code.matchAll(/(?<![\w$.])scoutTier(?![\w$])/g)) {
    const before = code.slice(Math.max(0, m.index - 200), m.index);
    const after = code.slice(m.index + 'scoutTier'.length);
    if (declarations.has(m.index)) declared = true;
    else if (/^\s*\(/.test(after) && !/\bfunction\s*\*?\s*$/.test(before)) continue;
    else if (rebinds(before, after)) return 'binding';
    else value = true;
  }
  if (!declared) return 'binding';
  return value ? 'value' : 'ok';
}

// The common shadowing forms for a mention that is not a call: a declaration, function or class of
// that name, a destructuring declaration, an assignment, a bare arrow parameter, or a parameter list
// (the enclosing parentheses close onto `=>` or `{`). A heuristic over code, not a parser.
function rebinds(before: string, after: string): boolean {
  if (/\b(?:function\s*\*?|const|let|var|class)\s*$/.test(before)) return true;
  if (/\b(?:const|let|var)\s*[{[][^;=]*$/.test(before)) return true;
  if (/^\s*(?:=(?![=>])|=>)/.test(after)) return true;
  let depth = 0;
  for (let i = 0; i < after.length; i++) {
    if (after[i] === '(') depth++;
    else if (after[i] === ')' && depth-- === 0) return /^\s*(?:=>|\{)/.test(after.slice(i + 1));
  }
  return false;
}

// The tier one call's `model:` option routes on, and whether it came through wish.js's stage override.
// `modelFor(scoutTier(…))` is the lead-chosen tier, whatever expression the lead's tier arrives in.
function modelSpelling(text: string): { tier: Tier; override: boolean } | null {
  const m =
    /\bmodel:\s*((?:GATE_MODEL|PUBLISH_MODEL) \|\| )?modelFor\((?:'(worker|reasoner|judge)'|(scoutTier\((?:[^()]|\([^()]*\))*\)))\)/.exec(
      text,
    );
  if (!m) return null;
  return { tier: m[3] ? 'lead-chosen' : (m[2] as Tier), override: m[1] !== undefined };
}

function spellingProblem(name: string, spelled: ReturnType<typeof modelSpelling>, clamp: Clamp): string | null {
  const none =
    name === BRAINSTORM
      ? "agent() call has no `model: modelFor('worker'|'reasoner'|'judge')` or `model: modelFor(scoutTier(…))`"
      : "agent() call has no `model: modelFor('worker'|'reasoner')`";
  if (!spelled) return none;
  if (spelled.override) return name === 'wish.js' && spelled.tier === 'worker' ? null : none;
  if (spelled.tier === 'judge' && name !== BRAINSTORM) return "`modelFor('judge')` is brainstorm.js only";
  if (spelled.tier !== 'lead-chosen') return null;
  if (name !== BRAINSTORM) return '`modelFor(scoutTier(…))` is brainstorm.js only';
  if (clamp === 'value') return '`scoutTier` is used as a value; call the clamp in the form `modelFor(scoutTier(x))`';
  if (clamp === 'binding')
    return `\`modelFor(scoutTier(…))\` needs \`${SCOUT_TIER_LINE}\` as the one binding of scoutTier`;
  return null;
}

function tiersProblem(name: string, src: string): string | null {
  if (name === BRAINSTORM) {
    return JUDGE_TIERS_LINE.test(src)
      ? null
      : "`const TIERS = { worker: { model: 'sonnet' }, reasoner: { model: 'opus' }, judge: { model: 'fable' } }` not declared as one line";
  }
  if (/^const TIERS = .*\bjudge:/m.test(src)) return 'the three-key TIERS with a `judge` tier is brainstorm.js only';
  return TIERS_LINE.test(src)
    ? null
    : "`const TIERS = { worker: { model: 'sonnet' }, reasoner: { model: 'opus' } }` not declared as one line";
}

function checkRouting(name: string, src: string): Verdict {
  if (!/const TIERS\b/.test(src)) return { status: 'skipped' };
  const failures: string[] = [];
  const tiers = tiersProblem(name, src);
  if (tiers) failures.push(`${name}: ${tiers}`);
  if (!/^const modelFor = \(tier\) => MODEL \|\| TIERS\[tier\]\.model$/m.test(src)) {
    failures.push(`${name}: \`const modelFor = (tier) => MODEL || TIERS[tier].model\` not declared`);
  }
  if (src.includes('...(MODEL ? { model: MODEL } : {})')) {
    failures.push(`${name}: still carries \`...(MODEL ? { model: MODEL } : {})\``);
  }
  const clamp: Clamp = name === BRAINSTORM ? clampState(src) : 'binding';
  for (const call of agentCalls(src)) {
    const where = `${name}:${call.line}`;
    const spelled = modelSpelling(call.text);
    const problem = spellingProblem(name, spelled, clamp);
    if (problem) failures.push(`${where}: ${problem}`);
    const map = TIER_MAP[name];
    if (!map) continue;
    const found = callLabel(call.text);
    const expected = found ? tierFor(map, found.label, found.template) : undefined;
    if (!found) failures.push(`${where}: agent() call has no string or template label`);
    else if (!expected) failures.push(`${where}: label ${found.label} is not in the tier map`);
    else if (spelled && !problem && spelled.tier !== expected)
      failures.push(`${where}: label ${found.label} runs on ${spelled.tier}, the map says ${expected}`);
  }
  return { status: 'checked', failures };
}

describe('workflow model routing', () => {
  const files = readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith('.js'))
    .sort();
  const skipped: string[] = [];

  for (const file of files) {
    test(`${file} routes every agent() through TIERS (or is skipped)`, () => {
      const verdict = checkRouting(file, readFileSync(join(WORKFLOWS, file), 'utf8'));
      if (verdict.status === 'skipped') {
        skipped.push(file);
        return;
      }
      expect(verdict.failures).toEqual([]);
    });
  }

  test('every catalog script declares TIERS — none is skipped', () => {
    const skips = files.filter((f) => checkRouting(f, readFileSync(join(WORKFLOWS, f), 'utf8')).status === 'skipped');
    expect(files.length).toBeGreaterThan(0);
    expect(skips).toEqual([]);
  });
});

describe('the scanner itself', () => {
  const head =
    "const TIERS = { worker: { model: 'sonnet' }, reasoner: { model: 'opus' } }\nconst modelFor = (tier) => MODEL || TIERS[tier].model\n";
  test('accepts routed calls, including a nested template prompt', () => {
    const src = `${head}await agent(\`x \${f(1)}\`, { label: 'a', model: modelFor('worker') })\nawait agent(p, { model: modelFor('reasoner') })`;
    expect(checkRouting('x.js', src)).toEqual({ status: 'checked', failures: [] });
  });
  test('fails a call with no model, an unknown tier, or a bare literal', () => {
    for (const opts of ["{ label: 'a' }", "{ model: modelFor('nope') }", "{ model: 'sonnet' }"]) {
      const v = checkRouting('x.js', `${head}await agent(p, ${opts})`);
      expect(v.status === 'checked' && v.failures.length).toBe(1);
    }
  });
  test('fails a routed script that keeps the legacy MODEL spread', () => {
    const v = checkRouting(
      'x.js',
      `${head}await agent(p, { model: modelFor('worker'), ...(MODEL ? { model: MODEL } : {}) })`,
    );
    expect(v.status === 'checked' && v.failures.length).toBe(1);
  });
  test('GATE_MODEL and PUBLISH_MODEL overrides are accepted in wish.js only', () => {
    const src = `${head}await agent(p, { label: 'gate:check', model: GATE_MODEL || modelFor('worker') })\nawait agent(p, { label: 'publish:pr', model: PUBLISH_MODEL || modelFor('worker') })`;
    expect(checkRouting('wish.js', src)).toEqual({ status: 'checked', failures: [] });
    const other = checkRouting('x.js', src);
    expect(other.status === 'checked' && other.failures.length).toBe(2);
  });
  test("an `agent(` inside a string, a template's text or a comment is prose, not a call", () => {
    const src = `${head}log(\`\${n} agent(s) silent\`)\nlog('one agent(s)')\n// agent(x)\nawait agent(p, { model: modelFor('worker') })`;
    expect(checkRouting('x.js', src)).toEqual({ status: 'checked', failures: [] });
  });
  test('a label must run on the tier the map gives it; template labels match by static prefix', () => {
    const ok = `${head}await agent(p, { label: \`read:shard-\${i}\`, model: modelFor('worker') })\nawait agent(p, { label: 'synthesize:merge', model: modelFor('reasoner') })`;
    expect(checkRouting('research-sweep.js', ok)).toEqual({ status: 'checked', failures: [] });
    for (const opts of [
      "{ label: 'synthesize:merge', model: modelFor('worker') }",
      "{ label: `read:shard-${i}`, model: modelFor('reasoner') }",
      "{ label: 'read:unknown', model: modelFor('worker') }",
      "{ label: `read:${i}`, model: modelFor('worker') }",
      "{ model: modelFor('worker') }",
    ]) {
      const v = checkRouting('research-sweep.js', `${head}await agent(p, ${opts})`);
      expect({ opts, n: v.status === 'checked' && v.failures.length }).toEqual({ opts, n: 1 });
    }
  });
  test('missing declarations fail', () => {
    const v = checkRouting('x.js', "const TIERS = { worker: 1 }\nawait agent(p, { model: modelFor('worker') })");
    expect(v.status === 'checked' && v.failures.length).toBe(2);
  });
  test('a script without TIERS is skipped', () => {
    expect(checkRouting('x.js', 'await agent(p, {})')).toEqual({ status: 'skipped' });
  });
});

// brainstorm.js does not exist until the workflow lands, so the contract it must meet is proven here
// on an in-memory script that declares the three lines verbatim and calls every label of the interface.
describe('the scanner on brainstorm.js: the judge and lead-chosen tiers', () => {
  const TIERS3 =
    "const TIERS = { worker: { model: 'sonnet' }, reasoner: { model: 'opus' }, judge: { model: 'fable' } }";
  const MODEL_FOR = 'const modelFor = (tier) => MODEL || TIERS[tier].model';
  const SCOUT = '() => agent(s.brief, { label: `scout:${i}`, model: modelFor(scoutTier(s.tier)), effort: s.effort })';
  const LABELS: [string, string][] = [
    ["'ledger:apply'", "modelFor('worker')"],
    ["'ledger:commit'", "modelFor('worker')"],
    ["'ledger:check'", "modelFor('worker')"],
    ["'ledger:stamp'", "modelFor('worker')"],
    ["'lead:plan'", "modelFor('reasoner')"],
    ["'lead:compose'", "modelFor('reasoner')"],
    ["'lead:design'", "modelFor('reasoner')"],
    ["'lead:repair'", "modelFor('reasoner')"],
    ['`lens:${key}`', "modelFor('reasoner')"],
    ['`answer:${key}`', "modelFor('reasoner')"],
    ["'socrates:elenchus'", "modelFor('judge')"],
    ["'socrates:proposal'", "modelFor('judge')"],
    ["'review:design'", "modelFor('reasoner')"],
  ];
  const call = (label: string, model: string) => `await agent(p, { label: ${label}, model: ${model} })`;
  const script = (body: string[], head = [TIERS3, MODEL_FOR, SCOUT_TIER_LINE]) =>
    ['const MODEL = args.model', ...head, ...body].join('\n');
  const scouts = `await parallel(plan.scouts.map((s, i) => ${SCOUT}))`;
  const failuresOf = (name: string, src: string) => {
    const v = checkRouting(name, src);
    return v.status === 'checked' ? v.failures : ['skipped'];
  };

  test('accepts the three declarations and every label on its mapped tier', () => {
    expect(failuresOf(BRAINSTORM, script([...LABELS.map(([l, m]) => call(l, m)), scouts]))).toEqual([]);
  });

  test('the clamp yields worker or reasoner whatever the lead writes, and a pinned model still wins', () => {
    const route = new Function('MODEL', `${TIERS3}\n${MODEL_FOR}\n${SCOUT_TIER_LINE}\nreturn [modelFor, scoutTier]`);
    const [modelFor, scoutTier] = route('') as [(t: string) => string, (t: unknown) => string];
    const scoutModels = ['reasoner', 'worker', 'judge', 'lead-chosen', 'opus', 'fable', '', undefined, null].map((t) =>
      modelFor(scoutTier(t)),
    );
    expect(scoutModels).toEqual(['opus', ...Array(8).fill('sonnet')]);
    expect(modelFor('judge')).toBe('fable');
    const [pinned] = route('haiku') as [(t: string) => string];
    expect(['worker', 'reasoner', 'judge'].map(pinned)).toEqual(['haiku', 'haiku', 'haiku']);
  });

  test('rejects an unclamped variable tier', () => {
    for (const model of ['modelFor(s.tier)', 'modelFor(tier)', "modelFor(s.tier || 'worker')", 'TIERS[s.tier].model']) {
      const src = script([call('`scout:${i}`', model)]);
      expect({ model, failures: failuresOf(BRAINSTORM, src) }).toEqual({
        model,
        failures: [
          `${BRAINSTORM}:5: agent() call has no \`model: modelFor('worker'|'reasoner'|'judge')\` or \`model: modelFor(scoutTier(…))\``,
        ],
      });
    }
  });

  test("rejects `modelFor('judge')` on every label that is not socrates:", () => {
    for (const [label, tierModel] of LABELS.filter(([l]) => !l.includes('socrates:'))) {
      const failures = failuresOf(BRAINSTORM, script([call(label, "modelFor('judge')")]));
      const expected = tierModel === "modelFor('worker')" ? 'worker' : 'reasoner';
      expect(failures).toEqual([
        `${BRAINSTORM}:5: label ${label.slice(1, -1).split('$')[0]} runs on judge, the map says ${expected}`,
      ]);
    }
    const scout = failuresOf(BRAINSTORM, script([call('`scout:${i}`', "modelFor('judge')")]));
    expect(scout).toEqual([`${BRAINSTORM}:5: label scout: runs on judge, the map says lead-chosen`]);
  });

  test('rejects the judge tier and the scout clamp in any other script, on any label', () => {
    const twoKey = "const TIERS = { worker: { model: 'sonnet' }, reasoner: { model: 'opus' } }";
    for (const name of ['council.js', 'wish.js', 'x.js']) {
      const judgeCall = failuresOf(
        name,
        script([call("'socrates:elenchus'", "modelFor('judge')")], [twoKey, MODEL_FOR]),
      );
      expect(judgeCall).toContain(`${name}:4: \`modelFor('judge')\` is brainstorm.js only`);
      const clampCall = failuresOf(name, script([call('`scout:${i}`', 'modelFor(scoutTier(s.tier))')]));
      expect(clampCall).toContain(`${name}: the three-key TIERS with a \`judge\` tier is brainstorm.js only`);
      expect(clampCall).toContain(`${name}:5: \`modelFor(scoutTier(…))\` is brainstorm.js only`);
    }
    // The real council.js, given the three-key table, fails on the table alone.
    const council = readFileSync(join(WORKFLOWS, 'council.js'), 'utf8').replace(/^const TIERS = .*$/m, TIERS3);
    expect(failuresOf('council.js', council)).toEqual([
      'council.js: the three-key TIERS with a `judge` tier is brainstorm.js only',
    ]);
    // And brainstorm.js, given the two-key table, fails on the table too.
    expect(failuresOf(BRAINSTORM, script([call("'lead:plan'", "modelFor('reasoner')")], [twoKey, MODEL_FOR]))).toEqual([
      `${BRAINSTORM}: \`${TIERS3}\` not declared as one line`,
    ]);
  });

  test('the TIERS tables are pinned to sonnet, opus and fable', () => {
    const swapped = TIERS3.replace("'fable'", "'opus'");
    expect(failuresOf(BRAINSTORM, script([call("'lead:plan'", "modelFor('reasoner')")], [swapped, MODEL_FOR]))).toEqual(
      [`${BRAINSTORM}: \`${TIERS3}\` not declared as one line`],
    );
    expect(failuresOf('x.js', script([], [swapped, MODEL_FOR]))).toEqual([
      'x.js: the three-key TIERS with a `judge` tier is brainstorm.js only',
    ]);
    const haiku = "const TIERS = { worker: { model: 'haiku' }, reasoner: { model: 'opus' } }";
    expect(failuresOf('x.js', script([], [haiku, MODEL_FOR]))).toEqual([
      "x.js: `const TIERS = { worker: { model: 'sonnet' }, reasoner: { model: 'opus' } }` not declared as one line",
    ]);
  });

  test('rejects a scout on a fixed tier and Socrates on reasoner or worker', () => {
    for (const tier of ['worker', 'reasoner']) {
      expect(failuresOf(BRAINSTORM, script([call('`scout:${i}`', `modelFor('${tier}')`)]))).toEqual([
        `${BRAINSTORM}:5: label scout: runs on ${tier}, the map says lead-chosen`,
      ]);
      expect(failuresOf(BRAINSTORM, script([call("'socrates:proposal'", `modelFor('${tier}')`)]))).toEqual([
        `${BRAINSTORM}:5: label socrates:proposal runs on ${tier}, the map says judge`,
      ]);
    }
  });

  test('rejects `modelFor(scoutTier(…))` on every label not mapped lead-chosen', () => {
    for (const [label, tierModel] of LABELS) {
      const failures = failuresOf(BRAINSTORM, script([call(label, 'modelFor(scoutTier(s.tier))')]));
      const expected = { "modelFor('worker')": 'worker', "modelFor('reasoner')": 'reasoner' }[tierModel] ?? 'judge';
      const shown = label.slice(1, -1).split('$')[0];
      expect(failures).toEqual([`${BRAINSTORM}:5: label ${shown} runs on lead-chosen, the map says ${expected}`]);
    }
  });

  // The failure a scout call gets when the script around it carries `lines`.
  const scoutFailures = (lines: string[]) => {
    const src = script([...lines, scouts], [TIERS3, MODEL_FOR]);
    const at = src.split('\n').findIndex((l) => l.includes('plan.scouts.map')) + 1;
    return { at, failures: failuresOf(BRAINSTORM, src) };
  };

  test('rejects a scout call when the scoutTier line is missing or altered, or a common form shadows it', () => {
    const clamps: Record<string, string[]> = {
      missing: [],
      'identity clamp': ['const scoutTier = (t) => t'],
      'judge clamp': ["const scoutTier = (t) => (t === 'judge' ? 'judge' : 'worker')"],
      'double quotes': ['const scoutTier = (t) => (t === "reasoner" ? "reasoner" : "worker")'],
      'let binding': ["let scoutTier = (t) => (t === 'reasoner' ? 'reasoner' : 'worker')"],
      'trailing space': [`${SCOUT_TIER_LINE} `],
      'function parameter': [SCOUT_TIER_LINE, 'function pick(scoutTier) { return scoutTier }'],
      'arrow parameter': [SCOUT_TIER_LINE, 'const pick = (s, scoutTier) => scoutTier(s)'],
      'bare arrow parameter': [SCOUT_TIER_LINE, 'const pick = scoutTier => scoutTier(1)'],
      destructuring: [SCOUT_TIER_LINE, 'if (x) { const { scoutTier } = helpers }'],
      'catch parameter': [SCOUT_TIER_LINE, 'try { f() } catch (scoutTier) { g() }'],
      'redeclared in a block': [SCOUT_TIER_LINE, 'if (x) { function scoutTier(t) { return t } }'],
      'verbatim only in a template': ['const note = `', SCOUT_TIER_LINE, '`'],
      'verbatim only in a comment': [`/*\n${SCOUT_TIER_LINE}\n*/`],
    };
    for (const [why, lines] of Object.entries(clamps)) {
      const { at, failures } = scoutFailures(lines);
      expect({ why, failures }).toEqual({
        why,
        failures: [
          `${BRAINSTORM}:${at}: \`modelFor(scoutTier(…))\` needs \`${SCOUT_TIER_LINE}\` as the one binding of scoutTier`,
        ],
      });
    }
  });

  test('rejects scoutTier used as a value, with a message naming the call form', () => {
    const uses: Record<string, string> = {
      'map callback': 'const tiers = plan.tiers.map(scoutTier)',
      alias: 'const pick = scoutTier',
      'object value': 'const tools = { tier: scoutTier }',
    };
    for (const [why, use] of Object.entries(uses)) {
      const { at, failures } = scoutFailures([SCOUT_TIER_LINE, use]);
      expect({ why, failures }).toEqual({
        why,
        failures: [
          `${BRAINSTORM}:${at}: \`scoutTier\` is used as a value; call the clamp in the form \`modelFor(scoutTier(x))\``,
        ],
      });
    }
  });

  test('the clamp tolerates calls and comments that name scoutTier, and a verbatim line after a quoted one', () => {
    const extra = [
      '// scoutTier clamps the tier the lead chose',
      'log(`scout ${i} runs on ${scoutTier(s.tier)}`)',
      'const effective = plan.scouts.map((s) => scoutTier(s.tier))',
      "if (scoutTier(s.tier) === 'reasoner') { log('reasoner scout') }",
    ];
    expect(failuresOf(BRAINSTORM, script([...extra, scouts]))).toEqual([]);
    expect(scoutFailures(['const note = `', SCOUT_TIER_LINE, '`', SCOUT_TIER_LINE]).failures).toEqual([]);
  });
});
