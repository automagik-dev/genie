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
    expect(priced.stdout).toMatch(/comment→comment\t1\t.*\t1\/1\t1100\t0\.0200\t-\t1\/1\ttable$/m);
    expect(priced.stdout).toContain('\toffloadUsd\tpriced\tcostSource');
    const pricedJson = JSON.parse(run(['metrics', 'export', '--json'], env).stdout);
    expect(pricedJson.summary[0]).toMatchObject({ calls: 1, pricedCalls: 1, costSource: 'table' });

    writeFileSync(table, 'not json');
    const refused = run(['metrics', 'prices', 'update', '--from', table]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('is not JSON; the stored table is unchanged');
    expect(readFileSync(join(home, 'metrics', 'prices.json')).equals(stored)).toBe(true);
    const status = JSON.parse(run(['metrics', 'prices', 'status', '--json']).stdout);
    expect(status).toMatchObject({ path: join(home, 'metrics', 'prices.json'), table: { source: table, models: 1 } });
  }, 60_000);

  test('prices update over http: 200 stores it, a re-run is idempotent, non-2xx exits 1 and keeps the table', async () => {
    // A loopback server in this process, so the CLI must run without blocking the event loop.
    const body = JSON.stringify({ 'claude-opus-5-5': { input_cost_per_token: 1e-5, output_cost_per_token: 1e-4 } });
    let status = 200;
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(body, { status }) });
    const runAsync = async (args: string[]) => {
      const proc = Bun.spawn(['bun', GENIE, ...args], {
        cwd: repo,
        env: { ...process.env, NO_COLOR: '1', GENIE_HOME: home },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, code };
    };
    const url = `http://127.0.0.1:${server.port}/model_prices.json`;
    const stored = join(home, 'metrics', 'prices.json');
    try {
      const first = await runAsync(['metrics', 'prices', 'update', '--from', url]);
      expect(first.code).toBe(0);
      expect(first.stdout).toContain(`prices: 1 models from ${url}`);
      const firstTable = JSON.parse(readFileSync(stored, 'utf8'));

      const again = await runAsync(['metrics', 'prices', 'update', '--from', url]);
      expect(again.code).toBe(0);
      const againTable = JSON.parse(readFileSync(stored, 'utf8'));
      // Same bytes fetched → same sha and same models; only fetchedAt may move.
      expect(againTable.genie.sha256).toBe(firstTable.genie.sha256);
      expect(againTable.models).toEqual(firstTable.models);

      const shown = await runAsync(['metrics', 'prices', 'status']);
      expect(shown.code).toBe(0);
      expect(shown.stdout).toContain(`source:  ${url}`);
      expect(shown.stdout).toContain('models:  1');

      status = 503;
      const before = readFileSync(stored);
      const failed = await runAsync(['metrics', 'prices', 'update', '--from', url]);
      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain('answered 503');
      expect(readFileSync(stored).equals(before)).toBe(true);
    } finally {
      server.stop(true);
    }
  }, 60_000);

  test('export ignores ledger lines of a database that is not <root>/.genie/genie.db, and says how many', () => {
    expect(run(['metrics', 'enable']).code).toBe(0);
    const id = run(['task', 'create', '--title', 'probe']).stdout.match(/Created task (\S+)/)?.[1] as string;
    expect(run(['task', 'comment', id, 'one']).code).toBe(0);
    expect(run(['task', 'comment', id, 'two']).code).toBe(0);
    const ledger = join(home, 'metrics', 'events.jsonl');
    const captured = readFileSync(ledger, 'utf8');

    // A ledger with only per-repo lines: the summary line and the JSON object keep the shape they always had.
    const cleanText = run(['metrics', 'export']).stdout;
    const cleanJson = JSON.parse(run(['metrics', 'export', '--json']).stdout);
    const lines = captured.trim().split('\n').length;
    expect(cleanText.split('\n')[0]).toBe(`ledger lines ${lines}, unmatched 0, corrupt 0`);
    expect(Object.keys(cleanJson)).toEqual(['lines', 'unmatched', 'corrupt', 'intervals', 'summary']);
    expect(cleanJson.intervals).toBeGreaterThan(0);

    // What a pre-#3134 suite run left behind: the same events, verifiable, under a test database path.
    const scratch = join(root, 'genie-task-AbCd', 'race.db');
    execFileSync('mkdir', ['-p', join(root, 'genie-task-AbCd')]);
    execFileSync('cp', [join(repo, '.genie', 'genie.db'), scratch]);
    const polluted = captured
      .trim()
      .split('\n')
      .map((row) => `${JSON.stringify({ ...JSON.parse(row), db: scratch })}\n`)
      .join('');
    writeFileSync(ledger, captured + polluted);

    const text = run(['metrics', 'export']).stdout;
    expect(text.split('\n')[0]).toBe(`ledger lines ${lines}, unmatched 0, corrupt 0, ignored ${lines}`);
    expect(text.split('\n').slice(1)).toEqual(cleanText.split('\n').slice(1));
    const json = JSON.parse(run(['metrics', 'export', '--json']).stdout);
    expect(Object.keys(json)).toEqual(['lines', 'unmatched', 'corrupt', 'ignored', 'intervals', 'summary']);
    expect(json).toEqual({ ...cleanJson, ignored: lines, summary: json.summary });
    expect(json.summary.map((r: { transition: string; n: number }) => [r.transition, r.n])).toEqual(
      cleanJson.summary.map((r: { transition: string; n: number }) => [r.transition, r.n]),
    );
    // Read past, never pruned.
    expect(readFileSync(ledger, 'utf8')).toBe(captured + polluted);
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
