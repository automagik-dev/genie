/**
 * mikro offload runs → per-interval usage, for `genie metrics export`.
 *
 * A mikro call runs in a child process against another provider, so the
 * runtime session log that prices a lifecycle interval never sees it: without
 * this, an interval that offloaded work shows the expensive model's savings
 * but not the microagent's bill. mikro already writes one row per attempt to
 * its run ledger — `<repo>/.mikro/runs/<agent>.jsonl` when the repository
 * tracks `.mikro/`, else `<GENIE_HOME>/mikro/runs/<name>-<hash>/<agent>.jsonl`
 * — with `ts`, `dir` and a priced `footer`. Those rows are joined to an
 * interval by repository (the row's `dir` inside the interval's repo root) and
 * time (`ts` inside the window).
 *
 * The join is by repository and window, not by session: two cards worked at
 * once in one repository both see the same runs (`Interval.sharedSession`
 * already flags that overlap for the session). A repository with no ledger on
 * this host is unknown (null), never 0. Calls made with `--no-ledger` or
 * through `mikro mcp` write no row and are not seen.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { resolveGenieHome } from './genie-home.js';

export interface OffloadUsage {
  calls: number;
  failed: number;
  tokens: number;
  /** Sum of the costs mikro priced; null when no call in the window carried one. */
  costUsd: number | null;
}

interface OffloadRow {
  at: number;
  dir: string;
  ok: boolean;
  tokens: number;
  cost: number | null;
}

type Rec = Record<string, unknown>;
const obj = (value: unknown): Rec | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : null;
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function readRows(file: string): OffloadRow[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows: OffloadRow[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const row = obj(JSON.parse(line));
      const footer = obj(row?.footer);
      if (!row || typeof row.ts !== 'string' || typeof row.dir !== 'string') continue;
      rows.push({
        at: Date.parse(row.ts),
        dir: row.dir,
        ok: row.ok === true,
        tokens: num(footer?.tokensIn) + num(footer?.tokensOut),
        cost: typeof footer?.cost === 'number' ? footer.cost : null,
      });
    } catch {
      // a torn line of a live ledger
    }
  }
  return rows;
}

function ledgerFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl') && name !== 'egress.jsonl')
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/** The repository root a per-repo genie.db belongs to: `<root>/.genie/genie.db`. */
export function repoRootOfDb(db: string): string {
  return dirname(dirname(db));
}

/** Every mikro run row of one repository on this host; null when no ledger for it exists here. */
export function readOffloadRows(repoRoot: string): OffloadRow[] | null {
  const files = ledgerFiles(join(repoRoot, '.mikro', 'runs'));
  const machineRuns = join(resolveGenieHome(), 'mikro', 'runs');
  for (const name of existsSync(machineRuns) ? readdirSync(machineRuns) : []) {
    files.push(...ledgerFiles(join(machineRuns, name)));
  }
  const inside = (dir: string) => dir === repoRoot || dir.startsWith(`${repoRoot}${sep}`);
  const rows = files.flatMap(readRows).filter((row) => Number.isFinite(row.at) && inside(row.dir));
  const hasRepoLedger = existsSync(join(repoRoot, '.mikro', 'runs'));
  return rows.length > 0 || hasRepoLedger ? rows : null;
}

export function offloadInWindow(rows: OffloadRow[] | null, startAt: number, endAt: number): OffloadUsage | null {
  if (rows === null) return null;
  const inside = rows.filter((row) => row.at >= startAt && row.at < endAt);
  const priced = inside.map((row) => row.cost).filter((c): c is number => c !== null);
  return {
    calls: inside.length,
    failed: inside.filter((row) => !row.ok).length,
    tokens: inside.reduce((sum, row) => sum + row.tokens, 0),
    costUsd: priced.length > 0 ? priced.reduce((sum, c) => sum + c, 0) : null,
  };
}
