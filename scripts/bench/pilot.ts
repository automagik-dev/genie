/**
 * Genie Bench — manifest freeze, deterministic replacement and the paired schedule.
 *
 * Every choice here is made before any outcome exists, and none of it looks at one:
 *
 * - `freezeManifest` takes, per `<source>/<category>` quota, the eligible pool entries in bytewise
 *   (UTF-16 code unit) `taskId` order and keeps the first quota-many. An unresolved entry in a
 *   needed category, a category short of its quota, or a smoke selector that is not an eligible
 *   pool entry refuses; a quota is never silently shrunk.
 * - `replaceIneligible` swaps one selected task for the next not-yet-selected eligible id of the
 *   same category, and refuses once any outcome is recorded.
 * - `scheduleCampaign` derives the attempt order from sha256(seed, pair identity) alone, keeps the
 *   two arms of a pair adjacent, and emits smoke rows (ids `smoke-…`) ahead of scored rows
 *   (ids `scored-…`), so the two can never collide.
 *
 * CLI (exit 0 ok, 1 not ok, 2 refusal). Every verb is operator-invoked and finite; nothing has a
 * default path. `replace` and `schedule` write under the explicit `--root` while holding the G2
 * supervisor lock; `freeze` writes only its explicit `--out`, never over an existing file.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ArmId,
  type AttemptIdentity,
  type HarnessConfiguration,
  type PoolEntry,
  type Quotas,
  type Result,
  type TaskIdentity,
  type TaskManifest,
  hostClock,
  taskKey as keyOf,
  parseConfiguration,
  parseManifest,
  parsePool,
} from './contracts';
import { acquireSupervisor, readJournal, registerCampaign } from './ledger';

/** The ledger's own rule for a path segment: no separator, no leading dot. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const refuse = <T>(...issues: string[]): Result<T> => ({ ok: false, issues });

/** Code-unit order: never locale-aware, never numeric. */
const bytewise = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byTaskId = (a: TaskIdentity, b: TaskIdentity): number => bytewise(a.taskId, b.taskId);
const byTaskKey = (a: TaskIdentity, b: TaskIdentity): number => bytewise(keyOf(a), keyOf(b));

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');
const categoryKey = (t: TaskIdentity): string => `${t.source}/${t.category}`;
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** JSON with object keys sorted bytewise at every depth, so equal content hashes equally whatever its key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort(bytewise);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Content address of a selection: the frozen pool, the quotas and the exact task identities chosen. */
function manifestIdFor(m: Pick<TaskManifest, 'poolDigest' | 'quotas' | 'selected' | 'smoke'>): string {
  const basis = canonicalJson({
    poolDigest: m.poolDigest,
    quotas: m.quotas,
    selected: [...m.selected].sort(byTaskKey),
    smoke: [...m.smoke].sort(byTaskKey),
  });
  return `manifest-${sha256Hex(basis).slice(0, 16)}`;
}

const serializeManifest = (m: TaskManifest): string => `${JSON.stringify(m, null, 2)}\n`;

function duplicateKeys(tasks: TaskIdentity[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const key of tasks.map(keyOf)) {
    if (seen.has(key)) dupes.add(key);
    seen.add(key);
  }
  return [...dupes].sort(bytewise);
}

// ---------------------------------------------------------------------------
// Freeze
// ---------------------------------------------------------------------------

/** Selectors are `<source>:<taskId>`; each must name exactly one eligible pool entry. */
function resolveSmoke(pool: PoolEntry[], selectors: string[]): Result<TaskIdentity[]> {
  if (selectors.length === 0) return refuse('refused: at least one smoke selector <source>:<taskId> is required');
  const issues: string[] = [];
  const tasks: TaskIdentity[] = [];
  const seen = new Set<string>();
  for (const selector of selectors) {
    const at = selector.indexOf(':');
    if (at <= 0 || at === selector.length - 1) {
      issues.push(`refused: smoke selector '${selector}' is not <source>:<taskId>`);
      continue;
    }
    if (seen.has(selector)) {
      issues.push(`refused: smoke selector '${selector}' is given twice`);
      continue;
    }
    seen.add(selector);
    const source = selector.slice(0, at);
    const taskId = selector.slice(at + 1);
    const matches = pool.filter((e) => e.task.source === source && e.task.taskId === taskId);
    if (matches.length === 0) issues.push(`refused: smoke selector '${selector}' matches no pool entry`);
    else if (matches.length > 1) issues.push(`refused: smoke selector '${selector}' matches ${matches.length} entries`);
    else if (matches[0].eligibility.status !== 'eligible') {
      issues.push(`refused: smoke selector '${selector}' names a ${matches[0].eligibility.status} pool entry`);
    } else tasks.push(matches[0].task);
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: tasks.sort(byTaskKey) };
}

export function freezeManifest(
  pool: PoolEntry[],
  quotas: Quotas,
  smoke: string[] /* '<source>:<taskId>' */,
  frozenAt: string,
): Result<TaskManifest> {
  const issues = duplicateKeys(pool.map((e) => e.task)).map((k) => `refused: the pool lists ${k} more than once`);
  const categories = Object.keys(quotas).sort(bytewise);
  if (categories.reduce((sum, c) => sum + (quotas[c] ?? 0), 0) <= 0) {
    issues.push('refused: the quotas select nothing');
  }
  const selected: TaskIdentity[] = [];
  for (const category of categories) {
    const quota = quotas[category];
    if (!Number.isInteger(quota) || quota < 0) {
      issues.push(`refused: quota for ${category} must be a non-negative integer`);
      continue;
    }
    if (quota === 0) continue;
    const entries = pool.filter((e) => categoryKey(e.task) === category);
    for (const e of entries) {
      if (e.eligibility.status === 'unresolved') {
        issues.push(
          `refused: category ${category} holds unresolved entry ${keyOf(e.task)} (${e.eligibility.blocker}); resolve it before freezing`,
        );
      }
    }
    const eligible = entries
      .filter((e) => e.eligibility.status === 'eligible')
      .map((e) => e.task)
      .sort(byTaskId);
    if (eligible.length < quota) {
      issues.push(
        `refused: category ${category} holds ${eligible.length} eligible entries, short of its quota ${quota}`,
      );
    } else selected.push(...eligible.slice(0, quota));
  }
  const smokeTasks = resolveSmoke(pool, smoke);
  if (!smokeTasks.ok) issues.push(...smokeTasks.issues);
  if (issues.length > 0 || !smokeTasks.ok) return { ok: false, issues };

  const base = {
    poolDigest: sha256Hex(canonicalJson(pool)),
    quotas: Object.fromEntries(categories.map((c) => [c, quotas[c]])),
    selected: selected.sort(byTaskKey),
    smoke: smokeTasks.value,
  };
  return parseManifest({
    schemaVersion: 1,
    manifestId: manifestIdFor(base),
    poolDigest: base.poolDigest,
    quotas: base.quotas,
    selected: base.selected,
    replacements: [],
    smoke: base.smoke,
    frozenAt,
  });
}

/** The invariants `verify` checks beyond the schema: every quota exactly filled, nothing doubled, id honest. */
function manifestIssues(m: TaskManifest): string[] {
  const issues = duplicateKeys(m.selected).map((k) => `selected lists ${k} more than once`);
  issues.push(...duplicateKeys(m.smoke).map((k) => `smoke lists ${k} more than once`));
  for (const category of Object.keys(m.quotas).sort(bytewise)) {
    const count = m.selected.filter((t) => categoryKey(t) === category).length;
    if (count !== m.quotas[category]) issues.push(`category ${category} selects ${count}, quota ${m.quotas[category]}`);
  }
  for (const t of m.selected) {
    if (m.quotas[categoryKey(t)] === undefined) issues.push(`${keyOf(t)} is selected outside every quota`);
  }
  const keys = new Set(m.selected.map(keyOf));
  for (const r of m.replacements) {
    if (!keys.has(r.by)) issues.push(`replacement ${r.replaced} -> ${r.by}: ${r.by} is not selected`);
    if (keys.has(r.replaced)) issues.push(`replacement ${r.replaced} -> ${r.by}: ${r.replaced} is still selected`);
  }
  const expected = manifestIdFor(m);
  if (m.manifestId !== expected) issues.push(`manifestId ${m.manifestId} does not match its content (${expected})`);
  return issues;
}

// ---------------------------------------------------------------------------
// Replacement
// ---------------------------------------------------------------------------

export function replaceIneligible(
  m: TaskManifest,
  pool: PoolEntry[],
  taskKey: string,
  reason: string,
  outcomesRecorded: boolean,
): Result<TaskManifest> {
  if (outcomesRecorded) {
    return refuse('refused: an attempt outcome is already recorded; replacement is allowed only before any outcome');
  }
  if (reason.trim().length === 0) return refuse('refused: a replacement needs a reason');
  const target = m.selected.find((t) => keyOf(t) === taskKey);
  if (target === undefined) {
    return refuse(`refused: ${taskKey} is not a selected task of manifest ${m.manifestId}`);
  }
  const category = categoryKey(target);
  // A task once selected or once replaced is never a candidate again.
  const taken = new Set([...m.selected.map(keyOf), ...m.replacements.map((r) => r.replaced)]);
  const next = pool
    .filter((e) => e.eligibility.status === 'eligible' && categoryKey(e.task) === category)
    .map((e) => e.task)
    .filter((t) => !taken.has(keyOf(t)))
    .sort(byTaskId)[0];
  if (next === undefined) {
    return refuse(
      `refused: category ${category} has no eligible replacement left for ${taskKey}; its quota ${m.quotas[category]} is never lowered`,
    );
  }
  const selected = [...m.selected.filter((t) => keyOf(t) !== taskKey), next].sort(byTaskKey);
  const replacements = [
    ...m.replacements,
    { replaced: taskKey, by: keyOf(next), reason, recordedAt: hostClock.wall() },
  ];
  const manifestId = manifestIdFor({ poolDigest: m.poolDigest, quotas: m.quotas, selected, smoke: m.smoke });
  return parseManifest({ ...m, manifestId, selected, replacements });
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

/** The arm is the configuration's treatment: none is the zero-genie arm, a pinned one the genie arm. */
const armOf = (c: HarnessConfiguration): ArmId => (c.treatment === null ? 'zero-genie' : 'genie');

interface Pair {
  kind: AttemptIdentity['kind'];
  taskKey: string;
  repeat: number;
  pairId: string;
}

export function scheduleCampaign(
  m: TaskManifest,
  configs: [HarnessConfiguration, HarnessConfiguration],
  repeats: number,
  seed: string,
  experimentId: string,
): AttemptIdentity[] {
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error('refused: repeats must be a positive integer');
  if (seed.length === 0) throw new Error('refused: a non-empty seed is required');
  if (!SAFE_SEGMENT.test(experimentId))
    throw new Error(`refused: experimentId '${experimentId}' is not a safe path segment`);
  const [a, b] = configs;
  if (armOf(a) === armOf(b)) {
    throw new Error(
      `refused: configurations ${a.configId} and ${b.configId} are both the ${armOf(a)} arm; a pair needs one of each`,
    );
  }
  if (a.configId === b.configId) throw new Error(`refused: both configurations are '${a.configId}'`);
  const dupes = [...duplicateKeys(m.selected), ...duplicateKeys(m.smoke)];
  if (dupes.length > 0) throw new Error(`refused: the manifest lists ${dupes.join(', ')} more than once`);

  // The pair id hashes the pair's identity, so no taskKey character (a '/') reaches a path segment.
  const pair = (kind: Pair['kind'], key: string, repeat: number): Pair => ({
    kind,
    taskKey: key,
    repeat,
    pairId: `${kind}-${sha256Hex(JSON.stringify(['genie-bench/pair', experimentId, m.manifestId, kind, key, repeat])).slice(0, 24)}`,
  });
  const orderKey = (p: Pair): string => sha256Hex(JSON.stringify(['genie-bench/order', seed, p.pairId]));
  const seeded = (pairs: Pair[]): Pair[] =>
    pairs
      .map((p) => ({ p, k: orderKey(p) }))
      .sort((x, y) => bytewise(x.k, y.k) || bytewise(x.p.pairId, y.p.pairId))
      .map(({ p }) => p);

  const smokePairs = m.smoke.map((t) => pair('smoke', keyOf(t), 0));
  const scoredPairs = m.selected.flatMap((t) => Array.from({ length: repeats }, (_, r) => pair('scored', keyOf(t), r)));
  const rows: AttemptIdentity[] = [];
  for (const p of [...seeded(smokePairs), ...seeded(scoredPairs)]) {
    const flip = Number.parseInt(sha256Hex(JSON.stringify(['genie-bench/arm-order', seed, p.pairId])).slice(0, 2), 16);
    for (const c of flip % 2 === 0 ? [a, b] : [b, a]) {
      rows.push({
        experimentId,
        pairId: p.pairId,
        manifestId: m.manifestId,
        taskKey: p.taskKey,
        configId: c.configId,
        arm: armOf(c),
        repeat: p.repeat,
        attemptId: `${p.pairId}-${armOf(c)}`,
        scheduledIndex: rows.length,
        kind: p.kind,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage:
  bun scripts/bench/pilot.ts freeze --pool <file> --quotas <file> --smoke <source:taskId,...> --frozen-at <iso> --out <file>
  bun scripts/bench/pilot.ts replace --manifest <file> --pool <file> --task <key> --reason <text> --root <dir>
  bun scripts/bench/pilot.ts verify <manifest>
  bun scripts/bench/pilot.ts schedule --manifest <file> --config-a <file> --config-b <file> --repeats <n> --seed <s> --experiment <id> --root <dir>
exit: 0 ok, 1 not ok, 2 refusal
`;

const FREEZE_FLAGS = ['--pool', '--quotas', '--smoke', '--frozen-at', '--out'] as const;
const REPLACE_FLAGS = ['--manifest', '--pool', '--task', '--reason', '--root'] as const;
const SCHEDULE_FLAGS = [
  '--manifest',
  '--config-a',
  '--config-b',
  '--repeats',
  '--seed',
  '--experiment',
  '--root',
] as const;

function parseFlags<F extends string>(argv: readonly string[], names: readonly F[]): Result<Record<F, string>> {
  const seen = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!(names as readonly string[]).includes(flag)) return refuse(`refused: unknown argument ${flag}`);
    if (seen.has(flag)) return refuse(`refused: ${flag} given twice`);
    if (value === undefined || value.length === 0 || value.startsWith('--'))
      return refuse(`refused: ${flag} needs a value`);
    seen.set(flag, value);
  }
  const missing = names.filter((f) => !seen.has(f));
  if (missing.length > 0) return refuse(`refused: missing ${missing.join(', ')}`);
  return { ok: true, value: Object.fromEntries(seen) as Record<F, string> };
}

function readJson(path: string, what: string): Result<unknown> {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (err) {
    return refuse(`refused: cannot read ${what} ${path}: ${message(err)}`);
  }
}

function load<T>(path: string, what: string, parse: (raw: unknown) => Result<T>): Result<T> {
  const raw = readJson(path, what);
  if (!raw.ok) return raw;
  const parsed = parse(raw.value);
  return parsed.ok ? parsed : refuse(...parsed.issues.map((i) => `refused: ${what} ${path}: ${i}`));
}

function parseQuotas(raw: unknown): Result<Quotas> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return refuse('quotas must be a JSON object');
  const bad = Object.entries(raw).filter(([, v]) => !Number.isInteger(v) || (v as number) < 0);
  if (bad.length > 0) return refuse(...bad.map(([k]) => `quota ${k} must be a non-negative integer`));
  return { ok: true, value: raw as Quotas };
}

function refused(issues: string[], usage = false): number {
  process.stderr.write(`${issues.map((i) => `pilot: ${i}`).join('\n')}\n${usage ? USAGE : ''}`);
  return 2;
}

function runFreeze(argv: readonly string[]): number {
  const flags = parseFlags(argv, FREEZE_FLAGS);
  if (!flags.ok) return refused(flags.issues, true);
  const out = flags.value['--out'];
  if (existsSync(out)) return refused([`refused: ${out} already exists; a frozen manifest is never overwritten`]);
  const pool = load(flags.value['--pool'], 'pool', parsePool);
  if (!pool.ok) return refused(pool.issues);
  const quotas = load(flags.value['--quotas'], 'quotas', parseQuotas);
  if (!quotas.ok) return refused(quotas.issues);
  const smoke = flags.value['--smoke']
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const manifest = freezeManifest(pool.value, quotas.value, smoke, flags.value['--frozen-at']);
  if (!manifest.ok) return refused(manifest.issues);
  writeFileSync(out, serializeManifest(manifest.value), { flag: 'wx' });
  const m = manifest.value;
  process.stdout.write(`${out}\nfrozen ${m.manifestId}: ${m.selected.length} selected, ${m.smoke.length} smoke\n`);
  return 0;
}

/**
 * Whether any attempt under the ledger root has moved past registration. Conservative by design:
 * any transition, any corrupt line, or a journal that cannot be read counts against replacement.
 */
function recordedOutcome(root: string): Result<string | null> {
  const dir = join(root, 'attempts');
  if (!existsSync(dir)) return { ok: true, value: null };
  const ids = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && SAFE_SEGMENT.test(d.name))
    .map((d) => d.name)
    .sort(bytewise);
  for (const attemptId of ids) {
    const read = readJournal(root, attemptId);
    if (!read.ok) return refuse(...read.issues.map((i) => `refused: cannot prove no outcome is recorded: ${i}`));
    if (read.value.entries.length > 0 || read.value.corrupt.length > 0) {
      return { ok: true, value: `attempt ${attemptId} has a recorded transition (state ${read.value.state})` };
    }
  }
  return { ok: true, value: null };
}

function runReplace(argv: readonly string[]): number {
  const flags = parseFlags(argv, REPLACE_FLAGS);
  if (!flags.ok) return refused(flags.issues, true);
  const { '--manifest': path, '--root': root } = flags.value;
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return refused([
      `refused: --root ${root} is not an existing directory; a mistyped root could hide recorded outcomes`,
    ]);
  }
  const manifest = load(path, 'manifest', parseManifest);
  if (!manifest.ok) return refused(manifest.issues);
  const pool = load(flags.value['--pool'], 'pool', parsePool);
  if (!pool.ok) return refused(pool.issues);
  const lock = acquireSupervisor(root);
  if (!lock.ok) return refused(lock.issues);
  try {
    const outcome = recordedOutcome(root);
    if (!outcome.ok) return refused(outcome.issues);
    const next = replaceIneligible(
      manifest.value,
      pool.value,
      flags.value['--task'],
      flags.value['--reason'],
      outcome.value !== null,
    );
    if (!next.ok) return refused(outcome.value === null ? next.issues : [...next.issues, outcome.value]);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, serializeManifest(next.value), { flag: 'wx' });
    renameSync(tmp, path);
    const record = next.value.replacements[next.value.replacements.length - 1];
    process.stdout.write(`replaced ${record.replaced} by ${record.by}; manifest ${next.value.manifestId}\n`);
    return 0;
  } finally {
    lock.value.release();
  }
}

function runVerify(argv: readonly string[]): number {
  if (argv.length !== 1 || argv[0].startsWith('--')) return refused(['refused: verify takes one manifest path'], true);
  const raw = readJson(argv[0], 'manifest');
  if (!raw.ok) return refused(raw.issues);
  const parsed = parseManifest(raw.value);
  const issues = parsed.ok ? manifestIssues(parsed.value) : parsed.issues;
  if (issues.length > 0 || !parsed.ok) {
    process.stderr.write(`${issues.map((i) => `pilot: ${argv[0]}: ${i}`).join('\n')}\n`);
    return 1;
  }
  process.stdout.write(`ok ${parsed.value.manifestId}: ${parsed.value.selected.length} selected\n`);
  return 0;
}

/** The seed and the inputs it ordered, beside the registered schedule; written once, never changed. */
function recordPreregistration(root: string, experimentId: string, record: Record<string, unknown>): Result<string> {
  const path = join(root, 'campaigns', experimentId, 'preregistration.json');
  const text = `${JSON.stringify({ schemaVersion: 1, experimentId, ...record }, null, 2)}\n`;
  if (existsSync(path)) {
    return readFileSync(path, 'utf8') === text
      ? { ok: true, value: path }
      : refuse(`not ok: ${path} already records a different preregistration; it was not overwritten`);
  }
  writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
  return { ok: true, value: path };
}

function runSchedule(argv: readonly string[]): number {
  const flags = parseFlags(argv, SCHEDULE_FLAGS);
  if (!flags.ok) return refused(flags.issues, true);
  const { '--root': root, '--seed': seed, '--experiment': experimentId } = flags.value;
  if (!/^[1-9][0-9]*$/.test(flags.value['--repeats']))
    return refused(['refused: --repeats must be a positive integer']);
  const repeats = Number(flags.value['--repeats']);
  const manifest = load(flags.value['--manifest'], 'manifest', parseManifest);
  if (!manifest.ok) return refused(manifest.issues);
  const invalid = manifestIssues(manifest.value);
  if (invalid.length > 0) return refused(invalid.map((i) => `refused: manifest does not verify: ${i}`));
  const configA = load(flags.value['--config-a'], 'configuration', parseConfiguration);
  if (!configA.ok) return refused(configA.issues);
  const configB = load(flags.value['--config-b'], 'configuration', parseConfiguration);
  if (!configB.ok) return refused(configB.issues);
  let schedule: AttemptIdentity[];
  try {
    schedule = scheduleCampaign(manifest.value, [configA.value, configB.value], repeats, seed, experimentId);
  } catch (err) {
    return refused([message(err)]);
  }
  const lock = acquireSupervisor(root);
  if (!lock.ok) return refused(lock.issues);
  try {
    const registered = registerCampaign(root, schedule);
    if (!registered.ok) return refused(registered.issues);
    const scored = schedule.filter((r) => r.kind === 'scored').length;
    const prereg = recordPreregistration(root, experimentId, {
      manifestId: manifest.value.manifestId,
      seed,
      repeats,
      configs: [configA.value.configId, configB.value.configId],
      scored,
      smoke: schedule.length - scored,
    });
    if (!prereg.ok) {
      process.stderr.write(`${prereg.issues.map((i) => `pilot: ${i}`).join('\n')}\n`);
      return 1;
    }
    process.stdout.write(
      `registered ${schedule.length} attempts (${scored} scored, ${schedule.length - scored} smoke) for ${experimentId}; seed ${seed}; ${prereg.value}\n`,
    );
    return 0;
  } finally {
    lock.value.release();
  }
}

function runPilotCli(argv: readonly string[]): number {
  const [verb, ...rest] = argv;
  try {
    if (verb === 'freeze') return runFreeze(rest);
    if (verb === 'replace') return runReplace(rest);
    if (verb === 'verify') return runVerify(rest);
    if (verb === 'schedule') return runSchedule(rest);
    return refused([`refused: unknown verb ${verb ?? '(none)'}`], true);
  } catch (err) {
    process.stderr.write(`pilot: not ok: ${message(err)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = runPilotCli(process.argv.slice(2));
}
