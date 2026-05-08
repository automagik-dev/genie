import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const POSTINSTALL = path.join(__dirname, '..', '..', 'scripts', 'postinstall-migrations.js');

test('postinstall: GENIE_SKIP_MIGRATIONS=1 short-circuits silently', () => {
  const r = spawnSync(process.execPath, [POSTINSTALL], {
    env: { ...process.env, GENIE_SKIP_MIGRATIONS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  });
  expect(r.status).toBe(0);
  expect(r.stdout.toString()).toBe('');
});

test('postinstall: missing ~/.genie/ exits 0 silently (fresh install)', () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'genie-fresh-'));
  const env = { ...process.env, HOME: fakeHome };
  env.GENIE_SKIP_MIGRATIONS = undefined;
  const r = spawnSync(process.execPath, [POSTINSTALL], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  });
  expect(r.status).toBe(0);
  rmSync(fakeHome, { recursive: true, force: true });
});
