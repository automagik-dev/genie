import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Content contract for the card conversation (council 2026-09-15, decision "revise" applied):
// engineers report once per claim, the orchestrator relays gates as comments, the
// reviewer never writes to the card, and every example passes --worker and `--`.

const ROOT = join(import.meta.dir, '..');
const skill = (name: string) => readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');

describe('card conversation contract in the skills', () => {
  test('work briefs open with checkout and close with one attributed report', () => {
    const work = skill('work');
    expect(work).toMatch(/genie task checkout <task-id> --worker <name>/);
    expect(work).toMatch(/genie task report <task-id> --worker <name> -- '/);
    expect(work).toContain('at most one report per claim-to-handoff span and one comment per gate');
    expect(work).toContain('never post periodic progress');
    expect(work).toContain('The reviewer never writes to the card.');
    expect(work).toContain('is the global task state');
    expect(work).toMatch(/orchestration\.mode = orca[^\n]*Orca is the lifecycle authority/);
  });

  test('the orchestrator relays every gate as a comment before task done', () => {
    const work = skill('work');
    const done = work.indexOf('genie task done <task-id>\n```');
    const relay = work.indexOf("genie task comment <task-id> --worker orchestrator -- 'review: SHIP");
    expect(relay).toBeGreaterThan(-1);
    expect(relay).toBeLessThan(done);
  });

  test("the reviewer stays read-only and the relay is the orchestrator's", () => {
    const review = skill('review');
    expect(review).toContain('The reviewer never mutates files or task state');
    expect(review).toContain('posts nothing to the card');
    expect(review).toMatch(/genie task comment <task-id> --worker orchestrator -- 'review: SHIP\|FIX-FIRST\|BLOCKED/);
  });

  test('the fix loop relays re-review verdicts and never lets the fixer post', () => {
    const fix = skill('fix');
    expect(fix).toContain('posts nothing to the card');
    expect(fix).toMatch(/genie task comment <task-id> --worker orchestrator -- 'review:/);
  });

  test('the worker reports its rulings and keeps a plan-identified ledger', () => {
    const work = skill('work');
    expect(work).toContain('Ruling: <what was decided> — <why> — <cost if wrong>');
    expect(work).toMatch(/genie task report <task-id> --worker <name> -- '[^\n]*Ruling: /);
    expect(work).toContain('Its first line is the plan identity');
    expect(work).toContain('the only resumption authority');
  });

  test('the reviewer pre-commits criteria and names evidence provenance', () => {
    const review = skill('review');
    expect(review).toContain('The first sees only the scope');
    expect(review).toContain('scores it against that frozen plan');
    expect(review).toContain('Each finding also names where its evidence came from');
    expect(review).toContain('is an unresolved hypothesis, not a confirmed finding');
  });

  test('converged fix attempts never self-authorize a release-affecting repair', () => {
    const fix = skill('fix');
    expect(fix).toContain('Recursive confidence is not approval');
    expect(fix).toMatch(/release machinery, retirement or backup paths, the install record/);
    expect(fix).toContain('until an independent re-review passes and the coordinator records a human ruling');
    expect(fix).toContain('genie config get budgets.maxEscalationsPerGroup');
    expect(fix).toContain('budget_source=');
  });

  test('every comment/report example in skills passes --worker and separates text with --', () => {
    for (const name of ['work', 'review', 'fix', 'genie']) {
      const text = skill(name);
      for (const line of text.split('\n')) {
        if (!/genie task (comment|report) /.test(line)) continue;
        expect(line, `${name}: ${line}`).toMatch(/--worker/);
        expect(line, `${name}: ${line}`).toMatch(/ -- '/);
      }
    }
  });
});
