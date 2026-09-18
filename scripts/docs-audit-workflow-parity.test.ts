import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Single-source guard: the documentation-audit stage roster and surface roster live in
// .claude/workflows/docs-audit.js. The docs skill is that workflow's front door and must
// not drift from its stages, its surface keys, or the two halves it still owns.

const ROOT = join(import.meta.dir, '..');
const JS = readFileSync(join(ROOT, '.claude', 'workflows', 'docs-audit.js'), 'utf8');
const SKILL = readFileSync(join(ROOT, 'skills', 'docs', 'SKILL.md'), 'utf8');
const STAGES = ['Locate', 'Audit', 'Consolidate', 'Render'];
const SURFACES = ['readme', 'agent-instructions', 'docs-architecture', 'runtime-dx'];
// Verbs that change the operator's own host: none of them may ever read as a permitted probe.
const MUTATING_VERBS = [
  'install',
  'update',
  'uninstall',
  'init',
  'setup',
  'task create',
  'task move',
  'task done',
  'task delete',
  'task import',
  'task sync',
  'omni serve',
  'omni handshake',
  'doctor --fix-global-db',
];

function capture(block: RegExp, token: RegExp, what: string): string[] {
  const found = block.exec(JS);
  if (!found) throw new Error(`docs-audit.js: ${what} not found`);
  return [...(found[1] as string).matchAll(token)].map((m) => m[1] as string);
}

function byHandSection(): string {
  const section = /## Without a workflow surface\n([\s\S]*?)\n## /.exec(SKILL);
  if (!section) throw new Error('SKILL.md: the by-hand section is missing');
  return section[1] as string;
}

describe('docs skill fronts the docs-audit workflow', () => {
  test('the skill names the script path and the saved name', () => {
    expect(SKILL).toContain('.claude/workflows/docs-audit.js');
    expect(SKILL).toContain('saved name `docs-audit`');
  });

  test('meta.phases, the phase() calls and the by-hand stages are one roster', () => {
    expect(capture(/phases: \[([\s\S]*?)\n {2}\],/, /title: '([A-Za-z]+)'/g, 'meta.phases')).toEqual(STAGES);
    expect([...new Set([...JS.matchAll(/\bphase\('([A-Za-z]+)'\)/g)].map((m) => m[1] as string))]).toEqual(STAGES);
    const byHand = byHandSection();
    for (const stage of STAGES) expect(byHand).toContain(`**${stage}**`);
  });

  test('the surface roster is one closed set', () => {
    // The skill's Surfaces table carries the shard key in its own column; the script's
    // SURFACES rows are the roster the fan-out shards by.
    const fromSkill = [...SKILL.matchAll(/^\|[^|\n]+\| `([a-z-]+)` \|/gm)].map((m) => m[1] as string);
    expect(fromSkill).toEqual(SURFACES);
    expect(capture(/const SURFACES = \[([\s\S]*?)\n\]/, /^ {4}key: '([a-z-]+)',$/gm, 'SURFACES')).toEqual(SURFACES);
  });

  test('the skill keeps the contributor test and the write half the workflow never performs', () => {
    expect(SKILL).toContain('This stays here, with you, and never reaches the workflow.');
    expect(SKILL).toContain('Never document features that do not exist;');
  });

  // The runtime-DX auditor is the only agent the workflow lets execute anything. "Read-only"
  // alone never bounded it, so the brief carries a fail-closed allowlist of probe shapes; this
  // pin is what stops the allowlist being dropped, softened into examples, or widened with a
  // verb that mutates the operator's own host.
  test('the runtime-DX brief carries a fail-closed probe allowlist and names no mutating verb', () => {
    const declared = /const PROBE_ALLOWLIST = \[([\s\S]*?)\n\]\.join\('\\n'\)/.exec(JS);
    if (!declared) throw new Error('docs-audit.js: the PROBE_ALLOWLIST declaration is missing');
    const allowlist = declared[1] as string;

    // Every permitted shape, by name.
    // Item 1 lives in a template literal, so its backticks are escaped in the source.
    expect(allowlist).toContain('\\`--help\\` on any command or subcommand');
    expect(allowlist).toContain('A documented missing-argument error');
    expect(allowlist).toContain('`genie mcp`');
    expect(allowlist).toContain('`genie ui-bridge`');
    expect(allowlist).toContain('`genie config get <key>` with an unknown or unrecognized key');
    expect(allowlist).toContain('`genie --version`');

    // Fail-closed in prose: the enumeration closes, it does not illustrate.
    expect(allowlist).toContain('Every other genie invocation is FORBIDDEN');
    expect(allowlist).toContain('This is an allowlist, not a set of examples');

    // Permitted shapes above the closing sentence; forbidden verbs only below it.
    const closed = allowlist.indexOf('Every other genie invocation is FORBIDDEN');
    const permitted = allowlist.slice(0, closed);
    const forbidden = allowlist.slice(closed);
    for (const verb of MUTATING_VERBS) {
      expect(forbidden).toContain(`\`genie ${verb}\``);
      expect(permitted).not.toMatch(new RegExp(`\\b${verb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
    }

    // Both prompt sites that instruct the runtime-DX auditor to probe carry it.
    const surface = /key: 'runtime-dx',([\s\S]*?)\n {2}\},/.exec(JS);
    if (!surface) throw new Error('docs-audit.js: the runtime-dx SURFACES entry is missing');
    expect(surface[1] as string).toContain('PROBE_ALLOWLIST');
    const clause = /surface\.key === 'runtime-dx'\n([\s\S]*?)\n {6}: '/.exec(JS);
    if (!clause) throw new Error('docs-audit.js: the runtime-dx probe clause in auditPrompt() is missing');
    expect(clause[1] as string).toContain('${PROBE_ALLOWLIST}');
  });
});
