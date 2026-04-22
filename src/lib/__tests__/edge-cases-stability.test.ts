/**
 * Group 7: Edge Cases & Stability (P2)
 *
 * QA tests for production hardening:
 *   7.1 — Concurrent operations (team isolation, spawn dedup, pool resilience)
 *   7.2 — tmux compatibility (isPaneAlive, version pinning, worktree cleanup)
 *   7.3 — Security (SQL injection, slug validation, secrets)
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ============================================================================
// 7.1 — Concurrent Operations
// ============================================================================

describe('7.1 Concurrent Operations', () => {
  // -------------------------------------------------------------------------
  // 7.1.1 — Advisory lock prevents concurrent spawn of same worker
  // -------------------------------------------------------------------------

  test('advisory lock prevents duplicate spawns (code review)', () => {
    const source = readFileSync(join(__dirname, '..', 'protocol-router.ts'), 'utf-8');

    // Advisory lock is acquired inside a transaction before spawning
    expect(source).toContain('pg_advisory_xact_lock(hashtext(');

    // Double-check pattern: re-verify after lock acquisition
    expect(source).toContain('another process may have spawned while we waited');

    // Dead worker cleanup happens inside the lock
    expect(source).toContain('cleanupDeadWorkers(recipientId');
  });

  test('executor creation also uses advisory lock (code review)', () => {
    const source = readFileSync(join(__dirname, '..', 'protocol-router-spawn.ts'), 'utf-8');

    // Executor guard uses advisory lock keyed on agent identity
    expect(source).toContain('pg_advisory_xact_lock(hashtext(');

    // Concurrent guard: terminate active executor before creating new one
    expect(source).toContain('terminateActiveExecutor');
  });

  // -------------------------------------------------------------------------
  // 7.1.2 — ensurePgserve dedup guard prevents multiple starts
  // -------------------------------------------------------------------------

  test('ensurePgserve deduplicates concurrent calls (code review)', () => {
    const source = readFileSync(join(__dirname, '..', 'db.ts'), 'utf-8');

    // Promise dedup pattern
    expect(source).toContain('if (ensurePromise) return ensurePromise');
    expect(source).toContain('ensurePromise = _ensurePgserve()');

    // Reset in finally block ensures retry on failure
    expect(source).toContain('ensurePromise = null');
  });

  // -------------------------------------------------------------------------
  // 7.1.3 — Connection pool recovers from broken connections
  // -------------------------------------------------------------------------

  test('getConnection health-checks cached client before returning (code review)', () => {
    const source = readFileSync(join(__dirname, '..', 'db.ts'), 'utf-8');

    // Health check pattern: SELECT 1 on cached client (extracted to healthCheckCachedClient)
    const healthIdx = source.indexOf('healthCheckCachedClient');
    expect(healthIdx).toBeGreaterThan(-1);

    // On failure, both sqlClient and activePort are nulled for full reconnect
    const block = source.slice(healthIdx, healthIdx + 400);
    expect(block).toContain('sqlClient = null');
    expect(block).toContain('activePort = null');
  });

  test('connection pool config is sensible for concurrent operations', () => {
    const source = readFileSync(join(__dirname, '..', 'db.ts'), 'utf-8');

    // max: 50 connections (serial CI; parallel test:parallel is a local-only tool)
    expect(source).toContain('max: 50');
    // Aggressive idle timeout (1s) to recycle unused connections
    expect(source).toContain('idle_timeout: 1');
    // 5s connect timeout prevents hanging
    expect(source).toContain('connect_timeout: 5');
  });

  // -------------------------------------------------------------------------
  // 7.1.4 — Team isolation via git clone --shared
  // -------------------------------------------------------------------------

  test('teams use git clone --shared for isolation (code review)', () => {
    const source = readFileSync(join(__dirname, '..', 'team-manager.ts'), 'utf-8');

    // Uses clone --shared instead of worktree to avoid core.bare corruption
    expect(source).toContain('git clone --shared');

    // Separate git config per team
    expect(source).toContain('git -C ${worktreePath} config user.name');
    expect(source).toContain('git -C ${worktreePath} config user.email');
  });

  test('team members are scoped by team name in kill operations (code review)', () => {
    const source = readFileSync(join(__dirname, '..', 'team-manager.ts'), 'utf-8');

    // Team-scoped filtering ensures one team's kill doesn't affect another
    expect(source).toContain('w.team');
  });

  // -------------------------------------------------------------------------
  // 7.1.5 — Test isolation via per-test PG databases cloned from a template
  // -------------------------------------------------------------------------

  test('test database isolation prevents cross-test interference (code review)', () => {
    const source = readFileSync(join(__dirname, '..', 'test-db.ts'), 'utf-8');

    // Each test gets a unique database name
    expect(source).toContain('process.pid');
    expect(source).toContain('Date.now()');

    // Per-test database is created via createTestDatabase (fast clone of the
    // genie_template DB) and torn down via dropTestDatabase.
    expect(source).toContain('createTestDatabase');
    expect(source).toContain('dropTestDatabase');
  });

  // -------------------------------------------------------------------------
  // 7.1.6 — Task sequence advisory lock
  // -------------------------------------------------------------------------

  test('task seq assignment uses advisory lock to prevent gaps (code review)', () => {
    const migrationPath = join(__dirname, '..', '..', 'db', 'migrations', '002_task_lifecycle.sql');
    if (!existsSync(migrationPath)) return; // Skip if migration file not present

    const source = readFileSync(migrationPath, 'utf-8');
    expect(source).toContain('pg_advisory_xact_lock');
    expect(source).toContain('assign_task_seq');
  });
});

// ============================================================================
// 7.2 — tmux Compatibility
// ============================================================================

describe('7.2 tmux Compatibility', () => {
  // -------------------------------------------------------------------------
  // 7.2.1 — tmux version pinning
  // -------------------------------------------------------------------------

  test('tmux is pinned to a specific version >= 3.3', () => {
    const source = readFileSync(join(__dirname, '..', 'ensure-tmux.ts'), 'utf-8');

    // Extract the pinned version
    const versionMatch = source.match(/TMUX_VERSION\s*=\s*['"]([^'"]+)['"]/);
    expect(versionMatch).not.toBeNull();

    const version = versionMatch![1];
    // Parse major.minor (e.g., "3.6a" → 3.6)
    const numericVersion = Number.parseFloat(version);
    expect(numericVersion).toBeGreaterThanOrEqual(3.3);
  });

  test('tmux auto-download supports all required platforms', () => {
    const source = readFileSync(join(__dirname, '..', 'ensure-tmux.ts'), 'utf-8');

    // All 4 platforms supported
    expect(source).toContain('linux-x64');
    expect(source).toContain('linux-arm64');
    expect(source).toContain('darwin-arm64');
    expect(source).toContain('darwin-x64');
  });

  // -------------------------------------------------------------------------
  // 7.2.2 — isPaneAlive handles tmux 3.5+ behavior
  // -------------------------------------------------------------------------

  test('isPaneAlive handles tmux 3.5+ empty string for non-existent panes (code review)', () => {
    const source = readFileSync(join(__dirname, '..', 'tmux.ts'), 'utf-8');

    // Only "0" means alive — handles empty string (tmux 3.5+) correctly
    expect(source).toContain("return paneDead === '0'");

    // Comment documents the 3.5+ behavior
    expect(source).toContain('tmux 3.5+');
  });

  test('isPaneAlive validates pane ID format before querying tmux', () => {
    const source = readFileSync(join(__dirname, '..', 'tmux.ts'), 'utf-8');

    // Rejects invalid pane IDs without hitting tmux at all
    expect(source).toContain("paneId === 'inline'");
    expect(source).toContain('/^%\\d+$/');
  });

  test('isPaneAlive distinguishes server-down from pane-dead errors', () => {
    const source = readFileSync(join(__dirname, '..', 'tmux.ts'), 'utf-8');

    // Server unreachable errors are thrown (not swallowed)
    expect(source).toContain('no server running');
    expect(source).toContain('server exited');
    expect(source).toContain('error connecting');
    expect(source).toContain('TmuxUnreachableError');

    // Pane-not-found errors return false (pane dead, server reachable)
    expect(source).toContain('Pane not found, session not found');
  });

  // -------------------------------------------------------------------------
  // 7.2.3 — Worktree cleanup prevents orphan branches/configs
  // -------------------------------------------------------------------------

  test('pruneStaleWorktrees removes teams with missing clone directories (code review)', () => {
    const source = readFileSync(join(__dirname, '..', 'team-manager.ts'), 'utf-8');

    // Function exists and scans PG for all teams
    expect(source).toContain('pruneStaleWorktrees');

    // Checks if worktree_path exists on disk
    expect(source).toContain('existsSync(row.worktree_path)');

    // Cleans up native team config
    expect(source).toContain('deleteNativeTeam');

    // Deletes PG row for orphaned team
    expect(source).toContain('DELETE FROM teams WHERE name =');
  });

  test('removeWorktree falls back to rm for non-worktree clones', () => {
    const source = readFileSync(join(__dirname, '..', 'team-manager.ts'), 'utf-8');

    // Primary: git worktree remove
    expect(source).toContain('git worktree remove --force');

    // Fallback: rm for shared clones
    expect(source).toContain('recursive: true, force: true');
  });

  test('archiveTeam kills members BEFORE DB update to prevent zombie writes', () => {
    const source = readFileSync(join(__dirname, '..', 'team-manager.ts'), 'utf-8');

    // Kill all members via Promise.allSettled
    expect(source).toContain('Promise.allSettled(config.members.map');

    // Comment documents the ordering requirement
    expect(source).toContain('must complete BEFORE DB update');
  });

  test('disband runs pruneStaleWorktrees to clean up orphaned configs', () => {
    const source = readFileSync(join(__dirname, '..', 'team-manager.ts'), 'utf-8');

    // Disband flow includes prune step — search the full disbandTeam function
    const disbandIdx = source.indexOf('async function disbandTeam');
    expect(disbandIdx).toBeGreaterThan(-1);

    // pruneStaleWorktrees is called after the disband transaction
    const afterDisband = source.slice(disbandIdx);
    expect(afterDisband).toContain('pruneStaleWorktrees');
  });
});

// ============================================================================
// 7.3 — Security
// ============================================================================

describe('7.3 Security', () => {
  // -------------------------------------------------------------------------
  // 7.3.1 — No SQL injection in import paths
  // -------------------------------------------------------------------------

  test('import uses table name whitelist to prevent SQL injection', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'term-commands', 'import.ts'), 'utf-8');

    // assertValidTable enforces whitelist before any SQL with table names
    expect(source).toContain('assertValidTable(');

    // VALID_TABLES is built from the GROUP_TABLES constant
    expect(source).toContain('VALID_TABLES');
  });

  test('assertValidTable rejects unknown table names', async () => {
    const { assertValidTable } = await import('../../term-commands/import.js');

    // Valid tables should not throw
    expect(() => assertValidTable('tasks')).not.toThrow();
    expect(() => assertValidTable('boards')).not.toThrow();

    // SQL injection attempts should throw
    expect(() => assertValidTable('tasks; DROP TABLE tasks--')).toThrow('Invalid table name');
    expect(() => assertValidTable("' OR 1=1--")).toThrow('Invalid table name');
    expect(() => assertValidTable('nonexistent_table')).toThrow('Invalid table name');
    expect(() => assertValidTable('')).toThrow('Invalid table name');
  });

  test('import insert uses parameterized placeholders ($N)', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'term-commands', 'import.ts'), 'utf-8');

    // Values use parameterized placeholders, never string interpolation
    expect(source).toContain('$${i + 1}');
    expect(source).toContain('VALUES (${placeholders})');

    // Primary key conditions use parameterized placeholders
    expect(source).toContain('$${values.length + i + 1}');
  });

  test('export uses parameterized queries for user-supplied values', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'term-commands', 'export.ts'), 'utf-8');

    // Named queries use postgres.js tagged templates (safe)
    expect(source).toContain('WHERE name = ${name}');

    // Parameterized unsafe queries use $1 placeholders
    expect(source).toContain('= $1');
  });

  // -------------------------------------------------------------------------
  // 7.3.2 — No SQL injection in backup/restore paths
  // -------------------------------------------------------------------------

  test('backup uses spawnSync with args array, not shell interpolation', () => {
    const source = readFileSync(join(__dirname, '..', 'db-backup.ts'), 'utf-8');

    // pg_dump uses spawnSync with separate args, not shell string
    expect(source).toContain("spawnSync('pg_dump'");

    // DB name passed via environment variable, not command string
    expect(source).toContain('PGDATABASE: DB_NAME');
  });

  test('restore uses psql variable binding to avoid SQL injection on DB name', () => {
    const source = readFileSync(join(__dirname, '..', 'db-backup.ts'), 'utf-8');

    // Uses psql -v for variable binding
    expect(source).toContain('-v');
    expect(source).toContain('target_db=${DB_NAME}');

    // Uses :"target_db" (psql quoted variable) for SQL identifiers
    expect(source).toContain(':"target_db"');

    // Restore uses stdin piping, not shell interpolation
    expect(source).toContain('input: sql');
  });

  // -------------------------------------------------------------------------
  // 7.3.3 — Slug validation rejects path traversal
  // -------------------------------------------------------------------------

  test('slug regex rejects slashes, double dots, and special characters', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'term-commands', 'dispatch.ts'), 'utf-8');

    // Regex enforces alphanumeric, dots, underscores, hyphens only
    expect(source).toContain('SLUG_PATTERN');
    expect(source).toContain('/^[a-zA-Z0-9._-]+$/');
  });

  test('slug validation covers all path traversal vectors', async () => {
    const { validateSlug } = await import('../../term-commands/dispatch.js');

    // Helper: intercept process.exit to test rejection
    function isRejected(slug: string): boolean {
      const origExit = process.exit;
      let exited = false;
      process.exit = (() => {
        exited = true;
        throw new Error('exit');
      }) as never;
      try {
        validateSlug(slug);
      } catch {
        // Expected
      } finally {
        process.exit = origExit;
      }
      return exited;
    }

    // Path traversal attacks
    expect(isRejected('../../etc/passwd')).toBe(true);
    expect(isRejected('../secret')).toBe(true);
    expect(isRejected('..%2F..%2Fetc%2Fpasswd')).toBe(true); // URL-encoded traversal
    expect(isRejected('foo/bar')).toBe(true);
    expect(isRejected('foo\\bar')).toBe(true);

    // Null byte injection
    expect(isRejected('foo\0bar')).toBe(true);

    // Shell metacharacters
    expect(isRejected('foo;rm -rf /')).toBe(true);
    expect(isRejected('foo|cat /etc/passwd')).toBe(true);
    expect(isRejected('foo$(whoami)')).toBe(true);
    expect(isRejected('foo`id`')).toBe(true);

    // Empty / whitespace
    expect(isRejected('')).toBe(true);
    expect(isRejected(' ')).toBe(true);
    expect(isRejected('\t')).toBe(true);
    expect(isRejected('\n')).toBe(true);

    // Valid slugs are accepted
    expect(isRejected('my-wish')).toBe(false);
    expect(isRejected('v4.hook-cli')).toBe(false);
    expect(isRejected('my_wish_v2')).toBe(false);
    expect(isRejected('abc123')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 7.3.4 — No secrets in committed files
  // -------------------------------------------------------------------------

  test('.gitignore excludes .env files', () => {
    const gitignore = readFileSync(join(__dirname, '..', '..', '..', '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.env');
    expect(gitignore).toContain('.env.local');
  });

  test('no .env files are tracked in git', () => {
    const { execSync } = require('node:child_process');
    const trackedEnvFiles = execSync('git ls-files | grep -iE "\\.env$|\\.env\\." || true', {
      encoding: 'utf-8',
      cwd: join(__dirname, '..', '..', '..'),
    }).trim();
    expect(trackedEnvFiles).toBe('');
  });

  test('no hardcoded API keys or tokens in source files', () => {
    const { execSync } = require('node:child_process');
    // Search for patterns that look like hardcoded secrets (8+ chars)
    const secrets = execSync(
      'grep -rnP "(APIKEY|API_KEY|SECRET_KEY|AUTH_TOKEN|PRIVATE_KEY)\\s*[:=]\\s*[\x27\\"][^\x27\\"]{8,}[\x27\\"]" src/ || true',
      {
        encoding: 'utf-8',
        cwd: join(__dirname, '..', '..', '..'),
      },
    ).trim();
    expect(secrets).toBe('');
  });

  test('OMNI API key is loaded from environment, not hardcoded', () => {
    const source = readFileSync(join(__dirname, '..', 'omni-registration.ts'), 'utf-8');

    // API key loaded from env
    expect(source).toContain('process.env.OMNI_API_KEY');

    // Not hardcoded
    const apiKeyMatch = source.match(/OMNI_API_KEY\s*=\s*['"][^'"]+['"]/);
    expect(apiKeyMatch).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 7.3.5 — Export table names come from whitelist
  // -------------------------------------------------------------------------

  test('GROUP_TABLES defines all valid export table names', async () => {
    const { GROUP_TABLES, ALL_GROUPS } = await import('../export-format.js');

    // All groups have at least one table
    for (const group of ALL_GROUPS) {
      expect(GROUP_TABLES[group].length).toBeGreaterThan(0);
    }

    // No empty table names
    const allTables = Object.values(GROUP_TABLES).flat();
    for (const table of allTables) {
      expect(typeof table).toBe('string');
      expect(table.length).toBeGreaterThan(0);
      // Table names are simple identifiers (no special chars)
      expect(table).toMatch(/^[a-z_]+$/);
    }
  });

  test('import-order PK definitions only contain safe column names', async () => {
    const { getPrimaryKey } = await import('../import-order.js');

    const knownTables = [
      'tasks',
      'boards',
      'tags',
      'projects',
      'agents',
      'task_tags',
      'task_actors',
      'task_dependencies',
      'conversation_members',
    ];

    for (const table of knownTables) {
      const pk = getPrimaryKey(table);
      for (const col of pk) {
        // Column names are simple identifiers
        expect(col).toMatch(/^[a-z_]+$/);
      }
    }
  });
});

// ============================================================================
// Cross-cutting: Protocol Router Safety
// ============================================================================

describe('Protocol Router Safety (cross-cutting)', () => {
  test('TOCTOU race protection: pane re-verified before delivery', () => {
    const source = readFileSync(join(__dirname, '..', 'protocol-router.ts'), 'utf-8');

    // Re-verify pane alive right before delivery
    expect(source).toContain('Re-verify pane alive right before delivery');
    expect(source).toContain('TOCTOU');
  });

  test('spawn failure is logged, not silently swallowed', () => {
    const source = readFileSync(join(__dirname, '..', 'protocol-router.ts'), 'utf-8');

    // Error is logged to console.error
    expect(source).toContain('[protocol-router] Spawn failed');

    // Worker state updated to error
    expect(source).toContain("state: 'error'");
  });

  test('message persisted to mailbox BEFORE delivery attempt', () => {
    const source = readFileSync(join(__dirname, '..', 'protocol-router.ts'), 'utf-8');

    // Comment documents the persist-first pattern
    expect(source).toContain('persisted to the');
  });

  test('dead worker cleanup only removes workers with dead panes', () => {
    const source = readFileSync(join(__dirname, '..', 'protocol-router.ts'), 'utf-8');

    // Cleanup checks isPaneAlive before removing
    expect(source).toContain('isPaneAlive(w.paneId)');
  });
});
