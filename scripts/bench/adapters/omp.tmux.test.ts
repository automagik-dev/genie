/**
 * The real-tmux proof of `tmuxHost`. It runs only with GENIE_BENCH_REAL_TMUX=1 (CI installs no
 * tmux, so CI runs it as a flag-off skip); under the flag a missing tmux is a failure, not a skip.
 * Every server it starts lives on its own `-L` socket and is killed afterwards.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tmuxHost } from './omp';

const REAL_TMUX = process.env.GENIE_BENCH_REAL_TMUX === '1';

/** Records whether stdin is a TTY and each argument, then stays alive until killed. */
const STUB = `#!/bin/sh
if [ -t 0 ]; then t=tty; else t=notty; fi
printf '%s\\n' "$t" > "$HOME/record.tmp"
for a in "$@"; do printf '[%s]\\n' "$a" >> "$HOME/record.tmp"; done
mv "$HOME/record.tmp" "$HOME/record"
exec sleep 30
`;

let tmp: string;
let session: string;

function hasSession(socket: string): number {
  const tmux = Bun.which('tmux');
  if (tmux === null) throw new Error('tmux is not on PATH');
  return Bun.spawnSync([tmux, '-L', socket, 'has-session'], { stdout: 'ignore', stderr: 'ignore' }).exitCode;
}

describe.if(REAL_TMUX)('tmuxHost against a real tmux', () => {
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'omp-tmux-')));
    session = `omp-tmux-test-${process.pid}-${Date.now()}`;
  });

  afterEach(() => {
    const tmux = Bun.which('tmux');
    if (tmux !== null) Bun.spawnSync([tmux, '-L', session, 'kill-server'], { stdout: 'ignore', stderr: 'ignore' });
    rmSync(tmp, { recursive: true, force: true });
  });

  test('tmux is on PATH', () => {
    expect(Bun.which('tmux')).not.toBeNull();
  });

  test('the stub runs on a genuine TTY with the prompt as one argument, and stop leaves no server', async () => {
    const home = join(tmp, 'home');
    const workspace = join(tmp, 'workspace');
    mkdirSync(home);
    mkdirSync(workspace);
    const stub = join(tmp, 'omp');
    writeFileSync(stub, STUB);
    chmodSync(stub, 0o755);
    const prompt = 'Say "hi" and \'bye\'\n$(id) `id`';

    await tmuxHost.start([stub, prompt], { PATH: process.env.PATH ?? '', HOME: home }, workspace, session);
    const record = join(home, 'record');
    for (let i = 0; i < 100 && !existsSync(record); i++) await Bun.sleep(50);
    expect(readFileSync(record, 'utf8')).toBe(`tty\n[${prompt}]\n`);
    expect(await tmuxHost.alive(session)).toBe(true);
    expect(await tmuxHost.version()).toMatch(/^tmux /);

    await tmuxHost.kill(session);
    expect(await tmuxHost.alive(session)).toBe(false);
    expect(hasSession(session)).not.toBe(0);
  });
});
