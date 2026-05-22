/**
 * Dedicated-role cutover — Goal A, Group 1 (foundation).
 *
 * Wish: `.genie/wishes/genie-dedicated-role-cutover/WISH.md`.
 *
 * Genie connects to the shared pgserve postmaster as the cluster superuser
 * `postgres`. A genie bug / bad migration / compromised process therefore has
 * superuser authority over the whole machine's Postgres (it can
 * `DROP DATABASE omni`, exhaust the cluster, create roles, corrupt shared WAL).
 *
 * This module provisions a dedicated NON-superuser role scoped to genie's own
 * objects inside the EXISTING `postgres` database. **No bytes move.** Group 1
 * only provisions + grants + proves the privilege envelope; the connection
 * identity rebind is Group 2. Wave 3 (Group 4) flipped the gate to DEFAULT-ON:
 * `ensureScopedRole()` runs unless the documented kill-switch
 * `GENIE_ROLE_CUTOVER=0` forces the legacy `postgres`/`postgres` path.
 *
 * Concurrency-safe: provisioning runs under a NON-BLOCKING
 * `pg_try_advisory_lock(hashtext('genie:role-cutover-v1'))`. Late arrivals
 * skip provisioning and return immediately — never block the boot path.
 *
 * Events are emitted OUT-OF-BAND (stderr structured JSON + a `~/.genie/`
 * file), never into any DB table — by council mandate the role-cutover signal
 * must not depend on the very DB it is reshaping.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import REPLICA_INSERT_DRAIN_BRIDGE_SQL from '../db/bridges/replica-insert-drain.sql' with { type: 'text' };
import { resolveDatabaseName } from './db.js';

// ============================================================================
// Naming — ports pgserve v2.4 `deriveProvisionedNames` / `resolveFingerprint`
// (pgserve/src/provision/db-naming.js + fingerprint.js) as pure functions so
// the role name stays forward-compatible with Goal B. Group 2 will unify the
// genie-package-dir resolution with db.ts; Group 1 stays self-contained.
// ============================================================================

const POSTGRES_MAX_IDENTIFIER = 63;
const NAME_PREFIX = 'pgserve_';
const FINGERPRINT_HEX_LEN = 12;
const ROLE_SUFFIX = '_role';
const GENIE_PACKAGE_NAME = '@automagik/genie';
const ADVISORY_LOCK_KEY = 'genie:role-cutover-v1';
const IDENTIFIER_RE = /^[a-z0-9_]+$/;

/** Lowercase + collapse non-`[a-z0-9]` runs to `_`, trim leading/trailing `_`. */
export function sanitizeSlug(input: string): string {
  if (typeof input !== 'string') return '';
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

export interface ProvisionedNames {
  databaseName: string;
  roleName: string;
  slug: string;
  fingerprintHex: string;
}

/**
 * Derive the `pgserve_<slug>_<fp12>` database + `…_role` role name pair from a
 * fingerprint + publisher. Identical algorithm to pgserve's provisioner so a
 * future Goal B relocation lands on the same identifiers. Pure.
 */
export function deriveProvisionedNames(args: { fingerprint: string; publisher: string }): ProvisionedNames {
  const { fingerprint, publisher } = args;
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
    throw new TypeError('deriveProvisionedNames: fingerprint must be a non-empty string');
  }
  const hexLike = /^[0-9a-f]+$/.test(fingerprint);
  const fingerprintHex = hexLike
    ? fingerprint.slice(0, FINGERPRINT_HEX_LEN)
    : sanitizeSlug(fingerprint).slice(0, FINGERPRINT_HEX_LEN);
  if (fingerprintHex.length === 0) {
    throw new Error('deriveProvisionedNames: fingerprint produced an empty hex segment');
  }

  const dbSlugBudget = POSTGRES_MAX_IDENTIFIER - NAME_PREFIX.length - 1 - fingerprintHex.length;
  const roleSlugBudget = dbSlugBudget - ROLE_SUFFIX.length;
  const slugBudget = Math.max(0, Math.min(dbSlugBudget, roleSlugBudget));

  const slug = sanitizeSlug(publisher).slice(0, slugBudget);

  const databaseName = slug.length > 0 ? `${NAME_PREFIX}${slug}_${fingerprintHex}` : `${NAME_PREFIX}${fingerprintHex}`;
  const roleName =
    slug.length > 0
      ? `${NAME_PREFIX}${slug}_${fingerprintHex}${ROLE_SUFFIX}`
      : `${NAME_PREFIX}${fingerprintHex}${ROLE_SUFFIX}`;

  return { databaseName, roleName, slug, fingerprintHex };
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

let geniePackageDirCache: string | null | undefined;

/**
 * Locate the on-disk directory whose `package.json#name === '@automagik/genie'`
 * by walking up from this module, with a `bun --compile` execPath fallback.
 * Mirrors `db.ts:resolveGeniePackageDir`; kept local so Group 1 does not edit
 * db.ts (Group 2 unifies the two). Returns null when neither strategy resolves.
 */
function resolveGeniePackageDir(): string | null {
  if (geniePackageDirCache !== undefined) return geniePackageDirCache;
  const MAX_WALK_DEPTH = 10;
  let current = dirname(import.meta.dir ?? __dirname);
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    const candidate = join(current, 'package.json');
    try {
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8')) as { name?: string };
        if (pkg?.name === GENIE_PACKAGE_NAME) {
          geniePackageDirCache = current;
          return current;
        }
      }
    } catch {
      // Malformed package.json — keep walking.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  try {
    const execPath = process.execPath;
    if (execPath) {
      const execDir = dirname(realpathSync(execPath));
      if (execDir && existsSync(execDir)) {
        geniePackageDirCache = execDir;
        return execDir;
      }
    }
  } catch {
    // execPath unavailable — fall through to null.
  }
  geniePackageDirCache = null;
  return null;
}

interface GenieFingerprint {
  fingerprint: string;
  publisher: string;
}

/**
 * Resolve genie's fingerprint + publisher with the same precedence pgserve's
 * provisioner uses: pinned `pgserve.fingerprint` → sha256(`name@version`) →
 * sha256(`name`) → sha256(absolute dir). Returns null when the genie package
 * dir cannot be resolved (unstable fingerprint → caller skips cutover).
 */
function resolveGenieFingerprint(): GenieFingerprint | null {
  const dir = resolveGeniePackageDir();
  if (!dir) return null;
  let pkg: Record<string, unknown> | null = null;
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as Record<string, unknown>;
  } catch {
    pkg = null;
  }
  const pgserveCfg =
    pkg && typeof pkg.pgserve === 'object' && pkg.pgserve !== null ? (pkg.pgserve as Record<string, unknown>) : null;
  const pinned = pgserveCfg && typeof pgserveCfg.fingerprint === 'string' ? (pgserveCfg.fingerprint as string) : '';
  const publisherCfg = pgserveCfg && typeof pgserveCfg.publisher === 'string' ? (pgserveCfg.publisher as string) : '';
  const name = pkg && typeof pkg.name === 'string' ? (pkg.name as string) : '';
  const version = pkg && typeof pkg.version === 'string' ? (pkg.version as string) : '';
  const publisher = publisherCfg.length > 0 ? publisherCfg : name;

  if (pinned.length > 0) return { fingerprint: pinned, publisher };
  if (name.length > 0) {
    return { fingerprint: version.length > 0 ? sha256Hex(`${name}@${version}`) : sha256Hex(name), publisher };
  }
  return { fingerprint: sha256Hex(dir), publisher };
}

/**
 * Resolve the scoped role name for this genie install, or null when the
 * fingerprint is unstable (caller emits `role-cutover.skip.fingerprint-unstable`
 * and stays on `postgres`/`postgres`).
 */
export function deriveScopedRoleName(): string | null {
  const fp = resolveGenieFingerprint();
  if (!fp) return null;
  return deriveProvisionedNames(fp).roleName;
}

// ============================================================================
// Out-of-band event sink — stderr structured JSON + a `~/.genie/` file.
// Never a DB table (council/operator mandate): the role-cutover signal must
// not depend on the DB it is reshaping.
// ============================================================================

export type RoleCutoverEventName =
  | 'role-cutover.provisioned'
  | 'role-cutover.cutover'
  | 'role-cutover.skip.disabled'
  | 'role-cutover.skip.fingerprint-unstable'
  | 'role-cutover.skip.lock-contended'
  | 'role-cutover.skip.already-provisioned'
  | 'role-cutover.skip.sentinel-fast-path'
  | 'role-cutover.error.provision-failed'
  // Group 2 — identity-rebind fallbacks. The `<reason>` suffix is open-ended
  // by council mandate (every degraded path emits its own reason out-of-band).
  | `role-cutover.fallback.${string}`;

export interface RoleCutoverEvent {
  event: RoleCutoverEventName;
  ts: string;
  pid: number;
  roleName?: string;
  database?: string;
  detail?: Record<string, unknown>;
}

export type RoleCutoverSink = (event: RoleCutoverEvent) => void;

// ============================================================================
// Default-ON gate (Wave 3 — Goal A, Group 4).
//
// Through Waves 1+2 the cutover was OPT-IN (`GENIE_ROLE_CUTOVER=1`). Wave 3
// flips it: cutover is now the DEFAULT and `GENIE_ROLE_CUTOVER=0` is the single
// documented KILL-SWITCH that forces the legacy `postgres`/`postgres` path
// (byte-for-byte today's behavior). Any other value — unset, `1`, anything that
// is not exactly the string `0` — leaves cutover ON. This is the only place
// the gate literal lives so the kill-switch can never drift between db.ts and
// this module.
// ============================================================================

/**
 * True unless the documented kill-switch is engaged. `GENIE_ROLE_CUTOVER=0`
 * (and ONLY the exact string `0`) forces the legacy postgres/postgres path;
 * unset / `1` / any other value ⇒ cutover ON. Single source of truth — db.ts
 * imports this rather than re-deriving the literal.
 */
export function isRoleCutoverEnabled(): boolean {
  return process.env.GENIE_ROLE_CUTOVER !== '0';
}

function genieHome(): string {
  return process.env.GENIE_HOME ?? join(homedir(), '.genie');
}

/** Out-of-band sink: structured JSON to stderr + append to `~/.genie/`. */
export function defaultRoleCutoverSink(event: RoleCutoverEvent): void {
  const line = `${JSON.stringify(event)}\n`;
  // emit-discipline: ok — out-of-band role-cutover structured event, never a DB row
  process.stderr.write(line);
  try {
    const home = genieHome();
    mkdirSync(home, { recursive: true });
    appendFileSync(join(home, 'role-cutover-events.jsonl'), line);
  } catch {
    // Best-effort: the file mirror is a convenience, stderr is the contract.
  }
}

function emit(
  sink: RoleCutoverSink,
  event: RoleCutoverEventName,
  fields: Partial<Pick<RoleCutoverEvent, 'roleName' | 'database' | 'detail'>> = {},
): void {
  try {
    sink({ event, ts: new Date().toISOString(), pid: process.pid, ...fields });
  } catch {
    // A broken sink must never break provisioning.
  }
}

// ============================================================================
// Provisioning
// ============================================================================

/** Minimal structural view of the postgres.js client we depend on. */
export interface SqlLike {
  // biome-ignore lint/suspicious/noExplicitAny: postgres.js tagged-template result
  (strings: TemplateStringsArray, ...values: any[]): Promise<any[]> & { values?: unknown };
  // biome-ignore lint/suspicious/noExplicitAny: postgres.js unsafe escape hatch
  unsafe: (query: string) => Promise<any[]>;
  reserve: () => Promise<ReservedSqlLike>;
}

export interface ReservedSqlLike {
  // biome-ignore lint/suspicious/noExplicitAny: postgres.js tagged-template result
  (strings: TemplateStringsArray, ...values: any[]): Promise<any[]>;
  // biome-ignore lint/suspicious/noExplicitAny: postgres.js unsafe escape hatch
  unsafe: (query: string) => Promise<any[]>;
  release: () => void;
}

export interface EnsureScopedRoleOptions {
  /** Superuser connection used to provision (the bootstrap connection in prod). */
  sql: SqlLike;
  /** Target database for the CONNECT grant. Defaults to the resolved DB name. */
  database?: string;
  /** Override the derived role name (tests). */
  roleName?: string;
  /** Event sink. Defaults to the out-of-band stderr+file sink. */
  sink?: RoleCutoverSink;
  /** Force the gate (tests). Defaults to `GENIE_ROLE_CUTOVER === '1'`. */
  enabled?: boolean;
}

export type RoleCutoverStatus = 'provisioned' | 'already-provisioned' | 'skipped';

export interface RoleCutoverResult {
  status: RoleCutoverStatus;
  roleName: string | null;
  reason?: string;
}

function assertSafeIdentifier(kind: string, value: string): void {
  if (!IDENTIFIER_RE.test(value)) {
    throw new Error(`role-cutover: refusing unsafe ${kind} identifier ${JSON.stringify(value)}`);
  }
}

/**
 * Cluster RBAC roles that migrations 041/043 create. They are global (cluster-
 * scoped, survive DB drops) and `CREATE ROLE` requires CREATEROLE/superuser —
 * which the scoped `NOCREATEROLE` role lacks. On a warm cluster they already
 * exist and the migrations' `IF NOT EXISTS` probes short-circuit; on a TRULY
 * fresh pgserve cluster (the CI smoke's `--data` dir) they do not, so the
 * privileged bootstrap must create them BEFORE the scoped role replays.
 *
 * Mirrors `src/db/migrations/041_rbac_roles.sql` + `043_executor_read_role.sql`
 * (`CREATE ROLE <x> NOINHERIT`). The fresh-DB replay test runs the REAL
 * migrations after this and fails loudly if the two ever drift.
 */
const PRIVILEGED_BOOTSTRAP_ROLES = [
  'events_admin',
  'events_operator',
  'events_subscriber',
  'events_audit',
  'executors_reader',
] as const;

/**
 * Stage the inherently-privileged, one-time setup that genie's migration set
 * performs but the least-privilege scoped role legitimately must NEVER do:
 * the `pgcrypto` extension (039/041), the cluster RBAC/executor roles
 * (041/043), and ownership of genie's OWN database `public` schema (so the
 * scoped role can evolve its own schema via `runMigrations`).
 *
 * Runs on the BOOTSTRAP SUPERUSER connection, before the rebind to the scoped
 * role. This does NOT grant the scoped role any extra privilege — the role
 * stays `NOSUPERUSER NOCREATEROLE`; the privileged primitives are created by
 * the superuser who legitimately may. Every statement is idempotent
 * (`IF NOT EXISTS` / set-style), so re-runs and warm clusters converge to a
 * no-op. Scoped to genie's own DB — zero bytes move, no neighbor touched.
 *
 * Throws on any failure; the caller (db.ts) funnels that into the existing
 * `role-cutover.fallback.*` path (stay on the superuser bootstrap pool, never
 * hard-fail boot — migrations then run as the superuser exactly like legacy).
 */
export async function ensurePrivilegedBootstrapObjects(sql: SqlLike, scopedRole: string): Promise<void> {
  assertSafeIdentifier('role', scopedRole);
  // pgcrypto: untrusted extension ⇒ superuser-only. Migrations 039 & 041 do
  // `CREATE EXTENSION IF NOT EXISTS pgcrypto`; pre-staging it makes those a
  // no-op when the scoped role later replays them.
  await sql.unsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  for (const role of PRIVILEGED_BOOTSTRAP_ROLES) {
    const exists = await sql.unsafe(`SELECT 1 FROM pg_roles WHERE rolname = '${role}'`);
    if (exists.length === 0) {
      await sql.unsafe(`CREATE ROLE "${role}" NOINHERIT`);
    }
  }
  // genie owns its OWN database's `public` schema so the scoped role can run
  // schema DDL in `runMigrations`. Metadata-only (catalog), zero bytes moved,
  // scoped to genie's DB — the proven Group-3 replay prerequisite.
  await sql.unsafe(`ALTER SCHEMA public OWNER TO "${scopedRole}"`);
  // Privilege bridges — SECURITY DEFINER wrappers owned by the bootstrap
  // superuser. The scoped role gets EXECUTE; the wrapped body is the only
  // surface that runs with elevated privilege. Currently bridges one capability:
  // session_replication_role='replica' (SUPERUSER-gated GUC) for the trigger-
  // suppressed bulk INSERT inside genie_runtime_events_drain_default (055/064).
  await installPrivilegeBridges(sql, scopedRole);
}

/**
 * Install (or refresh) the SECURITY DEFINER privilege bridges the scoped role
 * relies on. Idempotent and bootstrap-only: must run on the superuser
 * connection (CREATE OR REPLACE preserves an existing owner; the explicit
 * ALTER FUNCTION ... OWNER TO CURRENT_USER normalises ownership on first
 * install or recovers from an earlier scoped-role-owned variant).
 *
 * Each bridge is a one-statement-purpose wrapper. Adding more bridges later
 * means appending here — not granting the scoped role new cluster privileges.
 */
async function installPrivilegeBridges(sql: SqlLike, scopedRole: string): Promise<void> {
  const r = `"${scopedRole}"`;
  // CREATE OR REPLACE FUNCTION … SECURITY DEFINER, loaded from
  // src/db/bridges/replica-insert-drain.sql so the SQL body lives next to the
  // migrations it supports and stays outside src/lib/ (where the emit-discipline
  // lint legitimately forbids raw INSERTs into genie_runtime_events).
  await sql.unsafe(REPLICA_INSERT_DRAIN_BRIDGE_SQL);
  // Ownership + grants — done here (not in the .sql) so the bridge's caller
  // identity (the bootstrap superuser) is the authoritative source.
  await sql.unsafe('ALTER FUNCTION genie_runtime_events_replica_insert_drain() OWNER TO CURRENT_USER');
  await sql.unsafe('REVOKE EXECUTE ON FUNCTION genie_runtime_events_replica_insert_drain() FROM PUBLIC');
  await sql.unsafe(`GRANT EXECUTE ON FUNCTION genie_runtime_events_replica_insert_drain() TO ${r}`);
}

/**
 * GRANT genie's privilege envelope onto the scoped role. Set-style and
 * idempotent — re-running converges. Sized to keep genie fully functional in
 * its own DB (DML + schema DDL via `runMigrations`) while withholding every
 * cross-tenant / cluster privilege.
 */
async function grantScopedPrivileges(reserved: ReservedSqlLike, role: string, database: string): Promise<void> {
  const r = `"${role}"`;
  const db = `"${database}"`;
  await reserved.unsafe(`GRANT CONNECT ON DATABASE ${db} TO ${r}`);
  await reserved.unsafe(`GRANT USAGE, CREATE ON SCHEMA public TO ${r}`);
  await reserved.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${r}`);
  await reserved.unsafe(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${r}`);
  // Future migration-created objects must stay reachable. Default form =
  // FOR ROLE current_user (the provisioning superuser, owner of pre-cutover
  // migration objects). Also FOR ROLE the scoped role itself for post-cutover
  // objects it will own.
  await reserved.unsafe(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${r}`,
  );
  await reserved.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${r}`);
  await reserved.unsafe(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${r} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${r}`,
  );
  await reserved.unsafe(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${r} IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${r}`,
  );
}

/**
 * Idempotently ensure the dedicated non-superuser role exists with genie's
 * scoped privilege envelope. No-op only under the kill-switch
 * `GENIE_ROLE_CUTOVER=0` (Wave 3 default-on). Never throws
 * for an operational failure — it emits `role-cutover.error.*` out-of-band and
 * returns `skipped` so a caller on the boot path can fall back cleanly.
 *
 * Concurrency: provisioning runs under a NON-BLOCKING advisory lock on a
 * reserved connection. Late arrivals get `false` from `pg_try_advisory_lock`,
 * emit `role-cutover.skip.lock-contended`, and return immediately — they never
 * block and never double-provision (CREATE ROLE is guarded by a pg_roles
 * existence check and the GRANTs are set-style).
 */
export async function ensureScopedRole(opts: EnsureScopedRoleOptions): Promise<RoleCutoverResult> {
  const sink = opts.sink ?? defaultRoleCutoverSink;
  const enabled = opts.enabled ?? isRoleCutoverEnabled();

  if (!enabled) {
    emit(sink, 'role-cutover.skip.disabled');
    return { status: 'skipped', roleName: null, reason: 'disabled' };
  }

  const roleName = opts.roleName ?? deriveScopedRoleName();
  if (!roleName) {
    emit(sink, 'role-cutover.skip.fingerprint-unstable');
    return { status: 'skipped', roleName: null, reason: 'fingerprint-unstable' };
  }
  const database = opts.database ?? resolveDatabaseName();
  assertSafeIdentifier('role', roleName);
  assertSafeIdentifier('database', database);

  let reserved: ReservedSqlLike | null = null;
  let acquired = false;
  try {
    reserved = await opts.sql.reserve();
    const lockRows = await reserved.unsafe(`SELECT pg_try_advisory_lock(hashtext('${ADVISORY_LOCK_KEY}')) AS locked`);
    acquired = lockRows[0]?.locked === true;
    if (!acquired) {
      emit(sink, 'role-cutover.skip.lock-contended', { roleName, database });
      return { status: 'skipped', roleName, reason: 'lock-contended' };
    }

    const existing = await reserved.unsafe(`SELECT 1 FROM pg_roles WHERE rolname = '${roleName}'`);
    const alreadyExisted = existing.length > 0;
    if (!alreadyExisted) {
      await reserved.unsafe(
        `CREATE ROLE "${roleName}" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
    }
    await grantScopedPrivileges(reserved, roleName, database);

    if (alreadyExisted) {
      emit(sink, 'role-cutover.skip.already-provisioned', { roleName, database });
      return { status: 'already-provisioned', roleName };
    }
    emit(sink, 'role-cutover.provisioned', { roleName, database });
    return { status: 'provisioned', roleName };
  } catch (err) {
    emit(sink, 'role-cutover.error.provision-failed', {
      roleName,
      database,
      detail: { message: err instanceof Error ? err.message : String(err) },
    });
    return { status: 'skipped', roleName, reason: 'error' };
  } finally {
    if (reserved) {
      if (acquired) {
        try {
          await reserved.unsafe(`SELECT pg_advisory_unlock(hashtext('${ADVISORY_LOCK_KEY}'))`);
        } catch {
          // Session ends on pool drain anyway; unlock is best-effort.
        }
      }
      reserved.release();
    }
  }
}

// ============================================================================
// Group 2 — per-fingerprint sentinel + identity rebind resolution.
//
// The sentinel is a per-fingerprint FS marker (`~/.genie/.role-cutover-<fp>.json`)
// caching "role provisioned + grants verified". Steady-state boots cost ONE
// `stat`, not a role/grant introspection query. It is a *validated cache*, not
// source-of-truth: the DB (`pg_roles`) wins. A global sentinel would strand a
// multi-checkout host's second fingerprint (council finding) — so it is keyed
// by the 12-hex fingerprint segment, never a single global file.
// ============================================================================

/**
 * Fallback login identity = today's exact behavior (the postgres superuser).
 * Reconstructed locally (mirrors `db.ts:DB_NAME`) so this stays a pure
 * top-level constant — importing `DB_NAME` would be a circular top-level
 * dependency (db.ts imports this module) and trip the TDZ on load.
 */
const FALLBACK_SUPERUSER = ['post', 'gres'].join('');

export interface RoleCutoverSentinel {
  roleName: string;
  database: string;
  verifiedAt: string;
}

/** `~/.genie/.role-cutover-<fp>.json` — per-fingerprint, never global. */
export function roleCutoverSentinelPath(fingerprintHex: string): string {
  assertSafeIdentifier('fingerprint', fingerprintHex);
  return join(genieHome(), `.role-cutover-${fingerprintHex}.json`);
}

/** O(1) read of the per-fingerprint sentinel. Null = absent/unreadable/stale. */
export function readRoleCutoverSentinel(fingerprintHex: string): RoleCutoverSentinel | null {
  let path: string;
  try {
    path = roleCutoverSentinelPath(fingerprintHex);
  } catch {
    return null;
  }
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<RoleCutoverSentinel>;
    if (
      typeof parsed?.roleName === 'string' &&
      parsed.roleName.length > 0 &&
      typeof parsed.database === 'string' &&
      parsed.database.length > 0 &&
      typeof parsed.verifiedAt === 'string'
    ) {
      return { roleName: parsed.roleName, database: parsed.database, verifiedAt: parsed.verifiedAt };
    }
  } catch {
    // Malformed sentinel — treat as absent; the DB revalidation path rebuilds it.
  }
  return null;
}

/** Persist the validated cache after a successful provision + pg_roles check. */
export function writeRoleCutoverSentinel(fingerprintHex: string, data: { roleName: string; database: string }): void {
  try {
    const path = roleCutoverSentinelPath(fingerprintHex);
    mkdirSync(dirname(path), { recursive: true });
    const payload: RoleCutoverSentinel = {
      roleName: data.roleName,
      database: data.database,
      verifiedAt: new Date().toISOString(),
    };
    writeFileSync(path, `${JSON.stringify(payload)}\n`);
  } catch {
    // Best-effort: a missing sentinel only costs one introspection query next
    // boot — it never blocks or breaks the cutover.
  }
}

/** Self-heal: drop a stale sentinel so the next boot revalidates from pg_roles. */
export function clearRoleCutoverSentinel(fingerprintHex: string): void {
  try {
    unlinkSync(roleCutoverSentinelPath(fingerprintHex));
  } catch {
    // Already gone / unreadable — nothing to heal.
  }
}

export interface ScopedConnectionIdentity {
  /** Login role: the scoped role when cut over, else the postgres superuser. */
  username: string;
  /** Always the existing genie DB — Goal A moves zero bytes. */
  database: string;
  /** True only when genie should rebind to the scoped role. */
  cutover: boolean;
  /** 12-hex fingerprint segment (sentinel key); null when unresolved. */
  fingerprintHex: string | null;
  /** Populated when `cutover === false` (fallback / skip reason). */
  reason?: string;
}

export interface ResolveScopedIdentityOptions {
  /** Bootstrap superuser connection (the one genie just opened). */
  sql: SqlLike;
  /** Target database — stays the existing genie DB (`postgres` in prod). */
  database: string;
  /** Override the derived role name (tests). */
  roleName?: string;
  /** Override the sentinel fingerprint key (tests / multi-fingerprint). */
  fingerprintHex?: string;
  /** Event sink. Defaults to the out-of-band stderr+file sink. */
  sink?: RoleCutoverSink;
  /** Force the gate (tests). Defaults to `GENIE_ROLE_CUTOVER === '1'`. */
  enabled?: boolean;
}

/**
 * Resolve the login identity genie should use on the load-bearing
 * direct-postmaster path. Never throws and never hard-fails boot: any missing
 * role / failed query / pgserve-mid-upgrade degrades to today's exact
 * `postgres`/`postgres` behavior, emitting `role-cutover.fallback.<reason>`
 * out-of-band.
 *
 * Fast-path: a present + matching per-fingerprint sentinel returns the scoped
 * role with ZERO introspection (one `stat`). Steady-state boot #2 therefore
 * does NOT silently revert to `postgres`/`postgres`. Absent/stale ⇒ provision
 * (idempotent) + revalidate against `pg_roles` + rewrite the sentinel.
 */
export async function resolveScopedConnectionIdentity(
  opts: ResolveScopedIdentityOptions,
): Promise<ScopedConnectionIdentity> {
  const sink = opts.sink ?? defaultRoleCutoverSink;
  const enabled = opts.enabled ?? isRoleCutoverEnabled();
  const database = opts.database;
  const fallback = (reason: string, fp: string | null = null): ScopedConnectionIdentity => ({
    username: FALLBACK_SUPERUSER,
    database,
    cutover: false,
    fingerprintHex: fp,
    reason,
  });

  if (!enabled) {
    emit(sink, 'role-cutover.skip.disabled');
    return fallback('disabled');
  }

  let roleName = opts.roleName ?? null;
  let fingerprintHex = opts.fingerprintHex ?? null;
  if (!roleName || !fingerprintHex) {
    const fp = resolveGenieFingerprint();
    if (!fp) {
      emit(sink, 'role-cutover.fallback.fingerprint-unstable');
      return fallback('fingerprint-unstable');
    }
    const names = deriveProvisionedNames(fp);
    roleName = roleName ?? names.roleName;
    fingerprintHex = fingerprintHex ?? names.fingerprintHex;
  }
  try {
    assertSafeIdentifier('role', roleName);
    assertSafeIdentifier('fingerprint', fingerprintHex);
    assertSafeIdentifier('database', database);
  } catch {
    emit(sink, 'role-cutover.fallback.unsafe-identifier', { roleName, database });
    return fallback('unsafe-identifier', fingerprintHex);
  }

  // O(1) sentinel fast-path — no DB round-trip in steady state.
  const sentinel = readRoleCutoverSentinel(fingerprintHex);
  if (sentinel && sentinel.roleName === roleName && sentinel.database === database) {
    emit(sink, 'role-cutover.skip.sentinel-fast-path', { roleName, database });
    return { username: roleName, database, cutover: true, fingerprintHex };
  }

  // Sentinel absent/stale ⇒ provision (idempotent) + revalidate vs pg_roles.
  try {
    const result = await ensureScopedRole({ sql: opts.sql, roleName, database, sink, enabled: true });
    if (result.status === 'skipped' && result.reason !== 'lock-contended') {
      emit(sink, `role-cutover.fallback.${result.reason ?? 'provision-failed'}`, { roleName, database });
      return fallback(result.reason ?? 'provision-failed', fingerprintHex);
    }
    // pg_roles is source-of-truth. A `lock-contended` skip means a sibling
    // boot is provisioning concurrently; the role may already be present, so
    // we still validate rather than blindly falling back.
    const exists = await opts.sql.unsafe(`SELECT 1 FROM pg_roles WHERE rolname = '${roleName}'`);
    if (exists.length === 0) {
      clearRoleCutoverSentinel(fingerprintHex);
      emit(sink, 'role-cutover.fallback.role-missing', { roleName, database });
      return fallback('role-missing', fingerprintHex);
    }
    writeRoleCutoverSentinel(fingerprintHex, { roleName, database });
    emit(sink, 'role-cutover.cutover', { roleName, database });
    return { username: roleName, database, cutover: true, fingerprintHex };
  } catch (err) {
    emit(sink, 'role-cutover.fallback.query-failed', {
      roleName,
      database,
      detail: { message: err instanceof Error ? err.message : String(err) },
    });
    return fallback('query-failed', fingerprintHex);
  }
}

// ============================================================================
// Read-only inspection — backs `genie doctor --connection-identity`.
//
// Pure derivation + sentinel/package.json reads only. NEVER provisions, grants,
// connects, or writes any file. The live DB facts (rolsuper, grants,
// current_user/fallback) are queried separately by the doctor command on the
// already-open app connection — this function contributes only the FS/identity
// half so the doctor surface stays strictly read-only.
// ============================================================================

export interface RoleCutoverInspection {
  /** Effective gate: false only under the documented kill-switch. */
  enabled: boolean;
  /** True when `GENIE_ROLE_CUTOVER=0` (the documented kill-switch) is set. */
  killSwitch: boolean;
  /** Derived scoped role name, or null when the fingerprint is unstable. */
  roleName: string | null;
  /** 12-hex fingerprint segment (sentinel key), or null when unstable. */
  fingerprintHex: string | null;
  /** Absolute per-fingerprint sentinel path, or null when unresolved. */
  sentinelPath: string | null;
  /** Parsed sentinel contents, or null when absent/stale/unreadable. */
  sentinel: RoleCutoverSentinel | null;
}

/**
 * Resolve the role-cutover identity snapshot WITHOUT touching the DB or
 * mutating any state. Read-only: derives the role name + fingerprint and reads
 * the per-fingerprint sentinel. Used by `genie doctor --connection-identity`.
 */
export function inspectRoleCutover(): RoleCutoverInspection {
  const killSwitch = process.env.GENIE_ROLE_CUTOVER === '0';
  const enabled = isRoleCutoverEnabled();
  const fp = resolveGenieFingerprint();
  if (!fp) {
    return { enabled, killSwitch, roleName: null, fingerprintHex: null, sentinelPath: null, sentinel: null };
  }
  const names = deriveProvisionedNames(fp);
  let sentinelPath: string | null = null;
  try {
    sentinelPath = roleCutoverSentinelPath(names.fingerprintHex);
  } catch {
    sentinelPath = null;
  }
  return {
    enabled,
    killSwitch,
    roleName: names.roleName,
    fingerprintHex: names.fingerprintHex,
    sentinelPath,
    sentinel: readRoleCutoverSentinel(names.fingerprintHex),
  };
}
