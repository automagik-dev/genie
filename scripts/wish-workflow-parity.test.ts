import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Single-source guard: the wish delivery workflow lives only in .claude/workflows/wish.js.
// The wish skill is a front door that runs that workflow and must not carry a roster of its own,
// while the enums and clauses it relays must equal the script's, normalized, not merely contained.

const ROOT = join(import.meta.dir, '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim();

const script = read('.claude/workflows/wish.js');
const skill = read('skills/wish/SKILL.md');

function scriptArray(name: string): string[] {
  const match = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(script);
  if (!match) throw new Error(`wish.js: ${name} not found`);
  return [...match[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
}

function scriptPhases(): string[] {
  return [...script.matchAll(/^\s*phase\('([A-Za-z-]+)'\)/gm)].map((m) => m[1]);
}

function metaPhases(): string[] {
  const block = /phases: \[([\s\S]*?)\n {2}\],/.exec(script);
  if (!block) throw new Error('wish.js: meta.phases not found');
  return [...block[1].matchAll(/title: '([A-Za-z-]+)'/g)].map((m) => m[1]);
}

describe('wish skill fronts the wish workflow', () => {
  test('meta.name is wish, the phases the script runs are the phases meta declares', () => {
    expect(/name: 'wish',/.test(script)).toBe(true);
    expect(scriptPhases()).toEqual(metaPhases());
    expect(metaPhases()).toEqual(['Admit', 'Work', 'Gate', 'Review', 'Repair', 'Publish', 'Read-back', 'Render']);
  });

  test('the skill points at the workflow, names no client tool, and carries no roster', () => {
    expect(skill).toContain('.claude/workflows/wish.js');
    expect(skill).toContain('saved name `wish`');
    expect(skill).not.toMatch(/Claude Code|Workflow tool/);
    expect(/^\d+\. \*\*[A-Za-z]+\*\*/m.test(skill)).toBe(false);
  });

  test('every state and every route the script returns is defined in the skill, by equal enums', () => {
    const states = scriptArray('STATES');
    const routes = scriptArray('ROUTES');
    expect(states).toEqual(['merge-ready', 'pr-open', 'refused', 'blocked', 'missed']);
    expect(routes).toEqual(['proceed', 'report', 'brainstorm', 'plan']);
    const relay = skill.slice(skill.indexOf('## Relay'), skill.indexOf('## Contracts it inherits'));
    const defined = [...relay.matchAll(/^- `([a-z-]+)` — /gm)].map((m) => m[1]);
    expect(defined).toEqual(states);
    const admission = skill.slice(skill.indexOf('## Admission'), skill.indexOf('## Relay'));
    for (const route of routes) expect(admission).toContain(`\`${route}\``);
  });

  test('the size band the skill states equals the script constants', () => {
    const constant = (name: string): number => {
      const match = new RegExp(`const ${name} = (\\d+)`).exec(script);
      if (!match) throw new Error(`wish.js: ${name} not found`);
      return Number(match[1]);
    };
    const band = `maximum ${constant('MAX_FILES')} files, ${constant('MAX_INSERTIONS').toLocaleString('en-US')} insertions, ${constant('MAX_UNITS')} units; ideal ${constant('IDEAL_FILES')}, ${constant('IDEAL_INSERTIONS')}, ${constant('IDEAL_UNITS')}`;
    expect(normalize(skill)).toContain(band);
    expect(normalize(skill)).toContain(
      `\`repairBudget\` defaults to ${constant('DEFAULT_REPAIR_BUDGET')} and is capped at ${constant('MAX_REPAIR_BUDGET')}`,
    );
  });

  test('the by-hand section lists the same stages in the same order', () => {
    const byHand = normalize(skill.slice(skill.indexOf('## Without a workflow surface')));
    const order = [
      'read-only scout',
      'blind judge',
      'one executor',
      'mechanical gate',
      'reviewer that is not the executor',
      'repair rounds',
      'one publisher',
    ];
    const positions = order.map((phrase) => byHand.indexOf(phrase));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test('the three inherited clauses are verbatim in the source skill, the front door and the script', () => {
    const pins: Array<[string, string, RegExp]> = [
      [
        'skills/review/SKILL.md',
        'The reviewer is different from the author and remains read-only.',
        /NOT the agent that wrote this code/,
      ],
      ['skills/fix/SKILL.md', 'default 2 when the key is unset', /const DEFAULT_REPAIR_BUDGET = 2\b/],
      [
        'skills/work/SKILL.md',
        'a worker notification is not delivery evidence by itself.',
        /never an inferred green|checks: 'pending'|'pending'/,
      ],
    ];
    for (const [source, clause, mechanism] of pins) {
      expect(normalize(read(source))).toContain(clause);
      expect(normalize(skill)).toContain(clause);
      expect(mechanism.test(script)).toBe(true);
    }
  });

  test('the script pins no model, reads no clock, and keeps the denylist the skill describes', () => {
    expect(script).not.toMatch(/model: 'opus'|DEFAULT_MODEL/);
    expect(script).not.toMatch(/Date\.now|Math\.random/);
    for (const path of ['.github/', '.husky/', '.claude/hooks/', 'scripts/release-*', 'delivery-evidence-verify.ts']) {
      expect(script).toContain(`'${path}'`);
    }
  });

  test('quick is a one-line deprecation stub pointing at wish, and nothing pins the hour contract', () => {
    const quick = read('skills/quick/SKILL.md');
    const body = quick.slice(quick.indexOf('---', 4) + 3).trim();
    expect(body).toBe(
      'Retired: `quick` is superseded by `wish` (one task delivered); this stub is removed after three measured runs.',
    );
    for (const rel of [
      'skills/quick/SKILL.md',
      'skills/quick/agents/openai.yaml',
      'skills/genie/SKILL.md',
      'skills/genie/reference/lifecycle.md',
      'skills/README.md',
    ]) {
      expect(read(rel)).not.toMatch(/60 minutes|within one hour/);
    }
  });
});

describe('wish.js guards that must not drift', () => {
  const fenceOf = (source: string): string => {
    const match = /const INJECTION_FENCE = `([^`]*)`/.exec(source);
    if (!match) throw new Error('INJECTION_FENCE not found');
    return match[1];
  };
  const requiredList = (name: string): string => {
    const match = new RegExp(`const ${name} = obj\\((\\[[^\\]]*\\])`).exec(script);
    if (!match) throw new Error(`wish.js: ${name} not found`);
    return match[1];
  };

  test('the gate command and the failing-checks read-back mismatch stay pinned', () => {
    expect(script).toContain("const CHECK_COMMAND = 'bun run check'\n");
    expect(script).toContain(
      "if (checks === 'fail') mismatches.push(`the remote checks failed: ${pr.failingChecks.join(', ') || 'no check name was returned'}`)",
    );
  });

  test('exactly nine model spreads, no model literal, and no required/advisory check split', () => {
    expect(script.split('...(MODEL ? { model: MODEL } : {})').length - 1).toBe(9);
    expect(script).not.toMatch(/model: ['"`]/);
    expect(script).not.toContain('--required');
  });

  test('the gate and scout required lists are unchanged', () => {
    expect(requiredList('GATE_SCHEMA')).toBe("['hooksLive', 'exitCode', 'pass', 'problems', 'summaryLine']");
    expect(requiredList('SCOUT_SCHEMA')).toBe("['facts', 'plan', 'estimate', 'injectionAttempts']");
  });

  test('the injection fence equals the research-sweep copy', () => {
    expect(fenceOf(script)).toBe(fenceOf(read('.claude/workflows/research-sweep.js')));
  });

  test('the skill keeps checks pass in merge-ready and does not grow past 95 lines', () => {
    const mergeReady = skill.split('\n').find((line) => line.startsWith('- `merge-ready` — '));
    expect(mergeReady).toContain('checks pass');
    expect(skill.replace(/\n$/, '').split('\n').length).toBeLessThanOrEqual(95);
  });
});

describe('git-safety hook guards the surfaces the wish publisher is forbidden', () => {
  const hook = join(ROOT, '.claude', 'hooks', 'git-safety.sh');
  const probe = (command: string): number => {
    const result = spawnSync('bash', [hook], { input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8' });
    return result.status ?? -1;
  };

  test('blocks merge, API mutations, hook bypasses and direct refspecs to protected branches', () => {
    for (const command of [
      'gh pr merge 1 --squash',
      'gh api -X PUT repos/o/r/pulls/1/merge',
      'gh api --method POST repos/o/r/merges',
      'gh api -X PATCH repos/o/r/git/refs/heads/dev -f sha=abc',
      'HUSKY=0 git push origin wish/x',
      'git -c core.hooksPath=/dev/null push origin wish/x',
      'git config core.hooksPath /dev/null',
      'git push origin wish/x:main',
      'git push --force origin wish/x',
      'git commit --no-verify -m x',
    ]) {
      expect([command, probe(command)]).toEqual([command, 2]);
    }
  });

  test('allows the publisher allowlist and the read-only hooksPath query', () => {
    for (const command of [
      'git push -u origin wish/x',
      'gh pr create --base dev --head wish/x --title t --body b',
      'gh pr view 1 --json baseRefName,headRefOid,files',
      'gh pr checks 1',
      'gh pr list --head wish/x --json number',
      'git config --get core.hooksPath',
      'git rev-parse --git-path hooks',
      'git ls-remote origin wish/x',
      'gh api -X POST repos/o/r/pulls/1/comments/1/replies -f body=x',
      'git push --force-with-lease origin wish/x',
      'gh api repos/o/r/pulls/1',
      'git push origin HEAD:dev',
    ]) {
      expect([command, probe(command)]).toEqual([command, 0]);
    }
  });
});
