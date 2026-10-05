/**
 * genie metrics — CLI-level tests through the real `genie.ts` entry, the way a
 * user runs it. The first case is the owner rule: a host that never enabled
 * capture must see no new file under GENIE_HOME after ordinary lifecycle verbs.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GENIE = join(import.meta.dir, '..', 'genie.ts');

let root: string;
let repo: string;
let home: string;

function run(args: string[], env: Record<string, string> = {}): { stdout: string; stderr: string; code: number } {
  const proc = Bun.spawnSync(['bun', GENIE, ...args], {
    cwd: repo,
    env: {
      ...process.env,
      NO_COLOR: '1',
      GENIE_HOME: home,
      // No inherited runtime markers: each case states the session it means.
      CLAUDECODE: '',
      CLAUDE_CODE: '',
      CLAUDE_CODE_SESSION_ID: '',
      CODEX_THREAD_ID: '',
      PI_SESSION_ID: '',
      PI_SESSION_FILE: '',
      GENIE_METRICS: '',
      ...env,
    },
  });
  return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), code: proc.exitCode ?? -1 };
}

function listTree(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: false }).map(String).sort();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'genie-metrics-cli-'));
  repo = join(root, 'repo');
  home = join(root, 'home');
  execFileSync('mkdir', ['-p', repo, home]);
  execFileSync('git', ['init', '-q'], { cwd: repo });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('genie metrics', () => {
  test('capture off: lifecycle verbs leave GENIE_HOME byte-identical', () => {
    const create = run(['task', 'create', '--title', 'probe']);
    expect(create.code).toBe(0);
    const id = create.stdout.match(/Created task (\S+)/)?.[1] as string;
    expect(run(['task', 'comment', id, 'hello'], { CLAUDE_CODE_SESSION_ID: 'sess-off' }).code).toBe(0);
    expect(run(['task', 'list']).code).toBe(0);
    expect(listTree(home)).toEqual([]);
  }, 60_000);

  test('enable → a card event appends one line carrying the runtime session; disable stops it', () => {
    const enable = run(['metrics', 'enable']);
    expect(enable.code).toBe(0);
    expect(enable.stderr).toBe('');
    expect(enable.stdout).toContain('capture: on');

    const create = run(['task', 'create', '--title', 'probe']);
    const id = create.stdout.match(/Created task (\S+)/)?.[1] as string;
    expect(run(['task', 'comment', id, 'hello'], { CODEX_THREAD_ID: 'thr-42' }).code).toBe(0);

    const ledger = join(home, 'metrics', 'events.jsonl');
    const rows = readFileSync(ledger, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const comment = rows.find((row) => row.kind === 'comment');
    expect(comment).toMatchObject({ task: id, session: { id: 'thr-42', source: 'codex' }, authorKind: 'codex' });
    expect(comment.db).toEndWith(join('.genie', 'genie.db'));

    const before = readFileSync(ledger, 'utf8');
    expect(run(['task', 'comment', id, 'still on'], { GENIE_METRICS: 'off' }).code).toBe(0);
    expect(readFileSync(ledger, 'utf8')).toBe(before);

    expect(run(['metrics', 'disable']).stdout).toContain('capture: off');
    expect(run(['task', 'comment', id, 'after disable']).code).toBe(0);
    expect(readFileSync(ledger, 'utf8')).toBe(before);
  }, 60_000);

  test('export: no target configured → --phoenix exits 2 and sends nothing; a half target is refused', () => {
    expect(run(['metrics', 'enable']).code).toBe(0);
    const bare = run(['metrics', 'export']);
    expect(bare.code).toBe(0);
    expect(bare.stdout).toContain('no intervals yet');
    const phoenix = run(['metrics', 'export', '--phoenix']);
    expect(phoenix.code).toBe(2);
    expect(phoenix.stderr).toContain('no Phoenix target configured');
    expect(phoenix.stderr).toContain('Nothing was sent.');
    const half = run(['metrics', 'export', '--phoenix', '--project', 'mine']);
    expect(half.code).toBe(2);
    expect(half.stderr).toContain('needs an http(s) endpoint');
    expect(run(['metrics', 'export', '--since', 'yesterday-ish']).code).toBe(2);
    expect(listTree(home)).toEqual(['metrics', join('metrics', 'capture.on')]);
  }, 60_000);

  test('export --save works on a host that never enabled capture and stores the target 0600, key by name only', () => {
    const save = run([
      'metrics',
      'export',
      '--endpoint',
      'http://px.example:6006/',
      '--project',
      'mine',
      '--api-key-env',
      'PX_KEY',
      '--save',
    ]);
    expect(save.code).toBe(0);
    expect(save.stderr).toBe('');
    const path = join(home, 'metrics', 'export.json');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      endpoint: 'http://px.example:6006',
      project: 'mine',
      apiKeyEnv: 'PX_KEY',
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  }, 60_000);

  test.skipIf(process.getuid?.() === 0)(
    'export: an unreadable mikro ledger reports the offload unknown, never 0 (installed .15 regression)',
    () => {
      expect(run(['metrics', 'enable']).code).toBe(0);
      const id = run(['task', 'create', '--title', 'probe']).stdout.match(/Created task (\S+)/)?.[1] as string;
      expect(run(['task', 'comment', id, 'one'], { CLAUDE_CODE_SESSION_ID: 's' }).code).toBe(0);
      expect(run(['task', 'comment', id, 'two'], { CLAUDE_CODE_SESSION_ID: 's' }).code).toBe(0);
      const ledger = join(repo, '.mikro', 'runs', 'wish-context.jsonl');
      execFileSync('mkdir', ['-p', join(repo, '.mikro', 'runs')]);
      writeFileSync(ledger, '');
      chmodSync(ledger, 0o000);
      const out = join(root, 'intervals.jsonl');
      try {
        const exported = run(['metrics', 'export', '--out', out]);
        expect(exported.code).toBe(0);
        const [interval] = readFileSync(out, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l));
        expect(interval.offload).toBeNull();
        expect(exported.stdout).toMatch(/comment→comment\t1\t.*\t-$/m);
      } finally {
        chmodSync(ledger, 0o600);
      }
    },
    60_000,
  );

  test('prices: no table → export unchanged; update --from a local file prices Claude calls; a bad file is refused', () => {
    const claude = join(root, 'claude');
    const env = { CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CONFIG_DIR: claude };
    expect(run(['metrics', 'prices', 'status']).stdout).toContain('no price table — USD stays runtime-priced only');
    expect(run(['metrics', 'enable']).code).toBe(0);
    const id = run(['task', 'create', '--title', 'probe']).stdout.match(/Created task (\S+)/)?.[1] as string;
    expect(run(['task', 'comment', id, 'one'], env).code).toBe(0);
    execFileSync('mkdir', ['-p', join(claude, 'projects', '-repo')]);
    const call = {
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 100 } },
    };
    writeFileSync(join(claude, 'projects', '-repo', 's.jsonl'), `${JSON.stringify(call)}\n`);
    expect(run(['task', 'comment', id, 'two'], env).code).toBe(0);

    const out = join(root, 'intervals.jsonl');
    const exportUsage = () => {
      const exported = run(['metrics', 'export', '--out', out], env);
      expect(exported.code).toBe(0);
      return { stdout: exported.stdout, usage: JSON.parse(readFileSync(out, 'utf8').trim()).usage };
    };
    const bare = exportUsage();
    expect(bare.usage).toEqual({ calls: 1, input: 1000, cacheRead: 0, cacheWrite: 0, output: 100, costUsd: null });
    expect(bare.stdout).toMatch(/comment→comment\t1\t.*\t1\/1\t1100\t-\t-$/m);
    expect(bare.stdout).not.toContain('priced');
    const bareJson = JSON.parse(run(['metrics', 'export', '--json'], env).stdout);
    expect(Object.keys(bareJson.summary[0])).not.toContain('pricedCalls');

    const table = join(root, 'litellm.json');
    writeFileSync(
      table,
      JSON.stringify({ 'claude-opus-5-5': { input_cost_per_token: 1e-5, output_cost_per_token: 1e-4 } }),
    );
    const update = run(['metrics', 'prices', 'update', '--from', table]);
    expect(update.code).toBe(0);
    expect(update.stdout).toContain(`prices: 1 models from ${table}`);
    const stored = readFileSync(join(home, 'metrics', 'prices.json'));

    const priced = exportUsage();
    expect(priced.usage).toMatchObject({ costSource: 'table', pricedCalls: 1 });
    expect(priced.usage.costUsd).toBeCloseTo(0.02, 12);
    expect(priced.stdout).toMatch(/comment→comment\t1\t.*\t1\/1\t1100\t0\.0200\t-\t1\/1$/m);
    expect(priced.stdout).toContain('\toffloadUsd\tpriced');
    const pricedJson = JSON.parse(run(['metrics', 'export', '--json'], env).stdout);
    expect(pricedJson.summary[0]).toMatchObject({ calls: 1, pricedCalls: 1 });

    writeFileSync(table, 'not json');
    const refused = run(['metrics', 'prices', 'update', '--from', table]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('is not JSON; the stored table is unchanged');
    expect(readFileSync(join(home, 'metrics', 'prices.json')).equals(stored)).toBe(true);
    const status = JSON.parse(run(['metrics', 'prices', 'status', '--json']).stdout);
    expect(status).toMatchObject({ path: join(home, 'metrics', 'prices.json'), table: { source: table, models: 1 } });
  }, 60_000);

  test('status --json names the switch, the ledger and this shell’s session', () => {
    const status = run(['metrics', 'status', '--json'], { PI_SESSION_ID: 'pi-1', PI_SESSION_FILE: '/s/pi-1.jsonl' });
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      enabled: false,
      ledgerBytes: null,
      signal: join(home, 'metrics', 'capture.on'),
      session: { id: 'pi-1', source: 'pi', file: '/s/pi-1.jsonl' },
    });
    expect(listTree(home)).toEqual([]);
  }, 60_000);
});
