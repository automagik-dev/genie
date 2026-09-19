import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanRepoSkills } from '../skills-inventory-parity.js';
import {
  type Span,
  bashHead,
  canonicalSkill,
  convertHeadlessSession,
  convertSession,
  finalizeSpans,
  genieSkillRoster,
  parseBackfillArgs,
  projectNameFor,
  scrub,
  setContentLevel,
  stripNul,
} from './backfill.js';

// Fixtures only: the converter is pure over the transcript, and no test here reaches Phoenix.

const NUL = String.fromCharCode(0);
const REPO_ROOT = join(import.meta.dir, '..', '..');
const roots: string[] = [];

afterEach(() => {
  setContentLevel('metadata');
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function mkroot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cc-obs-backfill-'));
  roots.push(root);
  return root;
}

const jsonl = (rows: object[]) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;

describe('scrub', () => {
  test('redacts credential shapes and keeps the prefix', () => {
    expect(scrub(`ghp_${'A'.repeat(36)} x`)).toBe('[REDACTED] x');
    expect(scrub('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')).toBe('Authorization: Bearer [REDACTED]');
    expect(scrub('token=abcdefghijklmnopqrstuvwxyz0123')).toBe('token=[REDACTED]');
    expect(scrub('plain git status')).toBe('plain git status');
  });

  test('strips NUL (Postgres text rejects it)', () => {
    const input = 'a\u0000b\u0000';
    expect(input.includes(NUL)).toBe(true);
    expect(scrub(input)).toBe('ab');
    expect(stripNul(`x${NUL}y`)).toBe('xy');
  });

  test('neither the converter nor this test carries a raw NUL byte or a control-character suppression', () => {
    for (const file of ['backfill.ts', 'backfill.test.ts']) {
      const bytes = readFileSync(join(import.meta.dir, file));
      expect(bytes.includes(0)).toBe(false);
      expect(bytes.toString('utf8').includes(['noControlCharacters', 'InRegex'].join(''))).toBe(false);
    }
  });
});

describe('canonicalSkill roster', () => {
  test('is the skills/*/SKILL.md inventory, and never the non-skill trace', () => {
    const tree = scanRepoSkills(REPO_ROOT).names;
    expect(tree.length).toBeGreaterThan(0);
    expect(genieSkillRoster()).toEqual(tree);
    expect(genieSkillRoster()).not.toContain('trace');
    for (const name of tree) expect(canonicalSkill(name)).toBe(`genie:${name}`);
    expect(canonicalSkill('trace')).toBe('trace');
  });

  test('keeps foreign and already-qualified names as they are', () => {
    expect(canonicalSkill('wish')).toBe('genie:wish');
    expect(canonicalSkill('genie:wish')).toBe('genie:wish');
    expect(canonicalSkill('dataviz')).toBe('dataviz');
    expect(canonicalSkill(null)).toBeNull();
    expect(canonicalSkill('')).toBeNull();
  });

  test('a skill directory without SKILL.md is not on the roster', () => {
    const root = mkroot();
    mkdirSync(join(root, 'skills', 'alpha'), { recursive: true });
    writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\n---\n');
    mkdirSync(join(root, 'skills', 'beta'), { recursive: true });
    expect(genieSkillRoster(root)).toEqual(['alpha']);
  });
});

const SID = '11111111-2222-3333-4444-555555555555';
const t = (s: number) => new Date(Date.UTC(2026, 8, 1, 0, 0, s)).toISOString();
const usage = { input_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 5 };

function fixture(): string {
  const dir = mkroot();
  const rows = [
    { type: 'user', uuid: 'u1', sessionId: SID, promptId: 'p1', timestamp: t(0), message: { content: 'do it' } },
    {
      type: 'assistant',
      uuid: 'a1',
      sessionId: SID,
      attributionSkill: 'wish',
      timestamp: t(1),
      message: { id: 'msg1', model: 'claude-fable-5', usage, content: [{ type: 'text', text: `running${NUL}` }] },
    },
    {
      type: 'assistant',
      uuid: 'a2',
      sessionId: SID,
      attributionSkill: 'wish',
      timestamp: t(2),
      message: {
        id: 'msg1',
        model: 'claude-fable-5',
        usage,
        content: [
          { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: `cd x && git status${NUL}` } },
          { type: 'tool_use', id: 'tu2', name: 'Agent', input: { subagent_type: 'Explore', prompt: 'look' } },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'u2',
      sessionId: SID,
      timestamp: t(3),
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tu1', content: `hi${NUL}`, is_error: false },
          { type: 'tool_result', tool_use_id: 'tu2', content: 'done', is_error: true },
        ],
      },
    },
    // a resumed session re-appends an earlier record verbatim
    { type: 'assistant', uuid: 'a2', sessionId: SID, timestamp: t(2), message: { id: 'msg1', content: [] } },
    {
      type: 'assistant',
      uuid: 'a3',
      sessionId: SID,
      timestamp: t(4),
      message: { id: 'msg2', model: 'claude-fable-5', usage, content: [{ type: 'text', text: 'ok' }] },
    },
  ];
  writeFileSync(join(dir, `${SID}.jsonl`), jsonl(rows));
  const subDir = join(dir, SID, 'subagents');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(subDir, 'agent-a.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 'tu2' }));
  writeFileSync(
    join(subDir, 'agent-a.jsonl'),
    jsonl([
      { type: 'user', uuid: 's1', timestamp: t(2), message: { content: 'look' } },
      {
        type: 'assistant',
        uuid: 's2',
        timestamp: t(3),
        message: { id: 'sub-msg', model: 'claude-opus-5', usage, content: [{ type: 'text', text: 'found' }] },
      },
    ]),
  );
  return join(dir, `${SID}.jsonl`);
}

const byKind = (spans: Span[], kind: Span['span_kind']) => spans.filter((s) => s.span_kind === kind);

describe('convertSession', () => {
  test('emits turn CHAIN > skill AGENT > LLM per message.id > TOOL > subagent AGENT', () => {
    const ctx = convertSession(fixture(), 'cc-genie', 'u');
    expect(ctx.stats).toEqual({ turns: 1, llm: 3, tools: 2, skills: 1, subagents: 1, toolErrors: 1 });
    const [turn] = byKind(ctx.spans, 'CHAIN');
    expect(turn?.parent_id).toBeNull();
    expect(turn?.name).toBe('turn');
    const skill = ctx.spans.find((s) => s.name === 'skill:genie:wish') as Span;
    expect(skill.span_kind).toBe('AGENT');
    expect(skill.parent_id).toBe(turn?.context.span_id as string);

    const llms = byKind(ctx.spans, 'LLM');
    const main = llms.find((s) => s.attributes['metadata.skill'] === 'genie:wish') as Span;
    expect(main.parent_id).toBe(skill.context.span_id);
    expect(main.attributes['llm.token_count.prompt']).toBe(111);
    // msg2 carries no skill: its LLM span hangs off the turn directly
    const plain = llms.find((s) => s.parent_id === turn?.context.span_id) as Span;
    expect(plain.attributes['metadata.skill']).toBe('');

    const tools = byKind(ctx.spans, 'TOOL');
    for (const tool of tools) expect(tool.parent_id).toBe(main.context.span_id);
    const bash = tools.find((s) => s.name === 'Bash') as Span;
    expect(bash.attributes['metadata.bash_head']).toBe('git');
    const agentTool = tools.find((s) => s.name === 'Agent') as Span;
    expect(agentTool.status_code).toBe('ERROR');

    const sub = ctx.spans.find((s) => s.name === 'subagent:Explore') as Span;
    expect(sub.span_kind).toBe('AGENT');
    expect(sub.parent_id).toBe(agentTool.context.span_id);
    expect(sub.attributes['metadata.linked_by']).toBe('tool_use_id');
    const subLlm = llms.find((s) => s.name === 'claude-opus-5') as Span;
    expect(subLlm.parent_id).toBe(sub.context.span_id);

    for (const s of ctx.spans) expect(s.context.trace_id).toBe(turn?.context.trace_id as string);
    expect(ctx.spans.every((s) => s.attributes['session.id'] === SID)).toBe(true);
  });

  test('ids are deterministic across runs and unique within a run', () => {
    const path = fixture();
    const a = convertSession(path, 'cc-genie', 'u').spans.map((s) => `${s.context.trace_id}/${s.context.span_id}`);
    const b = convertSession(path, 'cc-genie', 'u').spans.map((s) => `${s.context.trace_id}/${s.context.span_id}`);
    expect(new Set(a).size).toBe(a.length);
    expect(a).toEqual(b);
  });

  test('metadata profile writes no content; head profile scrubs and strips NUL', () => {
    const path = fixture();
    const meta = convertSession(path, 'p', 'u');
    expect(meta.spans.every((s) => (s.attributes['output.value'] ?? '') === '')).toBe(true);
    setContentLevel('head');
    const head = finalizeSpans(convertSession(path, 'p', 'u').spans);
    const texts = head.flatMap((s) => Object.values(s.attributes)).filter((v) => typeof v === 'string');
    expect(texts.some((v) => v === 'running')).toBe(true);
    expect(texts.every((v) => !(v as string).includes(NUL))).toBe(true);
  });

  test('a headless session promotes every subagent to its own root', () => {
    const path = fixture();
    const ctx = convertHeadlessSession(path.replace(/\.jsonl$/, ''), 'p', 'u');
    const roots = ctx.spans.filter((s) => s.parent_id === null);
    expect(roots.map((s) => s.name)).toEqual(['subagent:Explore']);
    expect(roots[0]?.attributes['metadata.headless_session']).toBe(true);
  });
});

describe('finalizeSpans', () => {
  test('drops repeated span ids and strips NUL from names, attributes and status messages', () => {
    const span = (id: string): Span => ({
      name: `n${NUL}`,
      context: { trace_id: 't', span_id: id },
      parent_id: null,
      span_kind: 'TOOL',
      start_time: t(0),
      end_time: t(1),
      status_code: 'ERROR',
      status_message: `bad${NUL}`,
      attributes: { a: `v${NUL}`, tags: [`x${NUL}`] },
    });
    const out = finalizeSpans([span('1'), span('1'), span('2')]);
    expect(out.map((s) => s.context.span_id)).toEqual(['1', '2']);
    expect(out[0]).toMatchObject({ name: 'n', status_message: 'bad', attributes: { a: 'v', tags: ['x'] } });
  });
});

describe('projectNameFor', () => {
  test('names projects cc-<repo>', () => {
    const home = '/h/user';
    expect(projectNameFor('-h-user-workspace-repos-genie', home)).toBe('cc-genie');
    expect(projectNameFor('-h-user-notes', home)).toBe('cc-notes');
    expect(projectNameFor('-h-user', home)).toBe('cc-home');
    expect(projectNameFor('-private-tmp-x', home)).toBe('cc-scratch');
  });
});

describe('parseBackfillArgs', () => {
  test('carries --dry-run, --replace, --incremental and --verify', () => {
    const o = parseBackfillArgs(['--dry-run', '--verify', '--verify-timeout', '60', '--project', 'cc-x', 'a.jsonl']);
    expect(o).toMatchObject({ dryRun: true, verify: true, verifyTimeoutS: 60, project: 'cc-x', files: ['a.jsonl'] });
    expect(parseBackfillArgs(['--replace', 'a.jsonl']).replace).toBe(true);
    expect(parseBackfillArgs(['--incremental', 'a.jsonl']).incremental).toBe(true);
    expect(parseBackfillArgs(['a.jsonl']).content).toBe('metadata');
  });

  test('rejects what the usage does not allow', () => {
    expect(() => parseBackfillArgs(['--replace', '--incremental', 'a.jsonl'])).toThrow(/exclusive/);
    expect(() => parseBackfillArgs(['--content', 'raw', 'a.jsonl'])).toThrow(/--content/);
    expect(() => parseBackfillArgs(['--bogus', 'a.jsonl'])).toThrow(/unknown flag/);
    expect(() => parseBackfillArgs(['--dry-run'])).toThrow(/no transcript/);
  });
});

describe('bashHead', () => {
  test('skips cd prefixes and env assignments', () => {
    expect(bashHead('cd /x && FOO=1 bun test')).toBe('bun');
    expect(bashHead('   ')).toBe('?');
  });
});
