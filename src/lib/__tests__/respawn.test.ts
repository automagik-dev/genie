import { describe, expect, test } from 'bun:test';
import { isCompiledBunStandalone, respawnInvocation, respawnShellCommand } from '../respawn.js';

describe('isCompiledBunStandalone', () => {
  test('detects bunfs virtual entry path', () => {
    expect(isCompiledBunStandalone('/$bunfs/root/genie')).toBe(true);
    expect(isCompiledBunStandalone('/$bunfs/root/sub/dir/entry.js')).toBe(true);
  });

  test('rejects host filesystem paths', () => {
    expect(isCompiledBunStandalone('/home/user/.genie/dist/genie.js')).toBe(false);
    expect(isCompiledBunStandalone('/usr/local/bin/genie')).toBe(false);
    expect(isCompiledBunStandalone('src/genie.ts')).toBe(false);
  });

  test('treats undefined / empty as not compiled', () => {
    expect(isCompiledBunStandalone(undefined)).toBe(false);
    expect(isCompiledBunStandalone('')).toBe(false);
  });
});

describe('respawnInvocation', () => {
  test('compiled binary: invokes execPath alone (no bunfs argv leak)', () => {
    const result = respawnInvocation(['serve', '--foreground'], {
      execPath: '/home/u/.genie/bin/genie',
      argv1: '/$bunfs/root/genie',
    });
    expect(result.command).toBe('/home/u/.genie/bin/genie');
    expect(result.args).toEqual(['serve', '--foreground']);
  });

  test('dev mode (bun src/genie.ts): passes entry as first arg', () => {
    const result = respawnInvocation(['spawn', 'reviewer'], {
      execPath: '/usr/local/bin/bun',
      argv1: '/repo/src/genie.ts',
    });
    expect(result.command).toBe('/usr/local/bin/bun');
    expect(result.args).toEqual(['/repo/src/genie.ts', 'spawn', 'reviewer']);
  });

  test('dist mode (bun dist/genie.js): passes entry as first arg', () => {
    const result = respawnInvocation(['agent', 'list'], {
      execPath: '/opt/bun/bin/bun',
      argv1: '/repo/dist/genie.js',
    });
    expect(result.command).toBe('/opt/bun/bin/bun');
    expect(result.args).toEqual(['/repo/dist/genie.js', 'agent', 'list']);
  });

  test('falls back to PATH lookup when argv1 missing', () => {
    const result = respawnInvocation(['serve'], { execPath: '/usr/local/bin/bun', argv1: undefined });
    expect(result.command).toBe('genie');
    expect(result.args).toEqual(['serve']);
  });

  test('no extra args produces a bare invocation', () => {
    const result = respawnInvocation([], {
      execPath: '/home/u/.genie/bin/genie',
      argv1: '/$bunfs/root/genie',
    });
    expect(result.command).toBe('/home/u/.genie/bin/genie');
    expect(result.args).toEqual([]);
  });
});

describe('respawnShellCommand', () => {
  test('compiled binary emits only the binary path — no bunfs literal', () => {
    const cmd = respawnShellCommand([], {
      execPath: '/home/u/.genie/bin/genie',
      argv1: '/$bunfs/root/genie',
    });
    expect(cmd).toBe('/home/u/.genie/bin/genie');
    expect(cmd).not.toContain('bunfs');
    expect(cmd).not.toContain('$');
  });

  test('dev mode quotes the entry path safely', () => {
    const cmd = respawnShellCommand(['serve', '--foreground'], {
      execPath: '/usr/local/bin/bun',
      argv1: '/repo/src/genie.ts',
    });
    expect(cmd).toBe('/usr/local/bin/bun /repo/src/genie.ts serve --foreground');
  });

  test('escapes spaces and special chars', () => {
    const cmd = respawnShellCommand(['hello world'], {
      execPath: '/path with spaces/bun',
      argv1: '/repo/dist/genie.js',
    });
    expect(cmd).toBe(`'/path with spaces/bun' /repo/dist/genie.js 'hello world'`);
  });

  test('escapes embedded single quotes', () => {
    const cmd = respawnShellCommand([`it's`], {
      execPath: '/bin/bun',
      argv1: '/$bunfs/root/genie',
    });
    expect(cmd).toBe(`/bin/bun 'it'"'"'s'`);
  });
});
