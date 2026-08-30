/**
 * Tests for the skills.sh channel (`src/lib/skills-installer.ts`).
 *
 * The pinned CLI is never actually reached: every test injects a fake spawner,
 * except one end-to-end shim test that puts an executable `npx` on PATH and
 * proves the production argv survives the real bounded runner. Nothing here
 * touches the operator's real HOME or GENIE_HOME.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandRunner } from './runtime-integrations.js';
import {
  KNOWN_AGENT_SKILL_HOMES,
  SKILLS_CLI_VERSION,
  type SkillsInstallRecord,
  buildSkillsAddArgv,
  existingAgentSkillHomes,
  inventoryFromSkillsDir,
  isSafeSkillName,
  preflightNode,
  readSkillsInstallRecord,
  releaseTag,
  runSkillsChannelConvergence,
  runSkillsInstall,
  skillsInstallRecordPath,
  skillsInstallRemedy,
  writeSkillsInstallRecord,
} from './skills-installer.js';

const VERSION_UNDER_TEST = '5.260830.16';

let root: string;
let home: string;
let genieHome: string;

function fixtureSkillsTree(names: string[]): string {
  const skillsRoot = join(genieHome, 'skills');
  for (const name of names) {
    mkdirSync(join(skillsRoot, name), { recursive: true });
    writeFileSync(join(skillsRoot, name, 'SKILL.md'), `# ${name}\n`, 'utf8');
  }
  return skillsRoot;
}

function okRunner(record: { argv: string[][] }): CommandRunner {
  return (command, args) => {
    record.argv.push([command, ...args]);
    return { exitCode: 0, stdout: 'installed\n', stderr: '' };
  };
}

const alwaysFound = (name: string) => `/usr/bin/${name}`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'genie-skills-installer-'));
  home = join(root, 'home');
  genieHome = join(home, '.genie');
  mkdirSync(genieHome, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('pinned argv', () => {
  test('is exactly the production command line — no extra -y, --all implies it', () => {
    expect(buildSkillsAddArgv({ version: VERSION_UNDER_TEST })).toEqual([
      'npx',
      '-y',
      'skills@1.5.23',
      'add',
      'automagik-dev/genie@v5.260830.16',
      '--all',
      '--copy',
      '-g',
    ]);
  });

  test('the CLI version is pinned to the verified release (wish decision 1)', () => {
    expect(SKILLS_CLI_VERSION).toBe('1.5.23');
  });

  test('a version that already carries the v prefix is not double-prefixed', () => {
    expect(releaseTag('v5.260830.16')).toBe('v5.260830.16');
    expect(releaseTag('5.260830.16')).toBe('v5.260830.16');
    expect(buildSkillsAddArgv({ version: 'v9.9.9' })[4]).toBe('automagik-dev/genie@v9.9.9');
  });

  test('the remedy line is the argv verbatim', () => {
    expect(skillsInstallRemedy(VERSION_UNDER_TEST)).toBe(
      'Run: npx -y skills@1.5.23 add automagik-dev/genie@v5.260830.16 --all --copy -g',
    );
  });
});

describe('preflightNode', () => {
  test('passes when node and npx both resolve', () => {
    expect(preflightNode({ which: alwaysFound })).toEqual({ ok: true });
  });

  test('names every missing executable', () => {
    const missingNpx = preflightNode({ which: (name) => (name === 'npx' ? null : '/usr/bin/node') });
    expect(missingNpx.ok).toBe(false);
    expect(missingNpx.ok === false && missingNpx.reason).toContain('npx');

    const missingBoth = preflightNode({ which: () => null });
    expect(missingBoth.ok === false && missingBoth.reason).toContain('node and npx');
  });
});

describe('inventoryFromSkillsDir', () => {
  test('names top-level directories that carry a SKILL.md, sorted', () => {
    const skillsRoot = fixtureSkillsTree(['work', 'wish', 'code-quality']);
    mkdirSync(join(skillsRoot, 'no-skill-md'), { recursive: true });
    writeFileSync(join(skillsRoot, 'README.md'), '# not a skill\n', 'utf8');
    // A nested SKILL.md never promotes its parent into the inventory.
    mkdirSync(join(skillsRoot, 'no-skill-md', 'nested'), { recursive: true });
    writeFileSync(join(skillsRoot, 'no-skill-md', 'nested', 'SKILL.md'), '# nested\n', 'utf8');

    expect(inventoryFromSkillsDir(skillsRoot)).toEqual(['code-quality', 'wish', 'work']);
  });

  test('an absent tree is an empty inventory, never a throw', () => {
    expect(inventoryFromSkillsDir(join(root, 'nope'))).toEqual([]);
  });
});

describe('agent skill homes', () => {
  test('the known table covers codex, claude and cursor at minimum', () => {
    const agents = KNOWN_AGENT_SKILL_HOMES.map((entry) => entry.agent);
    expect(agents).toContain('codex');
    expect(agents).toContain('claude');
    expect(agents).toContain('cursor');
  });

  test('only homes that exist right now are reported', () => {
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    mkdirSync(join(home, '.codex', 'skills'), { recursive: true });
    // ~/.cursor is deliberately absent.
    expect(existingAgentSkillHomes(home).map((entry) => entry.agent)).toEqual(['claude', 'codex']);
  });
});

describe('runSkillsInstall', () => {
  test('records the tag, CLI version, inventory and existing agent dirs after a zero exit', () => {
    fixtureSkillsTree(['wish', 'work']);
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    mkdirSync(join(home, '.codex', 'skills'), { recursive: true });
    const calls = { argv: [] as string[][] };

    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: okRunner(calls),
      now: () => new Date('2026-08-30T12:00:00.000Z'),
    });

    expect(calls.argv).toEqual([
      ['npx', '-y', 'skills@1.5.23', 'add', 'automagik-dev/genie@v5.260830.16', '--all', '--copy', '-g'],
    ]);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok === true && outcome.record).toEqual({
      ref: 'v5.260830.16',
      cliVersion: '1.5.23',
      inventory: ['wish', 'work'],
      agentDirs: [join(home, '.claude', 'skills'), join(home, '.codex', 'skills')],
      installedAt: '2026-08-30T12:00:00.000Z',
    });

    const onDisk = JSON.parse(readFileSync(skillsInstallRecordPath(genieHome), 'utf8')) as SkillsInstallRecord;
    expect(onDisk).toEqual(outcome.ok === true ? outcome.record : ({} as SkillsInstallRecord));
    expect(statSync(skillsInstallRecordPath(genieHome)).mode & 0o777).toBe(0o600);
  });

  test('a non-zero exit writes NO record and returns the reason plus the remedy', () => {
    fixtureSkillsTree(['wish']);
    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: () => ({ exitCode: 7, stdout: '', stderr: 'ENOTFOUND registry.npmjs.org\n' }),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('skills CLI exited 7: ENOTFOUND registry.npmjs.org');
    expect(outcome.ok === false && outcome.remedy).toBe(
      'Run: npx -y skills@1.5.23 add automagik-dev/genie@v5.260830.16 --all --copy -g',
    );
    expect(existsSync(skillsInstallRecordPath(genieHome))).toBe(false);
  });

  test("stderr's last line wins over stdout when both streams are populated", () => {
    fixtureSkillsTree(['wish']);
    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: () => ({
        exitCode: 9,
        stdout: 'resolving automagik-dev/genie\ndone in 4.1s\n',
        stderr: 'npm ERR! code E404\nnpm ERR! 404 Not Found - GET .../skills\n',
      }),
    });
    expect(outcome.ok === false && outcome.reason).toBe('skills CLI exited 9: npm ERR! 404 Not Found - GET .../skills');
  });

  test('stdout is the fallback only when stderr is silent', () => {
    fixtureSkillsTree(['wish']);
    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: () => ({ exitCode: 3, stdout: 'first line\nlast stdout line\n', stderr: '   \n' }),
    });
    expect(outcome.ok === false && outcome.reason).toBe('skills CLI exited 3: last stdout line');
  });

  test('a timeout is reported as a timeout and still writes no record', () => {
    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: () => ({ exitCode: 1, stdout: '', stderr: '', timedOut: true }),
    });
    expect(outcome.ok === false && outcome.reason).toContain('timed out');
    expect(existsSync(skillsInstallRecordPath(genieHome))).toBe(false);
  });

  test('a zero exit that delivered NO skills is a failure, not an empty-inventory success', () => {
    // The skills tree is deliberately absent: a recorded empty inventory would
    // make uninstall a silent no-op and doctor's freshness check meaningless.
    const calls = { argv: [] as string[][] };
    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: okRunner(calls),
    });

    expect(calls.argv).toHaveLength(1); // the CLI DID run; only the result is rejected
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe(`no skills found under ${join(genieHome, 'skills')}`);
    expect(outcome.ok === false && outcome.remedy).toBe(skillsInstallRemedy(VERSION_UNDER_TEST));
    expect(existsSync(skillsInstallRecordPath(genieHome))).toBe(false);
  });

  test('an empty inventory surfaces through the convergence helper as a failure with exit 1', () => {
    const savedExitCode = process.exitCode;
    const lines: string[] = [];
    try {
      const result = runSkillsChannelConvergence({
        selection: 'auto',
        version: VERSION_UNDER_TEST,
        genieHome,
        home,
        which: alwaysFound,
        spawn: okRunner({ argv: [] }),
        log: (line) => lines.push(line),
      });
      expect(result).toEqual({ status: 'failed', reason: `no skills found under ${join(genieHome, 'skills')}` });
      expect(lines[0]).toStartWith(`Skills install failed: no skills found under ${join(genieHome, 'skills')}.`);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  test('a failed preflight never spawns anything', () => {
    let spawned = 0;
    const spawn: CommandRunner = () => {
      spawned += 1;
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: () => null,
      spawn,
    });
    expect(spawned).toBe(0);
    expect(outcome.ok).toBe(false);
    expect(existsSync(skillsInstallRecordPath(genieHome))).toBe(false);
  });
});

describe('install record', () => {
  test('round-trips', () => {
    const record: SkillsInstallRecord = {
      ref: 'v5.260830.16',
      cliVersion: SKILLS_CLI_VERSION,
      inventory: ['wish'],
      agentDirs: [join(home, '.claude', 'skills')],
      installedAt: '2026-08-30T12:00:00.000Z',
    };
    writeSkillsInstallRecord(genieHome, record);
    expect(readSkillsInstallRecord(genieHome)).toEqual(record);
  });

  test('an absent, malformed, or traversal-carrying record reads as null', () => {
    expect(readSkillsInstallRecord(genieHome)).toBeNull();

    writeFileSync(skillsInstallRecordPath(genieHome), '{ not json', 'utf8');
    expect(readSkillsInstallRecord(genieHome)).toBeNull();

    writeFileSync(
      skillsInstallRecordPath(genieHome),
      JSON.stringify({
        ref: 'v1',
        cliVersion: '1.5.23',
        inventory: ['../../.ssh'],
        agentDirs: [join(home, '.claude', 'skills')],
        installedAt: 'now',
      }),
      'utf8',
    );
    expect(readSkillsInstallRecord(genieHome)).toBeNull();

    writeFileSync(
      skillsInstallRecordPath(genieHome),
      JSON.stringify({
        ref: 'v1',
        cliVersion: '1.5.23',
        inventory: ['wish'],
        agentDirs: ['relative/skills'],
        installedAt: 'now',
      }),
      'utf8',
    );
    expect(readSkillsInstallRecord(genieHome)).toBeNull();
  });

  test('a symlinked record is rejected like a non-physical consent file', () => {
    const decoy = join(root, 'decoy.json');
    writeFileSync(
      decoy,
      JSON.stringify({
        ref: 'v1',
        cliVersion: '1.5.23',
        inventory: ['wish'],
        agentDirs: [join(home, '.claude', 'skills')],
        installedAt: 'now',
      }),
      'utf8',
    );
    symlinkSync(decoy, skillsInstallRecordPath(genieHome));
    expect(readSkillsInstallRecord(genieHome)).toBeNull();
  });

  test('an agentDir carrying a .. segment reads as null even though it is absolute', () => {
    writeFileSync(
      skillsInstallRecordPath(genieHome),
      JSON.stringify({
        ref: 'v1',
        cliVersion: '1.5.23',
        inventory: ['wish'],
        agentDirs: [`${home}/.claude/../../../etc/skills`],
        installedAt: 'now',
      }),
      'utf8',
    );
    expect(readSkillsInstallRecord(genieHome)).toBeNull();
  });

  test('a throwing publish leaves no staging file behind', () => {
    const record: SkillsInstallRecord = {
      ref: 'v5.260830.16',
      cliVersion: SKILLS_CLI_VERSION,
      inventory: ['wish'],
      agentDirs: [join(home, '.claude', 'skills')],
      installedAt: '2026-08-30T12:00:00.000Z',
    };
    // A DIRECTORY at the target makes renameSync throw (EISDIR/ENOTEMPTY) after
    // the staging file already exists — the exact leak the old code had.
    mkdirSync(skillsInstallRecordPath(genieHome), { recursive: true });
    writeFileSync(join(skillsInstallRecordPath(genieHome), 'occupant'), 'x', 'utf8');

    expect(() => writeSkillsInstallRecord(genieHome, record)).toThrow();
    expect(readdirSync(genieHome).filter((name) => name.includes('.staging-'))).toEqual([]);
  });

  test('the record is deliberately clobbering: a second write replaces the first', () => {
    const base: SkillsInstallRecord = {
      ref: 'v5.260830.16',
      cliVersion: SKILLS_CLI_VERSION,
      inventory: ['wish'],
      agentDirs: [join(home, '.claude', 'skills')],
      installedAt: '2026-08-30T12:00:00.000Z',
    };
    writeSkillsInstallRecord(genieHome, base);
    const next: SkillsInstallRecord = { ...base, ref: 'v5.260830.17', inventory: ['wish', 'work'] };
    writeSkillsInstallRecord(genieHome, next);
    expect(readSkillsInstallRecord(genieHome)).toEqual(next);
    expect(readdirSync(genieHome).filter((name) => name.includes('.staging-'))).toEqual([]);
  });
});

describe('isSafeSkillName', () => {
  test('is the one traversal guard uninstall shares with the installer', () => {
    expect(isSafeSkillName('wish')).toBe(true);
    expect(isSafeSkillName('code-quality')).toBe(true);
    expect(isSafeSkillName('a.b_c-1')).toBe(true);
    for (const bad of ['..', '.', '../x', 'a/b', '.hidden', '', '/abs']) {
      expect(isSafeSkillName(bad)).toBe(false);
    }
  });
});

describe('runSkillsChannelConvergence', () => {
  let previousExitCode: number | string | undefined;

  beforeEach(() => {
    previousExitCode = process.exitCode ?? undefined;
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
  });

  test('consent none skips the channel entirely', () => {
    let installs = 0;
    const lines: string[] = [];
    const result = runSkillsChannelConvergence({
      selection: 'none',
      version: VERSION_UNDER_TEST,
      genieHome,
      log: (line) => lines.push(line),
      install: () => {
        installs += 1;
        return { ok: false, reason: 'must not run', remedy: 'must not run' };
      },
    });

    expect(installs).toBe(0);
    expect(result).toEqual({ status: 'skipped', reason: 'consent: none' });
    expect(lines).toEqual(['skills: skipped (consent: none)']);
    expect(process.exitCode).toBe(previousExitCode as number);
  });

  test('every non-none selection installs with --all (wish decision 3)', () => {
    fixtureSkillsTree(['wish']);
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    for (const selection of ['auto', 'all', 'claude', 'codex'] as const) {
      const calls = { argv: [] as string[][] };
      const lines: string[] = [];
      const result = runSkillsChannelConvergence({
        selection,
        version: VERSION_UNDER_TEST,
        genieHome,
        home,
        which: alwaysFound,
        spawn: okRunner(calls),
        log: (line) => lines.push(line),
      });
      expect(calls.argv[0]).toContain('--all');
      expect(result.status).toBe('installed');
      expect(lines[0]).toBe('skills: installed 1 skill(s) from automagik-dev/genie@v5.260830.16 into 1 agent dir(s)');
    }
  });

  test('failure prints the exact remedy and sets exit code 1 without throwing', () => {
    const lines: string[] = [];
    const result = runSkillsChannelConvergence({
      selection: 'auto',
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: () => ({ exitCode: 1, stdout: '', stderr: 'boom\n' }),
      log: (line) => lines.push(line),
    });

    expect(result).toEqual({ status: 'failed', reason: 'skills CLI exited 1: boom' });
    expect(lines).toEqual([
      'Skills install failed: skills CLI exited 1: boom. Run: npx -y skills@1.5.23 add automagik-dev/genie@v5.260830.16 --all --copy -g',
    ]);
    expect(process.exitCode).toBe(1);
    expect(existsSync(skillsInstallRecordPath(genieHome))).toBe(false);
  });
});

describe('default bounded runner (fake npx shim on PATH)', () => {
  test('the production argv reaches the spawned process verbatim', () => {
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const argvLog = join(root, 'npx-argv.txt');
    for (const name of ['node', 'npx']) {
      const shim = join(bin, name);
      writeFileSync(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvLog}"\nexit 0\n`, 'utf8');
      chmodSync(shim, 0o755);
    }
    fixtureSkillsTree(['wish']);

    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    try {
      const outcome = runSkillsInstall({ version: VERSION_UNDER_TEST, genieHome, home });
      expect(outcome.ok).toBe(true);
    } finally {
      process.env.PATH = previousPath;
    }

    expect(readFileSync(argvLog, 'utf8').trimEnd().split('\n')).toEqual([
      '-y',
      'skills@1.5.23',
      'add',
      'automagik-dev/genie@v5.260830.16',
      '--all',
      '--copy',
      '-g',
    ]);
  });
});
