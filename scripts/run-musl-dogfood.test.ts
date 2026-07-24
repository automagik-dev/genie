import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'run-musl-dogfood.sh');
const roots: string[] = [];

function fixture(): { root: string; binary: string; log: string; env: Record<string, string> } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'genie-musl-adapter-')));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const binary = join(root, 'candidate-genie');
  writeFileSync(binary, '#!/bin/sh\nexit 0\n');
  chmodSync(binary, 0o755);
  const log = join(root, 'docker.log');
  writeFileSync(join(bin, 'uname'), `#!/bin/sh\nif [ "$1" = "-s" ]; then printf Linux; else printf x86_64; fi\n`);
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$@" > "$DOGFOOD_DOCKER_LOG"\n`);
  chmodSync(join(bin, 'uname'), 0o755);
  chmodSync(join(bin, 'docker'), 0o755);
  return {
    root,
    binary,
    log,
    env: { PATH: `${bin}:/usr/bin:/bin`, DOGFOOD_DOCKER_LOG: log },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('musl dogfood execution adapter', () => {
  test('binds a physical candidate read-only and passes adversarial argv without evaluation', () => {
    const fx = fixture();
    const result = Bun.spawnSync(
      ['bash', SCRIPT, fx.binary, 'update', '--value', '$(touch should-not-exist); spaced'],
      { env: fx.env, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(result.exitCode).toBe(0);
    const args = readFileSync(fx.log, 'utf8').split('\n');
    expect(args).toContain('--pull=always');
    expect(args).toContain('alpine:3.19@sha256:6baf43584bcb78f2e5847d1de515f23499913ac9f12bdf834811a3145eb11ca1');
    expect(args).toContain(`type=bind,src=${fx.root},dst=/candidate,readonly`);
    expect(args).toContain('$(touch should-not-exist); spaced');
    expect(existsSync(join(fx.root, 'should-not-exist'))).toBe(false);
  });

  test('stateful mode preserves the exact fixture cwd and rebinds the authenticated candidate read-only', () => {
    const fx = fixture();
    const repo = join(fx.root, 'repo');
    mkdirSync(repo);
    const env = {
      ...fx.env,
      DOGFOOD_ROOT: fx.root,
      HOME: join(fx.root, 'home'),
      GENIE_HOME: join(fx.root, 'genie-home'),
      CODEX_HOME: join(fx.root, 'codex-home'),
    };
    const result = Bun.spawnSync(['bash', SCRIPT, fx.binary, 'mcp'], {
      cwd: repo,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    const args = readFileSync(fx.log, 'utf8').split('\n');
    expect(args).toContain(`type=bind,src=${fx.root},dst=${fx.root}`);
    expect(args).toContain(`type=bind,src=${fx.binary},dst=${fx.binary},readonly`);
    expect(args).toContain('--workdir');
    expect(args).toContain(repo);
    expect(args).toContain('HOME');
    expect(args).toContain(`PATH=${fx.root}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`);
  });

  test('rejects relative, symlinked, non-executable, and non-canonical candidates before Docker', () => {
    for (const kind of ['relative', 'symlink', 'non-executable', 'non-canonical'] as const) {
      const fx = fixture();
      const nonExecutable = join(fx.root, 'non-executable');
      writeFileSync(nonExecutable, 'not executable\n');
      const symlink = join(fx.root, 'candidate-link');
      symlinkSync(fx.binary, symlink);
      const candidate = {
        relative: 'relative-genie',
        symlink,
        'non-executable': nonExecutable,
        'non-canonical': join(fx.root, '.', 'candidate-genie').replace('/candidate-genie', '//candidate-genie'),
      }[kind];
      const result = Bun.spawnSync(['bash', SCRIPT, candidate, '--version'], {
        env: fx.env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).not.toBe(0);
      expect(existsSync(fx.log)).toBe(false);
    }
  });
});
