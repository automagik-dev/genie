import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const scratch: string[] = [];
const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A home whose capture switch is ON: any card event written with capture reachable lands in `ledger`. */
function captureHome(): { home: string; genieHome: string; ledger: string } {
  const home = tmp('genie-preload-home-');
  const genieHome = join(home, '.genie');
  mkdirSync(join(genieHome, 'metrics'), { recursive: true });
  writeFileSync(join(genieHome, 'metrics', 'capture.on'), '');
  return { home, genieHome, ledger: join(genieHome, 'metrics', 'events.jsonl') };
}

describe('the test preload makes the suite hermetic to inherited colour policy', () => {
  test('a runner started with FORCE_COLOR=3 hands its tests an environment without it', () => {
    // A child `bun test` inherits the harness value; the preload must strip it before any test runs.
    const probe = spawnSync(
      process.execPath,
      ['test', './scripts/test-preload.test.ts', '-t', 'probe: FORCE_COLOR is absent'],
      // A synchronous spawn cannot be interrupted by the test timer, so it carries its own bound.
      { cwd: ROOT, env: { ...process.env, FORCE_COLOR: '3' }, encoding: 'utf8', timeout: 60_000 },
    );
    expect(`${probe.stdout}${probe.stderr}`).toContain('1 pass');
    expect(probe.status).toBe(0);
  });

  test('probe: FORCE_COLOR is absent', () => {
    expect(process.env.FORCE_COLOR).toBeUndefined();
  });
});

// The regression this owns: on a host that ran `genie metrics enable`, the suite appended a line per
// card event for its tmpdir databases to the operator's real ledger, because a child spawned with no
// explicit `env` got the runner's STARTING environment rather than the one the preload had edited.
describe('the test preload reaches children spawned without an explicit env', () => {
  test('a runner started on a capturing host leaves that host’s ledger untouched', () => {
    const host = captureHome();
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: host.home,
      GENIE_HOME: host.genieHome,
      // What the preload must undo: an agent harness running the gate on a capturing host.
      CLAUDECODE: '1',
      FORCE_COLOR: '3',
    };
    Reflect.deleteProperty(env, 'GENIE_METRICS');
    const probe = spawnSync(
      process.execPath,
      ['test', './scripts/test-preload.test.ts', '-t', 'probe: no-env children'],
      { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 },
    );
    expect(`${probe.stdout}${probe.stderr}`).toContain('1 pass');
    expect(probe.status).toBe(0);
    // Not one line: the file is created by the first captured event, so it must not exist at all.
    expect(existsSync(host.ledger)).toBe(false);
  }, 90_000);

  test('probe: no-env children see the preload’s environment and capture nothing', async () => {
    const dir = tmp('genie-preload-probe-');
    const workerPath = join(dir, 'worker.ts');
    // The worker takes the path the leak took: a real card event through task-state, which is where
    // capture is written. It prints what it saw so the assertion names the variable that leaked.
    writeFileSync(
      workerPath,
      `
import { openDb } from ${JSON.stringify(join(ROOT, 'src/lib/v5/genie-db.ts'))};
import { appendTaskEvent, createTask } from ${JSON.stringify(join(ROOT, 'src/lib/v5/task-state.ts'))};
const db = openDb({ path: process.argv[2] });
const card = createTask(db, { title: 'probe' });
appendTaskEvent(db, card.id, { kind: 'comment', note: 'probe' });
db.close();
const seen = ['GENIE_METRICS', 'CLAUDECODE', 'FORCE_COLOR'].map((k) => k + '=' + (process.env[k] ?? '')).join(' ');
process.stdout.write(seen);
`,
    );
    const argv = (api: string): string[] => ['run', workerPath, join(dir, `${api}.db`)];
    const bun = process.execPath;

    const viaBunSpawn = Bun.spawn([bun, ...argv('bun-spawn')], { stdout: 'pipe', stderr: 'pipe' });
    const viaBunSpawnObject = Bun.spawn({ cmd: [bun, ...argv('bun-spawn-object')], stdout: 'pipe', stderr: 'pipe' });
    const viaNodeSpawn = spawn(bun, argv('node-spawn'));
    let nodeSpawnOut = '';
    viaNodeSpawn.stdout.on('data', (chunk) => {
      nodeSpawnOut += String(chunk);
    });
    const nodeSpawnClosed = new Promise((resolve) => viaNodeSpawn.on('close', resolve));

    const seen: Record<string, string> = {
      'Bun.spawn': await new Response(viaBunSpawn.stdout).text(),
      'Bun.spawn({cmd})': await new Response(viaBunSpawnObject.stdout).text(),
      'Bun.spawnSync': Bun.spawnSync([bun, ...argv('bun-spawn-sync')]).stdout.toString(),
      'child_process.spawnSync': spawnSync(bun, argv('node-spawn-sync'), { encoding: 'utf8' }).stdout,
      'child_process.execFileSync': execFileSync(bun, argv('node-exec-file-sync'), { encoding: 'utf8' }),
    };
    await nodeSpawnClosed;
    seen['child_process.spawn'] = nodeSpawnOut;

    const hermetic = 'GENIE_METRICS=off CLAUDECODE= FORCE_COLOR=';
    expect(seen).toEqual(Object.fromEntries(Object.keys(seen).map((api) => [api, hermetic])));

    // Control: the same worker with capture reachable DOES write, so the empty ledger above is the
    // preload's doing and not a worker that stopped reaching the capture path.
    const control = captureHome();
    const controlRun = spawnSync(bun, argv('control'), {
      env: { ...process.env, HOME: control.home, GENIE_HOME: control.genieHome, GENIE_METRICS: '' },
      encoding: 'utf8',
    });
    expect(controlRun.status).toBe(0);
    expect(readFileSync(control.ledger, 'utf8').trim().split('\n')).toHaveLength(1);
  }, 60_000);
});
