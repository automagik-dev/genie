import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GENIE = join(import.meta.dir, '..', '..', 'src', 'genie.ts');
const RETIRED =
  'Error: genie mcp has been retired; use `genie task` and `genie board`, or roll back to a pre-A7 signed release.\n';

let base: string;
let genieHome: string;

function initRepo(name: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

function run(args: string[], cwd: string, stdin?: string) {
  const result = Bun.spawnSync([process.execPath, GENIE, ...args], {
    cwd,
    env: { ...process.env, GENIE_HOME: genieHome, NO_COLOR: '1' },
    stdin: stdin === undefined ? undefined : Buffer.from(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'genie-mcp-retirement-'));
  genieHome = join(base, 'genie-home');
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('project MCP route retirement', () => {
  test('init removes only a single complete owned Codex block and never creates a replacement route', () => {
    const repo = initRepo('repo');
    const config = join(repo, '.codex', 'config.toml');
    mkdirSync(join(repo, '.codex'), { recursive: true });
    writeFileSync(
      config,
      'model = "keep"\n# BEGIN GENIE MCP FALLBACK\n[mcp_servers.genie]\ncommand = "/old/genie"\nargs = ["mcp"]\n# END GENIE MCP FALLBACK\n',
    );

    expect(run(['init'], repo).code).toBe(0);
    expect(readFileSync(config, 'utf8')).toBe('model = "keep"\n');
    expect(existsSync(join(repo, '.mcp.json'))).toBe(false);
  });

  test('unowned configuration is byte-stable and every repo gets the same fail-closed command', () => {
    for (const name of ['alpha', 'bravo']) {
      const repo = initRepo(name);
      const json = join(repo, '.mcp.json');
      const original = '{"mcpServers":{"personal":{"command":"mine"}}}\n';
      writeFileSync(json, original);

      expect(run(['init'], repo).code).toBe(0);
      expect(readFileSync(json, 'utf8')).toBe(original);

      const mcp = run(['mcp'], repo, '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
      expect(mcp).toEqual({ code: 1, stdout: '', stderr: RETIRED });
    }
  });
});
