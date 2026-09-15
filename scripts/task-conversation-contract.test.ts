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
    expect(work).toMatch(/genie task checkout <task-id> --worker <engineer-name>/);
    expect(work).toMatch(/genie task report <task-id> --worker <engineer-name> -- '/);
    expect(work).toContain('at most one report per claim-to-handoff span and one comment per gate');
    expect(work).toContain('never post periodic progress');
    expect(work).toContain('The reviewer never writes to the card.');
    expect(work).toContain('Card conversation is the global task state.');
    expect(work).toMatch(/orchestration\.mode = orca[^\n]*Orca is the lifecycle authority/);
  });

  test('the orchestrator relays every gate as a comment before task done', () => {
    const work = skill('work');
    const done = work.indexOf('genie task done <task-id>\n   ```');
    const relay = work.indexOf("genie task comment <task-id> --worker orchestrator -- 'review: SHIP");
    expect(relay).toBeGreaterThan(-1);
    expect(relay).toBeLessThan(done);
  });

  test("the reviewer stays read-only and the relay is the orchestrator's", () => {
    const review = skill('review');
    expect(review).toContain('The reviewer never mutates files or task state');
    expect(review).toContain('The reviewer\nposts nothing to the card.');
    expect(review).toMatch(/genie task comment <task-id> --worker orchestrator -- 'review: SHIP\|FIX-FIRST\|BLOCKED/);
  });

  test('the fix loop relays re-review verdicts and never lets the fixer post', () => {
    const fix = skill('fix');
    expect(fix).toContain('The fixer posts nothing.');
    expect(fix).toMatch(/genie task comment <task-id> --worker orchestrator -- 'review:/);
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
