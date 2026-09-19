/**
 * The deterministic half of a coaching round: what a proposal must satisfy
 * before a cent is spent on it, and the verdict rule that judges the two bench
 * runs afterwards. Nothing here calls a model, spawns a bench or touches
 * `.mikro/` — that is the point. The generative half is measured in
 * `.mikro/agents/mikro-coach/EVIDENCE.md`.
 *
 * The one process this file starts is a compiled probe binary, which runs no agent.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CoachEdit,
  CoachRefusal,
  type FixtureMetrics,
  applyEditsSequentially,
  benchCommand,
  coachPrompt,
  decideVerdict,
  dirtyAgentsAbortReason,
  fixtureMetrics,
  improvement,
  verifyProposal,
} from './coach';
import { Coach } from './schemas';

const trash: string[] = [];
afterAll(() => {
  for (const dir of trash.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SYSTEM = [
  '# agent',
  '',
  'Rule one: cite what you printed.',
  'Rule two: cite what you printed.',
  '',
  'Budget the run in thirds.',
].join('\n');

const proposal = (edits: CoachEdit[], targetFixtures = ['a']) => ({
  hypothesis: 'h',
  edits,
  targetFixtures,
  expectedLift: { metric: 'recall' as const, from: 0.5, to: 0.8 },
});

describe('applyEditsSequentially', () => {
  test('a unique anchor is replaced and its line is recorded', () => {
    const { text, at } = applyEditsSequentially(SYSTEM, [
      { find: 'Budget the run in thirds.', replace: 'Budget the run in halves.' },
    ]);
    expect(text).toContain('Budget the run in halves.');
    expect(text).not.toContain('in thirds');
    expect(at).toEqual([6]);
  });

  test('an anchor that occurs twice is refused — even though a naive replace would "work"', () => {
    expect(() => applyEditsSequentially(SYSTEM, [{ find: 'cite what you printed.', replace: 'x' }])).toThrow(
      CoachRefusal,
    );
  });

  test('an anchor that occurs nowhere is refused', () => {
    expect(() => applyEditsSequentially(SYSTEM, [{ find: 'Rule three', replace: 'x' }])).toThrow(CoachRefusal);
  });

  test('uniqueness is judged at APPLICATION time, not once up front', () => {
    // Edit 1 duplicates a string that was unique in the original file; edit 2 may
    // then no longer anchor on it. An up-front pass over the ORIGINAL text would
    // have blessed both.
    const edits: CoachEdit[] = [
      { find: 'Budget the run in thirds.', replace: 'Budget the run in thirds. Budget the run in thirds.' },
      { find: 'Budget the run in thirds.', replace: 'gone' },
    ];
    expect(() => applyEditsSequentially(SYSTEM, edits)).toThrow(/more than once at the point it is applied/);
    // …and the mirror: edit 2 legitimately anchors on text edit 1 introduced.
    const ok = applyEditsSequentially(SYSTEM, [
      { find: 'Budget the run in thirds.', replace: 'Budget the run in quarters. PRINT SMALL.' },
      { find: 'PRINT SMALL.', replace: 'Print small.' },
    ]);
    expect(ok.text).toContain('Budget the run in quarters. Print small.');
  });

  test('an empty replace is a deletion, not a refusal', () => {
    expect(applyEditsSequentially(SYSTEM, [{ find: 'Budget the run in thirds.', replace: '' }]).text).not.toContain(
      'Budget',
    );
  });

  test('an over-long anchor is refused before it is searched for', () => {
    expect(() => applyEditsSequentially(SYSTEM, [{ find: 'x'.repeat(401), replace: '' }])).toThrow(
      /over the 400 limit/,
    );
  });
});

describe('verifyProposal', () => {
  const ids = ['a', 'b'];

  test('a bounded, anchored, targeted proposal passes and returns the patched text', () => {
    const v = verifyProposal(
      proposal([{ find: 'Budget the run in thirds.', replace: 'Budget the run in halves.' }]),
      SYSTEM,
      ids,
    );
    expect(v.text).toContain('halves');
    expect(v.replaceChars).toBe('Budget the run in halves.'.length);
  });

  test('an empty targetFixtures is a HARD REJECT, never a null proposal', () => {
    expect(() =>
      verifyProposal(proposal([{ find: 'Budget the run in thirds.', replace: 'x' }], []), SYSTEM, ids),
    ).toThrow(/`targetFixtures` is empty/);
  });

  test('a targetFixtures id the set does not hold is a hard reject and is named', () => {
    expect(() =>
      verifyProposal(proposal([{ find: 'Budget the run in thirds.', replace: 'x' }], ['a', 'zz']), SYSTEM, ids),
    ).toThrow(/does not hold: zz/);
  });

  test('more than three edits, or more than 1200 replacement characters, is refused', () => {
    const edit = { find: 'Budget the run in thirds.', replace: 'x' };
    expect(() => verifyProposal(proposal([edit, edit, edit, edit]), SYSTEM, ids)).toThrow(/1–3 edits/);
    expect(() =>
      verifyProposal(proposal([{ find: 'Budget the run in thirds.', replace: 'y'.repeat(1201) }]), SYSTEM, ids),
    ).toThrow(/over the 1200 limit/);
  });

  test('a patch that changes nothing is refused rather than measured', () => {
    expect(() =>
      verifyProposal(
        proposal([{ find: 'Budget the run in thirds.', replace: 'Budget the run in thirds.' }]),
        SYSTEM,
        ids,
      ),
    ).toThrow(/leave the prompt unchanged/);
  });
});

describe('the Coach schema', () => {
  test('proposal: null is valid — "nothing here earns a patch" is an answer', () => {
    const parsed = Coach.safeParse({
      agent: 'review-prep',
      diagnosis: [{ observation: 'every bar passes', evidence: 'x.md:1' }],
      proposal: null,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.injection_attempts).toEqual([]);
  });

  test('the bounds are in the schema too, so a failed attempt is retried with them', () => {
    const base = { agent: 'a', diagnosis: [{ observation: 'o', evidence: 'e.md:1' }] };
    const edits = (n: number, replace = 'r') => Array.from({ length: n }, () => ({ find: 'f', replace }));
    const p = (edits: unknown) => ({
      ...base,
      proposal: { hypothesis: 'h', edits, targetFixtures: ['a'], expectedLift: { metric: 'recall', from: 0, to: 1 } },
    });
    expect(Coach.safeParse(p(edits(4))).success).toBe(false);
    expect(Coach.safeParse(p(edits(1, 'r'.repeat(1201)))).success).toBe(false);
    expect(Coach.safeParse(p([{ find: 'f'.repeat(401), replace: '' }])).success).toBe(false);
    expect(
      Coach.safeParse({
        ...base,
        proposal: {
          hypothesis: 'h',
          edits: edits(1),
          targetFixtures: [],
          expectedLift: { metric: 'recall', from: 0, to: 1 },
        },
      }).success,
    ).toBe(false);
    expect(Coach.safeParse(p(edits(1))).success).toBe(true);
  });
});

describe('fixtureMetrics', () => {
  test('recall averages the OK runs only and is null when no run carried file truth', () => {
    const m = fixtureMetrics([
      { id: 'a', rep: 0, ok: true, cost: 0.01, seconds: 60, score: { filesRecall: 0.4 } },
      { id: 'a', rep: 1, ok: true, cost: 0.03, seconds: 100, score: { filesRecall: 1 } },
      { id: 'a', rep: 2, ok: false, cost: 0.02, seconds: 20, score: { filesRecall: 0 } },
      { id: 'b', rep: 0, ok: true, cost: 0.01, seconds: 10, score: { filesRecall: null } },
    ]);
    expect(m.get('a')).toEqual({ yield: 2 / 3, recall: 0.7, cost: 0.02, p50: 60, runs: 3 });
    expect(m.get('b')?.recall).toBeNull();
  });
});

describe('improvement', () => {
  test('higher is better for recall and yield, lower is better for cost', () => {
    expect(improvement('recall', 0.5, 0.8)).toBeCloseTo(0.3);
    expect(improvement('yield', 1, 0.5)).toBeCloseTo(-0.5);
    expect(improvement('cost', 0.02, 0.01)).toBeCloseTo(0.01);
  });
});

const fm = (recall: number | null, y = 1): FixtureMetrics => ({ yield: y, recall, cost: 0.01, p50: 60, runs: 2 });
const bars = { yield: true, fabrication: true, recall: true, cost: true, latency: true };

describe('decideVerdict — the pre-registered rule', () => {
  const base = {
    metric: 'recall' as const,
    targetFixtures: ['t'],
    barsBefore: bars,
    barsAfter: bars,
    band: new Map([
      ['t', 0.1],
      ['g', 0.1],
    ]),
  };

  test('a target gain wider than the band, with the guard steady, is a lift', () => {
    const d = decideVerdict({
      ...base,
      before: new Map([
        ['t', fm(0.5)],
        ['g', fm(0.9)],
      ]),
      after: new Map([
        ['t', fm(0.8)],
        ['g', fm(0.9)],
      ]),
    });
    expect(d.verdict).toBe('lift');
  });

  test('a target gain INSIDE the null-control band is inconclusive, not a lift', () => {
    const d = decideVerdict({
      ...base,
      before: new Map([['t', fm(0.5)]]),
      after: new Map([['t', fm(0.55)]]),
    });
    expect(d.verdict).toBe('inconclusive');
    expect(d.reasons[0]).toContain('inside the 0.100 drift band');
  });

  test('a guard fixture that falls past its own band is a regression, whatever the target did', () => {
    const d = decideVerdict({
      ...base,
      before: new Map([
        ['t', fm(0.5)],
        ['g', fm(0.9)],
      ]),
      after: new Map([
        ['t', fm(1)],
        ['g', fm(0.5)],
      ]),
    });
    expect(d.verdict).toBe('regression');
    expect(d.reasons.join(' ')).toContain('guard fixture g recall worsened');
  });

  test('a bar that passed before and fails after is a regression on its own', () => {
    const d = decideVerdict({
      ...base,
      before: new Map([['t', fm(0.5)]]),
      after: new Map([['t', fm(1)]]),
      barsAfter: { ...bars, yield: false },
    });
    expect(d.verdict).toBe('regression');
    expect(d.reasons[0]).toContain('bar yield passed before and fails after');
  });

  test('a bar that was already failing before is not held against the patch', () => {
    const d = decideVerdict({
      ...base,
      before: new Map([['t', fm(0.5)]]),
      after: new Map([['t', fm(0.8)]]),
      barsBefore: { ...bars, recall: false },
      barsAfter: { ...bars, recall: false },
    });
    expect(d.verdict).toBe('lift');
  });

  test('with no null-control band on record nothing can be concluded', () => {
    const d = decideVerdict({
      ...base,
      band: null,
      before: new Map([['t', fm(0.1)]]),
      after: new Map([['t', fm(0.9)]]),
    });
    expect(d.verdict).toBe('inconclusive');
    expect(d.reasons[0]).toContain('--null-control first');
  });

  test('a TARGET fixture falling is the hypothesis being wrong — no-lift, not regression', () => {
    const d = decideVerdict({
      ...base,
      before: new Map([
        ['t', fm(0.9)],
        ['g', fm(0.9)],
      ]),
      after: new Map([
        ['t', fm(0.4)],
        ['g', fm(0.9)],
      ]),
    });
    expect(d.verdict).toBe('no-lift');
    expect(d.reasons[0]).toContain('moved -0.500');
  });

  test('a metric no target fixture measured cannot be judged', () => {
    const d = decideVerdict({ ...base, before: new Map([['t', fm(null)]]), after: new Map([['t', fm(null)]]) });
    expect(d.verdict).toBe('inconclusive');
    expect(d.reasons[0]).toContain('no recall measured');
  });
});

/**
 * What a round reads and what it spawns — the two things that had to become portable
 * for `genie mikro coach` to work in a repository that has no `scripts/mikro/`.
 * Both are pure functions here: nothing is spawned, nothing is benched, nothing is
 * billed.
 */
describe('coachPrompt', () => {
  const paths = {
    agent: 'wish-context',
    repo: '/repo',
    systemPath: '/repo/.mikro/agents/wish-context/SYSTEM.md',
    evidencePath: '/repo/.mikro/agents/wish-context/EVIDENCE.md',
    fixturesPath: '/repo/.mikro/fixtures/wish-context.json',
  };

  test('every path is relative to --dir, because the citation gate scores that tree', () => {
    const prompt = coachPrompt({ ...paths, evidenceExists: true });
    expect(prompt).toContain('system: .mikro/agents/wish-context/SYSTEM.md');
    expect(prompt).toContain('evidence: .mikro/agents/wish-context/EVIDENCE.md');
    expect(prompt).toContain('fixtures: .mikro/fixtures/wish-context.json');
    expect(prompt).not.toContain('/repo/');
    // A fixture set outside the repository is named in full rather than mangled.
    expect(coachPrompt({ ...paths, fixturesPath: '/elsewhere/set.json', evidenceExists: true })).toContain(
      'fixtures: /elsewhere/set.json',
    );
  });

  test('a freshly seeded agent with no EVIDENCE.md gets a prompt that says so', () => {
    const prompt = coachPrompt({ ...paths, evidenceExists: false });
    // It must not ASK for a file that is not there: a cited path the tree lacks fails
    // the citation gate, and "read the rows of every round" has no rows to read.
    expect(prompt).not.toContain('evidence: .mikro');
    expect(prompt).toContain('does not exist');
    expect(prompt).toContain('never been benched');
    expect(prompt).toContain('null, which is the right answer before the first round');
    // …and it still names the prompt and the fixtures, which is what there IS to read.
    expect(prompt).toContain('system: .mikro/agents/wish-context/SYSTEM.md');
    expect(prompt).toContain('fixtures: .mikro/fixtures/wish-context.json');
  });
});

describe('benchCommand', () => {
  const genieCheckout = '/genie';
  const other = '/other';
  const has = (present: string[]) => (path: string) => present.includes(path);

  test('inside the genie checkout it is still bun scripts/mikro/bench.ts', () => {
    expect(
      benchCommand(genieCheckout, '/genie/scripts/mikro/coach.ts', '/bin/bun', has(['/genie/scripts/mikro/bench.ts'])),
    ).toEqual(['bun', '/genie/scripts/mikro/bench.ts']);
  });

  test('a repository without one falls back to whatever is running this code', () => {
    // `bun scripts/mikro/coach.ts --dir /other` from the genie checkout: the sibling.
    expect(
      benchCommand(other, '/genie/scripts/mikro/coach.ts', '/bin/bun', has(['/genie/scripts/mikro/bench.ts'])),
    ).toEqual(['bun', '/genie/scripts/mikro/bench.ts']);
    // `bun dist/genie.js mikro coach`: the bundle, which is a real file and carries the command.
    expect(benchCommand(other, '/genie/dist/genie.js', '/bin/bun', has(['/genie/dist/genie.js']))).toEqual([
      '/bin/bun',
      '/genie/dist/genie.js',
      'mikro',
      'bench',
    ]);
  });

  /**
   * The compiled binary, with the fixture the RUNTIME gives: inside a Bun standalone
   * binary `existsSync(Bun.main)` is TRUE — the embedded file really is there, for this
   * process — so an `exists` stub that answered false was testing a host that does not
   * exist. The embedded path is meaningless to any other process (`genie
   * /$bunfs/root/genie mikro bench` exits 1 on `unknown command`), which would leave the
   * round with no bench record at all. Same class as the `gh ENOENT` precedent: never
   * assert a runtime's own vocabulary against a fixture that contradicts it.
   */
  test('an embedded main is not a script, however real it looks from inside', () => {
    const embeddedMain = '/$bunfs/root/genie';
    expect(benchCommand(other, embeddedMain, '/usr/local/bin/genie', has([embeddedMain]))).toEqual([
      '/usr/local/bin/genie',
      'mikro',
      'bench',
    ]);
    // …including when the binary was compiled FROM coach.ts, where the sibling branch
    // would otherwise hand `bun` an embedded `bench.ts` of another process.
    expect(
      benchCommand(other, '/$bunfs/root/coach.ts', '/usr/local/bin/genie', has(['/$bunfs/root/bench.ts'])),
    ).toEqual(['/usr/local/bin/genie', 'mikro', 'bench']);
    // Windows spells the same thing `B:\~BUN\root\…`.
    expect(benchCommand(other, 'B:\\~BUN\\root\\genie', 'C:\\genie.exe', has(['B:\\~BUN\\root\\genie']))).toEqual([
      'C:\\genie.exe',
      'mikro',
      'bench',
    ]);
    // A repository that DOES carry the script still wins, compiled binary or not.
    expect(
      benchCommand(
        genieCheckout,
        embeddedMain,
        '/usr/local/bin/genie',
        has([embeddedMain, '/genie/scripts/mikro/bench.ts']),
      ),
    ).toEqual(['bun', '/genie/scripts/mikro/bench.ts']);
  });

  /**
   * The same claim against a REAL standalone binary rather than a fixture, because the
   * fixture is exactly what was wrong: this compiles a probe that imports this module
   * and prints what `benchCommand` answers from inside `/$bunfs`. Slow (a compile), and
   * softly skipped on a host where `bun build --compile` cannot run — the unit cases
   * above still pin the rule there.
   */
  test('inside a REAL compiled binary, no embedded path reaches the argv', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mikro-bunfs-'));
    trash.push(dir);
    writeFileSync(
      join(dir, 'probe.ts'),
      `import { existsSync } from 'node:fs';
import { benchCommand } from ${JSON.stringify(join(import.meta.dir, 'coach.ts'))};
process.stdout.write(
  JSON.stringify({ main: Bun.main, mainExists: existsSync(Bun.main), cmd: benchCommand('/no/such/repo') }),
);
`,
    );
    const bin = join(dir, 'probe-bin');
    const build = Bun.spawnSync([process.execPath, 'build', '--compile', join(dir, 'probe.ts'), '--outfile', bin], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (build.exitCode !== 0) {
      process.stderr.write(`· skipped: bun build --compile is unavailable here (${build.stderr.toString().trim()})\n`);
      return;
    }
    const ran = Bun.spawnSync([bin], { stdout: 'pipe', stderr: 'pipe' });
    expect(ran.exitCode).toBe(0);
    const seen = JSON.parse(ran.stdout.toString()) as { main: string; mainExists: boolean; cmd: string[] };
    // The fact the old fixture denied: inside the binary, the embedded main DOES exist.
    expect(seen.main).toContain('$bunfs');
    expect(seen.mainExists).toBe(true);
    // …and it is still nowhere in the command the round would spawn.
    expect(seen.cmd).toEqual([bin, 'mikro', 'bench']);
    for (const token of seen.cmd) expect(token).not.toContain('$bunfs');
  });
});

describe("Gate 1's abort message", () => {
  test('keeps the diagnostic and the dirty paths, and names both ways out plus the re-run', () => {
    const reason = dirtyAgentsAbortReason([
      '?? .mikro/agents/wish-context/EVIDENCE.md',
      ' M .mikro/agents/wish-context/SYSTEM.md',
    ]);
    // The diagnostic half is unchanged: why the gate exists, then every path git listed.
    expect(reason).toContain('.mikro/agents is not clean — "before" would not be the recorded prompt:');
    expect(reason).toContain('?? .mikro/agents/wish-context/EVIDENCE.md');
    expect(reason).toContain(' M .mikro/agents/wish-context/SYSTEM.md');
    // The remedy half: an operator who followed `genie mikro init` lands here with an
    // untracked EVIDENCE.md and needs to be told which two exits the gate accepts.
    expect(reason).toContain('commit the listed paths');
    expect(reason).toContain('or remove them');
    expect(reason).toContain('re-run');
  });
});
