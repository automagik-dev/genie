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
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { CommandRunner } from './runtime-integrations.js';
import {
  KNOWN_AGENT_SKILL_HOMES,
  SKILLS_CLI_VERSION,
  type SkillsInstallRecord,
  buildSkillsAddArgv,
  computeSkillDirDigest,
  existingAgentSkillHomes,
  inventoryFromSkillsDir,
  isSafeSkillName,
  preflightNode,
  readSkillsInstallRecord,
  releaseTag,
  runSkillsChannelConvergence,
  runSkillsInstall,
  scanSkillsHomes,
  selectSkillsHomesWrittenBy,
  skillsInstallRecordPath,
  skillsInstallRemedy,
  skillsSourceRoot,
  snapshotSkillsCollisions,
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
  test('is exactly the production command line — local source, no extra -y', () => {
    expect(buildSkillsAddArgv({ sourceRoot: '/home/u/.genie/skills' })).toEqual([
      'npx',
      '-y',
      'skills@1.5.23',
      'add',
      '/home/u/.genie/skills',
      '--all',
      '--copy',
      '-g',
    ]);
  });

  test('the CLI version is pinned to the verified release (wish decision 1)', () => {
    expect(SKILLS_CLI_VERSION).toBe('1.5.23');
  });

  test('the source root is the delivered tree under GENIE_HOME, never a GitHub ref', () => {
    // skills@1.5.23 IGNORES `@<ref>` and serves the default branch, so a GitHub
    // source is not a pin at all; the delivered tree is (wish B decision 1).
    expect(skillsSourceRoot('/home/u/.genie')).toBe('/home/u/.genie/skills');
    const argv = buildSkillsAddArgv({ sourceRoot: skillsSourceRoot('/home/u/.genie') });
    expect(argv.join(' ')).not.toContain('automagik-dev');
    expect(argv[4]).toBe('/home/u/.genie/skills');
  });

  test('a version that already carries the v prefix is not double-prefixed', () => {
    expect(releaseTag('v5.260830.16')).toBe('v5.260830.16');
    expect(releaseTag('5.260830.16')).toBe('v5.260830.16');
  });

  test('the remedy line is the argv verbatim', () => {
    expect(skillsInstallRemedy('/home/u/.genie/skills')).toBe(
      'Run: npx -y skills@1.5.23 add /home/u/.genie/skills --all --copy -g',
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
  test('the known table covers claude and the shared agents home at minimum', () => {
    const agents = KNOWN_AGENT_SKILL_HOMES.map((entry) => entry.agent);
    expect(agents).toContain('claude');
    expect(agents).toContain('agents');
  });

  test('the table lists no `.codex/skills` or `.cursor/skills` home', () => {
    // Verified against skills.sh 1.5.23 `--all --copy -g`: it creates neither
    // directory. Codex reads `~/.agents/skills`, which the `agents` row covers.
    // Listing them made doctor emit a permanent false `skills: codex 0/n` warn.
    const segments = KNOWN_AGENT_SKILL_HOMES.map((entry) => entry.segments.join('/'));
    expect(segments).not.toContain('.codex/skills');
    expect(segments).not.toContain('.cursor/skills');
    expect(segments).toContain('.agents/skills');
  });

  test('only homes that exist right now are reported', () => {
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
    // ~/.config/goose is deliberately absent.
    expect(existingAgentSkillHomes(home).map((entry) => entry.agent)).toEqual(['claude', 'agents']);
  });
});

describe('runSkillsInstall', () => {
  test('records the tag, CLI version, inventory and existing agent dirs after a zero exit', () => {
    fixtureSkillsTree(['wish', 'work']);
    // The pinned CLI copies every skill into each detected agent home; the fake
    // spawner does not, so the fixture seeds the post-install state itself.
    const claudeSkills = join(home, '.claude', 'skills');
    const agentsSkills = join(home, '.agents', 'skills');
    const expectedDigests: Record<string, string> = {};
    for (const parent of [claudeSkills, agentsSkills]) {
      for (const name of ['wish', 'work']) {
        mkdirSync(join(parent, name), { recursive: true });
        writeFileSync(join(parent, name, 'SKILL.md'), `# ${name}\n`, 'utf8');
        const digest = computeSkillDirDigest(join(parent, name));
        if (digest === null) throw new Error(`fixture skill dir was not digestable: ${join(parent, name)}`);
        expectedDigests[join(parent, name)] = digest;
      }
    }
    // A bare `~/.codex` is NOT a skill home: skills.sh creates no `.codex/skills`.
    mkdirSync(join(home, '.codex'), { recursive: true });
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
      ['npx', '-y', 'skills@1.5.23', 'add', join(genieHome, 'skills'), '--all', '--copy', '-g'],
    ]);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok === true && outcome.record).toEqual({
      ref: 'v5.260830.16',
      source: `local:${join(genieHome, 'skills')}`,
      cliVersion: '1.5.23',
      inventory: ['wish', 'work'],
      agentDirs: [claudeSkills, agentsSkills],
      dirDigests: expectedDigests,
      installedAt: '2026-08-30T12:00:00.000Z',
    });

    // C-R2: the recorded set is exactly the inventory of the tree the argv
    // named — the source, the record and the uninstall manifest are one thing.
    const argvSource = calls.argv[0]?.[4] as string;
    expect(outcome.ok === true && outcome.record.inventory).toEqual(inventoryFromSkillsDir(argvSource));
    expect(outcome.ok === true && outcome.record.source).toBe(`local:${argvSource}`);

    const onDisk = JSON.parse(readFileSync(skillsInstallRecordPath(genieHome), 'utf8')) as SkillsInstallRecord;
    expect(onDisk).toEqual(outcome.ok === true ? outcome.record : ({} as SkillsInstallRecord));
    expect(statSync(skillsInstallRecordPath(genieHome)).mode & 0o777).toBe(0o600);
  });

  test('records a content digest per installed agent dir, and only for dirs that exist', () => {
    fixtureSkillsTree(['wish']);
    const claudeSkills = join(home, '.claude', 'skills');
    mkdirSync(join(claudeSkills, 'wish'), { recursive: true });
    writeFileSync(join(claudeSkills, 'wish', 'SKILL.md'), '# wish\n', 'utf8');
    // A detected agent home the CLI did not populate contributes no digest:
    // uninstall treats that recorded combination as unverified and preserves it.
    mkdirSync(join(home, '.agents', 'skills'), { recursive: true });

    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: okRunner({ argv: [] }),
    });

    const wishDir = join(claudeSkills, 'wish');
    const digest = computeSkillDirDigest(wishDir);
    if (digest === null) throw new Error('fixture skill dir was not digestable');
    expect(outcome.ok === true && outcome.record.dirDigests).toEqual({ [wishDir]: digest });
    // One edited byte changes the digest, so a user-modified directory can
    // never reproduce the recorded value.
    writeFileSync(join(wishDir, 'SKILL.md'), '# my precious edit\n', 'utf8');
    expect(computeSkillDirDigest(wishDir)).not.toBe(digest);
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
      `Run: npx -y skills@1.5.23 add ${join(genieHome, 'skills')} --all --copy -g`,
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
    expect(outcome.ok === false && outcome.remedy).toBe(skillsInstallRemedy(join(genieHome, 'skills')));
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

describe('discovery scan', () => {
  /**
   * One fake `$HOME` carrying every case the record has to get right. The
   * install window is simulated rather than waited out: fixtures cannot be
   * created at two different real times, so the home this install "wrote" is
   * forward-dated with `utimesSync` and the window opens between the two.
   */
  function fakeHomeMatrix(): { since: number; source: string; expectedScan: string[]; written: string } {
    const source = fixtureSkillsTree(['wish', 'work']);
    const baseline = Date.now();
    const since = baseline + 60_000;
    const future = new Date(baseline + 3_600_000);

    // 1. A matching home created INSIDE the window.
    const written = join(home, '.claude', 'skills');
    mkdirSync(join(written, 'wish'), { recursive: true });
    writeFileSync(join(written, 'wish', 'SKILL.md'), '# wish\n', 'utf8');
    utimesSync(join(written, 'wish', 'SKILL.md'), future, future);
    utimesSync(written, future, future);

    // 2. A matching home created BEFORE it (left at its real, pre-window stamp).
    const stale = join(home, '.agents', 'skills');
    mkdirSync(join(stale, 'wish'), { recursive: true });
    writeFileSync(join(stale, 'wish', 'SKILL.md'), '# wish\n', 'utf8');

    // 3. A byte-differing home, freshly written: content decides, not timing.
    const foreign = join(home, '.foreign', 'skills');
    mkdirSync(join(foreign, 'wish'), { recursive: true });
    writeFileSync(join(foreign, 'wish', 'SKILL.md'), '# someone else\n', 'utf8');
    utimesSync(join(foreign, 'wish', 'SKILL.md'), future, future);
    utimesSync(foreign, future, future);

    // 4. A `node_modules` decoy: pruned, so it is never even visited.
    const decoy = join(home, 'proj', 'node_modules', 'pkg', 'skills');
    mkdirSync(join(decoy, 'wish'), { recursive: true });
    writeFileSync(join(decoy, 'wish', 'SKILL.md'), '# wish\n', 'utf8');

    // 5. A symlink pointing OUT of `$HOME`: never followed, never recorded.
    const outside = join(root, 'outside', 'skills');
    mkdirSync(join(outside, 'wish'), { recursive: true });
    writeFileSync(join(outside, 'wish', 'SKILL.md'), '# wish\n', 'utf8');
    mkdirSync(join(home, 'linked'), { recursive: true });
    symlinkSync(outside, join(home, 'linked', 'skills'));

    // 6. A depth-7 home: past the depth cap.
    const deep = join(home, 'a', 'b', 'c', 'd', 'e', 'f', 'skills');
    mkdirSync(join(deep, 'wish'), { recursive: true });
    writeFileSync(join(deep, 'wish', 'SKILL.md'), '# wish\n', 'utf8');

    return { since, source, expectedScan: [stale, written, foreign].sort(), written };
  }

  test('finds every physical skills home under $HOME, and only those', () => {
    const matrix = fakeHomeMatrix();
    const scan = scanSkillsHomes({ home, sourceRoot: matrix.source });

    expect(scan.status).toBe('ok');
    // The delivered source tree, the node_modules decoy, the out-of-$HOME
    // symlink and the depth-7 home are all absent by construction.
    expect(scan.dirs).toEqual(matrix.expectedScan);
    expect(scan.dirs).not.toContain(join(genieHome, 'skills'));
    expect(scan.dirs.some((dir) => dir.includes('node_modules'))).toBe(false);
    expect(scan.dirs.some((dir) => dir.includes('linked'))).toBe(false);
    expect(scan.dirs.some((dir) => dir.includes(`${sep}f${sep}`))).toBe(false);
  });

  test('keeps only byte-equal homes stamped inside the install window', () => {
    const matrix = fakeHomeMatrix();
    const scan = scanSkillsHomes({ home, sourceRoot: matrix.source });

    expect(
      selectSkillsHomesWrittenBy({
        dirs: scan.dirs,
        sourceRoot: matrix.source,
        probe: 'wish',
        since: matrix.since,
      }),
    ).toEqual([matrix.written]);
  });

  test('an exhausted entry cap or time budget reports capped and records nothing', () => {
    fakeHomeMatrix();
    const capped = scanSkillsHomes({ home, sourceRoot: join(genieHome, 'skills'), maxEntries: 1 });
    expect(capped.status).toBe('capped');
    expect(capped.dirs).toEqual([]);
    expect(capped.reason).toContain('entry cap');

    let ticks = 0;
    const timedOut = scanSkillsHomes({
      home,
      sourceRoot: join(genieHome, 'skills'),
      budgetMs: 5,
      // First call sets the deadline; every later call is past it.
      nowMs: () => (ticks++ === 0 ? 0 : 1_000),
    });
    expect(timedOut.status).toBe('capped');
    expect(timedOut.dirs).toEqual([]);
    expect(timedOut.reason).toContain('time budget');
  });

  test("genie's own state-backups tree is never scanned back in", () => {
    const source = fixtureSkillsTree(['wish']);
    // What the collision snapshot writes: a mirrored `.../skills/wish` under
    // the backup root, with a fresh mtime. Recording it would let uninstall
    // delete the backup the snapshot exists to protect.
    const mirrored = join(genieHome, 'state-backups', 'skills-collision-x', '.claude', 'skills');
    mkdirSync(join(mirrored, 'wish'), { recursive: true });
    writeFileSync(join(mirrored, 'wish', 'SKILL.md'), '# wish\n', 'utf8');

    const scan = scanSkillsHomes({ home, sourceRoot: source });
    expect(scan.status).toBe('ok');
    expect(scan.dirs).not.toContain(mirrored);
  });

  test('an unreadable directory is skipped, never a scan failure', () => {
    const source = fixtureSkillsTree(['wish']);
    const good = join(home, '.claude', 'skills');
    mkdirSync(good, { recursive: true });
    const locked = join(home, 'locked');
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o000);
    try {
      const scan = scanSkillsHomes({ home, sourceRoot: source });
      expect(scan.status).toBe('ok');
      expect(scan.dirs).toContain(good);
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});

describe('collision snapshot', () => {
  test('backs up a foreign same-named skill dir before the install can overwrite it', () => {
    const source = fixtureSkillsTree(['wish', 'work']);
    const claudeSkills = join(home, '.claude', 'skills');
    mkdirSync(join(claudeSkills, 'wish'), { recursive: true });
    writeFileSync(join(claudeSkills, 'wish', 'SKILL.md'), '# someone else entirely\n', 'utf8');
    writeFileSync(join(claudeSkills, 'wish', 'notes.md'), 'precious\n', 'utf8');
    // A byte-equal directory is ours, not a collision.
    mkdirSync(join(claudeSkills, 'work'), { recursive: true });
    writeFileSync(join(claudeSkills, 'work', 'SKILL.md'), '# work\n', 'utf8');

    const snapshot = snapshotSkillsCollisions({
      homes: [claudeSkills],
      inventory: ['wish', 'work'],
      sourceRoot: source,
      genieHome,
      home,
      now: () => new Date('2026-08-31T10:11:12.500Z'),
    });

    expect(snapshot.collisions).toEqual([{ dir: join(claudeSkills, 'wish'), skill: 'wish' }]);
    expect(snapshot.failures).toEqual([]);
    const backupRoot = join(genieHome, 'state-backups', 'skills-collision-2026-08-31T10-11-12-500Z');
    expect(snapshot.backupRoot).toBe(backupRoot);
    const mirrored = join(backupRoot, '.claude', 'skills', 'wish');
    expect(readFileSync(join(mirrored, 'SKILL.md'), 'utf8')).toBe('# someone else entirely\n');
    expect(readFileSync(join(mirrored, 'notes.md'), 'utf8')).toBe('precious\n');
    // The foreign directory is snapshotted, never moved: restoration is OUT.
    expect(existsSync(join(claudeSkills, 'wish', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(backupRoot, '.claude', 'skills', 'work'))).toBe(false);
  });

  test('an absent home, a byte-equal dir and a previously recorded dir collide with nothing', () => {
    const source = fixtureSkillsTree(['wish']);
    const absent = join(home, '.absent', 'skills');
    const equal = join(home, '.agents', 'skills');
    mkdirSync(join(equal, 'wish'), { recursive: true });
    writeFileSync(join(equal, 'wish', 'SKILL.md'), '# wish\n', 'utf8');
    // Genie provenance from a PREVIOUS release: same path, older content, but
    // the record's digest proves genie wrote it, so it is not foreign.
    const previousHome = join(home, '.goose', 'skills');
    mkdirSync(join(previousHome, 'wish'), { recursive: true });
    writeFileSync(join(previousHome, 'wish', 'SKILL.md'), '# wish (previous release)\n', 'utf8');
    const digest = computeSkillDirDigest(join(previousHome, 'wish'));
    if (digest === null) throw new Error('fixture skill dir was not digestable');

    const snapshot = snapshotSkillsCollisions({
      homes: [absent, equal, previousHome],
      inventory: ['wish'],
      sourceRoot: source,
      genieHome,
      home,
      previous: {
        ref: 'v5.260830.16',
        cliVersion: SKILLS_CLI_VERSION,
        inventory: ['wish'],
        agentDirs: [previousHome],
        dirDigests: { [join(previousHome, 'wish')]: digest },
        installedAt: '2026-08-30T12:00:00.000Z',
      },
    });

    expect(snapshot.collisions).toEqual([]);
    expect(snapshot.backupRoot).toBeNull();
    expect(existsSync(join(genieHome, 'state-backups'))).toBe(false);
  });

  test('a file or a symlink at a skill name is not a collision', () => {
    const source = fixtureSkillsTree(['wish']);
    const claudeSkills = join(home, '.claude', 'skills');
    mkdirSync(claudeSkills, { recursive: true });
    writeFileSync(join(claudeSkills, 'wish'), 'not a directory\n', 'utf8');
    const agentsSkills = join(home, '.agents', 'skills');
    mkdirSync(agentsSkills, { recursive: true });
    symlinkSync(join(root, 'elsewhere'), join(agentsSkills, 'wish'));

    const snapshot = snapshotSkillsCollisions({
      homes: [claudeSkills, agentsSkills],
      inventory: ['wish'],
      sourceRoot: source,
      genieHome,
      home,
    });
    expect(snapshot.collisions).toEqual([]);
    expect(snapshot.backupRoot).toBeNull();
  });
});

describe('computeSkillDirDigest', () => {
  test('is deterministic over sorted relative paths and file bytes, and content-sensitive', () => {
    const dir = join(root, 'skill');
    mkdirSync(join(dir, 'references'), { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '# x\n', 'utf8');
    writeFileSync(join(dir, 'zz-last.txt'), 'zz\n', 'utf8');
    writeFileSync(join(dir, 'references', 'a.md'), 'a\n', 'utf8');
    const digest = computeSkillDirDigest(dir);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);

    // Same bytes created in a different order must hash identically: the walk
    // sorts by relative path, not by readdir order.
    const copy = join(root, 'skill-copy');
    mkdirSync(join(copy, 'references'), { recursive: true });
    writeFileSync(join(copy, 'zz-last.txt'), 'zz\n', 'utf8');
    writeFileSync(join(copy, 'references', 'a.md'), 'a\n', 'utf8');
    writeFileSync(join(copy, 'SKILL.md'), '# x\n', 'utf8');
    expect(computeSkillDirDigest(copy)).toBe(digest);

    writeFileSync(join(copy, 'SKILL.md'), '# changed\n', 'utf8');
    expect(computeSkillDirDigest(copy)).not.toBe(digest);
  });

  test('hashes a symlink by its target path without following it; null for missing or non-dir roots', () => {
    const withLink = join(root, 'with-link');
    mkdirSync(withLink, { recursive: true });
    writeFileSync(join(withLink, 'SKILL.md'), '# x\n', 'utf8');
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, 'payload\n', 'utf8');
    symlinkSync(outside, join(withLink, 'payload-link'));
    expect(computeSkillDirDigest(withLink)).not.toBeNull();

    // Retargeting the link changes the digest even though neither target's
    // bytes nor the rest of the tree changed — links are hashed, not followed.
    const retargeted = join(root, 'retargeted');
    mkdirSync(retargeted, { recursive: true });
    writeFileSync(join(retargeted, 'SKILL.md'), '# x\n', 'utf8');
    symlinkSync(join(root, 'elsewhere.txt'), join(retargeted, 'payload-link'));
    expect(computeSkillDirDigest(retargeted)).not.toBe(computeSkillDirDigest(withLink));

    expect(computeSkillDirDigest(join(root, 'absent'))).toBeNull();
    const plainFile = join(root, 'plain.txt');
    writeFileSync(plainFile, 'x', 'utf8');
    expect(computeSkillDirDigest(plainFile)).toBeNull();
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

  test('a legacy record without dirDigests (written by 5.260830.x) reads back unchanged', () => {
    const legacy = {
      ref: 'v5.260830.16',
      cliVersion: SKILLS_CLI_VERSION,
      inventory: ['wish'],
      agentDirs: [join(home, '.claude', 'skills')],
      installedAt: '2026-08-30T12:00:00.000Z',
    };
    writeFileSync(skillsInstallRecordPath(genieHome), JSON.stringify(legacy), 'utf8');
    const read = readSkillsInstallRecord(genieHome);
    expect(read).toEqual(legacy);
    expect(read?.dirDigests).toBeUndefined();
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
      expect(lines[0]).toBe(`skills: installed 1 skill(s) from local:${join(genieHome, 'skills')} into 1 agent dir(s)`);
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
      `Skills install failed: skills CLI exited 1: boom. Run: npx -y skills@1.5.23 add ${join(genieHome, 'skills')} --all --copy -g`,
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
      join(genieHome, 'skills'),
      '--all',
      '--copy',
      '-g',
    ]);
  });

  /**
   * The defect this whole group exists for: on the 2026-08-30 dogfood host the
   * CLI wrote 57 agent homes and genie reported four. The shim below writes six
   * while `KNOWN_AGENT_SKILL_HOMES` matches two, so a fixed-table record would
   * report 2 and orphan 4 homes on uninstall.
   */
  test('the installed line reports the SCANNED home count, not the known-table count', () => {
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const homes = [
      join('.claude', 'skills'), // known
      join('.agents', 'skills'), // known
      join('.aider', 'skills'),
      join('.opencode', 'skills'),
      join('.zed', 'skills'),
      join('.config', 'crush', 'skills'),
    ];
    // `$4` is the source root in `npx -y skills@<v> add <src> --all --copy -g`.
    const shim = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `for rel in ${homes.join(' ')}; do`,
      `  mkdir -p "${home}/$rel"`,
      `  cp -R "$4/." "${home}/$rel/"`,
      'done',
      'exit 0',
    ].join('\n');
    writeFileSync(join(bin, 'npx'), `${shim}\n`, 'utf8');
    chmodSync(join(bin, 'npx'), 0o755);
    writeFileSync(join(bin, 'node'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
    chmodSync(join(bin, 'node'), 0o755);
    fixtureSkillsTree(['wish', 'work']);

    const lines: string[] = [];
    const previousPath = process.env.PATH;
    const savedExitCode = process.exitCode;
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    let result: ReturnType<typeof runSkillsChannelConvergence>;
    try {
      result = runSkillsChannelConvergence({
        selection: 'auto',
        version: VERSION_UNDER_TEST,
        genieHome,
        home,
        log: (line) => lines.push(line),
      });
    } finally {
      process.env.PATH = previousPath;
      process.exitCode = savedExitCode;
    }

    expect(result.status).toBe('installed');
    const expected = homes.map((rel) => join(home, rel)).sort();
    const record = readSkillsInstallRecord(genieHome);
    expect(record?.agentDirs.slice().sort()).toEqual(expected);
    expect(record?.source).toBe(`local:${join(genieHome, 'skills')}`);
    // Two of the six are the whole of what the known table can see.
    expect(existingAgentSkillHomes(home)).toHaveLength(2);
    expect(lines[0]).toBe(`skills: installed 2 skill(s) from local:${join(genieHome, 'skills')} into 6 agent dir(s)`);
    // Every recorded directory carries a digest, so `genie uninstall` can prove
    // and then remove all six homes rather than orphaning four of them.
    expect(Object.keys(record?.dirDigests ?? {})).toHaveLength(12);
  });

  test('a foreign skill dir is backed up and reported before the shim overwrites it', () => {
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const claudeSkills = join(home, '.claude', 'skills');
    const shim = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `mkdir -p "${claudeSkills}"`,
      `cp -R "$4/." "${claudeSkills}/"`,
      'exit 0',
    ].join('\n');
    writeFileSync(join(bin, 'npx'), `${shim}\n`, 'utf8');
    chmodSync(join(bin, 'npx'), 0o755);
    writeFileSync(join(bin, 'node'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
    chmodSync(join(bin, 'node'), 0o755);
    fixtureSkillsTree(['wish']);
    mkdirSync(join(claudeSkills, 'wish'), { recursive: true });
    writeFileSync(join(claudeSkills, 'wish', 'SKILL.md'), '# a foreign wish skill\n', 'utf8');

    const lines: string[] = [];
    const previousPath = process.env.PATH;
    const savedExitCode = process.exitCode;
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    try {
      runSkillsChannelConvergence({
        selection: 'auto',
        version: VERSION_UNDER_TEST,
        genieHome,
        home,
        log: (line) => lines.push(line),
      });
    } finally {
      process.env.PATH = previousPath;
      process.exitCode = savedExitCode;
    }

    const record = readSkillsInstallRecord(genieHome);
    expect(record?.collisions).toEqual([{ dir: join(claudeSkills, 'wish'), skill: 'wish' }]);
    const collisionLine = lines.find((line) => line.includes('collision:'));
    expect(collisionLine).toContain(`collision: ${join(claudeSkills, 'wish')} (wish) — backed up to `);
    const backupRoot = (collisionLine as string).split('backed up to ')[1] as string;
    expect(backupRoot.startsWith(join(genieHome, 'state-backups', 'skills-collision-'))).toBe(true);
    // The backup holds the ORIGINAL bytes; the live path now holds ours.
    expect(readFileSync(join(backupRoot, '.claude', 'skills', 'wish', 'SKILL.md'), 'utf8')).toBe(
      '# a foreign wish skill\n',
    );
    expect(readFileSync(join(claudeSkills, 'wish', 'SKILL.md'), 'utf8')).toBe('# wish\n');
  });
});
