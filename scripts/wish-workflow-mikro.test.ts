/**
 * Pins the mikro offload inside the wish workflow: the scout and reviewer briefs
 * name the runner, the `mikro` report key is optional on both schemas (so the
 * required-list pins in wish-workflow-parity.test.ts stay untouched), the three
 * microagents exist with the five-rules contract and the pinned model, and every
 * agent has a fixture set the bench can score.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const script = read('.claude/workflows/wish.js');
const AGENTS = ['issue-triage', 'wish-context', 'review-prep'];

describe('wish.js mikro offload', () => {
  test('constants name the runner and the two agents the stages call', () => {
    // The runner is the installed genie on PATH, never a path inside one checkout:
    // `bun scripts/mikro/call.ts` only ever existed in this repository, so every other
    // repository fell silently to the by-hand path and the offload never ran.
    expect(script).toContain("const MIKRO_CALL = 'genie mikro call'");
    expect(script).not.toContain('bun scripts/mikro/call.ts');
    expect(script).toContain("const MIKRO_SCOUT_AGENT = 'wish-context'");
    expect(script).toContain("const MIKRO_REVIEW_AGENT = 'review-prep'");
  });
  test('the scout offload asks for the deterministic facts file; the review offload does not (opt-in per agent)', () => {
    // #2956 measured wish-context recall 0.87 -> 0.96 with `--facts auto` and issue-triage WORSE with it, so the
    // flag is per agent: the scout line carries it, the review line stays bare until review-prep is measured.
    expect(script).toContain(
      '${MIKRO_CALL} ${MIKRO_SCOUT_AGENT} --dir <repository root> --facts auto --trace ${job.slug}',
    );
    expect(script).not.toMatch(/MIKRO_REVIEW_AGENT[^\n]*--facts/);
  });
  test('the scout and the reviewer briefs run the offload first, as data under the fence, and survive its absence', () => {
    const scout = script.slice(script.indexOf('function scoutPrompt('), script.indexOf('function judgePrompt('));
    const review = script.slice(script.indexOf('function reviewPrompt('), script.indexOf('function fixPrompt('));
    for (const brief of [scout, review]) {
      expect(brief).toContain('MIKRO_CALL');
      expect(brief).toMatch(/DATA under the fence/);
      expect(brief).toMatch(/exits 1 or is unavailable/);
      // An installed host has no `scripts/`: the only two things that can be missing
      // are the genie binary and the mikro runtime, and the brief must say so.
      expect(brief).toContain('no genie or no mikro on PATH');
      expect(brief).not.toContain('scripts/mikro');
      expect(brief).toMatch(/Report it in mikro as \{agent, ok, costUsd, seconds, usedFacts, usedFiles\}/);
      expect(brief).toMatch(/mikro is never omitted/);
    }
    expect(scout).toContain('MIKRO_SCOUT_AGENT');
    expect(review).toContain('MIKRO_REVIEW_AGENT');
  });
  test('mikro stays an optional schema key (the fake-agent scenarios omit it) while the briefs say it is never omitted', () => {
    const required = (name: string) => {
      const m = new RegExp(`const ${name} = obj\\(\\[([^\\]]*)\\]`).exec(script);
      if (!m) throw new Error(`${name} not found`);
      return m[1];
    };
    expect(required('SCOUT_SCHEMA')).not.toContain('mikro');
    expect(required('REVIEW_SCHEMA')).not.toContain('mikro');
    expect((script.match(/^\s+mikro: obj\(\['agent', 'ok'\]/gm) ?? []).length).toBe(2);
  });
  test('the report renders one offload line per stage that reported one', () => {
    expect(script).toContain('offloadLine(view.scoutMikro)');
    expect(script).toContain('offloadLine(review.mikro)');
    expect(script).toContain('scoutMikro: offloadOrAbsent(scout.mikro, MIKRO_SCOUT_AGENT)');
    expect(script).toContain('mikro: offloadOrAbsent(value.mikro, MIKRO_REVIEW_AGENT)');
    expect(script).toContain('not reported by the stage');
  });
});

describe('microagents', () => {
  for (const agent of AGENTS) {
    test(`${agent}: agent.yaml pins the flash model and thinking, SYSTEM.md carries the five rules, fixtures exist`, () => {
      const yaml = read(`.mikro/agents/${agent}/agent.yaml`);
      expect(yaml).toContain('model: deepseek-api/deepseek-flash');
      expect(yaml).toMatch(/^thinking: low/m);
      expect(yaml).toMatch(/^shape: loop/m);
      expect(yaml).toContain('system: SYSTEM.md');
      const system = read(`.mikro/agents/${agent}/SYSTEM.md`);
      expect(system).toContain('**Before anything else — the five rules this agent is:**');
      expect(system).toContain('No `FINAL` before your fourth repl block');
      expect(system).toContain('## Verify before you cite');
      expect(system).toContain('```json');
      expect(system).toMatch(/never a bare/);
      expect(existsSync(join(root, 'scripts/mikro/fixtures', `${agent}.json`))).toBe(true);
      const fixtures = JSON.parse(read(`scripts/mikro/fixtures/${agent}.json`)) as {
        agent: string;
        fixtures: { id: string; prompt: string; truth: object }[];
      };
      expect(fixtures.agent).toBe(agent);
      expect(fixtures.fixtures.length).toBeGreaterThanOrEqual(5);
    });
  }
  test('the provider the agents pin is declared in the tracked mikro config', () => {
    const config = read('.mikro/mikro.yaml');
    expect(config).toMatch(/^providers:\n {2}deepseek-api:/m);
    expect(config).toContain('api-key-env: DEEPSEEK_API_KEY');
    expect(config).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
  });
});
