import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectExplicitScriptPathRule } from './workflow-front-door-parity.js';

// Single-source guard for .claude/workflows/brainstorm.js (brainstorm-workflow WISH.md, Group 3): the
// spine the design fixes must stay in the script's text, where a refactor cannot quietly drop it. The
// behavior of each piece is proven in scripts/brainstorm-workflow-behavior.test.ts; this file pins
// that the pieces exist, with their numbers and their exact routing lines.

const ROOT = join(import.meta.dir, '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const script = read('.claude/workflows/brainstorm.js');
const lines = script.split('\n');

function constant(name: string): string {
  const match = new RegExp(`^const ${name} = (.+)$`, 'm').exec(script);
  if (!match) throw new Error(`brainstorm.js: const ${name} not found`);
  return match[1] as string;
}

// The three lines the routing contract (scripts/workflow-routing.test.ts) accepts in brainstorm.js only.
const ROUTING_LINES = [
  "const TIERS = { worker: { model: 'sonnet' }, reasoner: { model: 'opus' }, judge: { model: 'fable' } }",
  'const modelFor = (tier) => MODEL || TIERS[tier].model',
  "const scoutTier = (t) => (t === 'reasoner' ? 'reasoner' : 'worker')",
];

// The labels of the contract; a template label is its static prefix plus `*`.
const LABELS = [
  'answer:*',
  'lead:compose',
  'lead:design',
  'lead:plan',
  'lead:repair',
  'ledger:apply',
  'ledger:check',
  'ledger:commit',
  'ledger:stamp',
  'lens:*',
  'review:design',
  'scout:*',
  'socrates:elenchus',
  'socrates:proposal',
];

describe('brainstorm.js carries the spine the design fixes', () => {
  test('declares the three routing lines verbatim, each on a line of its own', () => {
    for (const line of ROUTING_LINES) expect(lines).toContain(line);
  });

  test('dispatches exactly the labels of the contract', () => {
    // An agent's options carry `label` then `phase`; an option of a question carries `label` then `description`.
    const found = [...script.matchAll(/\blabel: (?:'([^']+)'|`([^`$]+)\$\{[^`]*`),\s*phase:/g)].map(
      (m) => m[1] ?? `${m[2]}*`,
    );
    expect([...new Set(found)].sort()).toEqual(LABELS);
  });

  test('caps scouts at 11 and runs none in a council round', () => {
    expect(constant('MAX_SCOUTS')).toBe('11');
    expect(script).toContain('return scouts.slice(0, MAX_SCOUTS)');
    expect(script).toMatch(/if \(council\.convene\) \{\n[^\n]*A council round runs no scouts/);
  });

  test('bounds the lens list to 3-5 in the plan schema and always carries dissent', () => {
    expect([constant('MIN_LENSES'), constant('MAX_LENSES'), constant('DISSENT')]).toEqual(['3', '5', "'dissent'"]);
    expect(script).toContain('lenses: bounded(LENS_BRIEF_SCHEMA, MIN_LENSES, MAX_LENSES),');
    expect(script).toContain('const lensing = withDissent(normalizeLenses(wanted.lenses))');
    expect(script).toMatch(
      /function withDissent\(lenses\) \{\n {2}if \(lenses\.some\(\(lens\) => isDissent\(lens\.key\)\)\) return \{ lenses, inserted: false/,
    );
  });

  test('keeps the council cap, the batch limit, the closed state set and the fixed option values', () => {
    expect(constant('COUNCIL_CAP')).toBe('3');
    expect(constant('BATCH_LIMIT')).toBe('4');
    expect(constant('STATES')).toBe("['round', 'done', 'answered', 'blocked', 'failed']");
    expect([constant('CONVENE'), constant('END_VALUE'), constant('REPAIR_AGAIN'), constant('STOP')]).toEqual([
      "'convene'",
      "'end'",
      "'repair'",
      "'stop'",
    ]);
    // The approval is matched by its value, never by the option's position.
    expect(script).toContain("entry.kind === 'council-approval' && entry.value === CONVENE");
  });

  test('carries the per-question rule exactly as the reviewed design states it', () => {
    const design = read('scripts/fixtures/brainstorm-workflow/DESIGN.md');
    const rule = /\*"(An answer settles only the question it answers\.[^"]*)"\*/.exec(design)?.[1];
    const carried = /const PER_QUESTION_RULE =\s*'([^']+)'/.exec(script)?.[1];
    expect(rule).toBeDefined();
    expect(carried).toBe(rule);
  });

  test('the result names the agents that returned null `notConvened`, as every catalog workflow does', () => {
    expect(script).toContain('    notConvened: notConvened.slice(),');
    expect(script).toContain('`notConvened`\n// lists the label of every agent that returned null or threw');
    expect(script).not.toMatch(/\bsilent: /);
  });

  test('every phase the script enters is a meta phase, and every meta phase is entered', () => {
    const entered = [...new Set([...script.matchAll(/\bphase\('([A-Za-z-]+)'\)/g)].map((m) => m[1]))].sort();
    const declared = [...script.matchAll(/\{ title: '([A-Za-z-]+)'/g)].map((m) => m[1]).sort();
    expect(entered).toEqual(declared);
  });
});

// The /brainstorm front door (WISH.md Group 4): the skill runs this script by explicit path, hands it the
// args its intake declares, carries the same per-question rule, and the design template it ships beside
// the ledger has the exact shape `round-ledger.mjs check-design` reads.
describe('the /brainstorm front door runs brainstorm.js, and its template feeds check-design', () => {
  const skill = read('skills/brainstorm/SKILL.md');
  const template = read('skills/brainstorm/references/design-template.md');

  test('the skill names the workflow by explicit script path, never a bare name', () => {
    expectExplicitScriptPathRule(skill, 'brainstorm');
  });

  test('the skill passes the args the intake declares, with the tools resolved beside it', () => {
    const intake = /const INTAKE =\s*'Pass (\{[^']+\}) with absolute paths\.'/.exec(script)?.[1];
    expect(intake).toBeDefined();
    expect(skill).toContain(`Pass \`${intake}\` through args`);
    for (const tool of ['references/round-ledger.mjs', 'references/design-review-evidence.mjs', 'review/SKILL.md'])
      expect(skill).toContain(`\`${tool}\``);
    // The script derives the template from tools.ledger, so it must stay beside the ledger.
    expect(script).toContain("template: tools.ledger.replace(/[^/]+$/, 'design-template.md')");
    expect(skill).toContain('`references/design-template.md` beside the ledger');
  });

  test('the skill carries the per-question rule the script carries, verbatim', () => {
    const carried = /const PER_QUESTION_RULE =\s*'([^']+)'/.exec(script)?.[1];
    expect(carried).toBeDefined();
    expect(skill).toContain(`"${carried}"`);
  });

  test('a design written from the template by filling only its placeholders passes check-design', () => {
    const source = '<Settled id, council decision, reviewer finding or path>';
    const files = '<each file it changes, in backticks, marked new when created>';
    // Scope IN, Scope OUT and Decisions each carry a Source; Scope IN carries its files.
    expect(template.split(source).length - 1).toBe(3);
    expect(template).toContain(files);
    const filled = template
      .replaceAll(source, 'R1-1')
      .replaceAll(files, '`README.md`')
      .replace('YYYY-MM-DD', '2026-10-01')
      .replace(/<[A-Za-z][^<>]*>/g, 'filled');
    const dir = mkdtempSync(join(tmpdir(), 'genie-brainstorm-template-'));
    try {
      const check = (text: string) => {
        const design = join(dir, 'DESIGN.md');
        writeFileSync(design, text);
        const run = Bun.spawnSync(
          [
            'node',
            join(ROOT, 'skills', 'brainstorm', 'references', 'round-ledger.mjs'),
            'check-design',
            '--design',
            design,
            '--draft',
            join(ROOT, 'scripts', 'fixtures', 'brainstorm-workflow', 'DRAFT.md'),
            '--root',
            ROOT,
          ],
          { stdout: 'pipe', stderr: 'pipe' },
        );
        return { code: run.exitCode, findings: JSON.parse(run.stdout.toString()).findings as Array<{ kind: string }> };
      };
      expect(check(filled)).toEqual({ code: 0, findings: [] });
      // An unfilled template never reaches review: its placeholders are blocking findings.
      const raw = check(template);
      expect(raw.code).toBe(1);
      expect(raw.findings.map((finding) => finding.kind)).toContain('placeholder');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
