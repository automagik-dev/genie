import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeCodexMcpFallback, removeCodexMcpFallback } from './init.js';

const CLI = join(import.meta.dir, '..', 'genie.ts');
const INTERPRETED_MCP_ARGS = [realpathSync(CLI), 'mcp'];
const GITIGNORE_RULES = ['.genie/genie.db', '.genie/genie.db-wal', '.genie/genie.db-shm'];

let dir: string;

function initGitRepo(root: string): void {
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Run `genie init` in `cwd`. Returns { code, stdout, stderr }. */
function runInit(cwd: string, args: string[] = []): { code: number; stdout: string; stderr: string } {
  const res = Bun.spawnSync([process.execPath, CLI, 'init', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    // Keep unit tests isolated from any live Codex/plugin installation.
    env: { ...process.env, PATH: '/usr/bin:/bin' },
  });
  return {
    code: res.exitCode,
    stdout: res.stdout.toString(),
    stderr: res.stderr.toString(),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genie-init-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('genie init', () => {
  test('fresh repo: scaffolds INDEX.md and appends all ignore rules', () => {
    initGitRepo(dir);
    const { code, stdout } = runInit(dir);

    expect(code).toBe(0);
    const indexPath = join(dir, '.genie', 'INDEX.md');
    expect(existsSync(indexPath)).toBe(true);
    const index = readFileSync(indexPath, 'utf-8');
    expect(index).toContain('# Plans Index');
    for (const section of ['## Raw', '## Simmering', '## Ready', '## Poured']) {
      expect(index).toContain(section);
    }

    const gitignore = readFileSync(join(dir, '.gitignore'), 'utf-8');
    for (const rule of GITIGNORE_RULES) {
      expect(gitignore).toContain(rule);
    }
    expect(stdout).toContain('brainstorm');
    expect(stdout).toContain('$genie:brainstorm');
    expect(stdout).toContain('$genie:review');
    expect(stdout.indexOf('$genie:review')).toBeLessThan(stdout.indexOf('$genie:work'));
    expect(stdout).toContain('genie board');
  });

  test('--help discloses every project MCP file class init may reconcile', () => {
    const { code, stdout } = runInit(dir, ['--help']);
    expect(code).toBe(0);
    for (const path of ['.mcp.json', '.warp/.mcp.json', '.codex/config.toml']) expect(stdout).toContain(path);
  });

  test('second run is a no-op: .gitignore and INDEX.md are byte-identical', () => {
    initGitRepo(dir);
    expect(runInit(dir).code).toBe(0);

    const indexPath = join(dir, '.genie', 'INDEX.md');
    const gitignorePath = join(dir, '.gitignore');
    const indexBefore = readFileSync(indexPath);
    const gitignoreBefore = readFileSync(gitignorePath);

    expect(runInit(dir).code).toBe(0);

    expect(readFileSync(indexPath).equals(indexBefore)).toBe(true);
    expect(readFileSync(gitignorePath).equals(gitignoreBefore)).toBe(true);
  });

  test('non-git directory: refuses with exit 1 and clear stderr', () => {
    const { code, stderr } = runInit(dir);
    expect(code).toBe(1);
    expect(stderr.toLowerCase()).toContain('git repository');
    expect(existsSync(join(dir, '.genie', 'INDEX.md'))).toBe(false);
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
  });

  test('partial state: INDEX exists, rules missing → only rules appended, INDEX untouched', () => {
    initGitRepo(dir);
    const indexPath = join(dir, '.genie', 'INDEX.md');
    mkdirSync(join(dir, '.genie'), { recursive: true });
    writeFileSync(indexPath, '# Plans Index\n\ncustom content\n');
    const indexBefore = readFileSync(indexPath);

    const { code } = runInit(dir);
    expect(code).toBe(0);

    // INDEX preserved (not overwritten with skeleton).
    expect(readFileSync(indexPath).equals(indexBefore)).toBe(true);
    const gitignore = readFileSync(join(dir, '.gitignore'), 'utf-8');
    for (const rule of GITIGNORE_RULES) {
      expect(gitignore).toContain(rule);
    }
  });

  test('partial state: rules exist, INDEX missing → only INDEX created, .gitignore untouched', () => {
    initGitRepo(dir);
    const gitignorePath = join(dir, '.gitignore');
    writeFileSync(gitignorePath, `node_modules\n${GITIGNORE_RULES.join('\n')}\n`);
    const gitignoreBefore = readFileSync(gitignorePath);

    const { code } = runInit(dir);
    expect(code).toBe(0);

    expect(readFileSync(gitignorePath).equals(gitignoreBefore)).toBe(true);
    expect(existsSync(join(dir, '.genie', 'INDEX.md'))).toBe(true);
  });

  test('existing .gitignore content is preserved and rules appended after it', () => {
    initGitRepo(dir);
    const gitignorePath = join(dir, '.gitignore');
    writeFileSync(gitignorePath, 'node_modules\ndist\n');

    const { code } = runInit(dir);
    expect(code).toBe(0);

    const gitignore = readFileSync(gitignorePath, 'utf-8');
    expect(gitignore).toContain('node_modules');
    expect(gitignore).toContain('dist');
    for (const rule of GITIGNORE_RULES) {
      expect(gitignore).toContain(rule);
    }
    // Rules appended after existing content.
    expect(gitignore.indexOf('node_modules')).toBeLessThan(gitignore.indexOf('.genie/genie.db'));
  });

  test('existing .gitignore without trailing newline still yields well-formed rules', () => {
    initGitRepo(dir);
    const gitignorePath = join(dir, '.gitignore');
    writeFileSync(gitignorePath, 'dist'); // no trailing newline
    expect(runInit(dir).code).toBe(0);

    const gitignore = readFileSync(gitignorePath, 'utf-8');
    expect(gitignore).toContain('dist\n.genie/genie.db\n');
    // Idempotent despite the awkward starting state.
    const after = readFileSync(gitignorePath);
    expect(runInit(dir).code).toBe(0);
    expect(readFileSync(gitignorePath).equals(after)).toBe(true);
  });

  test('--json emits per-artifact actions', () => {
    initGitRepo(dir);
    const { code, stdout } = runInit(dir, ['--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.index).toBe('created');
    expect(parsed.gitignore).toBe('created');
    expect(parsed.rulesAdded).toEqual(GITIGNORE_RULES);

    // Second run: everything skipped.
    const second = JSON.parse(runInit(dir, ['--json']).stdout);
    expect(second.index).toBe('skipped');
    expect(second.gitignore).toBe('skipped');
    expect(second.rulesAdded).toEqual([]);
  });

  describe('MCP server registration', () => {
    const mcpPath = (root: string) => join(root, '.mcp.json');
    const warpMcpPath = (root: string) => join(root, '.warp', '.mcp.json');

    test('fresh repo: writes both .mcp.json and .warp/.mcp.json with the genie entry', () => {
      initGitRepo(dir);
      expect(runInit(dir).code).toBe(0);

      for (const path of [mcpPath(dir), warpMcpPath(dir)]) {
        expect(existsSync(path)).toBe(true);
        const servers = JSON.parse(readFileSync(path, 'utf-8')).mcpServers;
        expect(servers.genie).toBeDefined();
        expect(servers.genie.args).toEqual(INTERPRETED_MCP_ARGS);
        // Absolute command resolved from the running executable — never bare "genie".
        expect(servers.genie.command).not.toBe('genie');
        expect(servers.genie.command.startsWith('/')).toBe(true);
      }
    });

    test('pre-populated .mcp.json: preserves the other server and adds genie', () => {
      initGitRepo(dir);
      writeFileSync(mcpPath(dir), '{"mcpServers":{"other":{"command":"x"}}}');

      expect(runInit(dir).code).toBe(0);

      const servers = JSON.parse(readFileSync(mcpPath(dir), 'utf-8')).mcpServers;
      expect(servers.other).toEqual({ command: 'x' });
      expect(servers.genie).toBeDefined();
      expect(servers.genie.args).toEqual(INTERPRETED_MCP_ARGS);
    });

    test('preserves other top-level keys and an alternate wrapper key', () => {
      initGitRepo(dir);
      // Existing file uses the `servers` wrapper + carries an unrelated top-level key.
      writeFileSync(mcpPath(dir), '{"$schema":"./s.json","servers":{"other":{"command":"x"}}}');

      expect(runInit(dir).code).toBe(0);

      const parsed = JSON.parse(readFileSync(mcpPath(dir), 'utf-8'));
      expect(parsed.$schema).toBe('./s.json');
      // Whichever wrapper key already held servers is preserved — no new mcpServers key.
      expect(parsed.mcpServers).toBeUndefined();
      expect(parsed.servers.other).toEqual({ command: 'x' });
      expect(parsed.servers.genie).toBeDefined();
    });

    test('rerun is byte-identical for both fresh and pre-populated configs', () => {
      initGitRepo(dir);
      writeFileSync(mcpPath(dir), '{"mcpServers":{"other":{"command":"x"}}}');
      expect(runInit(dir).code).toBe(0);

      const mcpBefore = readFileSync(mcpPath(dir));
      const warpBefore = readFileSync(warpMcpPath(dir));

      expect(runInit(dir).code).toBe(0);

      expect(readFileSync(mcpPath(dir)).equals(mcpBefore)).toBe(true);
      expect(readFileSync(warpMcpPath(dir)).equals(warpBefore)).toBe(true);
    });

    test('--json reports the mcp config writes as created then skipped', () => {
      initGitRepo(dir);
      const first = JSON.parse(runInit(dir, ['--json']).stdout);
      const actions = first.mcp.map((c: { path: string; action: string }) => c.action);
      expect(actions.slice(0, 2)).toEqual(['created', 'created']);

      const second = JSON.parse(runInit(dir, ['--json']).stdout);
      expect(second.mcp.map((c: { action: string }) => c.action).slice(0, 2)).toEqual(['skipped', 'skipped']);
    });

    test('malformed .mcp.json is surfaced, not clobbered', () => {
      initGitRepo(dir);
      writeFileSync(mcpPath(dir), 'not json {');
      const { code, stderr } = runInit(dir);
      expect(code).toBe(1);
      expect(stderr).toContain('.mcp.json');
      // The bad file is left untouched.
      expect(readFileSync(mcpPath(dir), 'utf-8')).toBe('not json {');
      expect(existsSync(join(dir, '.genie', 'INDEX.md'))).toBe(false);
      expect(existsSync(join(dir, '.gitignore'))).toBe(false);
    });

    test('valid but wrong-shaped server maps are rejected without partial scaffold writes', () => {
      initGitRepo(dir);
      mkdirSync(join(dir, '.warp'), { recursive: true });
      writeFileSync(warpMcpPath(dir), '{"mcpServers":[]}');
      const { code, stderr } = runInit(dir);
      expect(code).toBe(1);
      expect(stderr).toContain('mcpServers');
      expect(readFileSync(warpMcpPath(dir), 'utf8')).toBe('{"mcpServers":[]}');
      expect(existsSync(mcpPath(dir))).toBe(false);
      expect(existsSync(join(dir, '.genie', 'INDEX.md'))).toBe(false);
    });
  });
});

describe('Codex MCP fallback merge', () => {
  test('does not duplicate an existing unowned genie server', () => {
    const path = join(dir, '.codex', 'config.toml');
    mkdirSync(join(dir, '.codex'), { recursive: true });
    const original = '[mcp_servers.genie]\ncommand = "/existing/genie"\nargs = ["mcp"]\n';
    writeFileSync(path, original);
    expect(mergeCodexMcpFallback(path, { command: '/new/genie', args: ['mcp'] })).toBe('skipped');
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  test('removes only the marker-owned fallback', () => {
    const path = join(dir, '.codex', 'config.toml');
    mkdirSync(join(dir, '.codex'), { recursive: true });
    writeFileSync(
      path,
      'model = "x"\n\n# BEGIN GENIE MCP FALLBACK\n[mcp_servers.genie]\ncommand = "/g"\nargs = ["mcp"]\n# END GENIE MCP FALLBACK\n\n[mcp_servers.other]\ncommand = "x"\n',
    );
    expect(removeCodexMcpFallback(path)).toBe('updated');
    const updated = readFileSync(path, 'utf8');
    expect(updated).not.toContain('GENIE MCP FALLBACK');
    expect(updated).toContain('[mcp_servers.other]');
  });
});

// ============================================================================
// Verified-current fallback gate — B's observation facade (Group D, D5)
// ============================================================================

import {
  type CanonicalFact,
  type CodexActivationSnapshot,
  type FamilyWitness,
  type IntentFact,
  type PhysicalCacheFact,
  type QueryFact,
  type RefreshIntent,
  parseReleaseVersion,
} from '../lib/codex-activation.js';
import { isCodexVerifiedCurrent } from './init.js';

const IT_T = '5.260712.1';
const IT_OLD = '5.260711.9';
const IT_NEWER = '5.260713.4';
const IT_DIGEST = 'a'.repeat(64);

function itVer(s: string) {
  const parsed = parseReleaseVersion(s);
  if (!parsed) throw new Error(`bad version ${s}`);
  return parsed;
}
function itFamily(): FamilyWitness {
  return { status: 'present', digest: 'f'.repeat(64), identity: '10:300' };
}
function itCanonical(): CanonicalFact {
  return { status: 'ok', version: itVer(IT_T), digest: IT_DIGEST, identity: '10:100' };
}
function itReg(version = IT_T): QueryFact {
  return { status: 'ok', registration: { present: true, enabled: true, version: itVer(version) } };
}
function itCache(digest = IT_DIGEST): PhysicalCacheFact {
  return { kind: 'present', digest, identity: '10:200' };
}
function itIntentTargetCurrent(): IntentFact {
  const intent: RefreshIntent = {
    schemaVersion: 1,
    refreshIntentId: '1'.repeat(32),
    operationId: '2'.repeat(32),
    fromPluginVersion: IT_OLD,
    targetVersion: IT_T,
    direction: 'upgrade',
    priorEnabled: true,
    canonicalPayloadSha256: IT_DIGEST,
    phase: 'planned',
    commandKind: 'codex-plugin-add',
    lastFailure: '',
    receiptId: null,
  };
  return { status: 'valid', intent, contentSha256: 'd'.repeat(64) };
}
function itSnapshot(over: Partial<CodexActivationSnapshot> = {}): CodexActivationSnapshot {
  return {
    canonical: itCanonical(),
    query: itReg(),
    cache: itCache(),
    receipt: { status: 'absent' },
    delivery: { status: 'absent' },
    intent: { status: 'absent' },
    receiptConsumed: false,
    observationWitness: { before: itFamily(), after: itFamily() },
    observedAt: '2026-07-12T00:00:00.000Z',
    ...over,
  };
}
function gate(snapshot: CodexActivationSnapshot, observed: string[] = []): boolean {
  return isCodexVerifiedCurrent({
    resolveCodexCommand: () => '/fake/codex',
    observeCodexActivation: ({ command }) => {
      observed.push(command ?? 'null');
      return snapshot;
    },
  });
}

describe('init verified-current fallback gate', () => {
  test('a fresh `current` observation is the ONLY state that reconciles (true)', () => {
    expect(gate(itSnapshot())).toBe(true);
  });

  test('state matrix: pending / broken / indeterminate / recovery all retain fallback (false)', () => {
    // activation-pending (N < T)
    expect(gate(itSnapshot({ query: itReg(IT_OLD), cache: itCache('b'.repeat(64)) }))).toBe(false);
    // query-failed (broken/indeterminate)
    expect(gate(itSnapshot({ query: { status: 'failed', detail: 'timed out' } }))).toBe(false);
    // registration-absent (activation required)
    expect(
      gate(itSnapshot({ query: { status: 'ok', registration: { present: false } }, cache: { kind: 'absent' } })),
    ).toBe(false);
    // cache-missing
    expect(gate(itSnapshot({ cache: { kind: 'absent' } }))).toBe(false);
    // installed-newer (implicit downgrade refused)
    expect(gate(itSnapshot({ query: itReg(IT_NEWER) }))).toBe(false);
  });

  test('a current-LOOKING but payload-mismatched snapshot is NOT fresh authority (false)', () => {
    // same version string, divergent cache digest → payload-mismatch, never current.
    expect(gate(itSnapshot({ cache: itCache('c'.repeat(64)) }))).toBe(false);
  });

  test('a current-version snapshot with an unresolved refresh intent is a recovery state, not current (false)', () => {
    // intent-target-current dominates the ordinary `current` row: retain fallback.
    expect(gate(itSnapshot({ intent: itIntentTargetCurrent() }))).toBe(false);
  });

  test('the observation is taken with the freshly resolved codex command (no stale authority)', () => {
    const observed: string[] = [];
    gate(itSnapshot(), observed);
    expect(observed).toEqual(['/fake/codex']);
  });

  test('an absent codex CLI observes with a null command and never reconciles', () => {
    const observed: string[] = [];
    const result = isCodexVerifiedCurrent({
      resolveCodexCommand: () => null,
      observeCodexActivation: ({ command }) => {
        observed.push(command === null ? 'null' : command);
        return itSnapshot({ query: { status: 'failed', detail: 'codex CLI not found' } });
      },
    });
    expect(result).toBe(false);
    expect(observed).toEqual(['null']);
  });

  test('init.ts never mints an assertion/permit and never touches the lifecycle lease', () => {
    const source = readFileSync(join(import.meta.dir, 'init.ts'), 'utf8');
    expect(source.includes('acquireLifecycleLease')).toBe(false);
    expect(source.includes('requestRetirementAssertion')).toBe(false);
    expect(source.includes('authorizeCodexActivation')).toBe(false);
    expect(source.includes('executeCodexActivation')).toBe(false);
  });
});
