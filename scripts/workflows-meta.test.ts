import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

// Static half of the `.claude/workflows/` catalog contract (see .claude/workflows/README.md).
// The native Workflow tool is the runtime and cannot run in CI; this test holds what CI can hold.

const CATALOG = join(import.meta.dir, '..', '.claude', 'workflows');
const META_RE = /^export const meta = (\{[\s\S]*?\n\})\n/;
const FORBIDDEN: ReadonlyArray<[string, RegExp]> = [
  ['import', /^\s*import\b/m],
  ['require', /\brequire\s*\(/],
  ['Date.now', /\bDate\.now\b/],
  ['Math.random', /\bMath\.random\b/],
  ['argless new Date()', /\bnew\s+Date\s*\(\s*\)/],
  ['process access', /\bprocess\s*[.[]/],
  ['filesystem module', /\b(?:node:)?fs\b/],
  ['child_process or shell', /\bchild_process\b|\b(?:exec|execFile|spawn)\s*\(/],
  ['network', /\b(?:fetch|WebSocket|XMLHttpRequest)\s*[.(]/],
  ['timers', /\b(?:setTimeout|setInterval|setImmediate|queueMicrotask)\s*\(/],
  ['dynamic code', /\b(?:eval|Function)\s*\(|\.\s*constructor\b|\b__proto__\b|\bglobalThis\s*\[/],
  ['quoted absolute path', /['"`]\/(?:Users|home|opt|var|tmp)\//],
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function checkWorkflowSource(name: string, source: string): string[] {
  const problems: string[] = [];
  const metaMatch = META_RE.exec(source);
  if (!metaMatch) return [`${name}: file must start with a pure-literal \`export const meta = {...}\``];
  let meta: Record<string, unknown>;
  const literal = metaMatch[1];
  const stripped = literal.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '""');
  if (
    /[A-Za-z_$][\w$]*\s*\(|\.\.\.|\$\{|`/.test(stripped) ||
    /:\s*[A-Za-z_$][\w$]*\s*[,}\n]/.test(stripped.replace(/:\s*(?:true|false|null)\b/g, ': 0'))
  ) {
    return [`${name}: meta must be a pure literal (no identifiers, calls, spreads or interpolation)`];
  }
  try {
    meta = new Function(`return (${literal})`)() as Record<string, unknown>;
  } catch (error) {
    return [`${name}: meta literal does not evaluate: ${(error as Error).message}`];
  }
  if (meta.name !== name)
    problems.push(`${name}: meta.name is ${JSON.stringify(meta.name)}, expected ${JSON.stringify(name)}`);
  if (typeof meta.description !== 'string' || !meta.description.trim())
    problems.push(`${name}: meta.description is required`);
  const body = source.slice(metaMatch[0].length);
  const code = stripComments(body);
  for (const [label, re] of FORBIDDEN) if (re.test(code)) problems.push(`${name}: forbidden token ${label}`);
  try {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as FunctionConstructor;
    new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'workflow', 'budget', 'args', body);
  } catch (error) {
    problems.push(`${name}: body does not parse as an async function body: ${(error as Error).message}`);
  }
  return problems;
}

describe('.claude/workflows catalog contract', () => {
  const files = readdirSync(CATALOG).filter((f) => f.endsWith('.js'));

  test('catalog is not empty', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    test(`${file} satisfies the contract`, () => {
      const source = readFileSync(join(CATALOG, file), 'utf8');
      expect(checkWorkflowSource(basename(file, '.js'), source)).toEqual([]);
    });
  }

  test('rejects a mismatched meta.name', () => {
    const src = "export const meta = {\n  name: 'other',\n  description: 'x',\n}\nreturn 1\n";
    expect(checkWorkflowSource('probe', src)).toContain('probe: meta.name is "other", expected "probe"');
  });

  test('rejects forbidden tokens and non-literal meta', () => {
    const src =
      "export const meta = {\n  name: 'probe',\n  description: 'x',\n}\nconst t = Date.now()\nconst r = Math.random()\nreturn t + r\n";
    const problems = checkWorkflowSource('probe', src);
    expect(problems).toContain('probe: forbidden token Date.now');
    expect(problems).toContain('probe: forbidden token Math.random');
    expect(
      checkWorkflowSource('probe', "export const meta = {\n  name: NAME,\n  description: 'x',\n}\nreturn 1\n")[0],
    ).toMatch(/pure literal/);
    expect(
      checkWorkflowSource(
        'probe',
        "export const meta = {\n  name: 'probe',\n  description: 'x',\n}\nconst d = new Date()\nconst p = process.env\nreturn d\n",
      ),
    ).toEqual(['probe: forbidden token argless new Date()', 'probe: forbidden token process access']);
  });

  test('rejects a body that does not parse', () => {
    const src = "export const meta = {\n  name: 'probe',\n  description: 'x',\n}\nconst = 1\n";
    expect(checkWorkflowSource('probe', src).some((p) => p.includes('does not parse'))).toBe(true);
  });
});
