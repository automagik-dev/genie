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

const WORKFLOWS = join(import.meta.dir, '..', '.claude', 'workflows');

type Verdict = { status: 'skipped' } | { status: 'checked'; failures: string[] };

// Text of every `agent(...)` call: from the opening paren to its balanced close, skipping
// strings, template literals (with `${}` nesting) and comments.
function agentCalls(src: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const opener = /(?<![\w.$])agent\(/g;
  for (let m = opener.exec(src); m; m = opener.exec(src)) {
    const before = src.slice(Math.max(0, src.lastIndexOf('\n', m.index)), m.index);
    if (/\/\/|function\s*$|^\s*\*/.test(before)) continue;
    const start = m.index + m[0].length;
    const end = closeParen(src, start);
    if (end < 0) continue;
    out.push({ line: src.slice(0, m.index).split('\n').length, text: src.slice(start, end) });
  }
  return out;
}

function closeParen(src: string, from: number): number {
  let depth = 1;
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
    } else if (top === undefined || top === '${' || top === '{') {
      if (c === '(') depth++;
      else if (c === ')' && top === undefined && --depth === 0) return i;
    }
  }
  return -1;
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

  test('scripts without const TIERS are reported as skipped', () => {
    const skips = files.filter((f) => checkRouting(f, readFileSync(join(WORKFLOWS, f), 'utf8')).status === 'skipped');
    process.stderr.write(`workflow-routing: skipped ${skips.length}/${files.length}: ${skips.join(', ')}\n`);
    expect(files.length).toBeGreaterThan(0);
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
    const src = `${head}await agent(p, { model: GATE_MODEL || modelFor('worker') })\nawait agent(p, { model: PUBLISH_MODEL || modelFor('worker') })`;
    expect(checkRouting('wish.js', src)).toEqual({ status: 'checked', failures: [] });
    const other = checkRouting('x.js', src);
    expect(other.status === 'checked' && other.failures.length).toBe(2);
  });
  test('missing declarations fail', () => {
    const v = checkRouting('x.js', "const TIERS = { worker: 1 }\nawait agent(p, { model: modelFor('worker') })");
    expect(v.status === 'checked' && v.failures.length).toBe(2);
  });
  test('a script without TIERS is skipped', () => {
    expect(checkRouting('x.js', 'await agent(p, {})')).toEqual({ status: 'skipped' });
  });
});
