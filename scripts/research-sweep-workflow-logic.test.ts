import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Two script-side decisions of `.claude/workflows/research-sweep.js` are tested here: the frozen-list
// gate (a planner that omits even one source refuses the run) and the conflict gate's backing lookup
// (a position is backed only by a quoted finding about the same claim). No module can import them —
// the runtime executes the script and it exports only `meta` — so, as `scripts/wish-workflow-logic.test.ts`
// already does, each declaration is lifted out of the shipped source and evaluated here.

const ROOT = join(import.meta.dir, '..');
const SCRIPT = readFileSync(join(ROOT, '.claude', 'workflows', 'research-sweep.js'), 'utf8');
const PARITY = readFileSync(join(ROOT, 'scripts', 'research-sweep-workflow-parity.test.ts'), 'utf8');

function lift(pattern: RegExp): string {
  const match = pattern.exec(SCRIPT);
  if (!match) throw new Error(`research-sweep.js: nothing matched ${pattern}`);
  return match[0];
}

interface Drop {
  ref: string;
  reason: string;
}
type Refusal = { ok: boolean; error: string; droppedSources: Drop[]; shards: unknown[] };

// The gate is inline in the script's flow, so the lifted text is wrapped in a function whose
// parameters are exactly the locals it closes over — anything else it reached would throw here.
const gate = new Function(
  'plannerDrops',
  'kept',
  'droppedSources',
  'planFallback',
  'planUnderPartitioned',
  'notConvened',
  `${lift(/^const refsOf = .*$/m)}\n${lift(/^ {2}if \(plannerDrops\.length\)[\s\S]*?^ {4}\}$/m)}\n  return null`,
) as (d: Drop[], k: { ref: string }[], i: Drop[], f: boolean, u: unknown, n: string[]) => Refusal | null;

const KEPT = ['a.md', 'b.md', 'c.md', 'd.md'].map((ref) => ({ ref }));
const refuse = (drops: Drop[], intake: Drop[] = []): Refusal | null => gate(drops, KEPT, intake, false, null, []);

describe('a planner omission of a frozen source refuses the run', () => {
  test('no half-of-the-list threshold survives, and no dropped ref reaches a shard', () => {
    expect(SCRIPT).not.toContain('* 2 >');
    expect(SCRIPT).not.toMatch(/plannerDrops\.length\s*[*/]/);
    expect(SCRIPT).toMatch(/^ {2}if \(plannerDrops\.length\)$/m);
    expect(SCRIPT).not.toMatch(/for \(const drop of plannerDrops\)/);
    // The three untouched paths: unassigned sources are still appended, and a bad or duplicate
    // assignment is still log-only.
    expect(SCRIPT).toContain('appended so no frozen source goes unread');
    expect(SCRIPT).toContain('planned assignment(s) naming no frozen source');
    expect(SCRIPT).toContain('duplicate shard assignment(s)');
  });

  test('one omission out of four refuses before dispatch; none falls through', () => {
    const refused = refuse([{ ref: 'b.md', reason: 'the planner dropped it: looked redundant' }]) as Refusal;
    expect(refused.ok).toBe(false);
    expect(refused.shards).toEqual([]);
    expect(refused.error).toContain('b.md');
    expect(refused.error).toContain('1 of 4');
    expect(refuse([])).toBeNull();
  });

  test('the refusal names every omitted ref and keeps the pre-existing key set', () => {
    const drops = [
      { ref: 'b.md', reason: 'the planner dropped it: looked redundant' },
      { ref: 'd.md', reason: 'the planner dropped it: no reason given' },
    ];
    const refused = refuse(drops, [{ ref: 'not-a-path', reason: 'intake' }]) as Refusal;
    for (const drop of drops) expect(refused.error).toContain(drop.ref);
    expect(Object.keys(refused).sort()).toEqual([
      'droppedSources',
      'error',
      'notConvened',
      'ok',
      'planFallback',
      'planUnderPartitioned',
      'shards',
    ]);
    // Intake drops first, then the planner's: the caller sees the whole unread list.
    expect(refused.droppedSources.map((entry) => entry.ref)).toEqual(['not-a-path', 'b.md', 'd.md']);
  });
});

interface Finding {
  claim: string;
  quote: string;
}

const backingOf = new Function(
  'slot',
  'claim',
  [
    lift(/^const text = .*$/m),
    lift(/^const STOPWORDS = .*$/m),
    lift(/^const contentWords = [\s\S]*?^ {2}\)$/m),
    lift(/^function claimsOverlap\(left, right\) \{[\s\S]*?^\}$/m),
    lift(/^ {4}const backing = slot && .*$/m),
    '    return backing || null',
  ].join('\n'),
) as (slot: { findings: Finding[] } | null, claim: string) => Finding | null;

describe('a conflict position is backed on source, locator AND topic', () => {
  const CLAIM = 'the retirement pass archives the recorded agent directories before the install spawns';
  const onTopic: Finding = { claim: 'retirement archives the recorded directories before install', quote: 'q' };
  const offTopic: Finding = { claim: 'bun test runs colocated suites inside the worktree', quote: 'colocated' };

  test('the shipped predicate carries claimsOverlap alongside the quote test', () => {
    expect(SCRIPT).toContain('text(finding.quote) && claimsOverlap(finding.claim, claim)');
  });

  test('a quoted finding at the same citation but on another topic backs nothing', () => {
    expect(backingOf({ findings: [offTopic] }, CLAIM)).toBeNull();
    expect(backingOf({ findings: [{ ...onTopic, quote: '  ' }] }, CLAIM)).toBeNull();
    expect(backingOf({ findings: [offTopic, onTopic] }, CLAIM)).toEqual(onTopic);
  });
});

test('the parity test compares the injection fence by equality, never containment', () => {
  expect(PARITY).toMatch(/expect\(flat\([\s\S]{0,60}?\)\)\.toBe\(flat\(fence\[1\] as string\)\)/);
});
