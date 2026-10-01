import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { designReviewDigest, designReviewViolations } from '../skills/brainstorm/references/design-review-evidence.mjs';

// The round ledger is a CLI the brainstorm workflow's ledger agents run, so every case drives it the
// way they do: `node round-ledger.mjs <command> …`, one JSON object on stdout, exit 0/1/2.

const ROOT = join(import.meta.dir, '..');
const LEDGER = join(ROOT, 'skills', 'brainstorm', 'references', 'round-ledger.mjs');
const FIXTURE = join(ROOT, 'scripts', 'fixtures', 'brainstorm-workflow');
const FIXTURE_DESIGN = join(FIXTURE, 'DESIGN.md');
const FIXTURE_DRAFT = join(FIXTURE, 'DRAFT.md');
const DIGEST = 'a'.repeat(64);

type Out = Record<string, any>;
type Run = { code: number; out: Out };

function ledger(...args: string[]): Run {
  const result = Bun.spawnSync(['node', LEDGER, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const stdout = result.stdout.toString();
  try {
    return { code: result.exitCode ?? -1, out: JSON.parse(stdout) };
  } catch {
    throw new Error(`round-ledger printed no JSON (exit ${result.exitCode}): ${stdout}${result.stderr.toString()}`);
  }
}

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'genie-round-ledger-'));
  dirs.push(dir);
  return dir;
}

function newDraft(): string {
  return join(tempDir(), 'my-idea', 'DRAFT.md');
}

function blockOf(path: string): Out {
  const match = /```ledger\n([\s\S]*?)\n```/.exec(readFileSync(path, 'utf8'));
  if (!match) throw new Error(`no ledger block in ${path}`);
  return JSON.parse(match[1] as string);
}

const PICK_M = { label: 'M (Recommended)', description: 'one wish', value: 'M' };
const PICK_G = { label: 'G', description: 'a grouped wish', value: 'G' };

function question(overrides: Out = {}): Out {
  return {
    kind: 'decision',
    question: 'Which size fits this idea?',
    header: 'Size',
    multiSelect: false,
    options: [PICK_M, PICK_G],
    ...overrides,
  };
}

const apply = (draft: string, answers?: Out[]) =>
  answers === undefined
    ? ledger('apply', '--draft', draft)
    : ledger('apply', '--draft', draft, '--answers', JSON.stringify(answers));
const ask = (draft: string, round: number, questions: Out[]) =>
  ledger('ask', '--draft', draft, '--round', String(round), '--questions', JSON.stringify(questions));
const answer = (id: string, text: string | string[], asked = 'Which size fits this idea?') => ({
  id,
  question: asked,
  answer: text,
});

/** A DRAFT whose round-1 questions were asked and whose round-2 apply settled the given answers. */
function settledDraft(questions: Out[], answers: Out[]): string {
  const draft = newDraft();
  expect(apply(draft).code).toBe(0);
  expect(ask(draft, 1, questions).code).toBe(0);
  const run = apply(draft, answers);
  expect(run.out.refused).toEqual([]);
  return draft;
}

describe('round trip: apply → ask → apply → render', () => {
  test('a first apply creates the DRAFT with its block, and answers land in Settled with their provenance', () => {
    const draft = newDraft();
    const first = apply(draft);
    expect(first.code).toBe(0);
    expect(first.out.round).toBe(1);
    expect(existsSync(draft)).toBe(true);
    expect(blockOf(draft)).toEqual({ settled: [], asked: [], size: [], scopeIn: [], councils: [], reviews: [] });

    const asked = ask(draft, 1, [question(), question({ question: 'Who owns it?', header: 'Owner' })]);
    expect(asked.code).toBe(0);
    expect(asked.out.asked.map((entry: Out) => entry.id)).toEqual(['R1-1', 'R1-2']);

    const second = apply(draft, [answer('R1-1', 'M (Recommended)')]);
    expect(second.code).toBe(0);
    expect(second.out.round).toBe(2);
    expect(second.out.applied).toEqual([{ id: 'R1-1', provenance: 'owner picked "M (Recommended)"' }]);
    expect(second.out.ledger.settled).toEqual([
      {
        id: 'R1-1',
        kind: 'decision',
        question: 'Which size fits this idea?',
        answer: 'M (Recommended)',
        value: 'M',
        provenance: 'owner picked "M (Recommended)"',
        round: 2,
      },
    ]);
    // L-a: the unanswered question stays Asked and is shown again.
    expect(second.out.skipped).toEqual(['R1-2']);
    expect(blockOf(draft).asked.map((entry: Out) => entry.id)).toEqual(['R1-2']);

    const render = ledger('render', '--draft', draft);
    expect(render.code).toBe(0);
    const text = readFileSync(draft, 'utf8');
    expect(text).toContain(
      '## Settled\n\n- **R1-1** (round 2, decision): Which size fits this idea? — owner picked "M (Recommended)"\n',
    );
    expect(text).toContain(
      '## Asked\n\n- **R1-2** (round 1, decision): Who owns it?\n  1. M (Recommended) — one wish\n',
    );
  });

  test('the round is one past the highest round recorded anywhere, so a fully answered ledger does not reset', () => {
    const draft = settledDraft([question()], [answer('R1-1', 'G')]);
    expect(blockOf(draft).asked).toEqual([]);
    expect(apply(draft).out.round).toBe(3);
  });
});

describe('apply', () => {
  test('a DRAFT without a block keeps its bytes and gains one', () => {
    const draft = newDraft();
    mkdirSync(dirname(draft), { recursive: true });
    const original = '# DRAFT: my idea\n\nWRS: ██░░░░░░░░ 20/100\n\n## Understanding\n\nsaid vs assumed';
    writeFileSync(draft, original);
    expect(apply(draft).code).toBe(0);
    const text = readFileSync(draft, 'utf8');
    expect(text.startsWith(`${original}\n`)).toBe(true);
    expect(blockOf(draft).settled).toEqual([]);
  });

  test('refuses an unknown id and a changed question text, and applies the rest of the batch', () => {
    const draft = newDraft();
    apply(draft);
    ask(draft, 1, [question(), question({ question: 'Who owns it?', header: 'Owner' })]);
    const run = apply(draft, [
      answer('R1-9', 'G'),
      answer('R1-1', 'G', 'Which size fits this idea, roughly?'),
      answer('R1-2', 'G', 'Who owns it?'),
    ]);
    expect(run.code).toBe(1);
    expect(run.out.refused).toEqual([
      { id: 'R1-9', reason: 'unknown id R1-9: it is neither Asked nor Settled' },
      { id: 'R1-1', reason: 'the question text for R1-1 differs from the one Asked' },
    ]);
    expect(run.out.applied.map((entry: Out) => entry.id)).toEqual(['R1-2']);
    expect(blockOf(draft).asked.map((entry: Out) => entry.id)).toEqual(['R1-1']);
  });

  test('refuses an edit to a Settled id; the identical answer again is a no-op', () => {
    const draft = settledDraft([question()], [answer('R1-1', 'M (Recommended)')]);
    const before = readFileSync(draft, 'utf8');
    const edit = apply(draft, [answer('R1-1', 'G')]);
    expect(edit.code).toBe(1);
    expect(edit.out.refused[0].reason).toContain('R1-1 is Settled; it changes only through a question whose reopens');
    const again = apply(draft, [answer('R1-1', 'M (Recommended)')]);
    expect(again.code).toBe(0);
    expect(again.out.applied).toEqual([{ id: 'R1-1', provenance: 'owner picked "M (Recommended)"', unchanged: true }]);
    expect(readFileSync(draft, 'utf8')).toBe(before);
  });

  test('free text stores value null and the verbatim quote; an empty answer is a skip', () => {
    const draft = newDraft();
    apply(draft);
    ask(draft, 1, [question(), question({ question: 'Who owns it?', header: 'Owner' })]);
    const run = apply(draft, [answer('R1-1', 'Neither: split it in two'), answer('R1-2', '  ', 'Who owns it?')]);
    expect(run.code).toBe(0);
    const [settled] = run.out.ledger.settled;
    expect(settled.value).toBeNull();
    expect(settled.answer).toBe('Neither: split it in two');
    expect(settled.provenance).toBe('owner said: "Neither: split it in two"');
    expect(run.out.skipped).toEqual(['R1-2']);
  });

  test('multi-select stores an array of values, from an array or the harness joined string', () => {
    const options = [
      { label: 'Ledger', description: 'g1', value: 'g1' },
      { label: 'Routing', description: 'g2', value: 'g2' },
      { label: 'Workflow', description: 'g3', value: 'g3' },
    ];
    const multi = (text: string) => question({ question: text, header: 'Groups', multiSelect: true, options });
    const draft = newDraft();
    apply(draft);
    ask(draft, 1, [multi('Which groups first?'), multi('Which groups last?'), multi('Which groups never?')]);
    const run = apply(draft, [
      answer('R1-1', ['Ledger', 'Routing'], 'Which groups first?'),
      answer('R1-2', 'Routing, Workflow', 'Which groups last?'),
      answer('R1-3', ['Ledger', 'none of these'], 'Which groups never?'),
    ]);
    expect(run.code).toBe(0);
    const byId = Object.fromEntries(run.out.ledger.settled.map((entry: Out) => [entry.id, entry]));
    expect(byId['R1-1'].value).toEqual(['g1', 'g2']);
    expect(byId['R1-1'].answer).toEqual(['Ledger', 'Routing']);
    expect(byId['R1-2'].value).toEqual(['g2', 'g3']);
    expect(byId['R1-3'].value).toEqual(['g1', null]);
    expect(byId['R1-3'].provenance).toBe('owner picked "Ledger"; owner said: "none of these"');
  });

  test('a single-select question refuses two picks', () => {
    const draft = newDraft();
    apply(draft);
    ask(draft, 1, [question()]);
    const run = apply(draft, [answer('R1-1', ['M (Recommended)', 'G'])]);
    expect(run.code).toBe(1);
    expect(run.out.refused[0].reason).toBe('R1-1 is single-select; answer with one label');
  });

  test('a malformed ledger block or two blocks refuse; a malformed flag is usage', () => {
    const draft = newDraft();
    mkdirSync(dirname(draft), { recursive: true });
    writeFileSync(draft, '# DRAFT\n\n```ledger\n{nope\n```\n');
    expect(apply(draft).code).toBe(1);
    writeFileSync(draft, '# DRAFT\n\n```ledger\n{}\n```\n\n```ledger\n{}\n```\n');
    expect(apply(draft).out.refused[0].reason).toContain('holds 2 ledger blocks');
    const bad = ledger('apply', '--draft', newDraft(), '--answers', '{not json');
    expect(bad.code).toBe(2);
    expect(bad.out.error).toContain('--answers is not valid JSON');
  });
});

describe('reopen: a Settled id changes only through a question that quotes old → new', () => {
  const reopen = (text: string) => question({ question: text, header: 'Reopen', reopens: 'R1-1' });

  test('ask refuses a reopens that names no Settled id, or a text that does not quote the old answer', () => {
    const draft = settledDraft([question()], [answer('R1-1', 'M (Recommended)')]);
    const unknown = ask(draft, 2, [question({ reopens: 'R1-7' })]);
    expect(unknown.code).toBe(1);
    expect(unknown.out.refused[0].reason).toBe('reopens R1-7, which is not a Settled id');
    const unquoted = ask(draft, 2, [reopen('Should we grow it to G?')]);
    expect(unquoted.code).toBe(1);
    expect(unquoted.out.refused[0].reason).toContain("must quote R1-1's answer verbatim");
  });

  test('a reopen answer settles its own id and records reopenedBy; a second reopen of the same id is refused', () => {
    const text = 'R1-1 said "M (Recommended)" → grow to G?';
    const draft = settledDraft([question()], [answer('R1-1', 'M (Recommended)')]);
    const asked = ask(draft, 2, [reopen(text)]);
    expect(asked.code).toBe(0);
    expect(asked.out.asked[0]).toMatchObject({ id: 'R2-1', reopens: 'R1-1' });
    const run = apply(draft, [answer('R2-1', 'G', text)]);
    expect(run.code).toBe(0);
    expect(run.out.applied).toEqual([{ id: 'R2-1', provenance: 'owner picked "G"', reopens: 'R1-1' }]);
    const settled = Object.fromEntries(run.out.ledger.settled.map((entry: Out) => [entry.id, entry]));
    expect(settled['R1-1']).toMatchObject({ answer: 'M (Recommended)', reopenedBy: 'R2-1' });
    expect(settled['R2-1']).toMatchObject({ value: 'G', reopens: 'R1-1' });
    const twice = ask(draft, 3, [reopen(text)]);
    expect(twice.out.refused[0].reason).toBe('R1-1 was already reopened by R2-1; reopen that one instead');
  });
});

describe('ask', () => {
  test('ids are R<round>-<n> and continue within a round', () => {
    const draft = newDraft();
    apply(draft);
    expect(ask(draft, 1, [question()]).out.asked[0].id).toBe('R1-1');
    expect(ask(draft, 1, [question({ question: 'Second?' })]).out.asked[0].id).toBe('R1-2');
  });

  test('Asked never holds more than four open questions, skipped ones included', () => {
    const draft = newDraft();
    apply(draft);
    ask(draft, 1, [question(), question({ question: 'Two?' })]);
    const over = ask(draft, 2, [
      question({ question: 'Three?' }),
      question({ question: 'Four?' }),
      question({ question: 'Five?' }),
    ]);
    expect(over.code).toBe(1);
    expect(over.out.refused).toEqual([
      { index: null, reason: 'Asked would hold 5 open questions; the batch limit is 4 (open: R1-1, R1-2)' },
    ]);
    expect(blockOf(draft).asked).toHaveLength(2);
  });

  test('refuses a malformed question and writes nothing', () => {
    const draft = newDraft();
    apply(draft);
    const cases: Array<[Out, string]> = [
      [question({ kind: 'probe' }), 'kind must be one of'],
      [question({ options: [PICK_M] }), 'a question needs 2 to 4 options'],
      [question({ options: [PICK_M, { ...PICK_G, label: PICK_M.label }] }), 'option labels must be unique'],
      [question({ options: [PICK_M, { label: 'G', description: 'x' }] }), 'option "G" needs a value'],
      [question({ header: '' }), 'a question needs a header'],
      [question({ kind: 'council-approval' }), 'needs exactly one option with value "convene"'],
    ];
    for (const [bad, reason] of cases) {
      const run = ask(draft, 1, [bad]);
      expect(run.code).toBe(1);
      expect(run.out.refused[0].reason).toContain(reason);
    }
    expect(blockOf(draft).asked).toEqual([]);
  });
});

describe('ratchet: size and Scope IN only go up without an owner answer', () => {
  const ratchet = (draft: string, round: number, ...flags: string[]) =>
    ledger('ratchet', '--draft', draft, '--round', String(round), '--by', 'lead', ...flags);

  test('raises are recorded with who and which round', () => {
    const draft = newDraft();
    apply(draft);
    const run = ratchet(draft, 1, '--size', 'M', '--scope', JSON.stringify(['ledger', 'workflow']));
    expect(run.code).toBe(0);
    expect(run.out.changes).toEqual([
      { change: 'size-raised', value: 'M' },
      { change: 'scope-added', item: 'ledger' },
      { change: 'scope-added', item: 'workflow' },
    ]);
    expect(blockOf(draft).size).toEqual([{ value: 'M', by: 'lead', round: 1 }]);
    expect(blockOf(draft).scopeIn[1]).toEqual({ item: 'workflow', by: 'lead', round: 1 });
  });

  test('a size or scope downgrade without an answer is refused and writes nothing', () => {
    const draft = newDraft();
    apply(draft);
    ratchet(draft, 1, '--size', 'G', '--scope', JSON.stringify(['ledger', 'workflow']));
    const before = readFileSync(draft, 'utf8');
    const smaller = ratchet(draft, 2, '--size', 'M');
    expect(smaller.code).toBe(1);
    expect(smaller.out.refused[0].reason).toContain('size:M lowers what the owner approved');
    const narrower = ratchet(draft, 2, '--scope', JSON.stringify(['ledger']));
    expect(narrower.code).toBe(1);
    expect(narrower.out.refused[0].reason).toContain('scope-drop:workflow lowers what the owner approved');
    expect(readFileSync(draft, 'utf8')).toBe(before);
  });

  test('P3: --approved takes exactly the downgrade a Settled answer agreed to, once', () => {
    const shrink = question({
      question: 'Shrink to P and drop the workflow item?',
      header: 'Shrink',
      multiSelect: true,
      options: [
        { label: 'Shrink to P', description: '', value: 'size:P' },
        { label: 'Drop workflow', description: '', value: 'scope-drop:workflow' },
        { label: 'Keep G', description: '', value: 'keep' },
      ],
    });
    const draft = newDraft();
    apply(draft);
    ratchet(draft, 1, '--size', 'G', '--scope', JSON.stringify(['ledger', 'workflow']));
    ask(draft, 1, [shrink]);
    apply(draft, [{ id: 'R1-1', question: shrink.question, answer: ['Shrink to P', 'Drop workflow'] }]);

    const wrong = ratchet(draft, 2, '--size', 'M', '--approved', 'R1-1');
    expect(wrong.code).toBe(1);
    expect(wrong.out.refused[0].reason).toBe('--approved R1-1 did not agree to size:M');

    const run = ratchet(draft, 2, '--size', 'P', '--scope', JSON.stringify(['ledger']), '--approved', 'R1-1');
    expect(run.code).toBe(0);
    expect(run.out).toMatchObject({ size: 'P', scope: ['ledger'] });
    const block = blockOf(draft);
    expect(block.size.at(-1)).toEqual({ value: 'P', by: 'lead', round: 2, approvedBy: 'R1-1' });
    expect(block.scopeIn[1].dropped).toEqual({ by: 'lead', round: 2, approvedBy: 'R1-1' });

    ratchet(draft, 3, '--size', 'G');
    const reuse = ratchet(draft, 3, '--size', 'P', '--approved', 'R1-1');
    expect(reuse.code).toBe(1);
    expect(reuse.out.refused[0].reason).toBe('--approved R1-1 was already used by the size change to P in round 2');
  });
});

describe('council: the ceiling, the owner approval and the cap of 3', () => {
  const council = (draft: string, round: number, run: string, ceiling: number, ...flags: string[]) =>
    ledger('council', '--draft', draft, '--round', String(round), '--run', run, '--ceiling', String(ceiling), ...flags);
  // The recommended option is "don't convene" and it comes FIRST: picking it must never count as approval.
  const approval = question({
    kind: 'council-approval',
    question: 'The council ceiling is reached. Convene anyway?',
    header: 'Council',
    options: [
      { label: "Don't convene (Recommended)", description: 'the lead decides', value: 'decline' },
      { label: 'Convene anyway', description: 'about 1M tokens', value: 'convene' },
    ],
  });
  const approve = (draft: string, id: string, pick: string) =>
    apply(draft, [{ id, question: approval.question, answer: pick }]);

  test('within the ceiling a convening is recorded with the decisions it named', () => {
    const draft = newDraft();
    apply(draft);
    const run = council(draft, 1, 'wf_a', 1, '--decided', JSON.stringify(['P1', 'P2']));
    expect(run.code).toBe(0);
    expect(run.out).toEqual({ council: { run: 'wf_a', round: 1, decided: ['P1', 'P2'] }, count: 1, ceiling: 1 });
  });

  test('past the ceiling: refused without approval, refused on the first option, accepted once on convene', () => {
    const draft = newDraft();
    apply(draft);
    council(draft, 1, 'wf_a', 1);
    const bare = council(draft, 2, 'wf_b', 1);
    expect(bare.code).toBe(1);
    expect(bare.out.refused[0].reason).toContain('council 2 is past the ceiling of 1');

    ask(draft, 1, [approval]);
    approve(draft, 'R1-1', "Don't convene (Recommended)");
    const declined = council(draft, 2, 'wf_b', 1, '--approved', 'R1-1');
    expect(declined.code).toBe(1);
    expect(declined.out.refused[0].reason).toContain('not the option of value "convene"');

    ask(draft, 2, [approval]);
    approve(draft, 'R2-1', 'Convene anyway');
    const run = council(draft, 3, 'wf_b', 1, '--approved', 'R2-1');
    expect(run.code).toBe(0);
    expect(run.out.council).toEqual({ run: 'wf_b', round: 3, approvedBy: 'R2-1', decided: [] });

    const reuse = council(draft, 3, 'wf_c', 1, '--approved', 'R2-1');
    expect(reuse.code).toBe(1);
    expect(reuse.out.refused[0].reason).toBe('--approved R2-1 was already used by council run wf_b');
  });

  test('a decision answer valued "convene" is not a council approval', () => {
    const fake = question({
      question: 'Convene?',
      options: [
        { label: 'Yes', description: '', value: 'convene' },
        { label: 'No', description: '', value: 'no' },
      ],
    });
    const draft = settledDraft([fake], [{ id: 'R1-1', question: 'Convene?', answer: 'Yes' }]);
    council(draft, 2, 'wf_a', 1);
    const run = council(draft, 2, 'wf_b', 1, '--approved', 'R1-1');
    expect(run.out.refused[0].reason).toBe('--approved R1-1 is a decision answer, not a council-approval one');
  });

  test('never past 3, and no approval question is asked at the cap', () => {
    const draft = newDraft();
    apply(draft);
    council(draft, 1, 'wf_1', 3, '--decided', JSON.stringify(['P1']));
    council(draft, 1, 'wf_2', 3, '--decided', JSON.stringify(['P2']));
    ask(draft, 1, [approval]);
    approve(draft, 'R1-1', 'Convene anyway');
    expect(council(draft, 2, 'wf_3', 3).code).toBe(0);
    const fourth = council(draft, 2, 'wf_4', 3, '--approved', 'R1-1');
    expect(fourth.code).toBe(1);
    expect(fourth.out.refused[0].reason).toBe('3 councils are recorded; no council is convened past 3');
    const asked = ask(draft, 2, [approval]);
    expect(asked.code).toBe(1);
    expect(asked.out.refused[0].reason).toBe(
      '3 councils are recorded, the cap; no approval question is asked at the cap',
    );
  });

  test('a repeated run id or decision id is refused; a ceiling past 3 is usage', () => {
    const draft = newDraft();
    apply(draft);
    council(draft, 1, 'wf_a', 3, '--decided', JSON.stringify(['P1']));
    expect(council(draft, 2, 'wf_a', 3).out.refused[0].reason).toBe('council run wf_a is already recorded');
    const reused = council(draft, 2, 'wf_b', 3, '--decided', JSON.stringify(['P1']));
    expect(reused.out.refused[0].reason).toBe("P1 already name an earlier council's decisions");
    expect(council(draft, 2, 'wf_b', 4).code).toBe(2);
    expect(council(draft, 2, 'wf_b', 3, '--decided', JSON.stringify(['D1'])).code).toBe(2);
  });
});

describe('review', () => {
  const review = (draft: string, round: number, verdict: string, ...flags: string[]) =>
    ledger('review', '--draft', draft, '--round', String(round), '--verdict', verdict, '--digest', DIGEST, ...flags);

  test('appends each verdict with its findings; nothing is recorded after a SHIP', () => {
    const draft = newDraft();
    apply(draft);
    const first = review(draft, 1, 'FIX-FIRST', '--findings', JSON.stringify(['HIGH-1', 'C11']));
    expect(first.out).toEqual({
      review: { verdict: 'FIX-FIRST', digest: DIGEST, round: 1, repaired: false, findings: ['HIGH-1', 'C11'] },
      ordinal: 1,
    });
    expect(review(draft, 1, 'SHIP', '--repaired').out.review.repaired).toBe(true);
    const after = review(draft, 2, 'SHIP');
    expect(after.code).toBe(1);
    expect(after.out.refused[0].reason).toBe('DESIGN.md is frozen by the SHIP recorded in round 1');
  });

  test('a bad verdict or digest is usage', () => {
    const draft = newDraft();
    apply(draft);
    expect(review(draft, 1, 'PASS').code).toBe(2);
    expect(
      ledger('review', '--draft', draft, '--round', '1', '--verdict', 'SHIP', '--digest', 'a2dd766c').out.error,
    ).toBe('--digest must be 64 lowercase hex characters');
  });
});

describe('render keeps every section it does not own byte-for-byte', () => {
  test('owned sections are rewritten in place, missing ones appended, everything else untouched', () => {
    const draft = newDraft();
    mkdirSync(dirname(draft), { recursive: true });
    const head = '# DRAFT: my idea\n\nWRS: ██░░░░░░░░ 20/100\n\n## Settled (round 1, prose)\nkept verbatim\n\n';
    const understanding = '## Understanding\n\nlead text\n```\n## Asked\nnot a heading inside a fence\n```\n\n';
    const open = '## Open\n\n- the gap map\n';
    writeFileSync(
      draft,
      `${head}## Settled\n\nstale hand edit\n### sub\nmore stale\n\n${understanding}## Asked\nstale\n${open}`,
    );
    apply(draft);
    ask(draft, 1, [question()]);
    const run = ledger('render', '--draft', draft);
    expect(run.out).toEqual({
      rewritten: ['Settled', 'Asked'],
      appended: ['Size', 'Scope ratchet', 'Councils'],
      changed: true,
    });
    const block = `\`\`\`ledger\n${JSON.stringify(blockOf(draft), null, 2)}\n\`\`\`\n`;
    const asked =
      '- **R1-1** (round 1, decision): Which size fits this idea?\n  1. M (Recommended) — one wish\n  2. G — a grouped wish';
    const owned = `${head}## Settled\n\n_Nothing settled yet._\n\n${understanding}## Asked\n\n${asked}\n\n${open}`;
    const appended =
      '## Size\n\n_Not sized yet._\n\n## Scope ratchet\n\n_No IN items yet._\n\n## Councils\n\n_None convened._\n';
    expect(readFileSync(draft, 'utf8')).toBe(`${owned}\n## Ledger\n\n${block}\n${appended}`);
    const before = readFileSync(draft, 'utf8');
    expect(ledger('render', '--draft', draft).out.changed).toBe(false);
    expect(readFileSync(draft, 'utf8')).toBe(before);
  });

  test('an owned section ends at the ledger block even with no heading between them', () => {
    const draft = newDraft();
    mkdirSync(dirname(draft), { recursive: true });
    const block = `\`\`\`ledger\n${JSON.stringify({ settled: [], asked: [], size: [], scopeIn: [], councils: [], reviews: [] }, null, 2)}\n\`\`\`\n`;
    writeFileSync(draft, `# DRAFT\n\n## Councils\n\nstale\n\n${block}\nnotes after the block\n`);
    expect(ledger('render', '--draft', draft).code).toBe(0);
    const text = readFileSync(draft, 'utf8');
    expect(text.startsWith(`# DRAFT\n\n## Councils\n\n_None convened._\n\n${block}\nnotes after the block\n`)).toBe(
      true,
    );
    expect(blockOf(draft).settled).toEqual([]);
  });

  test('two sections with one owned heading are refused, not guessed at', () => {
    const draft = newDraft();
    apply(draft);
    writeFileSync(draft, `${readFileSync(draft, 'utf8')}\n## Size\n\nduplicate\n`);
    const run = ledger('render', '--draft', draft);
    expect(run.code).toBe(1);
    expect(run.out.refused[0].reason).toBe('the DRAFT has 2 sections headed "## Size"; merge them');
  });

  test('a multi-line answer renders on one line, so it can never forge a heading', () => {
    const draft = settledDraft([question()], [answer('R1-1', 'keep it\n## Asked\nsmall')]);
    ledger('render', '--draft', draft);
    expect(readFileSync(draft, 'utf8')).toContain('owner said: "keep it ## Asked small"');
    expect(ledger('render', '--draft', draft).code).toBe(0);
  });
});

describe('the committed fixture (Decision 8)', () => {
  const design = readFileSync(FIXTURE_DESIGN, 'utf8');

  test('DESIGN.md is the frozen, SHIP-stamped design, byte for byte', () => {
    expect(designReviewViolations(design)).toEqual([]);
    expect(designReviewDigest(design)).toBe('a2dd766c158cc36431d81261d3165e83eda8ab21a31a8ea65e7baff869cf9775');
  });

  test('the DRAFT transcribes the cited ids with their DRAFT meaning, not the R<round>-<n> numbering', () => {
    const block = blockOf(FIXTURE_DRAFT);
    const settled = Object.fromEntries(block.settled.map((entry: Out) => [entry.id, entry]));
    for (const id of [
      'R1-1',
      'R1-2',
      'R2-4',
      'R2-5',
      'R3-council',
      'R3-agents',
      'R4-ceiling',
      'R4-delivery',
      'R5-roster',
    ]) {
      expect(settled[id]).toBeDefined();
    }
    expect(settled['R1-1'].answer).toStartWith('WRS returns as it was');
    expect(settled['R2-4'].answer).toStartWith('Spine fixed, inside free');
    expect(settled['R2-5'].answer).toStartWith("The council is Felipe's Socratic pattern");
    expect(settled['R1-3'].reopenedBy).toBe('R3-council');
    expect(block.councils[0].decided).toEqual(Array.from({ length: 16 }, (_, index) => `P${index + 1}`));
    expect(block.reviews[0].findings).toContain('C11');
    expect(block.reviews.at(-1)).toMatchObject({ verdict: 'SHIP', digest: designReviewDigest(design) });
  });

  test('check-design passes on it with the default root, and the fixture DRAFT is already rendered', () => {
    const run = ledger('check-design', '--design', FIXTURE_DESIGN, '--draft', FIXTURE_DRAFT);
    expect(run.out.findings).toEqual([]);
    expect(run.code).toBe(0);
    const copy = join(tempDir(), 'DRAFT.md');
    cpSync(FIXTURE_DRAFT, copy);
    expect(ledger('render', '--draft', copy).out.changed).toBe(false);
  });
});

describe('check-design', () => {
  const original = readFileSync(FIXTURE_DESIGN, 'utf8');

  function check(edit: (text: string) => string, root = ROOT): Run {
    const edited = edit(original);
    expect(edited).not.toBe(original);
    const path = join(tempDir(), 'DESIGN.md');
    writeFileSync(path, edited);
    return ledger('check-design', '--design', path, '--draft', FIXTURE_DRAFT, '--root', root);
  }

  const swap = (from: string, to: string) => (text: string) => {
    expect(text).toContain(from);
    return text.replace(from, to);
  };

  test('flags a criterion without Proof', () => {
    const run = check(
      swap(
        'a council past the ceiling. **Proof:** `scripts/brainstorm-round-ledger.test.ts`.',
        'a council past the ceiling.',
      ),
    );
    expect(run.code).toBe(1);
    expect(run.out.findings).toEqual([
      {
        kind: 'criterion-without-proof',
        location: 'Success Criteria #1 (line 115)',
        detail: 'add **Proof:**',
        blocking: true,
      },
    ]);
  });

  test('Decision 4: a Source needs a token; prose beside one is ignored, prose alone is not a Source', () => {
    const prose = check(
      swap('| Choosing a path changed no artifact | P3 |', '| Choosing a path changed no artifact | in PR #3085 |'),
    );
    expect(prose.out.findings).toEqual([
      expect.objectContaining({ kind: 'missing-source', location: 'Decisions #8 (line 94)', blocking: true }),
    ]);
    const outProse = check(swap('(Source: R3-agents; in PR #3085', '(Source: in PR #3085'));
    expect(outProse.out.findings.map((entry: Out) => [entry.kind, entry.location])).toEqual([
      ['missing-source', 'Scope OUT bullet 1 (line 28)'],
    ]);
    const outNone = check(swap(' (Source: P14).', '.'));
    expect(outNone.out.findings[0]).toMatchObject({ kind: 'missing-source', location: 'Scope OUT bullet 2 (line 29)' });
  });

  test('every token must resolve: Settled, council, reviewer and path', () => {
    const cases: Array<[string, string, string]> = [
      [
        "| Felipe's design; a visible progress view | R1-1 |",
        "| Felipe's design; a visible progress view | R1-9 |",
        'R1-9 is not a Settled id',
      ],
      ['(Source: P14)', '(Source: P17)', 'P17 is not a decision of any recorded council'],
      ['R4-ceiling, reviewer N2 |', 'R4-ceiling, reviewer N99 |', 'reviewer N99: no recorded review lists N99'],
      [
        '| `.claude/workflows/README.md` |\n',
        '| `.claude/workflows/MISSING.md` |\n',
        '`.claude/workflows/MISSING.md` does not exist under',
      ],
      ['| `.claude/workflows/README.md` |\n', '| `../outside.md` |\n', '`../outside.md` points outside the root'],
    ];
    for (const [from, to, detail] of cases) {
      const run = check(swap(from, to));
      expect(run.code).toBe(1);
      expect(run.out.findings).toHaveLength(1);
      expect(run.out.findings[0].kind).toBe('unresolved-source');
      expect(run.out.findings[0].detail).toContain(detail);
    }
  });

  test('Decision 5: reviewer round-<n> <id> resolves against the n-th review, criterion ids included', () => {
    expect(check(swap('reviewer round-1 C11', 'reviewer round-4 L9')).out.findings).toEqual([]);
    const wrongRound = check(swap('reviewer round-1 C11', 'reviewer round-2 HIGH-4'));
    expect(wrongRound.out.findings[0].detail).toBe('reviewer round-2 HIGH-4: review 2 lists no HIGH-4');
    const noRound = check(swap('reviewer round-1 C11', 'reviewer round-9 C11'));
    expect(noRound.out.findings[0].detail).toBe('reviewer round-9 C11: the ledger records 4 reviews');
  });

  test('flags an IN item without files and a table without a Source column', () => {
    const noFiles = check(swap('| `skills/brainstorm/references/design-template.md` |', '| the template |'));
    expect(noFiles.out.findings).toEqual([
      {
        kind: 'in-without-files',
        location: 'Scope IN #5 (line 23)',
        detail: 'name the files this item changes, each in backticks',
        blocking: true,
      },
    ]);
    const noColumn = check(swap('| # | Decision | Rationale | Source |', '| # | Decision | Rationale | Cite |'));
    expect(noColumn.out.findings).toEqual([
      {
        kind: 'missing-source',
        location: '## Decisions',
        detail: 'the Decisions table has no Source column',
        blocking: true,
      },
    ]);
  });

  test('flags a placeholder outside code spans and the evidence block', () => {
    const run = check(
      swap('## Approach\n', '## Approach\n\n<Concrete deliverable> by YYYY-MM-DD, owner TBD; `<code>` is fine.\n'),
    );
    expect(run.out.findings.map((entry: Out) => entry.detail)).toEqual([
      'placeholder <Concrete deliverable>',
      'placeholder YYYY-MM-DD',
      'placeholder TBD',
    ]);
    const pending = check(swap('- **Verdict:** SHIP', '- **Verdict:** PENDING'));
    expect(pending.out.findings).toEqual([]);
  });

  test('a backticked path resolves against --root', () => {
    const run = check((text) => `${text}\n`, tempDir());
    expect(run.code).toBe(1);
    expect(run.out.findings.map((entry: Out) => entry.detail)).toEqual([
      expect.stringContaining('`.claude/workflows/README.md` does not exist under'),
      expect.stringContaining('`.claude/workflows/README.md` does not exist under'),
    ]);
  });
});

describe('usage', () => {
  test('an unknown command, flag or missing flag exits 2 with one JSON object', () => {
    expect(ledger().code).toBe(2);
    expect(ledger('bogus').out.error).toBe('unknown command bogus');
    expect(ledger('render').out.error).toBe('render needs --draft');
    expect(ledger('render', '--draft', 'x', '--size', 'M').out.error).toBe('render does not take --size');
    expect(ledger('ask', '--draft', 'x', '--round', '0', '--questions', '[]').out.error).toBe(
      '--round must be a positive integer',
    );
  });

  test('a JSON flag may name a file, so question text never meets shell quoting', () => {
    const draft = newDraft();
    apply(draft);
    const file = join(tempDir(), 'questions.json');
    writeFileSync(file, JSON.stringify([question({ question: 'It\'s the owner\'s call: "M" or `G`?' })]));
    const run = ledger('ask', '--draft', draft, '--round', '1', '--questions', `@${file}`);
    expect(run.code).toBe(0);
    expect(run.out.asked[0].question).toBe('It\'s the owner\'s call: "M" or `G`?');
  });

  test('commands other than apply refuse a DRAFT that does not exist', () => {
    const run = ledger('render', '--draft', newDraft());
    expect(run.code).toBe(1);
    expect(run.out.refused[0].reason).toContain('DRAFT not found at');
  });
});
