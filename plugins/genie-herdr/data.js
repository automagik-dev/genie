// The Tasks board's pure rules: discovery, the forge-sync budget, lanes and cards, cost and time
// from usagemeter, the badge join and the degraded states. No imports at all (no `herdr`, no
// `gpui-kit`, no node built-ins): the same file loads in Herdr and in bun:test. Every process is
// spawned by main.js; the shell it runs is exported here so the tests run the very same strings.

export const MOD = 'genie-herdr';
export const WAITING_KEY = 'genie.tasks.waiting';
export const LANES = ['Working', 'Review', 'Merged', 'Closed'];
export const CARD_CAP = 12;
export const SYNC_BUDGET = 10;
export const MAX_IN_FLIGHT = 8;
export const TICK_MS = 60_000;
export const BACKOFF_CAP_MIN = 60;
const MIN_MS = 60_000;
const OPEN = new Set(['Working', 'Review']);

// ---------- processes ----------

/**
 * Discovery and the never-synced test in one loop, run as `sh -c PROBE_SCRIPT sh <folder>...`.
 * One line per folder holding `.genie/genie.db`: `<synced|never>\t<pwd -P realpath>`. The cursor
 * is forge-sync's `<GENIE_HOME>/cache/forge/<sha256(realpath)>.cursor.json`; it is synced only
 * when it holds a numeric `since` (forge-sync writes compact JSON). A cursor whose `origin` is
 * another remote still greps as synced (Decision 20).
 */
export const PROBE_SCRIPT = [
  'for d in "$@"; do',
  '  [ -f "$d/.genie/genie.db" ] || continue',
  '  r=$(cd "$d" 2>/dev/null && pwd -P) || continue',
  '  h=$(printf %s "$r" | shasum -a 256 | cut -d " " -f 1)',
  '  f="${GENIE_HOME:-$HOME/.genie}/cache/forge/$h.cursor.json"',
  '  if grep -q \'"since":[0-9]\' "$f" 2>/dev/null; then s=synced; else s=never; fi',
  '  printf \'%s\\t%s\\n\' "$s" "$r"',
  'done',
].join('\n');

/** `genie-rs` as the TS front door finds it: GENIE_RS_BIN, else the payload's copy. Exit 0 when it can run. */
export const BIN_SCRIPT = [
  'b="${GENIE_RS_BIN:-${GENIE_HOME:-$HOME/.genie}/plugins/genie-rs/bin/genie-rs}"',
  'printf \'%s\\n\' "$b"',
  '[ -f "$b" ] && [ -x "$b" ]',
].join('\n');

/** `<given>\t<pwd -P>` for each folder that exists, for the labels' `task.project` and workers' `project`. */
export const REALPATH_SCRIPT = [
  'for p in "$@"; do',
  '  r=$(cd "$p" 2>/dev/null && pwd -P) && printf \'%s\\t%s\\n\' "$p" "$r"',
  'done',
  'exit 0',
].join('\n');

/**
 * An exec as a value: `{ok, code, stdout, stderr, error, errorCode}`. A rejection (no program, the
 * 30 s limit) is `ok: false` with `error` its message and `errorCode` its `code`, when it has one.
 */
export async function settle(promise) {
  try {
    const r = await promise;
    const code = typeof r?.code === 'number' ? r.code : null;
    const out = { stdout: String(r?.stdout ?? ''), stderr: String(r?.stderr ?? '') };
    return { ok: code === 0, code, ...out, error: null, errorCode: null };
  } catch (e) {
    const err = /** @type {any} */ (e);
    const errorCode = typeof err?.code === 'string' ? err.code : null;
    return { ok: false, code: null, stdout: '', stderr: '', error: String(err?.message ?? e), errorCode };
  }
}

const LAUNCH_CODES = new Set(['ENOENT', 'EACCES', 'ENOEXEC', 'EPERM', 'ENOTDIR']);
const LAUNCH_TEXT = /ENOENT|EACCES|ENOEXEC|EPERM|spawn|not found|no such file|permission denied|exec format/i;

/**
 * A rejection that says the program could not be started (missing, not executable, the wrong
 * format), as opposed to a run that timed out or exited non-zero. Under the login PATH a
 * `genie-rs` run goes through `/usr/bin/env`, which always starts: a missing binary is then env's
 * exit 127 and an unexecutable one its 126, codes `genie-rs` itself never uses (it exits 0, 1, 2).
 */
export const launchFailed = (outcome) =>
  outcome?.error != null
    ? LAUNCH_CODES.has(outcome.errorCode) || LAUNCH_TEXT.test(outcome.error)
    : outcome?.code === 126 || outcome?.code === 127;

export const syncOk = (outcome) => Boolean(outcome?.ok);

// ---------- the login PATH ----------

const PATH_MARK = '__GENIE_LOGIN_PATH__';
/** What each login shell runs: the marker keeps a profile's own output (a banner, an echo) out of the PATH. */
export const LOGIN_PATH_COMMAND = `printf '\\n${PATH_MARK}%s' "$PATH"`;
const ENV = '/usr/bin/env';

/**
 * The login shells to ask, in order, as `[command, args]`. First the person's own `$SHELL`: Herdr's
 * runtime has no `process.env`, but the environment its `exec` hands a program does carry `SHELL`,
 * so `/bin/sh` reads it and execs it (`/bin/zsh` when unset), LOGIN_PATH_COMMAND passed as `$1`,
 * an argv element no shell parses. Then `/bin/zsh`, then `/bin/sh`. `-l` reads the login profile
 * files (`.zprofile`, `.bash_profile`, `.profile`), not `.zshrc` / `.bashrc`, on purpose: `-i`
 * would bring in prompts and plugin managers that can hang until the exec limit.
 */
export const LOGIN_CANDIDATES = [
  ['/bin/sh', ['-c', 'exec "${SHELL:-/bin/zsh}" -l -c "$1"', 'sh', LOGIN_PATH_COMMAND]],
  ['/bin/zsh', ['-l', '-c', LOGIN_PATH_COMMAND]],
  ['/bin/sh', ['-l', '-c', LOGIN_PATH_COMMAND]],
];

/**
 * A PATH a POSIX shell would build: every non-empty `:` entry absolute, and none holding another
 * path after whitespace. That rejects what a non-POSIX `$SHELL` prints for LOGIN_PATH_COMMAND (a
 * literal `$PATH` from nushell, fish 2's space-joined list) and stray profile text alike.
 */
const isPosixPath = (path) =>
  path.split(':').every((entry) => entry === '' || (entry.startsWith('/') && !/\s\//.test(entry)));

/** A login shell's outcome as its PATH: the text after the last marker, or null when there is none or it is no PATH. */
export function parseLoginPath(outcome) {
  if (!outcome?.ok) return null;
  const at = outcome.stdout.lastIndexOf(PATH_MARK);
  if (at < 0) return null;
  const path = outcome.stdout.slice(at + PATH_MARK.length).replace(/\n+$/, '');
  return path && isPosixPath(path) ? path : null;
}

/**
 * The person's login PATH, or null to keep the inherited one. Herdr launched from Finder or the
 * Dock inherits launchd's `/usr/bin:/bin:/usr/sbin:/sbin`, where `gh` and `glab` are not, and its
 * `exec` takes no environment; the login shell is where the person set their PATH up (hc starts
 * one on macOS for the same reason). LOGIN_CANDIDATES run in order, each under Herdr's 30 s exec
 * limit; the first that answers with a PATH wins, and none answering keeps the inherited PATH.
 */
export async function resolveLoginPath(io) {
  for (const [cmd, args] of LOGIN_CANDIDATES) {
    const path = parseLoginPath(await settle(io.exec(cmd, args)));
    if (path) return path;
  }
  return null;
}

/**
 * A `genie-rs` run as `[command, args]`: under the login PATH, `/usr/bin/env PATH=<path> <cmd>
 * <args...>`, the PATH one argv element that no shell parses; without one, the run as it was.
 */
export const loginArgv = (path, cmd, args) => (path ? [ENV, [`PATH=${path}`, cmd, ...args]] : [cmd, args]);

/** Runs `fn` over `items` with at most `limit` calls in flight; results in input order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** A tick handler that skips (never queues) a call made while the last call's promise is pending. */
export function skipWhileBusy(fn) {
  let busy = false;
  return (...args) => {
    if (busy) return;
    busy = true;
    let p;
    try {
      p = Promise.resolve(fn(...args));
    } catch (e) {
      p = Promise.reject(e);
    }
    p.catch(() => {}).finally(() => {
      busy = false;
    });
  };
}

// ---------- discovery ----------

/** Each local space's folder once (an empty folder is the home); spaces on other machines are out (A2). */
export function localFolders(spaces, home) {
  const out = [];
  for (const s of spaces ?? []) {
    if (s?.machine) continue;
    const folder = s?.folder || home;
    if (folder && !out.includes(folder)) out.push(folder);
  }
  return out;
}

/** PROBE_SCRIPT's output as `{projects, neverSynced}`, realpaths deduped, in sort order. */
export function parseProbe(stdout) {
  const projects = new Set();
  const neverSynced = new Set();
  for (const line of String(stdout ?? '').split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const state = line.slice(0, tab);
    const path = line.slice(tab + 1);
    if (!path || (state !== 'synced' && state !== 'never')) continue;
    projects.add(path);
    if (state === 'never') neverSynced.add(path);
  }
  return { projects: [...projects].sort(), neverSynced };
}

/** REALPATH_SCRIPT's output as a Map from the given string to its realpath. */
export function parseRealpaths(stdout) {
  const map = new Map();
  for (const line of String(stdout ?? '').split('\n')) {
    const tab = line.indexOf('\t');
    if (tab > 0 && line.length > tab + 1) map.set(line.slice(0, tab), line.slice(tab + 1));
  }
  return map;
}

/** BIN_SCRIPT's outcome: `{found, path}`. A rejection names no path. */
export function parseBin(outcome) {
  const path = String(outcome?.stdout ?? '').split('\n')[0] || null;
  return { found: Boolean(outcome?.ok && path), path };
}

export const missingBinaryLine = (path) => `genie-rs not found: run 'genie update' (${path ?? 'no path'})`;

// ---------- the forge-sync budget ----------

export const initialState = () => ({ pointer: null, neverPointer: null, backoff: {} });

/** Minutes a project waits after its `fails`-th failure in a row: 1, 2, 4… capped at 60. */
export const backoffMinutes = (fails) => Math.min(BACKOFF_CAP_MIN, 2 ** Math.max(0, fails - 1));

/** The sorted ring after `pointer`: the next path in sort order, so a vanished pointer resumes there. */
function ringAfter(sorted, pointer) {
  if (pointer == null) return sorted;
  const i = sorted.findIndex((p) => p > pointer);
  return i < 0 ? sorted : [...sorted.slice(i), ...sorted.slice(0, i)];
}

/**
 * One tick's plan. `results` are the previous plan's forge-sync outcomes (`project -> ok`), applied
 * at `now`: a failure backs the project off, a success resets it. Every project is listed. Up to
 * SYNC_BUDGET forge-syncs: the focused project first, then at most one never-synced project (the
 * focused one when it is never-synced itself), taken round-robin over the never-synced ring, then
 * the synced projects round-robin. `pointer` is the last synced realpath of the synced ring and
 * `neverPointer` that of the never-synced ring; both and the backoff map survive a re-probe.
 */
export function planTick(state, { now, projects, focused, neverSynced, results }) {
  const backoff = { ...(state?.backoff ?? {}) };
  for (const [p, good] of Object.entries(results ?? {})) {
    if (good) {
      delete backoff[p];
      continue;
    }
    const fails = (backoff[p]?.fails ?? 0) + 1;
    backoff[p] = { fails, until: now + backoffMinutes(fails) * MIN_MS };
  }
  const never = neverSynced ?? new Set();
  const sorted = [...new Set(projects ?? [])].sort();
  const eligible = (p) => !(backoff[p] && backoff[p].until > now);
  const sync = [];
  let pointer = state?.pointer ?? null;
  let neverPointer = state?.neverPointer ?? null;
  let neverTaken = false;

  const lead = focused && sorted.includes(focused) && eligible(focused) ? focused : null;
  if (lead) {
    sync.push(lead);
    neverTaken = never.has(lead);
  }
  if (!neverTaken) {
    const pick = ringAfter(
      sorted.filter((p) => never.has(p)),
      neverPointer,
    ).find((p) => p !== lead && eligible(p));
    if (pick && sync.length < SYNC_BUDGET) {
      sync.push(pick);
      neverPointer = pick;
    }
  }
  for (const p of ringAfter(
    sorted.filter((x) => !never.has(x)),
    pointer,
  )) {
    if (sync.length >= SYNC_BUDGET) break;
    if (p === lead || !eligible(p)) continue;
    sync.push(p);
    pointer = p;
  }
  return { sync, list: sorted, state: { pointer, neverPointer, backoff } };
}

/** The "forge not synced" note while a project's last forge-sync failed. */
export const forgeNote = (state, project) => (state?.backoff?.[project] ? 'forge not synced' : null);

const FORGE_CLI = /\b(gh|glab) could not be run\b/;

/**
 * Why a forge-sync failed, when its stderr says: genie-rs's `<gh|glab> could not be run (<os
 * error>): install it and run ...` is `<gh|glab> not found on PATH` for a missing program and
 * `<gh|glab> could not be run` otherwise. Null when the text names neither.
 */
export function forgeReason(outcome) {
  const err = String(outcome?.stderr ?? '');
  const m = FORGE_CLI.exec(err);
  if (!m) return null;
  return /no such file|os error 2\b|not found/i.test(err) ? `${m[1]} not found on PATH` : `${m[1]} could not be run`;
}

// ---------- list ----------

const ROW_FIELDS =
  'task task_key state lane title lead forge url branch updated_at created_at opened_at merged_at closed_at worktree project'.split(
    ' ',
  );

/** A `list --json` element with every field present: an older `genie-rs` gives nulls. */
export function normalizeRow(r) {
  const out = {};
  for (const k of ROW_FIELDS) out[k] = r?.[k] ?? null;
  return out;
}

/**
 * The project's list after one `list` run: `{rows, at, stale, hidden}`. Exit 0 with a JSON array
 * replaces it; exit 2 (no database, `user_version = 0`, a newer schema) hides the project; anything
 * else (exit 1, the time limit, unparseable output) keeps the last good rows, marked stale.
 */
export function applyList(prev, outcome, now) {
  if (outcome?.code === 2) return { rows: [], at: now, stale: false, hidden: true };
  if (outcome?.ok) {
    try {
      const parsed = JSON.parse(outcome.stdout);
      if (Array.isArray(parsed)) return { rows: parsed.map(normalizeRow), at: now, stale: false, hidden: false };
    } catch {
      // kept below
    }
  }
  return { rows: prev?.rows ?? [], at: prev?.at ?? null, stale: true, hidden: Boolean(prev?.hidden) };
}

export const shownProjects = (projects, lists) => (projects ?? []).filter((p) => !lists?.[p]?.hidden);

export const listAge = (entry, now) => (entry?.at == null ? null : fmtMin((now - entry.at) / MIN_MS));

// ---------- usagemeter ----------

/** `doc get herdr-meter`: a doc only on exit 0 with one line of JSON (Decision 15); else null. */
export function docFeed(outcome) {
  if (!outcome?.ok) return null;
  const text = String(outcome.stdout ?? '').trim();
  if (!text || text.includes('\n')) return null;
  try {
    const doc = JSON.parse(text);
    return doc && typeof doc === 'object' ? doc : null;
  } catch {
    return null;
  }
}

/** The pinned `space.projects[<project>].tasks`, only when it is an array (usagemeter#8). */
export function feedRows(doc, project) {
  const tasks = doc?.space?.projects?.[project]?.tasks;
  return Array.isArray(tasks) ? tasks : null;
}

/** The feed row of a card: `(project, task)`, or the url when the task is null. */
export function feedRowFor(rows, task, url) {
  if (!rows) return null;
  if (task != null) return rows.find((r) => r?.task === task) ?? null;
  return url ? (rows.find((r) => r?.task == null && r?.url === url) ?? null) : null;
}

/** The project's past `lead_min` values, sorted. */
export const historyOf = (rows) =>
  (rows ?? [])
    .map((r) => r?.lead_min)
    .filter((m) => typeof m === 'number' && Number.isFinite(m))
    .sort((a, b) => a - b);

const median = (xs) => (xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2);

/**
 * An open task's time left, in minutes: the median of the past `lead_min` values above the
 * elapsed time, minus it (`basis` of them); past the slowest, `over`. null without both.
 */
export function estimateOf(elapsed, history) {
  if (elapsed == null || !history?.length) return null;
  const longer = history.filter((m) => m > elapsed);
  if (!longer.length) return { over: true, left: null, total: null, basis: 0 };
  const total = median(longer);
  return { over: false, left: total - elapsed, total, basis: longer.length };
}

export const etaText = (est) => (!est ? '–' : est.over ? 'over' : `~${fmtMin(est.left)}`);

/** ms since the epoch from an ISO string or epoch seconds/ms; null otherwise. */
export function parseTime(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v !== 'string' || !v) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

// ---------- formatting ----------

/** Minutes in the mock's hour format; null is "–" and a measured 0 is "0m". */
export function fmtMin(m) {
  if (m == null || !Number.isFinite(m)) return '–';
  if (m <= 0) return '0m';
  const h = m / 60;
  if (h < 1) return `${Math.max(1, Math.round(m))}m`;
  return h < 100 ? `${h.toFixed(1)}h` : `${Math.round(h)}h`;
}

/** Dollars; null is "–" and a measured 0 is "$0.00". */
export function fmtUsd(x) {
  if (x == null || !Number.isFinite(x)) return '–';
  if (x === 0) return '$0.00';
  if (x < 0.01) return '<$0.01';
  return x < 10 ? `$${x.toFixed(2)}` : `$${Math.round(x)}`;
}

// ---------- lanes and cards ----------

const rowKey = (r) => r.task_key ?? r.task ?? r.url ?? r.branch ?? r.title ?? '';

/** The read-only card model: what a card and its drawer show. No actions. */
export function cardOf(project, r, rows, history, now) {
  const f = feedRowFor(rows, r.task, r.url);
  const open = OPEN.has(r.lane);
  const started = parseTime(f?.started_at);
  const elapsed = open && started != null ? Math.max(0, (now - started) / MIN_MS) : null;
  const est = open ? estimateOf(elapsed, history) : null;
  const leadMin = f?.lead_min ?? null;
  return {
    key: rowKey(r),
    id: r.task ?? 'untracked',
    task: r.task,
    untracked: r.task == null,
    url: r.url,
    title: r.title ?? '',
    lead: r.lead,
    lane: r.lane,
    branch: r.branch,
    worktree: r.worktree,
    project,
    updated_at: r.updated_at,
    created_at: r.created_at,
    opened_at: r.opened_at,
    merged_at: r.merged_at,
    closed_at: r.closed_at,
    usd: f?.usd ?? null,
    work_min: f?.work_min ?? null,
    lead_min: leadMin,
    elapsed,
    cost: fmtUsd(f?.usd ?? null),
    time: open ? fmtMin(elapsed) : fmtMin(leadMin),
    eta: open ? etaText(est) : '–',
    est,
    merges: history.length,
    bots: Array.isArray(f?.bots) ? f.bots : [],
  };
}

const byUpdated = (a, b) => (parseTime(b.updated_at) ?? 0) - (parseTime(a.updated_at) ?? 0);

/** Working, Review, Merged and Closed, newest `updated_at` first, CARD_CAP cards each with the total. */
export function lanesOf(project, rows, feed, now) {
  const history = historyOf(feed);
  const cards = (rows ?? []).map((r) => cardOf(project, normalizeRow(r), feed, history, now));
  return LANES.map((key) => {
    const all = cards.filter((c) => c.lane === key).sort(byUpdated);
    return { key, label: key, cards: all.slice(0, CARD_CAP), total: all.length };
  });
}

// ---------- workers and the badge ----------

/** `workers.jsonl` (its tail): the latest `start` row with `kind: "worker"` per terminal. */
export function parseWorkers(text) {
  const map = new Map();
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const w = JSON.parse(line);
      if (w?.event === 'start' && w.kind === 'worker' && w.terminal) map.set(w.terminal, w);
    } catch {
      // a torn or foreign line
    }
  }
  return map;
}

const labelled = (t) => Boolean(t?.labels?.task && t.labels['task.project']);
const real = (realpaths, p) => (p ? (realpaths?.get(p) ?? p) : null);

/** The card (`{project, row}`) a terminal works on: its labels first, workers.jsonl only when unlabelled. */
export function cardOfTerminal(t, boards, { realpaths, workers }) {
  if (labelled(t)) {
    const project = real(realpaths, t.labels['task.project']);
    const row = (boards?.[project] ?? []).find((r) => r.task === t.labels.task);
    const lead = t.labels['task.lead'];
    return row ? { project, row, lead: Boolean(lead) && t.labels['worker.of'] === lead } : null;
  }
  const w = workers?.get(t?.address);
  if (!w) return null;
  const project = real(realpaths, w.project);
  const rows = boards?.[project] ?? [];
  const row =
    (w.task && rows.find((r) => r.task === w.task)) ||
    (w.task && rows.find((r) => r.branch === w.task)) ||
    (w.branch && rows.find((r) => r.branch === w.branch)) ||
    (w.worktree && rows.find((r) => r.worktree === w.worktree)) ||
    null;
  // The card's own lead decides; the start row's `lead` only when the card names none.
  const lead = row?.lead || w.lead;
  return row ? { project, row, lead: Boolean(w.botId) && Boolean(lead) && w.botId === lead } : null;
}

/**
 * Cards waiting on the owner across projects, each counted once: every Review card, plus every
 * Working card with a blocked worker. null at 0, so the badge shows nothing.
 */
export function waitingCount(boards, terminals, ctx) {
  const ids = new Set();
  for (const [project, rows] of Object.entries(boards ?? {})) {
    for (const r of rows ?? []) if (r.lane === 'Review') ids.add(`${project}\n${rowKey(r)}`);
  }
  for (const t of terminals ?? []) {
    if (t?.status !== 'blocked') continue;
    const hit = cardOfTerminal(t, boards, ctx);
    if (hit?.row.lane === 'Working') ids.add(`${hit.project}\n${rowKey(hit.row)}`);
  }
  return ids.size > 0 ? ids.size : null;
}

/** Writes the badge only when it changed (setShared re-renders every mod). True when it wrote. */
export function publishWaiting(n, { shared, setShared }) {
  if ((shared(WAITING_KEY) ?? null) === n) return false;
  setShared(WAITING_KEY, n);
  return true;
}

/** The live terminal of a card for its terminal icon, the lead's first; null when none runs. */
export function terminalFor(card, terminals, ctx) {
  const boards = { [card.project]: [card] };
  let found = null;
  for (const t of terminals ?? []) {
    if (!t?.address || (t.state && t.state !== 'live')) continue;
    const hit = cardOfTerminal(t, boards, ctx);
    if (!hit) continue;
    if (hit.lead) return t.address;
    found ??= t.address;
  }
  return found;
}

/** Every path the badge join may realpath: the `task.project` labels and the workers' projects. */
export function joinPaths(terminals, workers) {
  const out = new Set();
  for (const t of terminals ?? []) {
    if (labelled(t)) out.add(t.labels['task.project']);
    else if (t?.address && workers?.get(t.address)?.project) out.add(workers.get(t.address).project);
  }
  return [...out];
}

/**
 * Whether the badge or an icon may need `workers.jsonl`: any live terminal without the full task
 * labels, whatever its status, may be a worker the fallback joins. Only a bot's own pane (its
 * `bot` label) is ruled out: Herdr never gives a worker one (am-sidebar `workers.js`). When every
 * other live terminal is fully labelled, nothing is read (Decision 14).
 */
export function needsWorkers(terminals) {
  return (terminals ?? []).some(
    (t) => t?.address && (!t.state || t.state === 'live') && !labelled(t) && !t.labels?.bot,
  );
}

// ---------- one refresh ----------

/** The board's state between refreshes (main.js keeps it on the view). */
export const newModel = () => ({
  bin: null, // {found, path}
  projects: [],
  never: new Set(),
  foldersKey: null,
  lists: {}, // realpath -> applyList entry
  feed: null,
  sched: undefined, // planTick state
  results: {}, // the last forge-sync outcome per project, for the next plan
  reasons: {}, // project -> why its last forge-sync failed (forgeReason), until one succeeds
  path: undefined, // the login PATH: undefined until resolved, null when the inherited one is kept
  realpaths: new Map(), // label / folder -> realpath, for the tab's life
  workers: new Map(),
});

/** The shown projects' rows, for the badge. */
export function boardsOf(m) {
  const out = {};
  for (const p of shownProjects(m.projects, m.lists)) out[p] = m.lists[p]?.rows ?? [];
  return out;
}

export const focusedProjectOf = (m, folder) => {
  const r = folder ? m.realpaths.get(folder) : null;
  return r && m.projects.includes(r) ? r : null;
};

export const waitingOf = (m, terminals) =>
  waitingCount(boardsOf(m), terminals, { realpaths: m.realpaths, workers: m.workers });

/**
 * The project's forge note: its last forge-sync failed (this refresh's outcome, else the plan's
 * backoff), worded by `forgeReason` when genie-rs said why, else "forge not synced".
 */
export function forgeNoteOf(m, project) {
  const failed = project in m.results ? !m.results[project] : Boolean(forgeNote(m.sched, project));
  return failed ? (m.reasons?.[project] ?? 'forge not synced') : null;
}

/** One `genie-rs`, BIN_SCRIPT or `automagik-herdr` run under the model's login PATH, settled. */
const runBin = (m, io, cmd, args) => {
  const [c, a] = loginArgv(m.path, cmd, args);
  return settle(io.exec(c, a));
};

/**
 * After a batch of `genie-rs` runs: true (and the model in the missing-binary state, its path kept
 * so the next refresh resolves again) when one of them could not be launched, or when any of them
 * was rejected and BIN_SCRIPT no longer finds a runnable binary. A timeout or a non-zero exit with
 * the binary still in place is an ordinary failure: stale list, forge backoff.
 */
async function binaryGone(m, io, outcomes) {
  if (!outcomes.some((o) => o.error != null || launchFailed(o))) return false;
  if (!outcomes.some(launchFailed) && parseBin(await runBin(m, io, 'sh', ['-c', BIN_SCRIPT])).found) return false;
  m.bin = { found: false, path: m.bin.path };
  return true;
}

/**
 * One refresh of model `m`. `io` is the host: `exec(cmd, args)`, `probe(folders)`
 * (main.js runs PROBE_SCRIPT), `spaces()`, `home()`, `terminals()`, `focusedFolder()`, `workersFile`,
 * `now()`, `notify()` and `publish()`. Order: the login PATH (once per model), binary, probe, the
 * workers tail only when needed, realpaths, the plan, `list` for every project, `doc get`, the badge,
 * then the planned forge-syncs (their outcomes go to the next plan). BIN_SCRIPT, `list`, `doc get`
 * (usagemeter's cost and time, from `automagik-herdr`) and `forge-sync` run under the login PATH. `sync: false` plans no forge-sync; `feed: false` skips `doc get`.
 */
export async function refresh(m, io, { sync = true, feed = true } = {}) {
  if (m.path === undefined) m.path = await resolveLoginPath(io);
  if (!m.bin?.found) m.bin = parseBin(await runBin(m, io, 'sh', ['-c', BIN_SCRIPT]));
  if (!m.bin.found) return io.notify();
  const bin = m.bin.path;

  const folders = localFolders(io.spaces(), io.home());
  m.foldersKey = folders.join('\n');
  const probe = await settle(io.probe(folders));
  if (probe.ok) ({ projects: m.projects, neverSynced: m.never } = parseProbe(probe.stdout));

  const terms = io.terminals();
  m.workers = new Map();
  if (needsWorkers(terms)) {
    const tail = await settle(io.exec('tail', ['-n', '2000', io.workersFile]));
    if (tail.ok) m.workers = parseWorkers(tail.stdout);
  }
  const want = [io.focusedFolder(), ...joinPaths(terms, m.workers)].filter((p) => p && !m.realpaths.has(p));
  if (want.length) {
    const r = await settle(io.exec('sh', ['-c', REALPATH_SCRIPT, 'sh', ...want]));
    for (const [k, v] of parseRealpaths(r.stdout)) m.realpaths.set(k, v);
  }

  let syncs = [];
  if (sync) {
    const results = m.results;
    m.results = {};
    const focused = focusedProjectOf(m, io.focusedFolder());
    const plan = planTick(m.sched, { now: io.now(), projects: m.projects, focused, neverSynced: m.never, results });
    m.sched = plan.state;
    syncs = plan.sync;
  }

  const listed = [...m.projects];
  const outs = await mapLimit(listed, MAX_IN_FLIGHT, (p) => runBin(m, io, bin, ['list', '--json', '--project', p]));
  if (await binaryGone(m, io, outs)) return io.notify();
  listed.forEach((p, i) => {
    m.lists[p] = applyList(m.lists[p], outs[i], io.now());
  });
  if (feed) m.feed = docFeed(await runBin(m, io, 'automagik-herdr', ['doc', 'get', 'herdr-meter']));
  io.publish();
  io.notify();

  if (!syncs.length) return;
  const done = await mapLimit(syncs, MAX_IN_FLIGHT, (p) => runBin(m, io, bin, ['forge-sync', '--project', p]));
  // Every outcome known on its own terms reaches the next plan, before any missing-binary return:
  // only a call that is known not to have launched carries no forge result.
  m.results = Object.fromEntries(syncs.flatMap((p, i) => (launchFailed(done[i]) ? [] : [[p, syncOk(done[i])]])));
  m.reasons = { ...m.reasons };
  for (const [p, good] of Object.entries(m.results)) {
    const why = good ? null : forgeReason(done[syncs.indexOf(p)]);
    if (why) m.reasons[p] = why;
    else delete m.reasons[p];
  }
  if (await binaryGone(m, io, done)) return io.notify();
  io.notify();
}
