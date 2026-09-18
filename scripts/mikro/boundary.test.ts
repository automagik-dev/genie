/**
 * The boundary's policy, tested without a sandbox.
 *
 * `bwrapArgv` is pure, so the whole mount and environment policy is asserted here
 * on a host that has no bwrap at all — a CI runner with user namespaces disabled
 * still fails this file for the right reason. The one suite that needs the real
 * thing (`live boundary`) is skipped, loudly, when bwrap is absent; the live probe
 * table in the PR body is the evidence from a host that has it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BoundaryError,
  type BoundarySpec,
  DEFAULT_EGRESS_ALLOW,
  SANDBOX_PROXY_PORT,
  SYSTEM_RO_BINDS,
  appendBoundaryEvidence,
  bindArgs,
  boundaryEnv,
  bwrapArgv,
  egressLogLine,
  hostHeaderTarget,
  innerCommand,
  isBoundaryMode,
  isEgressAllowed,
  parseConnectRequest,
  preflightArgv,
  probeTable,
  sandboxEnv,
  sandboxSettings,
  shellQuote,
  startEgressProxy,
} from './boundary';

const HOME = '/home/tester';
const SCRATCH = '/tmp/mikro-boundary-xyz';

function spec(overrides: Partial<BoundarySpec> = {}): BoundarySpec {
  const dir = '/home/tester/work/repo';
  return {
    dir,
    gitCommonDir: '/home/tester/work/main/.git',
    agentsDir: null,
    home: HOME,
    mikroRoot: `${HOME}/.mikro/mikro`,
    mikroLauncher: `${HOME}/.mikro/mikro/bin/mikro.mjs`,
    mikroCommandPath: `${HOME}/.local/bin/mikro`,
    settingsFile: `${SCRATCH}/settings.json`,
    nodeRoot: `${HOME}/.hermes/node`,
    scratch: SCRATCH,
    socket: `${SCRATCH}/egress.sock`,
    writable: [`${dir}/.mikro/runs`],
    systemRo: SYSTEM_RO_BINDS,
    env: sandboxEnv(
      {
        home: HOME,
        mikroCommandPath: `${HOME}/.local/bin/mikro`,
        nodeRoot: `${HOME}/.hermes/node`,
        proxyPort: SANDBOX_PROXY_PORT,
      },
      { DEEPSEEK_API_KEY: 'sk-test', MIKRO_AGENTS_DIR: `${dir}/.mikro/agents` },
    ),
    command: ['mikro', 'mcp', '--dir', dir],
    proxyPort: SANDBOX_PROXY_PORT,
    maxProcs: 256,
    maxVirtualKb: 4_194_304,
    socatPath: '/usr/bin/socat',
    shellPath: '/bin/bash',
    bwrapPath: '/usr/bin/bwrap',
    ...overrides,
  };
}

/** Index of the first `value` that follows `flag` — the only way to assert ORDER, which is what bwrap actually applies. */
function indexOfBind(argv: string[], flag: string, source: string): number {
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === flag && argv[i + 1] === source) return i;
  return -1;
}

describe('bwrapArgv: isolation flags', () => {
  test('unshares everything, dies with its parent, and is invoked by absolute path', () => {
    const argv = bwrapArgv(spec());
    expect(argv[0]).toBe('/usr/bin/bwrap');
    for (const flag of ['--unshare-all', '--die-with-parent', '--new-session']) expect(argv).toContain(flag);
  });

  test('the network namespace is private: no bwrap flag ever re-shares it', () => {
    expect(bwrapArgv(spec())).not.toContain('--share-net');
  });

  test('the command is exec’d through the shell payload, never spliced into argv', () => {
    const argv = bwrapArgv(spec());
    expect(argv[argv.length - 3]).toBe('/bin/bash');
    expect(argv[argv.length - 2]).toBe('-c');
    expect(argv[argv.length - 1]).toContain("exec 'mikro' 'mcp' '--dir'");
  });

  test('the preflight runs the same mounts with no payload and no proxy', () => {
    const argv = preflightArgv(spec());
    expect(argv[argv.length - 1]).toBe('/bin/true');
    expect(argv.join(' ')).not.toContain('socat');
    expect(argv).toContain('--unshare-all');
  });
});

describe('bwrapArgv: mounts', () => {
  test('the repository is read-only and its git common dir comes with it', () => {
    const s = spec();
    const argv = bwrapArgv(s);
    expect(indexOfBind(argv, '--ro-bind', s.dir)).toBeGreaterThan(-1);
    expect(indexOfBind(argv, '--bind', s.dir)).toBe(-1);
    expect(indexOfBind(argv, '--ro-bind', s.gitCommonDir as string)).toBeGreaterThan(-1);
  });

  test('the HOME tmpfs lands before everything bound back underneath it', () => {
    const s = spec();
    const argv = bwrapArgv(s);
    const tmpfs = indexOfBind(argv, '--tmpfs', s.home);
    expect(tmpfs).toBeGreaterThan(-1);
    for (const under of [s.mikroRoot, s.nodeRoot, s.settingsFile])
      expect(indexOfBind(argv, '--ro-bind', under)).toBeGreaterThan(tmpfs);
    expect(indexOfBind(argv, '--symlink', s.mikroLauncher)).toBeGreaterThan(tmpfs);
  });

  test('a writable path is punched through AFTER the read-only bind it sits inside', () => {
    const s = spec();
    const argv = bwrapArgv(s);
    expect(indexOfBind(argv, '--bind', `${s.dir}/.mikro/runs`)).toBeGreaterThan(indexOfBind(argv, '--ro-bind', s.dir));
  });

  test('the scratch dir holding the proxy socket is the only other writable bind', () => {
    const s = spec();
    const argv = bwrapArgv(s);
    const writable: string[] = [];
    for (let i = 0; i < argv.length - 1; i++) if (argv[i] === '--bind') writable.push(argv[i + 1]);
    expect(writable.sort()).toEqual([`${s.dir}/.mikro/runs`, s.scratch].sort());
    expect(s.socket.startsWith(`${s.scratch}/`)).toBe(true);
  });

  test('nothing else of HOME is mounted: no ~/.config, ~/.ssh, ~/.claude, ~/.mikro/gate-env.sh', () => {
    const argv = bwrapArgv(spec()).join(' ');
    for (const secret of ['/.config', '/.ssh', '/.claude', '/.hermes/keys', 'gate-env.sh'])
      expect(argv).not.toContain(`${HOME}${secret}`);
  });

  test('the mikro launcher is a symlink, never a bind — a bound launcher would resolve the wrong root', () => {
    const s = spec();
    const argv = bwrapArgv(s);
    expect(indexOfBind(argv, '--symlink', s.mikroLauncher)).toBeGreaterThan(-1);
    expect(indexOfBind(argv, '--ro-bind', s.mikroCommandPath)).toBe(-1);
  });

  test('the generated settings copy is mounted at the path mikro reads, not the host file', () => {
    const s = spec();
    const argv = bwrapArgv(s);
    const i = indexOfBind(argv, '--ro-bind', s.settingsFile);
    expect(argv[i + 2]).toBe(`${HOME}/.mikro/settings.json`);
  });

  test('a relative path is refused with a typed error, never silently normalised', () => {
    expect(() => bindArgs(spec({ home: 'relative/home' }))).toThrow(BoundaryError);
    try {
      bindArgs(spec({ dir: 'work/repo' }));
    } catch (error) {
      expect((error as BoundaryError).failure).toBe('bad-spec');
    }
  });
});

describe('sandboxEnv', () => {
  test('points every proxy variable at the in-sandbox loopback port and empties NO_PROXY', () => {
    const env = spec().env;
    expect(env.HTTP_PROXY).toBe(`http://127.0.0.1:${SANDBOX_PROXY_PORT}`);
    expect(env.HTTPS_PROXY).toBe(env.HTTP_PROXY);
    expect(env.NO_PROXY).toBe('');
    expect(env.NODE_USE_ENV_PROXY).toBe('1');
  });

  test('PATH carries the mikro launcher dir and the node runtime, nothing of the caller', () => {
    const env = spec().env;
    expect(env.PATH.startsWith(`${HOME}/.local/bin:${HOME}/.hermes/node/bin:`)).toBe(true);
    expect(env.TMPDIR).toBe('/tmp');
  });

  test('the environment is handed to the bwrap process, never spelled into its argv', () => {
    const s = spec();
    const argv = bwrapArgv(s);
    // /proc/<pid>/cmdline is world-readable: one --setenv here would publish the provider
    // key to every user on the host for as long as the run lasts.
    expect(argv).not.toContain('--setenv');
    expect(argv).not.toContain('--clearenv');
    expect(argv.join('\u0000')).not.toContain('sk-test');
    expect(boundaryEnv(s)).toEqual(s.env);
    expect(boundaryEnv(s).DEEPSEEK_API_KEY).toBe('sk-test');
  });

  test('boundaryEnv is a copy, so a caller cannot mutate the spec through it', () => {
    const s = spec();
    const env = boundaryEnv(s);
    env.DEEPSEEK_API_KEY = 'tampered';
    expect(s.env.DEEPSEEK_API_KEY).toBe('sk-test');
  });
});

describe('innerCommand', () => {
  test('applies both ulimits before anything else runs', () => {
    const payload = innerCommand(spec());
    expect(payload.startsWith('ulimit -u 256\nulimit -v 4194304\n')).toBe(true);
  });

  test('starts socat on the loopback port against the bound unix socket', () => {
    const s = spec();
    expect(innerCommand(s)).toContain(
      `TCP-LISTEN:${s.proxyPort},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${shellQuote(s.socket)}`,
    );
  });

  test('a path with a quote in it cannot break out of the payload', () => {
    const payload = innerCommand(spec({ socket: `${SCRATCH}/it's.sock` }));
    expect(payload).toContain(`'${SCRATCH}/it'\\''s.sock'`);
  });
});

describe('egress allowlist', () => {
  test('exact host:port only — a suffix or a different port is not the allowlisted host', () => {
    expect(isEgressAllowed({ host: 'api.deepseek.com', port: 443 }, DEFAULT_EGRESS_ALLOW)).toBe(true);
    expect(isEgressAllowed({ host: 'API.DeepSeek.com', port: 443 }, DEFAULT_EGRESS_ALLOW)).toBe(true);
    expect(isEgressAllowed({ host: 'api.deepseek.com', port: 80 }, DEFAULT_EGRESS_ALLOW)).toBe(false);
    expect(isEgressAllowed({ host: 'api.deepseek.com.attacker.net', port: 443 }, DEFAULT_EGRESS_ALLOW)).toBe(false);
    expect(isEgressAllowed({ host: 'evil.api.github.com', port: 443 }, DEFAULT_EGRESS_ALLOW)).toBe(false);
  });

  test('the default list is exactly the provider and the GitHub API the helpers call', () => {
    expect(DEFAULT_EGRESS_ALLOW).toEqual(['api.deepseek.com:443', 'api.github.com:443']);
  });

  test('a CONNECT line parses; anything else does not', () => {
    expect(parseConnectRequest('CONNECT api.deepseek.com:443 HTTP/1.1\r\nHost: x\r\n\r\n')).toEqual({
      host: 'api.deepseek.com',
      port: 443,
    });
    expect(parseConnectRequest('GET http://example.com/ HTTP/1.1\r\n\r\n')).toBeNull();
    expect(parseConnectRequest('CONNECT api.deepseek.com HTTP/1.1\r\n\r\n')).toBeNull();
  });

  test('a non-CONNECT request is still named in the log by its Host header', () => {
    expect(hostHeaderTarget('GET / HTTP/1.1\r\nHost: example.com\r\n\r\n')).toEqual({ host: 'example.com', port: 80 });
    expect(hostHeaderTarget('GET / HTTP/1.1\r\n\r\n')).toEqual({ host: 'unknown', port: 0 });
  });

  test('the log line is one JSON object with the five fields the ledger promises', () => {
    const line = egressLogLine({ ts: '2026-09-18T00:00:00.000Z', runId: 'r1', host: 'h', port: 443, allowed: false });
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({
      ts: '2026-09-18T00:00:00.000Z',
      runId: 'r1',
      host: 'h',
      port: 443,
      allowed: false,
    });
  });
});

describe('the proxy, over a real unix socket', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const ask = (socketPath: string, head: string): Promise<string> =>
    new Promise((done) => {
      const client = connect(socketPath, () => client.write(head));
      let buf = '';
      client.on('data', (chunk) => {
        buf += chunk.toString();
      });
      client.on('close', () => done(buf));
      client.on('error', () => done(buf));
    });

  test('a host outside the allowlist gets 403, is counted, and is logged as allowed:false', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mikro-proxy-'));
    roots.push(root);
    const logPath = join(root, 'runs', 'egress.jsonl');
    const proxy = await startEgressProxy({ socketPath: join(root, 'e.sock'), logPath, runId: 'test-run' });
    const answer = await ask(proxy.socketPath, 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
    await proxy.close();
    expect(answer.split('\r\n')[0]).toBe('HTTP/1.1 403 Forbidden');
    expect(proxy.counts()).toEqual({ allowed: 0, denied: 1 });
    const logged = JSON.parse(readFileSync(logPath, 'utf8').trim());
    expect({ host: logged.host, port: logged.port, allowed: logged.allowed, runId: logged.runId }).toEqual({
      host: 'example.com',
      port: 443,
      allowed: false,
      runId: 'test-run',
    });
  });

  test('a non-CONNECT request is refused too, and still named in the ledger', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mikro-proxy-'));
    roots.push(root);
    const logPath = join(root, 'runs', 'egress.jsonl');
    const proxy = await startEgressProxy({ socketPath: join(root, 'e.sock'), logPath, runId: 'test-run' });
    const answer = await ask(proxy.socketPath, 'GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n');
    await proxy.close();
    expect(answer.split('\r\n')[0]).toBe('HTTP/1.1 403 Forbidden');
    expect(JSON.parse(readFileSync(logPath, 'utf8').trim()).host).toBe('example.com');
  });

  test('a socket it cannot bind fails closed with the typed cause', async () => {
    let failure = '';
    try {
      const leaked = await startEgressProxy({
        socketPath: '/nonexistent-boundary-root/e.sock',
        logPath: join(tmpdir(), 'mikro-boundary-test.jsonl'),
        runId: 'test-run',
      });
      await leaked.close();
    } catch (error) {
      failure = error instanceof BoundaryError ? error.failure : 'not-a-boundary-error';
    }
    expect(failure).toBe('socket-unavailable');
  });
});

describe('probe reporting', () => {
  test('the table marks a failed expectation and keeps observed beside expected', () => {
    const table = probeTable([
      { probe: 'write-to-repo', arm: 'boundary', expected: 'EROFS', observed: 'exit 2', ok: true },
      { probe: 'egress-denied', arm: 'control', expected: '403', observed: '200', ok: false },
    ]);
    expect(table).toContain('| write-to-repo | boundary | EROFS | exit 2 | ✔ |');
    expect(table).toContain('| egress-denied | control | 403 | 200 | ✖ |');
  });

  test('the evidence file gets its preamble once and is appended to afterwards', () => {
    const root = mkdtempSync(join(tmpdir(), 'mikro-evidence-'));
    const path = join(root, 'EVIDENCE-boundary.md');
    const rows = [{ probe: 'p', arm: 'boundary' as const, expected: 'e', observed: 'o', ok: true }];
    appendBoundaryEvidence(path, rows, 'first');
    appendBoundaryEvidence(path, rows, 'second');
    const text = readFileSync(path, 'utf8');
    expect(text.split('# mikro execution boundary — evidence').length).toBe(2);
    expect(text).toContain('— first');
    expect(text).toContain('— second');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('sandboxSettings', () => {
  test('copies the providers block and the model selection, and nothing else', () => {
    const copied = sandboxSettings({
      'model.provider': 'deepseek-api',
      'model.model': 'deepseek-flash',
      providers: { 'deepseek-api': { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
      telemetry: { token: 'secret' },
    });
    expect(Object.keys(copied).sort()).toEqual(['model.model', 'model.provider', 'providers']);
  });

  test('a host file with no providers still yields a valid, empty providers block', () => {
    expect(sandboxSettings({})).toEqual({ providers: {} });
  });
});

describe('isBoundaryMode', () => {
  test('accepts exactly the two arms', () => {
    expect(isBoundaryMode('none')).toBe(true);
    expect(isBoundaryMode('bwrap')).toBe(true);
    expect(isBoundaryMode('docker')).toBe(false);
    expect(isBoundaryMode('')).toBe(false);
  });
});

const BWRAP = Bun.which('bwrap');
describe.skipIf(!BWRAP)('live boundary (skipped when bwrap is absent on this host)', () => {
  test('a write into a read-only bind is refused and leaves nothing behind', () => {
    const root = mkdtempSync(join(tmpdir(), 'mikro-live-'));
    const target = join(root, 'written');
    const proc = Bun.spawnSync(
      [
        'bwrap',
        '--unshare-all',
        '--die-with-parent',
        '--ro-bind',
        '/usr',
        '/usr',
        '--ro-bind',
        '/bin',
        '/bin',
        '--ro-bind',
        '/lib',
        '/lib',
        '--ro-bind',
        '/lib64',
        '/lib64',
        '--ro-bind',
        root,
        root,
        '--',
        '/bin/sh',
        '-c',
        `echo x > ${shellQuote(target)}`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    expect(proc.exitCode).not.toBe(0);
    expect(existsSync(target)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});
