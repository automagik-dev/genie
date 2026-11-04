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

/** `genie-rs` as the TS front door finds it: GENIE_RS_BIN, else the payload's copy. Exit 0 when it is there. */
export const BIN_SCRIPT = [
  'b="${GENIE_RS_BIN:-${GENIE_HOME:-$HOME/.genie}/plugins/genie-rs/bin/genie-rs}"',
  'printf \'%s\\n\' "$b"',
  '[ -f "$b" ]',
].join('\n');

/** `<given>\t<pwd -P>` for each folder that exists, for the labels' `task.project` and workers' `project`. */
export const REALPATH_SCRIPT = [
  'for p in "$@"; do',
  '  r=$(cd "$p" 2>/dev/null && pwd -P) && printf \'%s\\t%s\\n\' "$p" "$r"',
  'done',
  'exit 0',
].join('\n');

/** An exec as a value: `{ok, code, stdout, stderr, error}`; a rejection (no program, the 30 s limit) is `ok: false`. */
export async function settle(promise) {
  try {
    const r = await promise;
    const code = typeof r?.code === 'number' ? r.code : null;
    return { ok: code === 0, code, stdout: String(r?.stdout ?? ''), stderr: String(r?.stderr ?? ''), error: null };
  } catch (e) {
    return { ok: false, code: null, stdout: '', stderr: '', error: String(/** @type {any} */ (e)?.message ?? e) };
  }
}

export const syncOk = (outcome) => Boolean(outcome?.ok);

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
    return row ? { project, row, lead: t.labels['worker.of'] === t.labels['task.lead'] } : null;
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
  return row ? { project, row, lead: Boolean(w.botId) && w.botId === w.lead } : null;
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
