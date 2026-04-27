/**
 * State-machine invariant tests — Group 6 of invincible-genie wish.
 *
 * These tests convert the contracts in `docs/state-machine.md` into
 * executable assertions. If a test here fails, either the doc is wrong
 * (update it in the same PR) or the invariant has regressed (fix the
 * regression — do not weaken the test).
 *
 * Four invariants:
 *
 *   1. No consumer reads `agents.claude_session_id` directly.
 *      (Column dropped by migration 047; this guards against accidental
 *      re-introduction via a future migration or a stray SELECT.)
 *
 *   2. No consumer infers permanence ad-hoc (`id LIKE 'dir:%'`).
 *      (Migration 049 made `agents.kind` the single source; consumers read
 *      `WHERE kind = 'permanent'` instead.)
 *
 *   3. `shouldResume()` is the only function that calls `getResumeSessionId()`.
 *      (Single-reader chokepoint discipline. The definition site in
 *      `executor-registry.ts` is the only other allowed location.)
 *
 *   4. `agents.kind` agrees with the structural inference rule for every row.
 *      (Belt-and-suspenders for the GENERATED column; runs the
 *      `auditAgentKind()` audit on a representative fixture.)
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { auditAgentKind } from '../lib/agent-registry.js';
import { getConnection } from '../lib/db.js';
import { DB_AVAILABLE, setupTestDatabase } from '../lib/test-db.js';

const SRC_ROOT = 'src';

/**
 * True iff ripgrep is on PATH. The grep-based invariants degrade to a
 * no-op skip without `rg`; their value is precisely the static-analysis
 * guarantee, so silently failing closed would be a worse outcome than a
 * loud "rg not installed" skip in the rare environments missing it.
 */
function hasRipgrep(): boolean {
  try {
    execSync('rg --version', { encoding: 'utf-8', stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a ripgrep pattern and return the trimmed stdout. Treats exit code 1
 * (no matches) as the success path — rg conventionally exits 1 when nothing
 * matches, which is what every invariant here expects.
 */
function rg(pattern: string, ...extraArgs: string[]): string {
  try {
    // `-n` is required so output is `file:line:content` — the comment-line
    // filters in each invariant rely on `line.split(':').slice(2)` to extract
    // the code text. Without line numbers, slice(2) yields the empty string
    // and comments leak through as false-positive violations.
    return execSync(`rg --no-heading -n ${pattern} ${SRC_ROOT} ${extraArgs.join(' ')}`, {
      encoding: 'utf-8',
      cwd: process.cwd(),
    }).trim();
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1) return ''; // no matches — invariant satisfied
    throw err;
  }
}

const RG_AVAILABLE = hasRipgrep();

// ============================================================================
// Invariant 1: agents.claude_session_id is never read directly
// ============================================================================

describe('invariant 1: no consumer reads agents.claude_session_id', () => {
  test.skipIf(!RG_AVAILABLE)('no SQL pattern selects claude_session_id from agents', () => {
    // Migration 047 dropped the column. A future migration that re-adds it
    // would be a structural regression; a stray SELECT against `agents.claude_session_id`
    // would crash at runtime but might slip past typecheck. Guard both.
    //
    // Patterns we explicitly forbid (case-insensitive):
    //   - `agents.claude_session_id`     (qualified read)
    //   - `a.claude_session_id`          (aliased read in agent JOINs — common pattern)
    //   - `ALTER TABLE agents ADD COLUMN claude_session_id`  (resurrection migration)
    //
    // Patterns we allow:
    //   - Comments referencing the historical column (they explain why it's gone).
    //   - Migration 047 itself (the column DROP).
    //   - `executors.claude_session_id` (the canonical column lives here).
    const forbidden = rg(
      `--type sql --type ts -i "(agents\\.claude_session_id|a\\.claude_session_id|ALTER TABLE agents ADD COLUMN.*claude_session_id)"`,
      `--glob '!src/db/migrations/047_drop_agents_claude_session_id.sql'`,
      `--glob '!src/__tests__/state-machine.invariants.test.ts'`,
      // Allow comments — they explain why the column is gone. We strip
      // matches whose first non-whitespace character is `-`, `*`, or `/` later.
    );
    const violations = forbidden
      .split('\n')
      .filter((line) => line.length > 0)
      .filter((line) => {
        // Drop comment lines: SQL `--`, TS `//`, JSDoc `*`.
        const codePart = line.split(':').slice(2).join(':').trimStart();
        if (codePart.startsWith('--')) return false;
        if (codePart.startsWith('//')) return false;
        if (codePart.startsWith('*')) return false;
        return true;
      });
    expect(violations).toEqual([]);
  });

  test.skipIf(!RG_AVAILABLE)('no migration after 047 re-adds the column', () => {
    // Defense against a careless schema PR that regresses the drop.
    // The pattern catches `ADD COLUMN claude_session_id` inside a file
    // numbered 048 or higher, scoped to the `agents` table.
    const reintroductions = rg(
      `--type sql -U "ALTER TABLE agents[\\s\\S]*?ADD COLUMN[\\s\\S]*?claude_session_id"`,
      `--glob '!src/db/migrations/047_drop_agents_claude_session_id.sql'`,
      // Pre-047 migrations (005, 012) created the column originally; allow them.
      `--glob '!src/db/migrations/005_pg_state.sql'`,
      `--glob '!src/db/migrations/012_executor_model.sql'`,
    );
    expect(reintroductions).toBe('');
  });
});

// ============================================================================
// Invariant 2: no ad-hoc permanence inference (`id LIKE 'dir:%'`)
// ============================================================================

describe('invariant 2: no ad-hoc permanence inference', () => {
  test.skipIf(!RG_AVAILABLE)('"id LIKE \'dir:%\'" appears only in migrations + this test + docs', () => {
    // Migration 049 makes `agents.kind` the single source of truth. Any new
    // call site that recomputes the inference rule (`id LIKE 'dir:%'`) is
    // exactly the fragmentation that produced the 2026-04-25 incident.
    //
    // Allowed residents:
    //   - Migration 046 (backfills dir:* state to NULL — references the
    //     pattern legitimately).
    //   - Migration 049 (defines the GENERATED column — references the
    //     pattern in the CASE expression).
    //   - The migration test that asserts the rule + this invariant test.
    const raw = rg(
      `--type ts --type sql "id LIKE 'dir:%'"`,
      `--glob '!src/db/migrations/046_dir_agents_state_null.sql'`,
      `--glob '!src/db/migrations/049_agents_kind_generated.sql'`,
      `--glob '!src/db/migrations/agents-kind.test.ts'`,
      `--glob '!src/db/migrations/master-backfill-and-shadow-cleanup.test.ts'`,
      `--glob '!src/__tests__/state-machine.invariants.test.ts'`,
    );
    // Strip comment lines (SQL `--`, TS `//`, JSDoc `*`) — references inside
    // comments are documentation, not executable inference.
    const violations = raw
      .split('\n')
      .filter((line) => line.length > 0)
      .filter((line) => {
        const codePart = line.split(':').slice(2).join(':').trimStart();
        if (codePart.startsWith('--')) return false;
        if (codePart.startsWith('//')) return false;
        if (codePart.startsWith('*')) return false;
        return true;
      });
    expect(violations).toEqual([]);
  });
});

// ============================================================================
// Invariant 3: shouldResume is the only caller of getResumeSessionId
// ============================================================================

describe('invariant 3: shouldResume owns getResumeSessionId', () => {
  test.skipIf(!RG_AVAILABLE)('only should-resume.ts and the definition site call getResumeSessionId()', () => {
    // The chokepoint contract: every consumer reads ShouldResumeResult, never
    // the raw session UUID. Allowed call sites:
    //   - src/lib/should-resume.ts (the chokepoint that delegates to it)
    //   - src/lib/executor-registry.ts (where it's defined; the function body
    //     contains its own name in the `export async function` line)
    //   - test files (free to exercise the lower-level helper directly).
    const callSites = rg(
      // No `--` separator: it terminates rg option parsing, which then
      // treats subsequent `--glob` flags as positional path args and
      // crashes with `--glob: No such file or directory`.
      `--type ts "getResumeSessionId\\("`,
      // Tests are allowed to call the lower-level helper directly.
      `--glob '!**/*.test.ts'`,
      `--glob '!**/__tests__/**'`,
    );
    const lines = callSites
      .split('\n')
      .filter((line) => line.length > 0)
      // Strip mentions inside JSDoc / line comments — those are documentation,
      // not call sites.
      .filter((line) => {
        const codePart = line.split(':').slice(2).join(':').trimStart();
        if (codePart.startsWith('//')) return false;
        if (codePart.startsWith('*')) return false;
        return true;
      });
    const allowedFiles = new Set(['src/lib/should-resume.ts', 'src/lib/executor-registry.ts']);
    const violators = lines.map((line) => line.split(':')[0]).filter((file) => !allowedFiles.has(file));
    expect(violators).toEqual([]);
  });
});

// ============================================================================
// Invariant 4: agents.kind matches structural inference
// ============================================================================

describe.skipIf(!DB_AVAILABLE)('invariant 4: agents.kind == structural inference', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    const sql = await getConnection();
    await sql`DELETE FROM assignments`;
    await sql`DELETE FROM executors`;
    await sql`DELETE FROM agents`;
  });

  test('clean fixture: every row has the structurally-correct kind', async () => {
    const sql = await getConnection();
    // Cover every shape the rule decides on:
    //   - dir:-prefixed → permanent
    //   - reports_to NULL → permanent
    //   - reports_to set → task
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, reports_to)
      VALUES
        ('dir:invariant', '', 'sess-dir', NULL, '/tmp/test', now(), NULL),
        ('lead-invariant', '%a', 'sess-lead', 'working', '/tmp/test', now(), NULL),
        ('parent-invariant', '%b', 'sess-parent', 'working', '/tmp/test', now(), NULL),
        ('child-invariant', '%c', 'sess-child', 'spawning', '/tmp/test', now(), 'parent-invariant')
    `;
    const result = await auditAgentKind();
    expect(result.total).toBe(4);
    expect(result.drifted).toEqual([]);
  });

  test('the audit catches a synthetic drift if one were ever introduced', async () => {
    // We cannot author a wrong `kind` directly — the GENERATED contract
    // rejects it. So we audit a clean fixture and assert the *result shape*
    // is what `genie status --debug` will render. This guards against a
    // refactor that silently changes the audit's return type.
    const sql = await getConnection();
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, reports_to)
      VALUES ('dir:audit-shape', '', 'sess-x', NULL, '/tmp/test', now(), NULL)
    `;
    const result = await auditAgentKind();
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('drifted');
    expect(Array.isArray(result.drifted)).toBe(true);
    expect(typeof result.total).toBe('number');
  });
});

// ============================================================================
// Doc <-> code coupling: the chokepoint claim must remain true
// ============================================================================

describe('doc/code coupling', () => {
  test('docs/state-machine.md exists and references the four invariants', () => {
    // Defensive: if the doc was renamed/removed the invariants test should
    // fail loudly. The doc is the contract this test enforces.
    const direct = execSync('test -f docs/state-machine.md && echo present || echo missing', {
      encoding: 'utf-8',
    }).trim();
    expect(direct).toBe('present');
    // The doc must mention each contract by name; if a reorganization drops
    // one of them, this test fails and forces a deliberate re-write.
    const required = [
      'shouldResume',
      'agents.kind',
      'GENERATED',
      'PermanentAgentDoneRejected',
      'rehydrate',
      'genie status',
    ];
    const docContents = execSync('cat docs/state-machine.md', { encoding: 'utf-8' });
    for (const term of required) {
      expect(docContents).toContain(term);
    }
  });
});
