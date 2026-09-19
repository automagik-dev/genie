import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANNOTATION_NAMES, ANNOTATOR_ID, PRICING_VERSION, annotationRows, measure, usd } from './annotate.js';

// Fixtures only: measure() reads the transcript on disk and no test here reaches Phoenix.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const jsonl = (rows: object[]) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
const bash = (id: string, command: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command } });
const usage = (ctx: number, output = 0) => ({ input_tokens: ctx, output_tokens: output });

function assistant(uuid: string, id: string, content: object[], opts: { ctx?: number; skill?: string } = {}) {
  return {
    type: 'assistant',
    uuid,
    sessionId: SID,
    attributionSkill: opts.skill,
    message: { id, model: 'claude-opus-5', usage: usage(opts.ctx ?? 1_000_000), content },
  };
}

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cc-obs-annotate-'));
  roots.push(dir);
  const repeated = 'git status';
  const rows = [
    { type: 'user', uuid: 'h1', sessionId: SID, message: { content: 'please fix it' } },
    // r1: a pure polling response (sleep) — 1M input tokens at $5/M = $5
    assistant('a1', 'r1', [bash('t1', 'sleep 30')], { skill: 'wish' }),
    // the same response id again: counted once
    assistant('a1b', 'r1', [bash('t1b', 'sleep 5')], { skill: 'wish' }),
    // r2: real work, four identical commands (the repeat threshold) and one failing tool
    assistant('a2', 'r2', [bash('t2', repeated), bash('t3', repeated), bash('t4', repeated), bash('t5', repeated)], {
      ctx: 600_000,
      skill: 'review',
    }),
    {
      type: 'user',
      uuid: 'u2',
      sessionId: SID,
      message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'x', is_error: true }] },
    },
    // back to wish: a second run of the same skill is one re-invocation
    assistant('a3', 'r3', [{ type: 'text', text: 'done' }], { ctx: 2_000, skill: 'wish' }),
    { type: 'user', uuid: 'i1', sessionId: SID, message: { content: '[Request interrupted by user]' } },
    { type: 'system', uuid: 'c1', subtype: 'compact_boundary', sessionId: SID },
    { type: 'user', uuid: 'm1', sessionId: SID, isMeta: true, message: { content: 'meta' } },
  ];
  const path = join(dir, `${SID}.jsonl`);
  writeFileSync(path, jsonl(rows));
  const sub = join(dir, SID, 'subagents');
  mkdirSync(sub, { recursive: true });
  writeFileSync(
    join(sub, 'agent-x.jsonl'),
    jsonl([
      { type: 'user', uuid: 's0', message: { content: 'sub prompt (not a human turn)' } },
      assistant('s1', 'sr1', [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: {} }], { ctx: 10 }),
    ]),
  );
  return path;
}

describe('measure', () => {
  test('computes every metric from the fixture transcript and its subagents', () => {
    const m = measure(fixture());
    expect(m.responses).toBe(4);
    expect(m.polling_responses).toBe(1);
    expect(m.polling_share).toBe(0.25);
    expect(m.tool_calls).toBe(7);
    expect(m.tool_errors).toBe(1);
    expect(m.tool_error_rate).toBeCloseTo(1 / 7, 10);
    expect(m.interrupts).toBe(1);
    expect(m.ask_user).toBe(1);
    expect(m.max_context).toBe(1_000_000);
    expect(m.compactions).toBe(1);
    expect(m.repeated_commands).toBe(4);
    expect(m.skill_reinvocations).toBe(1);
    expect(m.human_turns).toBe(1);
    expect(m.waste_usd).toBeCloseTo(5, 10);
    expect(m.total_usd).toBeCloseTo(5 + 3 + 0.01 + 0.00005, 10);
  });
});

describe('annotationRows', () => {
  test('emits the eight session annotations under code-annotator/v1', () => {
    const m = measure(fixture());
    const rows = annotationRows(SID, m);
    expect(ANNOTATOR_ID).toBe('code-annotator/v1');
    expect(rows.map((r) => r.name)).toEqual([
      'polling_share',
      'tool_error_rate',
      'interrupts',
      'max_context',
      'compactions',
      'rework',
      'waste_usd',
      'total_usd',
    ]);
    expect(rows.map((r) => r.name)).toEqual([...ANNOTATION_NAMES]);
    for (const row of rows) {
      expect(row).toMatchObject({ session_id: SID, annotator_kind: 'CODE', identifier: 'code-annotator/v1' });
      expect(row.metadata.pricing_version).toBe(PRICING_VERSION);
    }
    const score = (name: string) => rows.find((r) => r.name === name)?.result;
    expect(score('polling_share')).toEqual({ score: 0.25, label: 'high', explanation: null });
    expect(score('tool_error_rate')).toEqual({ score: 0.1429, label: 'high', explanation: null });
    expect(score('interrupts')).toEqual({ score: 1, label: 'interrupted', explanation: null });
    expect(score('max_context')).toEqual({ score: 1_000_000, label: 'bloated', explanation: null });
    expect(score('compactions')).toEqual({ score: 1, label: 'compacted', explanation: null });
    expect(score('rework')).toEqual({ score: 5, label: 'ok', explanation: null });
    expect(score('waste_usd')).toEqual({ score: 5, label: 'ok', explanation: null });
    expect(score('total_usd')).toEqual({ score: 8.01, label: PRICING_VERSION, explanation: null });
  });
});

describe('usd', () => {
  test('prices by model and falls back to the opus-5 row', () => {
    expect(usd('claude-sonnet-5', 1e6, 0, 0, 0)).toBeCloseTo(0.2, 10);
    expect(usd('unknown-model', 0, 0, 0, 1e6)).toBeCloseTo(25, 10);
  });
});
