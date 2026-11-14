/**
 * Shared-input parity between the legacy session-log parser and the Rust meter (meter wish, Group 2).
 *
 * One synthetic corpus, two frozen answers:
 *
 *   __fixtures__/meter-parity/sessions.jsonl        five tasks of Claude Code and Codex logs plus the Herdr
 *                                                  workers-ledger start rows that tie them to tasks; one
 *                                                  `{file, record}` (or `{file, thread}` for the Codex state
 *                                                  database) per line, with `{{ROOT}}`, `{{DAY}}`, `{{DAYDIR}}`,
 *                                                  `{{T0_MS}}` and `{{T1_MS}}` as the only machine-bound values
 *   __fixtures__/meter-parity/legacy-summary.json   what genie's export computed from those logs before the
 *                                                  cutover (`readUsageSamples` + `sumUsage` + `tableCost`)
 *   __fixtures__/meter-parity/usagemeter-query.json what `usagemeter query --by task` answered for the same logs
 *
 * Nothing here runs a parser or the meter: both answers are frozen. The legacy parser
 * (`src/lib/metrics-usage.ts`) was deleted with this cutover; its answer stays here as history.
 *
 * What the comparison shows, task by task:
 *   gn-1  Claude, one response streamed as two records: both count it once; tokens and cost agree.
 *   gn-2  Codex, one cumulative total re-emitted: both count it once; tokens and cost agree. The meter also
 *         reports `reasoning` (inside `output`, as Codex counts it); legacy had no such field.
 *   gn-3  Claude with a subagent sidecar that repeats a parent response: both dedupe it (legacy by message id
 *         across the session's files, the meter by message id + request id); tokens and cost agree.
 *   gn-4  a model no price table knows: legacy said `costUsd: null` with nothing else; the meter says
 *         `cost.state: "unpriced"`, names the model and keeps the measured tokens. Neither ever said 0.
 *   gn-5  one priced and one unpriced call: legacy's `costUsd` was the priced part alone, printed as the total
 *         (only `pricedCalls` hinted, and only with a price table loaded); the meter says `partial` and counts
 *         the unpriced tokens. The USD of the priced part agrees.
 * Cache writes: legacy kept one `cacheWrite` sum (it priced the 1-hour part per call); the meter keeps the
 * 5-minute and 1-hour writes apart, and their sum agrees. The meter rounds USD to 4 decimals, so cost agrees
 * within half of that last digit.
 * Reported cost: Claude Code and Codex logs carry no price, so neither side has one — legacy priced every
 * call from the table, and the meter reports `usd_reported` 0 (null where it priced nothing).
 *
 * Regeneration. The legacy side is history: it was produced at cb5a8be2, the last commit whose export read
 * session logs, by running `buildIntervals` over one whole-day `claim→report` interval per task with a price
 * table holding the meter's bundled list prices (`priceTableUsdPerMillion`), and it is not regenerated. The
 * meter side is regenerated with the real binary against a throwaway tree, never the operator's store (Linux
 * `date`; `jq`, `sqlite3` and `git` on PATH; the meter only answers about recent days, so the corpus is
 * placed on yesterday):
 *
 *   umask 077; FX=src/lib/__fixtures__/meter-parity; ROOT=$(mktemp -d); DAY=$(date -u -d yesterday +%F)
 *   T0=$(( $(date -u -d "${DAY}T09:00:00Z" +%s) * 1000 )); T1=$(( $(date -u -d "${DAY}T11:00:00Z" +%s) * 1000 ))
 *   git -c init.defaultBranch=main init -q "$ROOT/work/Widgets"
 *   git -C "$ROOT/work/Widgets" remote add origin https://example.com/Acme/Widgets.git
 *   git -C "$ROOT/work/Widgets" -c user.name=p -c user.email=p@example.com commit -q --allow-empty -m init
 *   sed -e "s|{{ROOT}}|$ROOT|g" -e "s|{{DAYDIR}}|${DAY//-//}|g" -e "s|{{DAY}}|$DAY|g" \
 *       -e "s|\"{{T0_MS}}\"|$T0|g" -e "s|\"{{T1_MS}}\"|$T1|g" "$FX/sessions.jsonl" > "$ROOT/expanded.jsonl"
 *   jq -r 'select(.record.event == "start") | .record.branch + " " + .record.worktree' "$ROOT/expanded.jsonl" |
 *     while read -r b w; do git -C "$ROOT/work/Widgets" worktree add -q -b "$b" "$w"; done
 *   jq -c 'select(.record)' "$ROOT/expanded.jsonl" | while IFS= read -r l; do
 *     f="$ROOT/$(jq -r .file <<<"$l")"; mkdir -p "$(dirname "$f")"; jq -c .record <<<"$l" >> "$f"; done
 *   mkdir -p "$ROOT/home/.codex"; sqlite3 "$ROOT/home/.codex/state_5.sqlite" 'CREATE TABLE threads (id TEXT
 *     PRIMARY KEY, rollout_path TEXT, tokens_used INTEGER, cwd TEXT, model TEXT, git_branch TEXT,
 *     git_origin_url TEXT, updated_at_ms INTEGER, archived INTEGER)'
 *   jq -r 'select(.thread) | .thread | [.id, .rollout_path, .tokens_used, .cwd, .model, .git_branch,
 *     .git_origin_url, .updated_at_ms, .archived] | @csv' "$ROOT/expanded.jsonl" |
 *     sqlite3 -csv "$ROOT/home/.codex/state_5.sqlite" '.import /dev/stdin threads'
 *   meter() { env -i HOME="$ROOT/home" PATH=/usr/bin:/bin METER_STATE_DIR="$ROOT/state" \
 *     CLAUDE_CONFIG_DIR="$ROOT/home/.claude" CODEX_HOME="$ROOT/home/.codex" HERDR_APP_HOME="$ROOT/app" \
 *     METER_HC="$ROOT/no-hc" ~/.local/bin/usagemeter "$@"; }
 *   meter sync --force --no-publish
 *   meter query --repo example.com/Acme/Widgets --by task --window d30 --json |
 *     jq '.machine.id = "m-000000000000000000000000"' > "$FX/usagemeter-query.json"
 *   bunx biome format --write "$FX"
 *
 * A regenerated golden differs only in its timestamps, `meter_version` and the meter's own fields; the token
 * and cost fields this test compares must not move. If they do, the meter changed its accounting: say why in
 * the commit that refreezes the file.
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FX = join(import.meta.dir, '__fixtures__', 'meter-parity');
const sessionsText = readFileSync(join(FX, 'sessions.jsonl'), 'utf8');

interface LegacyUsage {
  calls: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  costUsd: number | null;
  pricedCalls: number;
  costSource: string | null;
}
interface LegacySummary {
  sessionsSha256: string;
  tasks: Array<{ task: string; usage: LegacyUsage }>;
}
interface MeterRow {
  task: string;
  state: string;
  reason: string | null;
  tokens: Record<
    'input' | 'cache_read' | 'cache_write_5m' | 'cache_write_1h' | 'output' | 'unsplit' | 'total',
    number
  > & {
    reasoning: number | null;
  };
  cost: {
    state: string;
    usd: number | null;
    usd_reported: number | null;
    usd_estimated: number | null;
    tokens_priced: number;
    tokens_reported: number;
    tokens_unpriced: number;
    unpriced_models: string[];
  };
}

const legacy = JSON.parse(readFileSync(join(FX, 'legacy-summary.json'), 'utf8')) as LegacySummary;
const meter = JSON.parse(readFileSync(join(FX, 'usagemeter-query.json'), 'utf8'));
const rows = meter.rows as MeterRow[];
const rowOf = (task: string): MeterRow => {
  const row = rows.find((r) => r.task === task);
  if (!row) throw new Error(`the meter golden has no row for ${task}`);
  return row;
};
/** The meter prints USD to 4 decimals: a legacy float agrees when it is within half of that last digit. */
const sameUsd = (meterUsd: number | null, legacyUsd: number | null) =>
  meterUsd !== null && legacyUsd !== null && Math.abs(meterUsd - legacyUsd) <= 0.00005 + 1e-12;

describe('meter parity fixtures', () => {
  test('both answers belong to the frozen corpus, and the corpus carries no machine-bound value', () => {
    expect(createHash('sha256').update(sessionsText).digest('hex')).toBe(legacy.sessionsSha256);
    const lines = sessionsText.trimEnd().split('\n');
    for (const raw of lines) {
      const line = JSON.parse(raw) as { file: string; record?: unknown; thread?: unknown };
      expect(typeof line.file).toBe('string');
      expect(line.record !== undefined || line.thread !== undefined).toBe(true);
    }
    // Absolute paths start at the {{ROOT}} placeholder; no home folder, user or machine name is frozen.
    expect(sessionsText).not.toMatch(/"\/(?:home|Users|root|tmp|mnt)\//);
    expect(JSON.stringify(meter)).not.toMatch(/\/(?:home|Users|root|tmp|mnt)\//);
    expect(meter.machine.id).toBe('m-000000000000000000000000');
  });

  test('the meter golden is a Contract 1 ok --by task answer for the corpus repository, one row per task', () => {
    expect(meter).toMatchObject({
      contract: 'usagemeter.query',
      contract_version: 1,
      capability: 'meter.usage@1',
      status: 'ok',
      error: null,
      query: { repo: 'example.com/Acme/Widgets', by: 'task', window: 'd30' },
    });
    expect(meter.meter_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(rows.map((r) => r.task).sort()).toEqual(legacy.tasks.map((t) => t.task).sort());
    for (const row of rows) expect(row).toMatchObject({ state: 'measured', reason: null });
  });

  test('tokens agree exactly on every task; the meter splits cache writes by TTL and reports reasoning', () => {
    for (const { task, usage } of legacy.tasks) {
      const { tokens } = rowOf(task);
      expect({ task, input: tokens.input, cacheRead: tokens.cache_read, output: tokens.output }).toEqual({
        task,
        input: usage.input,
        cacheRead: usage.cacheRead,
        output: usage.output,
      });
      expect(tokens.cache_write_5m + tokens.cache_write_1h).toBe(usage.cacheWrite);
      expect(tokens.unsplit).toBe(0);
      expect(tokens.total).toBe(usage.input + usage.cacheRead + usage.cacheWrite + usage.output);
      // Reasoning rides inside output (Codex counts it there); it is never added on top.
      expect(tokens.reasoning ?? 0).toBeLessThanOrEqual(tokens.output);
    }
    expect(rowOf('gn-1').tokens).toMatchObject({ cache_write_5m: 800, cache_write_1h: 400 });
    expect(rowOf('gn-2').tokens.reasoning).toBe(300);
  });

  test('cost agrees on every fully priced task: one call streamed twice, a re-emitted Codex total, a subagent fork', () => {
    for (const task of ['gn-1', 'gn-2', 'gn-3']) {
      const usage = legacy.tasks.find((t) => t.task === task)?.usage as LegacyUsage;
      const { cost, tokens } = rowOf(task);
      expect(usage.pricedCalls).toBe(usage.calls);
      expect({ task, state: cost.state, unpriced: cost.unpriced_models }).toEqual({
        task,
        state: 'priced',
        unpriced: [],
      });
      expect(sameUsd(cost.usd, usage.costUsd)).toBe(true);
      expect(cost.usd_estimated).toBe(cost.usd);
      expect(cost.tokens_priced).toBe(tokens.total);
    }
  });

  test('no runtime-reported cost on either side: Claude Code and Codex logs carry none, so all USD is a list-price estimate', () => {
    for (const { task, usage } of legacy.tasks) {
      const { cost } = rowOf(task);
      // Legacy took a runtime price only from pi/OMP logs; every priced call here came from the table.
      expect({ task, legacySource: usage.costSource === 'runtime' || usage.costSource === 'mixed' }).toEqual({
        task,
        legacySource: false,
      });
      expect(cost.tokens_reported).toBe(0);
      // Reported USD is 0 wherever the meter priced anything, and unknown (null) where it priced nothing.
      expect({ task, reported: cost.usd_reported }).toEqual({ task, reported: cost.state === 'unpriced' ? null : 0 });
    }
  });

  test('an unknown model: legacy said only null; the meter says unpriced, names the model and keeps the tokens', () => {
    const usage = legacy.tasks.find((t) => t.task === 'gn-4')?.usage as LegacyUsage;
    expect(usage).toMatchObject({ costUsd: null, pricedCalls: 0, costSource: null });
    const { cost, tokens } = rowOf('gn-4');
    expect(cost).toMatchObject({
      state: 'unpriced',
      usd: null,
      usd_estimated: null,
      unpriced_models: ['acme-local-1'],
    });
    expect(cost.tokens_unpriced).toBe(tokens.total);
    expect(tokens.total).toBe(900);
  });

  test('one priced and one unpriced call: legacy printed the priced part as the total; the meter says partial', () => {
    const usage = legacy.tasks.find((t) => t.task === 'gn-5')?.usage as LegacyUsage;
    expect(usage).toMatchObject({ calls: 2, pricedCalls: 1, costSource: 'table' });
    const { cost, tokens } = rowOf('gn-5');
    expect(cost).toMatchObject({ state: 'partial', unpriced_models: ['acme-local-1'] });
    expect(sameUsd(cost.usd, usage.costUsd)).toBe(true);
    // The priced part is a list-price estimate, as on the fully priced tasks.
    expect(cost.usd_estimated).toBe(cost.usd);
    // The unpriced call's 500 input + 100 output are counted as unpriced, never dropped from the total.
    expect(cost.tokens_unpriced).toBe(600);
    expect(cost.tokens_priced + cost.tokens_unpriced).toBe(tokens.total);
  });
});
