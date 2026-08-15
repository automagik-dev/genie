/**
 * Cross-module invariant: no code path that FIRST creates GENIE_HOME may leave
 * group or other write bits on it.
 *
 * Regression for fresh Linux installs of v5.260814.5 failing with
 * `InstallPromotionError: GENIE_HOME has unsafe permissions`. Under Ubuntu's
 * user-private-group default umask 002, an unmoded `mkdirSync(…, { recursive:
 * true })` yields 0775, and `assertSafeOwnedDirectory` in install-promotion.ts
 * rejects any directory whose mode carries `0o022`.
 *
 * Several unrelated modules can win the race to be that first creator, so the
 * invariant is asserted here in one place rather than per module. The lease
 * path — the site the original incident traced to — additionally keeps its own
 * colocated regression test in codex-lifecycle-lease.test.ts.
 *
 * Assertions are on the RESULTING mode, never on umask mechanics, so they hold
 * across platforms and runtimes (local darwin/bun vs. the Linux CI where the
 * bug reproduces).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { convergeAuxiliaryTree } from '../genie-commands/auxiliary-trees.js';
import { persistIntegrationConsent } from './runtime-integrations.js';
import { openGlobalDb, resolveGlobalDbPath } from './v5/global-db.js';
import { openSqlite } from './v5/sqlite-open.js';
import { findWorkspace } from './workspace.js';

const cleanups: Array<() => void> = [];
const umaskRestores: number[] = [];

/** Ubuntu's user-private-group default — the umask that produced the incident. */
const PERMISSIVE_UMASK = 0o002;

afterEach(() => {
  for (const mask of umaskRestores.splice(0)) process.umask(mask);
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function useUmask(mask: number): void {
  umaskRestores.push(process.umask(mask));
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/**
 * The predicate `assertSafeOwnedDirectory` applies in install-promotion.ts,
 * which is module-private there. Any group or other write bit aborts the
 * install with "has unsafe permissions".
 */
function hasUnsafeWriteBits(path: string): boolean {
  return (lstatSync(path).mode & 0o022) !== 0;
}

describe('GENIE_HOME first-creation permissions', () => {
  // Each entry receives a GENIE_HOME path that does NOT exist yet, and must
  // leave it safe for the install promoter after creating it.
  const creators: Array<{ site: string; create: (genieHome: string) => void }> = [
    {
      site: 'runtime-integrations.ts — persistIntegrationConsent',
      create: (genieHome) => persistIntegrationConsent('auto', genieHome),
    },
    {
      // The global genie.db lives directly in GENIE_HOME, and every `genie
      // omni` subcommand opens it leaseless — so this is a first-creator.
      site: 'global-db.ts — openGlobalDb',
      create: (genieHome) => openGlobalDb({ path: join(genieHome, 'genie.db') }).close(),
    },
    {
      site: 'auxiliary-trees.ts — convergeAuxiliaryTree staging',
      create: (genieHome) => {
        // Production callers always pass `<GENIE_HOME>/<tree>`, so the parent
        // this stages into is GENIE_HOME itself.
        const source = tempRoot('genie-aux-source-');
        writeFileSync(join(source, 'payload.txt'), 'payload\n');
        const outcome = convergeAuxiliaryTree({
          label: 'plugins',
          source,
          destination: join(genieHome, 'plugins'),
        });
        if (outcome.status === 'failed') throw new Error(`convergence failed at ${outcome.stage}: ${outcome.error}`);
      },
    },
  ];

  for (const { site, create } of creators) {
    test(`${site} creates GENIE_HOME without group/other write bits under a permissive umask`, () => {
      const root = tempRoot('genie-home-perms-');
      useUmask(PERMISSIVE_UMASK);
      const intermediate = join(root, 'intermediate');
      const genieHome = join(intermediate, '.genie');

      create(genieHome);

      expect(hasUnsafeWriteBits(genieHome)).toBe(false);
      expect(hasUnsafeWriteBits(intermediate)).toBe(false);
    });
  }

  test('workspace.ts — saveWorkspaceRoot creates GENIE_HOME without group/other write bits', () => {
    // `saveWorkspaceRoot` deliberately refuses to persist workspaces under
    // tmpdir(), so the workspace root must live outside it for the mkdir to be
    // reached at all. GENIE_HOME itself still points into tmp.
    const workspaceRoot = mkdtempSync(join(homedir(), '.genie-home-perms-test-'));
    cleanups.push(() => rmSync(workspaceRoot, { recursive: true, force: true }));
    mkdirSync(join(workspaceRoot, '.genie'), { recursive: true });
    writeFileSync(join(workspaceRoot, '.genie', 'workspace.json'), JSON.stringify({ name: 'perms-test' }));

    const root = tempRoot('genie-home-perms-workspace-');
    const intermediate = join(root, 'intermediate');
    const genieHome = join(intermediate, '.genie');
    const previousGenieHome = process.env.GENIE_HOME;
    process.env.GENIE_HOME = genieHome;
    cleanups.push(() => {
      if (previousGenieHome === undefined) {
        // biome-ignore lint/performance/noDelete: process.env assignment coerces undefined→"undefined"; delete is the only correct unset
        delete process.env.GENIE_HOME;
      } else {
        process.env.GENIE_HOME = previousGenieHome;
      }
    });
    useUmask(PERMISSIVE_UMASK);

    expect(findWorkspace(workspaceRoot)?.root).toBe(workspaceRoot);

    // Guard the guard: if the tmp refusal ever starts swallowing this root the
    // mode assertions below would vacuously pass on a directory never created.
    expect(JSON.parse(readFileSync(join(genieHome, 'config.json'), 'utf8')).workspaceRoot).toBe(workspaceRoot);
    expect(hasUnsafeWriteBits(genieHome)).toBe(false);
    expect(hasUnsafeWriteBits(intermediate)).toBe(false);
  });

  test('the global db resolves into GENIE_HOME, while a per-repo .genie keeps the ambient umask', () => {
    // The two halves of the deliberate split in openSqlite's `dirMode`. The
    // global db's directory IS GENIE_HOME (so it opts in to 0o700); the
    // per-repo `.genie/` lives inside the user's own repository, where forcing
    // owner-only would be surprising, so it stays at the ambient umask.
    const root = tempRoot('genie-home-perms-split-');
    const genieHome = join(root, '.genie-home');
    const previousGenieHome = process.env.GENIE_HOME;
    process.env.GENIE_HOME = genieHome;
    cleanups.push(() => {
      if (previousGenieHome === undefined) {
        // biome-ignore lint/performance/noDelete: process.env assignment coerces undefined→"undefined"; delete is the only correct unset
        delete process.env.GENIE_HOME;
      } else {
        process.env.GENIE_HOME = previousGenieHome;
      }
    });
    expect(dirname(resolveGlobalDbPath())).toBe(genieHome);

    useUmask(PERMISSIVE_UMASK);
    openGlobalDb().close();
    expect(hasUnsafeWriteBits(genieHome)).toBe(false);

    const repoGenieDir = join(root, 'repo', '.genie');
    openSqlite({
      path: join(repoGenieDir, 'genie.db'),
      schemaVersion: 1,
      ensureSchema: (db) => db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)'),
    }).close();
    expect(lstatSync(repoGenieDir).mode & 0o777).toBe(0o775);
  });

  test('no recursive mkdirSync under GENIE_HOME lacks an explicit safe mode', () => {
    // Negative scan: a NEW unmoded GENIE_HOME creator fails here by default
    // rather than having to be remembered. For several sites — installGenie-
    // TmuxConf, the legacy-v4 backups, the update diagnostics log — this is the
    // only coverage, since they are private, wizard-only, or destructive.
    const offenders = scanUnsafeGenieHomeMkdirs(REPO_ROOT);
    expect(offenders).toEqual([]);
  });

  test('GENIE_HOME creators the scan cannot see keep an explicit safe mode', () => {
    // The scan reads expressions, so it only sees GENIE_HOME when a token
    // survives local const expansion. These sites receive the path as a
    // function parameter or through a cross-module accessor, so no token is
    // visible at the call and the scan structurally cannot flag them. Pin them
    // by hand — verified reachable, and each regressed the incident on its own.
    const pinned: Array<[file: string, marker: string, why: string]> = [
      ['src/term-commands/hook/trust.ts', 'mkdirSync(dir, {', '<GENIE_HOME>/hooks via `genie hook trust`'],
      ['src/lib/genie-config.ts', 'mkdirSync(dir, {', 'GENIE_HOME via getGenieDir()'],
      ['src/genie-commands/auxiliary-trees.ts', 'mkdirSync(dirname(options.destination), {', 'GENIE_HOME parent'],
      ['src/lib/codex-lifecycle-lease.ts', 'mkdirSync(dirOf(path), {', 'GENIE_HOME via the lease path'],
      [
        'src/lib/codex-activation-persistence.ts',
        'mkdirSync(dir, {',
        'atomicWriteFileSync — every caller writes under GENIE_HOME',
      ],
    ];

    for (const [file, marker, why] of pinned) {
      const call = readFileSync(join(REPO_ROOT, file), 'utf8')
        .split('\n')
        .find((line) => line.includes(marker));
      expect(call, `${file}: no call matching \`${marker}\``).toBeDefined();
      expect(call, `${file}: ${why} — must declare a safe mode`).toMatch(SAFE_MODE);
    }

    // The shared sqlite primitive takes its mode from the caller, so the pin is
    // on the global DB opting in — the per-repo DB deliberately does not.
    expect(readFileSync(join(REPO_ROOT, 'src/lib/v5/global-db.ts'), 'utf8')).toContain('dirMode: 0o700');
  });
});

const REPO_ROOT = new URL('../..', import.meta.url).pathname;

// ─── Source scan ──────────────────────────────────────────────────────────────

/**
 * Targets whose text still names a GENIE_HOME source after local `const`
 * expansion. `backupRoot` is included because it is always
 * `<GENIE_HOME>/state-backups/…`.
 */
const GENIE_HOME_TOKENS = /genieHome|GENIE_HOME|resolveGenieHome|backupRoot/;

/** A safe mode grants nothing to group or other. */
const SAFE_MODE = /mode:\s*0o[0-7]{3,4}/;

/**
 * Verified NOT to create GENIE_HOME, despite matching the token heuristic.
 * Keyed by `<path>:<line>` with the reason it is exempt.
 */
const SCAN_EXEMPTIONS = new Map<string, string>([
  [
    'src/lib/agent-sync.ts:5171',
    // Triggered by the identifier `before`: the scan's file-scoped const map
    // resolves it to the file's FIRST `const before = lstatSync(path)`
    // (agent-sync.ts:883), whose `path` cascades into a genieHome token. The
    // real target here is `join(transactionDir, 'before')` inside a council
    // workflow transaction dir the preceding renameSync already published, so
    // GENIE_HOME is never created.
    'council workflow transaction dir, not GENIE_HOME (scan token collision)',
  ],
]);

interface UnsafeMkdir {
  site: string;
  target: string;
}

/**
 * Flag every recursive `mkdirSync` in `src/` whose target resolves to or under
 * GENIE_HOME but declares no explicit mode. Identifiers are expanded through
 * same-file `const`/`let` initializers so indirection like
 * `const logsDir = join(GENIE_HOME, 'logs')` is still caught.
 *
 * The expansion is file-scoped rather than block-scoped, which can over-match
 * when a parameter shares a name with an unrelated const. That direction is
 * deliberate: over-matching costs one reviewed SCAN_EXEMPTIONS entry, while
 * under-matching would silently ship the bug this file exists to prevent.
 */
function scanUnsafeGenieHomeMkdirs(repoRoot: string): UnsafeMkdir[] {
  const offenders: UnsafeMkdir[] = [];
  for (const file of sourceFiles(join(repoRoot, 'src'))) {
    const lines = readFileSync(file, 'utf8').split('\n');
    const consts = new Map<string, string>();
    for (const line of lines) {
      const declaration = /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+?);?\s*$/.exec(line);
      if (declaration && !consts.has(declaration[1])) consts.set(declaration[1], declaration[2]);
    }
    for (const [index, line] of lines.entries()) {
      const call = /mkdirSync\(\s*(.+?),\s*\{(.*?)\}\s*\)/.exec(line);
      if (!call || !call[2].includes('recursive: true') || SAFE_MODE.test(call[2])) continue;
      const [, target] = call;
      if (!GENIE_HOME_TOKENS.test(expandIdentifiers(target, consts))) continue;
      const site = `${relative(repoRoot, file)}:${index + 1}`;
      if (!SCAN_EXEMPTIONS.has(site)) offenders.push({ site, target });
    }
  }
  return offenders;
}

function expandIdentifiers(expression: string, consts: Map<string, string>, depth = 0): string {
  if (depth > 8) return expression;
  let expanded = expression;
  for (const name of new Set(expression.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
    const initializer = consts.get(name);
    if (initializer === undefined || initializer === expression) continue;
    expanded = expanded.replace(new RegExp(`\\b${name}\\b`, 'g'), `(${initializer})`);
  }
  return expanded === expression ? expanded : expandIdentifiers(expanded, consts, depth + 1);
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') found.push(...sourceFiles(path));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      found.push(path);
    }
  }
  return found;
}
