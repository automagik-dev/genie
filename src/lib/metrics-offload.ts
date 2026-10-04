/**
 * mikro offload runs → per-interval usage, for `genie metrics export`.
 *
 * A mikro call runs in a child process against another provider, so the
 * runtime session log that prices a lifecycle interval never sees it: without
 * this, an interval that offloaded work shows the expensive model's savings
 * but not the microagent's bill. mikro writes one row per ATTEMPT to its run
 * ledger — `<checkout>/.mikro/runs/<agent>.jsonl` when the checkout tracks
 * `.mikro/`, else `<GENIE_HOME>/mikro/runs/<name>-<hash>/<agent>.jsonl` — with
 * `ts` (the attempt's START), `dir` and a priced `footer`.
 *
 * Repository membership: the repo root (from `<root>/.genie/genie.db`) and
 * every worktree git has registered for it (`<root>/.git/worktrees/<n>/gitdir`),
 * wherever it lives on disk; each of those checkouts' own `.mikro/runs` is read
 * too. An attempt belongs to the interval its `ts` falls in (`[start, end)`).
 *
 * Unknown is never 0: a repository with no ledger on this host is null; tokens
 * or cost are null as soon as one attempt in the window carried no footer or
 * no price (a window with no attempt in an existing, READABLE ledger is a measured 0; any ledger dir
 * or file in scope that cannot be read makes the whole repository's offload unknown); an attempt that also falls inside another card's interval of the
 * same repository cannot be told apart, so it is counted `ambiguous` and the
 * interval's tokens and cost become null (the bill may be this card's). Calls made with `--no-ledger` or through `mikro mcp`
 * write no row and are not seen.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { resolveGenieHome } from './genie-home.js';

export interface OffloadUsage {
  /** mikro attempts started inside the window and owned by this card alone (a retry is a second attempt). */
  attempts: number;
  failed: number;
  /** Attempts that also fall inside another card's interval of the same repository: tokens and cost become null. */
  ambiguous: number;
  /** null when any counted attempt had no footer. */
  tokens: number | null;
  /** null when any counted attempt was unpriced; 0 when the ledger holds no attempt in the window. */
  costUsd: number | null;
}

export interface OffloadRow {
  at: number;
  dir: string;
  ok: boolean;
  tokens: number | null;
  cost: number | null;
}

type Rec = Record<string, unknown>;
const obj = (value: unknown): Rec | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : null;
const numOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Reads that can fail. An ABSENT path (ENOENT / ENOTDIR) is no ledger — normal. Any other failure
 * (EACCES, EIO, …) means a ledger may exist that this process cannot see: the caller's answer is then
 * unknown, never a measured 0 or a partial total, so each failure is recorded on `seen.unreadable`.
 */
interface ReadState {
  unreadable: boolean;
}

const isAbsent = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  // EISDIR: a directory that happens to be named *.jsonl can never be a ledger.
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR';
};

function listDir(dir: string, seen?: ReadState): string[] {
  try {
    return readdirSync(dir);
  } catch (error) {
    if (!isAbsent(error) && seen) seen.unreadable = true;
    return [];
  }
}

function readRows(file: string, seen: ReadState): OffloadRow[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (!isAbsent(error)) seen.unreadable = true;
    return [];
  }
  const rows: OffloadRow[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const row = obj(JSON.parse(line));
      if (!row || typeof row.ts !== 'string' || typeof row.dir !== 'string') continue;
      const footer = obj(row.footer);
      const tokensIn = numOrNull(footer?.tokensIn);
      const tokensOut = numOrNull(footer?.tokensOut);
      rows.push({
        at: Date.parse(row.ts),
        dir: row.dir,
        ok: row.ok === true,
        tokens: tokensIn === null || tokensOut === null ? null : tokensIn + tokensOut,
        cost: numOrNull(footer?.cost),
      });
    } catch {
      // a torn line of a live ledger
    }
  }
  return rows;
}

const ledgerFiles = (dir: string, seen?: ReadState): string[] =>
  listDir(dir, seen)
    .filter((name) => name.endsWith('.jsonl') && name !== 'egress.jsonl')
    .map((name) => join(dir, name));

/** The repository root a per-repo genie.db belongs to: `<root>/.genie/genie.db`. */
export function repoRootOfDb(db: string): string {
  return dirname(dirname(db));
}

/** The repo root plus every worktree git registered for it, wherever it lives. */
export function repoCheckouts(repoRoot: string, seen?: ReadState): string[] {
  const registry = join(repoRoot, '.git', 'worktrees');
  const checkouts = [repoRoot];
  for (const name of listDir(registry, seen)) {
    try {
      const gitdir = readFileSync(join(registry, name, 'gitdir'), 'utf8').trim();
      // git ≥2.48 `worktree add --relative-paths` writes it relative to this registration directory.
      if (gitdir) checkouts.push(dirname(isAbsolute(gitdir) ? gitdir : resolve(join(registry, name), gitdir)));
    } catch (error) {
      // A pruned or half-written registration is no worktree; an UNREADABLE one may hide a worktree whose
      // ledger holds this repository's attempts, so the repository's offload becomes unknown.
      if (!isAbsent(error) && seen) seen.unreadable = true;
    }
  }
  return checkouts;
}

/**
 * Every mikro attempt of one repository on this host; null when no ledger of it exists here, and null
 * too when ANY ledger directory or file in scope could not be read (permissions, I/O): an unseen
 * ledger may hold this repository's attempts, so a readable-only total would be a guess dressed as a
 * measurement. That includes a mixture where some ledgers read and one does not.
 */
export function readOffloadRows(repoRoot: string): OffloadRow[] | null {
  const seen: ReadState = { unreadable: false };
  const checkouts = repoCheckouts(repoRoot, seen);
  const ownFiles = checkouts.flatMap((checkout) => ledgerFiles(join(checkout, '.mikro', 'runs'), seen));
  const files = [...ownFiles];
  const machineRuns = join(resolveGenieHome(), 'mikro', 'runs');
  // A machine ledger dir is named after the checkout that INVOKED mikro, not the tree its rows cite, so
  // any unreadable one may hold this repository's rows.
  for (const name of listDir(machineRuns, seen)) files.push(...ledgerFiles(join(machineRuns, name), seen));
  const inside = (dir: string) => checkouts.some((c) => dir === c || dir.startsWith(`${c}${sep}`));
  const rows = files
    .flatMap((file) => readRows(file, seen))
    .filter((row) => Number.isFinite(row.at) && inside(row.dir));
  if (seen.unreadable) return null;
  if (files.length === 0) return null;
  return rows.length > 0 || ownFiles.length > 0 ? rows : null;
}

const inWindow = (row: OffloadRow, startAt: number, endAt: number) => row.at >= startAt && row.at < endAt;

/**
 * The offload of one interval. `others` are the windows of OTHER cards' intervals in the same repository:
 * an attempt inside one of them is ambiguous and stays out of tokens and cost.
 */
export function offloadInWindow(
  rows: OffloadRow[] | null,
  startAt: number,
  endAt: number,
  others: Array<{ startAt: number; endAt: number }> = [],
): OffloadUsage | null {
  if (rows === null) return null;
  const inside = rows.filter((row) => inWindow(row, startAt, endAt));
  const shared = inside.filter((row) => others.some((o) => inWindow(row, o.startAt, o.endAt)));
  const own = inside.filter((row) => !shared.includes(row));
  const tokens = own.map((row) => row.tokens);
  const costs = own.map((row) => row.cost);
  return {
    attempts: own.length,
    failed: own.filter((row) => !row.ok).length,
    ambiguous: shared.length,
    // An ambiguous attempt may be this card's: leaving it out would understate the bill, so the bill is unknown.
    tokens: shared.length > 0 || tokens.includes(null) ? null : (tokens as number[]).reduce((sum, t) => sum + t, 0),
    costUsd: shared.length > 0 || costs.includes(null) ? null : (costs as number[]).reduce((sum, c) => sum + c, 0),
  };
}
