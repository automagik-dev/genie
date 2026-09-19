import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectExplicitScriptPathRule } from './workflow-front-door-parity.js';

// Single-source guard: the documentation-audit stage roster and surface roster live in
// .claude/workflows/docs-audit.js. The docs skill is that workflow's front door and must
// not drift from its stages, its surface keys, or the two halves it still owns.

const ROOT = join(import.meta.dir, '..');
const JS = readFileSync(join(ROOT, '.claude', 'workflows', 'docs-audit.js'), 'utf8');
const SKILL = readFileSync(join(ROOT, 'skills', 'docs', 'SKILL.md'), 'utf8');
const STAGES = ['Locate', 'Audit', 'Consolidate', 'Render'];
const SURFACES = ['readme', 'agent-instructions', 'docs-architecture', 'runtime-dx'];

// The runtime-DX auditor is the only agent that executes anything. Its probe set is an
// allowlist, closed by exact equality: a seventh shape is as much a failure as a missing one,
// and a mutating verb named as a permitted probe is the failure this guard exists for.
const PROBE_SHAPES = [
  'bun src/genie.ts <command> --help, for any command the documented surfaces name',
  'a missing-argument error: a documented read command invoked with a required argument omitted, and nothing else omitted',
  'genie config get <unknown key>, which only reads the resolved config',
  'genie --version',
];
const FORBIDDEN_VERBS = [
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
  'doctor --fix-global-db',
];
const ENTRY = /^ {2}'(.+)',$/gm;

function capture(block: RegExp, token: RegExp, what: string): string[] {
  const found = block.exec(JS);
  if (!found) throw new Error(`docs-audit.js: ${what} not found`);
  return [...(found[1] as string).matchAll(token)].map((m) => m[1] as string);
}

function section(block: RegExp, what: string): string {
  const found = block.exec(JS);
  if (!found) throw new Error(`docs-audit.js: ${what} not found`);
  return found[1] as string;
}

function byHandSection(): string {
  const section = /## Without a workflow surface\n([\s\S]*?)\n## /.exec(SKILL);
  if (!section) throw new Error('SKILL.md: the by-hand section is missing');
  return section[1] as string;
}

describe('docs skill fronts the docs-audit workflow', () => {
  test('the skill states the explicit-script-path rule for both scopes', () => {
    expectExplicitScriptPathRule(SKILL, 'docs-audit');
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

  test('the runtime-dx probe allowlist is fail-closed', () => {
    // Both constants resolve through capture(), so a deleted block throws rather than
    // matching nothing: an absent allowlist is a failure, never a vacuous pass.
    expect(capture(/const PROBE_ALLOWLIST = \[([\s\S]*?)\n\]/, ENTRY, 'PROBE_ALLOWLIST')).toEqual(PROBE_SHAPES);
    expect(capture(/const FORBIDDEN_PROBE_VERBS = \[([\s\S]*?)\n\]/, ENTRY, 'FORBIDDEN_PROBE_VERBS')).toEqual(
      FORBIDDEN_VERBS,
    );

    // The brief and the auditPrompt branch both interpolate the allowlist and the same
    // fail-closed rule, and the open-ended phrase they replaced is gone from each.
    const runtimeBrief = section(/key: 'runtime-dx',([\s\S]*?)\n {2}\},/, 'the runtime-dx surface row');
    const probeBranch = section(
      /surface\.key === 'runtime-dx'\n([\s\S]*?)\n {6}: /,
      'the auditPrompt runtime-dx branch',
    );
    for (const region of [runtimeBrief, probeBranch]) {
      expect(region).toContain('${PROBE_ALLOWLIST_BLOCK}');
      expect(region).toContain('${PROBE_FAIL_CLOSED_RULE}');
      expect(region).not.toContain('a handful of documented failing invocations');
    }
    expect(capture(/const PROBE_FAIL_CLOSED_RULE = \[([\s\S]*?)\n\]/, /(FORBIDDEN_PROBE_VERBS)/g, 'the rule')).toEqual([
      'FORBIDDEN_PROBE_VERBS',
    ]);

    // Negative half: no mutating verb may be named as something to invoke, in the allowlist
    // or in either runtime-dx prompt region. Adding `genie task create` here must fail.
    const allowlist = section(/const PROBE_ALLOWLIST = \[([\s\S]*?)\n\]/, 'PROBE_ALLOWLIST');
    for (const verb of FORBIDDEN_VERBS) {
      const invocation = new RegExp(`genie(?:\\.ts)?\\s+${verb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      for (const region of [allowlist, runtimeBrief, probeBranch]) expect(region).not.toMatch(invocation);
    }
  });

  test('the skill keeps the contributor test and the write half the workflow never performs', () => {
    expect(SKILL).toContain('This stays here, with you, and never reaches the workflow.');
    expect(SKILL).toContain('Never document features that do not exist;');
  });
});
