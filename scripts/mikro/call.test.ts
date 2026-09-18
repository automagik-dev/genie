import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractJson, parseFooter, stripFooter, verifyCitations } from './call';
import { IssueTriage, SCHEMAS } from './schemas';

const FOOTER =
  'mikro · issue-triage · deepseek-api/deepseek-flash · 7 iterations · 12,345 in / 1,234 out · $0.0031 · 84.2s · session 3f2a-b1';

describe('parseFooter', () => {
  test('parses the seven fields and the session id', () => {
    const f = parseFooter(`answer\n${FOOTER}`);
    expect(f).toEqual({
      label: 'issue-triage',
      model: 'deepseek-api/deepseek-flash',
      iterations: 7,
      tokensIn: 12345,
      tokensOut: 1234,
      cost: 0.0031,
      seconds: 84.2,
      budgetHit: null,
      validationFailed: false,
      sessionId: '3f2a-b1',
    });
  });
  test('reads budget hit and validation_failed, singular iteration', () => {
    const f = parseFooter(
      'x\nmikro · q · m/m · 1 iteration · 1 in / 2 out · $0.00 · 1.0s · budget hit: max_iterations · validation_failed: true · session s',
    );
    expect(f?.iterations).toBe(1);
    expect(f?.budgetHit).toBe('max_iterations');
    expect(f?.validationFailed).toBe(true);
  });
  test('returns null without a footer and stripFooter leaves the answer', () => {
    expect(parseFooter('no footer here')).toBeNull();
    expect(stripFooter(`the answer\n${FOOTER}`)).toBe('the answer');
  });
});

describe('extractJson', () => {
  test('takes the last json fence that parses', () => {
    const text = 'prose ```json\n{"a":1}\n``` more ```json\n{"b":2}\n```';
    expect(extractJson(text).value).toEqual({ b: 2 });
  });
  test('falls back to the outermost braces', () => {
    expect(extractJson('FINAL: {"ok": true} trailing').value).toEqual({ ok: true });
  });
  test('names the failure when nothing parses', () => {
    expect(extractJson('nothing').error).toMatch(/no JSON object/);
    expect(extractJson('{ not json }').error).toMatch(/no parseable/);
  });
});

describe('verifyCitations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mikro-cite-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'l1\nl2\nl3\n');
  test('accepts existing path:line, rejects past-end, missing and traversal', () => {
    const parsed = {
      facts: [
        { claim: 'x', evidence: 'src/a.ts:2' },
        { claim: 'y', evidence: 'src/a.ts:99' },
        { claim: 'z', evidence: 'src/missing.ts:1' },
      ],
      candidate_files: [
        { path: 'src/a.ts', why: 'w' },
        { path: '../etc/passwd', why: 'w' },
      ],
    };
    const cites = verifyCitations(parsed, dir);
    const byKey = Object.fromEntries(cites.map((c) => [`${c.path}:${c.line ?? ''}`, c]));
    expect(byKey['src/a.ts:2'].ok).toBe(true);
    expect(byKey['src/a.ts:99'].ok).toBe(false);
    expect(byKey['src/missing.ts:1'].ok).toBe(false);
    expect(byKey['src/a.ts:'].ok).toBe(true);
    expect(byKey['../etc/passwd:'].ok).toBe(false);
  });
  test('a deleted file in review-prep is not a failed citation', () => {
    const cites = verifyCitations({ files: [{ path: 'gone.ts', change: 'deleted' }] }, dir);
    expect(cites[0].ok).toBe(true);
  });
});

describe('schemas', () => {
  test('every agent schema rejects an empty object and accepts its own minimal record', () => {
    for (const schema of Object.values(SCHEMAS)) expect(schema.safeParse({}).success).toBe(false);
    const ok = IssueTriage.safeParse({
      issue: 1,
      title: 't',
      type: 'bug',
      area: ['a'],
      summary: 's',
      repro: { present: false },
      candidate_files: [{ path: 'src/x.ts', why: 'w' }],
      lane: 'patch',
      first_question: null,
    });
    expect(ok.success).toBe(true);
  });
});
