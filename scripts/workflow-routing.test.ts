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
// A routed script that still carries `...(MODEL ? { model: MODEL } : {})` fails.
//
// Each call's tier must also match its label in TIER_MAP (the routing contract's map, design D2).
// A key ending in `*` matches by prefix; a template-literal label is matched by its static prefix,
// the text before its first `${`, so `read:shard-${i}` needs a `read:shard-*` (or wider) key.

const WORKFLOWS = join(import.meta.dir, '..', '.claude', 'workflows');

const TIER_MAP: Record<string, Record<string, 'worker' | 'reasoner'>> = {
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
  'evidence-gate.js': { 'verify:*': 'worker', 'report:write': 'worker', 'synthesize:verdict': 'reasoner' },
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
function tierFor(map: Record<string, 'worker' | 'reasoner'>, label: string, template: boolean) {
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

function checkRouting(name: string, src: string): Verdict {
  if (!/const TIERS\b/.test(src)) return { status: 'skipped' };
  const failures: string[] = [];
  if (!/^const TIERS = \{ worker: \{ model: '\w[\w.-]*' \}, reasoner: \{ model: '\w[\w.-]*' \} \}$/m.test(src)) {
    failures.push(
      `${name}: \`const TIERS = { worker: { model: '...' }, reasoner: { model: '...' } }\` not declared as one line`,
    );
  }
  if (!/^const modelFor = \(tier\) => MODEL \|\| TIERS\[tier\]\.model$/m.test(src)) {
    failures.push(`${name}: \`const modelFor = (tier) => MODEL || TIERS[tier].model\` not declared`);
  }
  if (src.includes('...(MODEL ? { model: MODEL } : {})')) {
    failures.push(`${name}: still carries \`...(MODEL ? { model: MODEL } : {})\``);
  }
  for (const call of agentCalls(src)) {
    const where = `${name}:${call.line}`;
    const routed = /\bmodel:\s*modelFor\('(?:worker|reasoner)'\)/.test(call.text);
    const override =
      name === 'wish.js' && /\bmodel:\s*(?:GATE_MODEL|PUBLISH_MODEL) \|\| modelFor\('worker'\)/.test(call.text);
    if (!routed && !override) failures.push(`${where}: agent() call has no \`model: modelFor('worker'|'reasoner')\``);
    const map = TIER_MAP[name];
    if (!map) continue;
    const found = callLabel(call.text);
    const tier = /modelFor\('(worker|reasoner)'\)/.exec(call.text)?.[1];
    const expected = found ? tierFor(map, found.label, found.template) : undefined;
    if (!found) failures.push(`${where}: agent() call has no string or template label`);
    else if (!expected) failures.push(`${where}: label ${found.label} is not in the tier map`);
    else if (tier !== expected)
      failures.push(`${where}: label ${found.label} runs on ${tier}, the map says ${expected}`);
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
