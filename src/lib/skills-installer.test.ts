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
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
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

/**
 * `okRunner` plus what the real CLI does: copy the delivered tree into every
 * agent home that exists. A zero exit that writes nothing is now a failure of
 * its own (see "a zero exit that wrote no verifiable skill directory"), so a
 * test that wants a SUCCESSFUL install has to deliver something.
 */
function deliveringOkRunner(record: { argv: string[][] }, extraHomes: string[] = []): CommandRunner {
  const inner = okRunner(record);
  return (command, args, options) => {
    const source = args[args.indexOf('add') + 1] as string;
    const targets = [...existingAgentSkillHomes(home).map((entry) => entry.dir), ...extraHomes];
    // `--all` writes every agent home it detects, which on a real host is far
    // more than the four-row known table: `extraHomes` is how a test says so.
    for (const dir of targets) cpSync(source, dir, { recursive: true });
    return inner(command, args, options);
  };
}

const alwaysFound = (name: string) => `/usr/bin/${name}`;

/** Every `skills-collision-*` root currently under GENIE_HOME/state-backups. */
function collisionBackupRoots(): string[] {
  const base = join(genieHome, 'state-backups');
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((name) => name.startsWith('skills-collision-'))
    .map((name) => join(base, name));
}

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

  /**
   * M4 / GAP 1. A staged copy is discarded only when the ORIGINAL is still
   * byte-for-byte what the snapshot copied. A spawn that never ran leaves every
   * original intact, so nothing it staged survives the run: the dogfood host's
   * `state-backups` no longer accumulates foreign trees from flaky updates.
   */
  test('a failed install that overwrote nothing leaves no staged copy behind', () => {
    fixtureSkillsTree(['wish']);
    const claudeSkills = join(home, '.claude', 'skills');
    mkdirSync(join(claudeSkills, 'wish'), { recursive: true });
    writeFileSync(join(claudeSkills, 'wish', 'SKILL.md'), '# a foreign wish skill\n', 'utf8');

    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: () => ({ exitCode: 7, stdout: '', stderr: 'ENOTFOUND registry.npmjs.org\n' }),
    });

    expect(outcome.ok).toBe(false);
    expect(
      (outcome.ok === false ? (outcome.warnings ?? []) : []).filter((line) => line.includes('collision:')),
    ).toEqual([]);
    expect(collisionBackupRoots()).toEqual([]);
    expect(readFileSync(join(claudeSkills, 'wish', 'SKILL.md'), 'utf8')).toBe('# a foreign wish skill\n');
  });

  /**
   * The other half of that rule: a spawn that died AFTER replacing a foreign
   * directory keeps exactly that copy, and says so. Retention never depends on
   * a verdict about which homes the install "probably" wrote.
   */
  test('a failed install keeps and reports the copy of an original it had already replaced', () => {
    const source = fixtureSkillsTree(['wish']);
    const claudeSkills = join(home, '.claude', 'skills');
    mkdirSync(join(claudeSkills, 'wish'), { recursive: true });
    writeFileSync(join(claudeSkills, 'wish', 'SKILL.md'), '# a foreign wish skill\n', 'utf8');

    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: () => {
        // Half-done work: the delivered tree lands, then the CLI dies.
        cpSync(source, claudeSkills, { recursive: true });
        return { exitCode: 7, stdout: '', stderr: 'ENOTFOUND registry.npmjs.org\n' };
      },
    });

    expect(outcome.ok).toBe(false);
    const warning = (outcome.ok === false ? (outcome.warnings ?? []) : []).find((line) => line.includes('collision:'));
    expect(warning).toContain(
      `skills: collision: ${join(claudeSkills, 'wish')} (wish) — a foreign skill dir that changed while this install ran; its previous contents are backed up to `,
    );
    const backupRoot = (warning as string).split('backed up to ')[1] as string;
    expect(readFileSync(join(backupRoot, '.claude', 'skills', 'wish', 'SKILL.md'), 'utf8')).toBe(
      '# a foreign wish skill\n',
    );
  });

  /**
   * M4: the snapshot used to union the known homes with an UNFILTERED `$HOME`
   * scan and COPY every match, so any `<anything>/skills/<name>/` directory
   * under the home was duplicated into GENIE_HOME and reported as an overwrite.
   * On the 2026-09-15 dogfood host that was 152 directories — `~/.Trash`,
   * `~/backups`, another product's agent tree — none of which the installer
   * ever writes, all of them provably byte-identical afterwards. Only homes
   * genie can name in advance are copied now, and the assertion inside the
   * spawn proves it holds WHILE the install runs, not just afterwards.
   */
  test('only agent homes the install writes are snapshotted; foreign trees elsewhere are untouched', () => {
    const source = fixtureSkillsTree(['wish']);
    const claudeSkills = join(home, '.claude', 'skills');
    mkdirSync(join(claudeSkills, 'wish'), { recursive: true });
    writeFileSync(join(claudeSkills, 'wish', 'SKILL.md'), '# a foreign wish skill\n', 'utf8');
    // Not an agent home: a stray `skills/` tree the scan used to sweep in.
    const stray = join(home, 'workspace', 'skills', 'wish');
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, 'SKILL.md'), '# someone else\n', 'utf8');
    const trashed = join(home, '.Trash', 'skills', 'wish');
    mkdirSync(trashed, { recursive: true });
    writeFileSync(join(trashed, 'SKILL.md'), '# deleted by the user\n', 'utf8');

    const staged: string[][] = [];
    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: (command, args, options) => {
        // MID-RUN: nothing outside an agent home has been read into a backup.
        for (const backupRoot of collisionBackupRoots()) staged.push(readdirSync(backupRoot));
        return deliveringOkRunner({ argv: [] })(command, args, options);
      },
    });

    expect(outcome.ok).toBe(true);
    expect(staged).toEqual([['.claude']]);
    const collisions = (outcome.ok ? (outcome.warnings ?? []) : []).filter((line) => line.includes('collision:'));
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toContain(join(claudeSkills, 'wish'));
    expect(outcome.ok && outcome.record.collisions).toEqual([{ dir: join(claudeSkills, 'wish'), skill: 'wish' }]);
    const backupRoot = (collisions[0] as string).split('backed up to ')[1] as string;
    expect(existsSync(join(backupRoot, '.claude', 'skills', 'wish'))).toBe(true);
    // Nothing outside an agent home was read into the backup, and both stray
    // trees are exactly as the user left them.
    expect(existsSync(join(backupRoot, 'workspace'))).toBe(false);
    expect(existsSync(join(backupRoot, '.Trash'))).toBe(false);
    expect(readFileSync(join(stray, 'SKILL.md'), 'utf8')).toBe('# someone else\n');
    expect(readFileSync(join(trashed, 'SKILL.md'), 'utf8')).toBe('# deleted by the user\n');
    expect(source).toBe(join(genieHome, 'skills'));
  });

  /**
   * The cost of that narrowing, stated out loud. A home no record names and no
   * genie skill lives in is indistinguishable from `~/.Trash/skills` BEFORE the
   * spawn, so nothing is copied out of it — but if the install does replace
   * something there, the operator is told in plain words instead of being shown
   * a backup that does not exist. The home is recorded, so the NEXT update
   * backs it up (the test below).
   */
  test('an unknown home the install writes is reported, never silently overwritten, on a FIRST install', () => {
    fixtureSkillsTree(['wish']);
    // No previous record, and a home the known table never names.
    const astrbot = join(home, '.astrbot', 'data', 'skills');
    mkdirSync(join(astrbot, 'wish'), { recursive: true });
    writeFileSync(join(astrbot, 'wish', 'SKILL.md'), '# a foreign wish\n', 'utf8');
    const stray = join(home, '.Trash', 'skills', 'wish');
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, 'SKILL.md'), '# deleted by the user\n', 'utf8');

    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: deliveringOkRunner({ argv: [] }, [astrbot]),
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.record.agentDirs).toContain(astrbot);
    expect(outcome.ok && outcome.record.collisions).toEqual([{ dir: join(astrbot, 'wish'), skill: 'wish' }]);
    const lines = (outcome.ok ? (outcome.warnings ?? []) : []).filter((entry) => entry.includes('collision:'));
    expect(lines).toEqual([
      `skills: collision: ${join(astrbot, 'wish')} (wish) — a foreign skill dir that changed while this install ran, outside every agent home genie could name in advance, so no copy of it was taken`,
    ]);
    // Nothing was copied into GENIE_HOME — not the overwritten home, and above
    // all not the tree the user deleted.
    expect(collisionBackupRoots()).toEqual([]);
    expect(readFileSync(join(stray, 'SKILL.md'), 'utf8')).toBe('# deleted by the user\n');
  });

  test('the next install DOES back that home up, because the record now names it', () => {
    fixtureSkillsTree(['wish']);
    const astrbot = join(home, '.astrbot', 'data', 'skills');
    mkdirSync(join(astrbot, 'wish'), { recursive: true });
    writeFileSync(join(astrbot, 'wish', 'SKILL.md'), '# a foreign wish\n', 'utf8');
    writeSkillsInstallRecord(genieHome, {
      ref: 'v5.260830.15',
      cliVersion: SKILLS_CLI_VERSION,
      inventory: ['wish'],
      agentDirs: [astrbot],
      installedAt: '2026-08-30T00:00:00.000Z',
    });

    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: deliveringOkRunner({ argv: [] }, [astrbot]),
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.record.collisions).toEqual([{ dir: join(astrbot, 'wish'), skill: 'wish' }]);
    const line = (outcome.ok ? (outcome.warnings ?? []) : []).find((entry) => entry.includes('collision:')) as string;
    const backupRoot = line.split('backed up to ')[1] as string;
    expect(readFileSync(join(backupRoot, '.astrbot', 'data', 'skills', 'wish', 'SKILL.md'), 'utf8')).toBe(
      '# a foreign wish\n',
    );
  });

  /**
   * A home no record names is still backed up when genie's OWN skills already
   * live in it: that is proof this channel delivers there, which `~/.Trash` can
   * never produce.
   */
  test("a home that already carries genie's own skills is backed up without a record", () => {
    const source = fixtureSkillsTree(['wish', 'work']);
    const astrbot = join(home, '.astrbot', 'data', 'skills');
    mkdirSync(astrbot, { recursive: true });
    cpSync(join(source, 'work'), join(astrbot, 'work'), { recursive: true });
    mkdirSync(join(astrbot, 'wish'), { recursive: true });
    writeFileSync(join(astrbot, 'wish', 'SKILL.md'), '# a foreign wish\n', 'utf8');

    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: deliveringOkRunner({ argv: [] }, [astrbot]),
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.record.collisions).toEqual([{ dir: join(astrbot, 'wish'), skill: 'wish' }]);
    const line = (outcome.ok ? (outcome.warnings ?? []) : []).find((entry) => entry.includes('collision:')) as string;
    const backupRoot = line.split('backed up to ')[1] as string;
    expect(readFileSync(join(backupRoot, '.astrbot', 'data', 'skills', 'wish', 'SKILL.md'), 'utf8')).toBe(
      '# a foreign wish\n',
    );
  });

  /**
   * M4 / GAP 2 — the data-loss shape retention-by-discovery introduces. The
   * install DOES replace a foreign dir in a recorded home, but the post-install
   * discovery scan cannot recognize that home (the probe skill is not delivered
   * there and its stamps predate the window — a networked or clock-skewed agent
   * home). Deciding retention from the discovery verdict deletes the only
   * surviving copy of the user's bytes, silently. Deciding it from the
   * directory's own digest keeps it.
   */
  test('a replaced dir in a home discovery cannot recognize keeps its backup', () => {
    const source = fixtureSkillsTree(['review', 'wish']);
    const astrbot = join(home, '.astrbot', 'data', 'skills');
    // Genie's own `review` from an OLDER release: proof the channel delivers
    // here, but not byte-equal to the delivered tree, so the post-install probe
    // never recognizes the home.
    mkdirSync(join(astrbot, 'review'), { recursive: true });
    writeFileSync(join(astrbot, 'review', 'SKILL.md'), '# review (previous release)\n', 'utf8');
    mkdirSync(join(astrbot, 'wish'), { recursive: true });
    writeFileSync(join(astrbot, 'wish', 'SKILL.md'), "# the user's OWN wish skill\n", 'utf8');
    const previousDigest = computeSkillDirDigest(join(astrbot, 'review'));
    if (previousDigest === null) throw new Error('fixture skill dir was not digestable');
    const claudeSkills = join(home, '.claude', 'skills');
    mkdirSync(claudeSkills, { recursive: true });
    writeSkillsInstallRecord(genieHome, {
      ref: 'v5.260830.15',
      cliVersion: SKILLS_CLI_VERSION,
      inventory: ['review', 'wish'],
      // The home itself is NOT recorded — only the digest of the skill inside
      // it — so nothing but that digest can justify backing it up.
      agentDirs: [claudeSkills],
      dirDigests: { [join(astrbot, 'review')]: previousDigest },
      installedAt: '2026-08-30T00:00:00.000Z',
    });

    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: (command, args, options) => {
        // The CLI replaces `wish` there — and only `wish`, so the probe skill
        // `review` stays untouched and stale.
        cpSync(join(source, 'wish'), join(astrbot, 'wish'), { recursive: true });
        return deliveringOkRunner({ argv: [] })(command, args, options);
      },
    });

    expect(outcome.ok).toBe(true);
    // Discovery never saw the home; the digest did.
    expect(outcome.ok && outcome.record.agentDirs).not.toContain(astrbot);
    expect(outcome.ok && outcome.record.collisions).toEqual([{ dir: join(astrbot, 'wish'), skill: 'wish' }]);
    const line = (outcome.ok ? (outcome.warnings ?? []) : []).find((entry) => entry.includes('collision:')) as string;
    const backupRoot = line.split('backed up to ')[1] as string;
    expect(readFileSync(join(backupRoot, '.astrbot', 'data', 'skills', 'wish', 'SKILL.md'), 'utf8')).toBe(
      "# the user's OWN wish skill\n",
    );
  });

  /**
   * M4 / GAP 1 — a `skills-collision-*` root an earlier run left behind is
   * pruned by a later one, but only once every file in it still matches its
   * live original. A root holding replaced bytes is never touched.
   */
  test('a later run prunes a stale collision root that protects nothing, and keeps one that does', () => {
    fixtureSkillsTree(['wish']);
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    const backups = join(genieHome, 'state-backups');
    const redundant = join(backups, 'skills-collision-2026-09-01T00-00-00-000Z');
    const precious = join(backups, 'skills-collision-2026-09-02T00-00-00-000Z');
    const strayLive = join(home, 'workspace', 'skills', 'wish');
    mkdirSync(strayLive, { recursive: true });
    writeFileSync(join(strayLive, 'SKILL.md'), '# someone else\n', 'utf8');
    mkdirSync(join(redundant, 'workspace', 'skills', 'wish'), { recursive: true });
    writeFileSync(join(redundant, 'workspace', 'skills', 'wish', 'SKILL.md'), '# someone else\n', 'utf8');
    mkdirSync(join(precious, '.claude', 'skills', 'wish'), { recursive: true });
    writeFileSync(join(precious, '.claude', 'skills', 'wish', 'SKILL.md'), '# bytes nothing else has\n', 'utf8');

    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: deliveringOkRunner({ argv: [] }),
    });

    expect(outcome.ok).toBe(true);
    expect(existsSync(redundant)).toBe(false);
    expect(readFileSync(join(precious, '.claude', 'skills', 'wish', 'SKILL.md'), 'utf8')).toBe(
      '# bytes nothing else has\n',
    );
    expect(readFileSync(join(strayLive, 'SKILL.md'), 'utf8')).toBe('# someone else\n');
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
      process.exitCode = savedExitCode ?? 0;
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

describe('retiring removed skills during an upgrade', () => {
  function previousInstall(names = ['trace']): { dirs: string[]; record: SkillsInstallRecord; spawn: CommandRunner } {
    const source = fixtureSkillsTree(['review']);
    const dirs = [join(home, '.claude', 'skills'), join(home, '.agents', 'skills')];
    const dirDigests: Record<string, string> = {};
    for (const dir of dirs) {
      for (const name of names) {
        const target = join(dir, name);
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, 'SKILL.md'), `# previous ${name}\n`);
        dirDigests[target] = computeSkillDirDigest(target) as string;
      }
    }
    const record: SkillsInstallRecord = {
      ref: 'v5.260914.1',
      cliVersion: SKILLS_CLI_VERSION,
      inventory: names,
      agentDirs: dirs,
      dirDigests,
      installedAt: '2026-09-14T00:00:00.000Z',
    };
    writeSkillsInstallRecord(genieHome, record);
    return {
      dirs,
      record,
      spawn: () => {
        for (const dir of dirs) cpSync(source, dir, { recursive: true });
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
  }

  test('archives unchanged removed skills after install, records the new inventory, and is idempotent', () => {
    const { dirs, spawn } = previousInstall();
    const install = () => runSkillsInstall({ version: VERSION_UNDER_TEST, genieHome, home, which: alwaysFound, spawn });
    const first = install();
    expect(first.ok).toBe(true);
    expect(readSkillsInstallRecord(genieHome)?.inventory).toEqual(['review']);
    const backups = join(genieHome, 'state-backups');
    const generations = readdirSync(backups);
    expect(generations).toHaveLength(1);
    for (const [index, dir] of dirs.entries()) {
      expect(existsSync(join(dir, 'trace'))).toBe(false);
      expect(readFileSync(join(dir, 'review', 'SKILL.md'), 'utf8')).toBe('# review\n');
      const agent = index === 0 ? '.claude' : '.agents';
      expect(readFileSync(join(backups, generations[0] as string, agent, 'skills', 'trace', 'SKILL.md'), 'utf8')).toBe(
        '# previous trace\n',
      );
    }
    // ONE line per removed SKILL, not one per (agent dir x skill), plus one
    // line naming the backup root (F14: 11 skills x 57 homes was 627 lines).
    expect(first.warnings).toEqual([
      'skills: retired trace from 2 agent dir(s)',
      `skills: retirement backups under ${join(backups, generations[0] as string)}`,
      'skills: retirement: 2 archived, 0 preserved, 0 already absent of 2 recorded target(s)',
    ]);
    // The backup root sorts by time, so `state-backups` listings stay ordered.
    expect(generations[0]).toMatch(/^skills-retirement-\d{4}-\d{2}-\d{2}T[\d-]+Z$/);
    expect(install().ok).toBe(true);
    expect(readdirSync(backups)).toEqual(generations);
  });

  test('preserves edited, unrecorded, legacy, and symlinked skills', () => {
    const { dirs, record, spawn } = previousInstall(['trace', 'perf', 'qa']);
    const dir = dirs[0] as string;
    writeFileSync(join(dir, 'trace', 'SKILL.md'), '# user edit\n');
    delete record.dirDigests?.[join(dir, 'perf')];
    const foreign = join(home, 'personal');
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'SKILL.md'), '# personal\n');
    rmSync(join(dir, 'qa'), { recursive: true });
    symlinkSync(foreign, join(dir, 'qa'));
    mkdirSync(join(dir, 'mine'));
    writeFileSync(join(dir, 'mine', 'SKILL.md'), '# mine\n');
    writeSkillsInstallRecord(genieHome, record);
    const outcome = runSkillsInstall({ version: VERSION_UNDER_TEST, genieHome, home, which: alwaysFound, spawn });
    expect(outcome.ok).toBe(true);
    expect(readFileSync(join(dir, 'trace', 'SKILL.md'), 'utf8')).toBe('# user edit\n');
    expect(readFileSync(join(dir, 'perf', 'SKILL.md'), 'utf8')).toBe('# previous perf\n');
    expect(readFileSync(join(dir, 'qa', 'SKILL.md'), 'utf8')).toBe('# personal\n');
    expect(readFileSync(join(dir, 'mine', 'SKILL.md'), 'utf8')).toBe('# mine\n');
    expect(outcome.warnings?.filter((line) => line.includes('preserved retired skill'))).toHaveLength(3);
  });

  test('does not follow a redirected agent home or retire paths outside HOME', () => {
    const { record, spawn } = previousInstall();
    const external = join(root, 'external', 'skills');
    mkdirSync(join(external, 'trace'), { recursive: true });
    writeFileSync(join(external, 'trace', 'SKILL.md'), '# external\n');
    const redirected = join(home, '.redirected');
    symlinkSync(join(root, 'external'), redirected);
    for (const dir of [external, join(redirected, 'skills')]) {
      record.agentDirs.push(dir);
      (record.dirDigests as Record<string, string>)[join(dir, 'trace')] = computeSkillDirDigest(
        join(dir, 'trace'),
      ) as string;
    }
    writeSkillsInstallRecord(genieHome, record);
    const outcome = runSkillsInstall({ version: VERSION_UNDER_TEST, genieHome, home, which: alwaysFound, spawn });
    expect(outcome.ok).toBe(true);
    expect(readFileSync(join(external, 'trace', 'SKILL.md'), 'utf8')).toBe('# external\n');
    expect(outcome.warnings?.filter((line) => line.includes('preserved retired skill'))).toHaveLength(2);
  });

  /**
   * M1: retirement now runs BEFORE the install pass, so a failing install no
   * longer leaves the retired bytes where `skills.sh --all` can destroy them.
   * The record is still untouched, so `genie update` retries; the bytes are in
   * `state-backups/` and the warnings say so even on the failure path.
   */
  test('a failed installation keeps the old record, and the bytes it already archived', () => {
    const { dirs, record } = previousInstall();
    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: () => ({ exitCode: 1, stdout: '', stderr: 'offline' }),
    });
    expect(outcome.ok).toBe(false);
    expect(readSkillsInstallRecord(genieHome)).toEqual(record);
    const generation = readdirSync(join(genieHome, 'state-backups'))[0] as string;
    for (const [index, dir] of dirs.entries()) {
      expect(existsSync(join(dir, 'trace'))).toBe(false);
      const agent = index === 0 ? '.claude' : '.agents';
      expect(
        readFileSync(join(genieHome, 'state-backups', generation, agent, 'skills', 'trace', 'SKILL.md'), 'utf8'),
      ).toBe('# previous trace\n');
    }
    expect(outcome.warnings).toContain('skills: retired trace from 2 agent dir(s)');
  });

  /**
   * The replacement check retirement can no longer make for itself, now that it
   * runs first: a zero exit that wrote no verifiable skill directory anywhere
   * is still a failure, so no record is written and `genie update` keeps
   * retrying instead of recording an install that never landed.
   */
  test('a zero exit that wrote no verifiable skill directory is still a failure', () => {
    const { record } = previousInstall();
    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: okRunner({ argv: [] }),
    });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe('the skills CLI wrote no verifiable skill directory');
    expect(readSkillsInstallRecord(genieHome)).toEqual(record);
  });

  /**
   * M1, the ordering contract: a home whose replacement bytes never land (or
   * land edited, or as a symlink) still has its retired directory archived,
   * because the archive was taken before the install ran. The pre-fix code
   * retired AFTER the install and used the post-install digests as a veto, so
   * this home kept a directory the record then dropped — and a home skills.sh
   * had already replaced was silently skipped instead.
   */
  test.each(['missing', 'edited', 'symlinked'])(
    'an %s replacement in one home does not strand the retired bytes',
    (replacement) => {
      const { dirs, spawn } = previousInstall();
      const damaged = dirs[1] as string;
      const outcome = runSkillsInstall({
        version: VERSION_UNDER_TEST,
        genieHome,
        home,
        which: alwaysFound,
        spawn: (...args) => {
          const result = spawn(...args);
          const target = join(damaged, 'review');
          if (replacement === 'edited') writeFileSync(join(target, 'SKILL.md'), '# personal review\n');
          else {
            rmSync(target, { recursive: true });
            if (replacement === 'symlinked') symlinkSync(join(genieHome, 'skills', 'review'), target);
          }
          return result;
        },
      });
      expect(outcome.ok).toBe(true);
      expect(readSkillsInstallRecord(genieHome)?.preserved).toBeUndefined();
      const generations = readdirSync(join(genieHome, 'state-backups'));
      expect(generations).toHaveLength(1);
      for (const [index, dir] of dirs.entries()) {
        expect(existsSync(join(dir, 'trace'))).toBe(false);
        const agent = index === 0 ? '.claude' : '.agents';
        expect(
          readFileSync(
            join(genieHome, 'state-backups', generations[0] as string, agent, 'skills', 'trace', 'SKILL.md'),
            'utf8',
          ),
        ).toBe('# previous trace\n');
      }
      expect(outcome.warnings).toContain('skills: retired trace from 2 agent dir(s)');
    },
  );

  test('backup failure preserves the old record and skills so update can retry', () => {
    const { dirs, record, spawn } = previousInstall();
    const backups = join(genieHome, 'state-backups');
    writeFileSync(backups, 'blocked backup destination');
    const install = () => runSkillsInstall({ version: VERSION_UNDER_TEST, genieHome, home, which: alwaysFound, spawn });
    const failed = install();
    expect(failed.ok).toBe(false);
    expect(!failed.ok && failed.reason).toContain('could not retire the skills this release drops');
    expect(!failed.ok && failed.remedy).toContain('genie update');
    expect(readSkillsInstallRecord(genieHome)).toEqual(record);
    for (const dir of dirs) expect(existsSync(join(dir, 'trace'))).toBe(true);
    rmSync(backups);
    expect(install().ok).toBe(true);
    for (const dir of dirs) expect(existsSync(join(dir, 'trace'))).toBe(false);
  });

  test.each(['edited', 'replaced'])('restores a skill %s between verification and archival', (change) => {
    const { dirs, spawn } = previousInstall();
    const target = join(dirs[0] as string, 'trace');
    let parked = '';
    let expectedInode = 0;
    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn,
      renameRetiredSkill: (source, destination) => {
        if (source === target) {
          if (change === 'replaced') {
            renameSync(source, join(root, 'original-trace'));
            mkdirSync(source);
          }
          writeFileSync(join(source, 'SKILL.md'), change === 'edited' ? '# concurrent edit\n' : '# previous trace\n');
          expectedInode = statSync(source).ino;
          parked = destination;
        }
        renameSync(source, destination);
      },
    });
    expect(outcome.ok).toBe(true);
    expect(statSync(target).ino).toBe(expectedInode);
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe(
      change === 'edited' ? '# concurrent edit\n' : '# previous trace\n',
    );
    expect(existsSync(parked)).toBe(false);
    expect(outcome.warnings).toContain(
      `skills: preserved retired skill ${target} (changed during archival; restored); review it manually`,
    );
    expect(existsSync(join(dirs[1] as string, 'trace'))).toBe(false);
  });

  test.each(['empty', 'populated'])('a restore collision preserves a %s live directory and the backup', (live) => {
    const { dirs, record, spawn } = previousInstall();
    const target = join(dirs[0] as string, 'trace');
    let parked = '';
    let liveInode = 0;
    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn,
      renameRetiredSkill: (source, destination) => {
        writeFileSync(join(source, 'SKILL.md'), '# concurrent edit\n');
        renameSync(source, destination);
        mkdirSync(source);
        liveInode = statSync(source).ino;
        if (live === 'populated') writeFileSync(join(source, 'SKILL.md'), '# new live skill\n');
        parked = destination;
      },
    });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toContain(`recover ${parked} manually`);
    expect(statSync(target).ino).toBe(liveInode);
    if (live === 'populated') expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('# new live skill\n');
    else expect(readdirSync(target)).toEqual([]);
    expect(readFileSync(join(parked, 'SKILL.md'), 'utf8')).toBe('# concurrent edit\n');
    expect(readSkillsInstallRecord(genieHome)).toEqual(record);
  });

  /**
   * What a cross-filesystem `renameSync` really throws. `GENIE_HOME` on another
   * mount (`/data/genie`, a bind-mounted agent home, a container volume) used
   * to abort the whole install here — before the record was written — so every
   * retry of the suggested `genie update` failed identically forever.
   */
  function crossDeviceRename(...blocked: string[]): (source: string, destination: string) => void {
    return (source, destination) => {
      if (blocked.includes(source)) {
        const error: NodeJS.ErrnoException = new Error('EXDEV: cross-device link not permitted');
        error.code = 'EXDEV';
        throw error;
      }
      renameSync(source, destination);
    };
  }

  test('EXDEV falls back to copy-then-remove, and the record is still written', () => {
    const { dirs, spawn } = previousInstall();
    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn,
      renameRetiredSkill: crossDeviceRename(...dirs.map((dir) => join(dir, 'trace'))),
    });
    expect(outcome.ok).toBe(true);
    const record = readSkillsInstallRecord(genieHome);
    expect(record?.ref).toBe(`v${VERSION_UNDER_TEST}`);
    expect(record?.inventory).toEqual(['review']);
    // Nothing was preserved: the copy fallback archived both homes.
    expect(record?.preserved).toBeUndefined();
    const generations = readdirSync(join(genieHome, 'state-backups'));
    expect(generations).toHaveLength(1);
    for (const [index, dir] of dirs.entries()) {
      expect(existsSync(join(dir, 'trace'))).toBe(false);
      const agent = index === 0 ? '.claude' : '.agents';
      // Backup-first: the bytes are in the backup root, verified there before
      // the original was removed.
      expect(
        readFileSync(
          join(genieHome, 'state-backups', generations[0] as string, agent, 'skills', 'trace', 'SKILL.md'),
          'utf8',
        ),
      ).toBe('# previous trace\n');
    }
    expect(outcome.warnings?.[0]).toBe('skills: retired trace from 2 agent dir(s)');
  });

  test('the EXDEV copy reproduces symlinks verbatim, so the post-move digest still verifies', () => {
    const { dirs, record, spawn } = previousInstall();
    const target = join(dirs[0] as string, 'trace');
    symlinkSync('./SKILL.md', join(target, 'alias.md'));
    (record.dirDigests as Record<string, string>)[target] = computeSkillDirDigest(target) as string;
    writeSkillsInstallRecord(genieHome, record);
    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn,
      renameRetiredSkill: crossDeviceRename(target),
    });
    expect(outcome.ok).toBe(true);
    expect(existsSync(target)).toBe(false);
    const generation = readdirSync(join(genieHome, 'state-backups'))[0] as string;
    // A rewritten (absolutized) link target would change the digest the copy is
    // verified against, and the directory would have been preserved instead.
    expect(readlinkSync(join(genieHome, 'state-backups', generation, '.claude', 'skills', 'trace', 'alias.md'))).toBe(
      './SKILL.md',
    );
  });

  test('a rename failure that is not EXDEV fails the install and leaks no empty backup root', () => {
    const { dirs, record, spawn } = previousInstall();
    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn,
      renameRetiredSkill: () => {
        throw new Error('EACCES: permission denied');
      },
    });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toContain('could not retire the skills this release drops');
    expect(readSkillsInstallRecord(genieHome)).toEqual(record);
    for (const dir of dirs) expect(existsSync(join(dir, 'trace'))).toBe(true);
    // Every retry used to leave one more empty `skills-retirement-*` tree here.
    expect(readdirSync(join(genieHome, 'state-backups'))).toEqual([]);
  });

  test('preserved directories stay in the record with a reason, and a reverted edit is retired next update', () => {
    const { dirs, record, spawn } = previousInstall(['trace', 'perf']);
    const claude = dirs[0] as string;
    const edited = join(claude, 'trace');
    writeFileSync(join(edited, 'SKILL.md'), '# user edit\n');
    delete record.dirDigests?.[join(claude, 'perf')];
    writeSkillsInstallRecord(genieHome, record);
    const install = () => runSkillsInstall({ version: VERSION_UNDER_TEST, genieHome, home, which: alwaysFound, spawn });

    const first = install();
    expect(first.ok).toBe(true);
    // The pre-fix record dropped both of these, so doctor read clean, uninstall
    // left them, and no later update ever looked at them again.
    expect(readSkillsInstallRecord(genieHome)?.preserved).toEqual([
      {
        agentDir: claude,
        skill: 'trace',
        reason: 'content changed since the recorded install',
        digest: record.dirDigests?.[edited] as string,
      },
      { agentDir: claude, skill: 'perf', reason: 'no recorded content digest' },
    ]);
    expect(first.warnings).toEqual([
      'skills: retired perf from 1 agent dir(s)',
      'skills: retired trace from 1 agent dir(s)',
      `skills: retirement backups under ${join(genieHome, 'state-backups', readdirSync(join(genieHome, 'state-backups'))[0] as string)}`,
      `skills: preserved retired skill ${edited} (content changed since the recorded install); review it manually`,
      `skills: preserved retired skill ${join(claude, 'perf')} (no recorded content digest); review it manually`,
      'skills: retirement: 2 archived, 2 preserved, 0 already absent of 4 recorded target(s)',
    ]);

    // The user reverts their edit; the NEXT update retries the retirement using
    // the digest the preserved entry carried forward.
    writeFileSync(join(edited, 'SKILL.md'), '# previous trace\n');
    const second = install();
    expect(second.ok).toBe(true);
    expect(existsSync(edited)).toBe(false);
    expect(second.warnings).toContain('skills: retired trace from 1 agent dir(s)');
    // `perf` has no digest to prove, so it is reported for a human, forever.
    expect(readSkillsInstallRecord(genieHome)?.preserved).toEqual([
      { agentDir: claude, skill: 'perf', reason: 'no recorded content digest' },
    ]);
  });

  /**
   * M1/M2, the dogfood regression. A whole recorded agent home vanished between
   * the record and the retirement pass (`skills.sh --all` recreated
   * `~/.openclaw` mid-run). The pre-fix code printed `retired trace from 2
   * agent dir(s)` against a 3-home record, said nothing about the third, and
   * then wrote a record that no longer contained it — erasing the only evidence
   * the home was ever recorded, from the transcript, from `genie doctor`, and
   * from `genie uninstall`'s removal authority.
   */
  test('a recorded agent home that vanished is reported, counted, and kept in the record', () => {
    const source = fixtureSkillsTree(['review']);
    const dirs = [join(home, '.claude', 'skills'), join(home, '.agents', 'skills'), join(home, '.openclaw', 'skills')];
    const dirDigests: Record<string, string> = {};
    for (const dir of dirs) {
      const target = join(dir, 'trace');
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'SKILL.md'), '# previous trace\n');
      dirDigests[target] = computeSkillDirDigest(target) as string;
    }
    writeSkillsInstallRecord(genieHome, {
      ref: 'v5.260914.1',
      cliVersion: SKILLS_CLI_VERSION,
      inventory: ['trace'],
      agentDirs: dirs,
      dirDigests,
      installedAt: '2026-09-14T00:00:00.000Z',
    });
    const gone = dirs[2] as string;
    rmSync(join(home, '.openclaw'), { recursive: true });

    const lines: string[] = [];
    const result = runSkillsChannelConvergence({
      selection: 'auto',
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      log: (line) => lines.push(line),
      spawn: () => {
        for (const dir of dirs.slice(0, 2)) cpSync(source, dir, { recursive: true });
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(result.status).toBe('installed');
    expect(lines).toContain(
      `skills: recorded agent dir ${gone} no longer exists; kept in the record so the next run still names it`,
    );
    expect(lines).toContain(`skills: retirement: ${join(gone, 'trace')} was already gone — nothing to archive`);
    expect(lines).toContain('skills: retired trace from 2 agent dir(s)');
    expect(lines).toContain('skills: retirement: 2 archived, 0 preserved, 1 already absent of 3 recorded target(s)');
    // The record still names the home `genie uninstall` would have to sweep.
    expect(readSkillsInstallRecord(genieHome)?.agentDirs).toContain(gone);
  });

  /**
   * M1's root shape, independent of who deleted the home: the install pass
   * replaces an agent home wholesale, taking the retired directory with it.
   * Because retirement now runs FIRST, the bytes are already in the backup
   * root — the pre-fix ordering archived nothing at all for that home.
   */
  test('an agent home the install pass replaces has already been archived', () => {
    const source = fixtureSkillsTree(['review']);
    const { dirs } = previousInstall();
    const replaced = dirs[1] as string;
    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: () => {
        // `skills.sh --all` recreating the home: everything under it is gone.
        rmSync(join(home, '.agents'), { recursive: true, force: true });
        for (const dir of dirs) cpSync(source, dir, { recursive: true });
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    expect(outcome.ok).toBe(true);
    expect(existsSync(join(replaced, 'trace'))).toBe(false);
    const generation = readdirSync(join(genieHome, 'state-backups'))[0] as string;
    expect(
      readFileSync(join(genieHome, 'state-backups', generation, '.agents', 'skills', 'trace', 'SKILL.md'), 'utf8'),
    ).toBe('# previous trace\n');
    expect(outcome.warnings).toContain('skills: retired trace from 2 agent dir(s)');
  });

  test('already-gone targets are named up to five, then counted', () => {
    const names = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
    const { dirs, spawn } = previousInstall(names);
    const claude = dirs[0] as string;
    for (const name of names) rmSync(join(claude, name), { recursive: true });
    const outcome = runSkillsInstall({ version: VERSION_UNDER_TEST, genieHome, home, which: alwaysFound, spawn });
    expect(outcome.ok).toBe(true);
    const absent = (outcome.warnings ?? []).filter((line) => line.includes('was already gone'));
    expect(absent).toHaveLength(5);
    expect(outcome.warnings).toContain('skills: retirement: +2 more recorded target(s) were already gone');
    expect(outcome.warnings).toContain(
      'skills: retirement: 7 archived, 0 preserved, 7 already absent of 14 recorded target(s)',
    );
  });

  /**
   * m4's other half: doctor reports a preserved entry whose path is gone as
   * RESOLVED, and this is the update that makes that true — the entry leaves
   * the record, and the run says so instead of passing over it in silence.
   */
  test('a preserved dir the operator deleted is reported absent and leaves the record', () => {
    const { dirs, record, spawn } = previousInstall(['trace']);
    const claude = dirs[0] as string;
    const gone = join(claude, 'trace');
    delete record.dirDigests?.[gone];
    writeSkillsInstallRecord(genieHome, record);
    const install = () => runSkillsInstall({ version: VERSION_UNDER_TEST, genieHome, home, which: alwaysFound, spawn });

    expect(install().ok).toBe(true);
    expect(readSkillsInstallRecord(genieHome)?.preserved).toEqual([
      { agentDir: claude, skill: 'trace', reason: 'no recorded content digest' },
    ]);

    rmSync(gone, { recursive: true });
    const second = install();
    expect(second.ok).toBe(true);
    expect(second.warnings).toContain(`skills: retirement: ${gone} was already gone — nothing to archive`);
    expect(second.warnings).toContain(
      'skills: retirement: 0 archived, 0 preserved, 1 already absent of 1 recorded target(s)',
    );
    expect(readSkillsInstallRecord(genieHome)?.preserved).toBeUndefined();
  });

  test('a skill this release delivers again drops out of the preserved list', () => {
    const { dirs, record, spawn } = previousInstall();
    const claude = dirs[0] as string;
    writeFileSync(join(claude, 'trace', 'SKILL.md'), '# user edit\n');
    writeSkillsInstallRecord(genieHome, record);
    expect(runSkillsInstall({ version: VERSION_UNDER_TEST, genieHome, home, which: alwaysFound, spawn }).ok).toBe(true);
    expect(readSkillsInstallRecord(genieHome)?.preserved).toHaveLength(1);

    // `trace` is delivered again: it is no longer a retirement at all.
    const source = fixtureSkillsTree(['review', 'trace']);
    const redeliver: CommandRunner = () => {
      for (const dir of dirs) cpSync(source, dir, { recursive: true });
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: redeliver,
    });
    expect(outcome.ok).toBe(true);
    expect(readSkillsInstallRecord(genieHome)?.preserved).toBeUndefined();
    expect(readSkillsInstallRecord(genieHome)?.inventory).toEqual(['review', 'trace']);
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

  test('an exhausted directory cap or time budget reports capped and records nothing', () => {
    fakeHomeMatrix();
    const capped = scanSkillsHomes({ home, sourceRoot: join(genieHome, 'skills'), maxDirs: 1 });
    expect(capped.status).toBe('capped');
    expect(capped.dirs).toEqual([]);
    expect(capped.reason).toContain('directory cap');

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

  /**
   * The cap counts DIRECTORIES, never plain files. Counting every directory
   * entry made the scan cap out on any ordinary developer `$HOME` (a real host
   * measured 112,885 entries under these prune rules against a 50,000 entry
   * cap), which silently demoted `agentDirs` to the four-row known-home table —
   * the exact defect this scan exists to fix.
   */
  test('plain files never count toward the cap', () => {
    const source = fixtureSkillsTree(['wish']);
    const written = join(home, '.claude', 'skills');
    mkdirSync(join(written, 'wish'), { recursive: true });
    writeFileSync(join(written, 'wish', 'SKILL.md'), '# wish\n', 'utf8');
    // Far more files than the cap below, in the two directories the walk opens.
    for (let index = 0; index < 200; index += 1) {
      writeFileSync(join(home, `file-${index}.txt`), 'x', 'utf8');
      writeFileSync(join(home, '.claude', `file-${index}.txt`), 'x', 'utf8');
    }

    // Three directories are opened or considered: `$HOME`, `.claude` and the
    // `skills` home itself. `.genie` and everything under it is pruned whole.
    const scan = scanSkillsHomes({ home, sourceRoot: source, genieHome, maxDirs: 3 });

    expect(scan.status).toBe('ok');
    expect(scan.dirs).toEqual([written]);
  });

  /**
   * Releases through 5.260831.x delivered a SECOND physical skill tree inside
   * `$GENIE_HOME` (`plugins/genie/skills`, byte-identical to `skills/`),
   * extracted from the tarball moments before the install ran. Byte-equal plus a
   * fresh stamp is exactly what the selection rule keeps, so without the prune it
   * inflated the honest N and put a path inside `$GENIE_HOME` into the uninstall
   * manifest. The mirror no longer ships, but an operator upgrading from such a
   * release still has one on disk — and the prune is the structural guarantee for
   * any future sibling tree, so this fixture stays.
   */
  test('a second skill tree inside GENIE_HOME is never a discovered home', () => {
    const source = fixtureSkillsTree(['wish']);
    const mirror = join(genieHome, 'plugins', 'genie', 'skills');
    mkdirSync(join(mirror, 'wish'), { recursive: true });
    writeFileSync(join(mirror, 'wish', 'SKILL.md'), '# wish\n', 'utf8');

    // The fixture is real: without the prune the mirror IS found and selected.
    const unpruned = scanSkillsHomes({ home, sourceRoot: source });
    expect(unpruned.dirs).toContain(mirror);
    expect(
      selectSkillsHomesWrittenBy({
        dirs: unpruned.dirs,
        sourceRoot: source,
        probe: 'wish',
        since: Date.now() - 60_000,
      }),
    ).toContain(mirror);

    const scan = scanSkillsHomes({ home, sourceRoot: source, genieHome });
    expect(scan.status).toBe('ok');
    expect(scan.dirs).not.toContain(mirror);
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

    expect(snapshot.collisions).toEqual([
      {
        dir: join(claudeSkills, 'wish'),
        skill: 'wish',
        digest: computeSkillDirDigest(join(claudeSkills, 'wish')),
        backedUp: true,
      },
    ]);
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
    process.exitCode = previousExitCode ?? 0;
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
        spawn: deliveringOkRunner(calls),
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

  test('a failure still reports the collisions it actually replaced, and only those', () => {
    const source = fixtureSkillsTree(['wish']);
    const claudeSkills = join(home, '.claude', 'skills');
    mkdirSync(join(claudeSkills, 'wish'), { recursive: true });
    writeFileSync(join(claudeSkills, 'wish', 'SKILL.md'), '# a foreign wish skill\n', 'utf8');

    const lines: string[] = [];
    const result = runSkillsChannelConvergence({
      selection: 'auto',
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: () => {
        cpSync(source, claudeSkills, { recursive: true });
        return { exitCode: 1, stdout: '', stderr: 'boom\n' };
      },
      log: (line) => lines.push(line),
    });

    expect(result.status).toBe('failed');
    expect(lines[0]).toStartWith('Skills install failed: skills CLI exited 1: boom.');
    expect(lines[1]).toContain(
      `skills: collision: ${join(claudeSkills, 'wish')} (wish) — a foreign skill dir that changed while this install ran; its previous contents are backed up to `,
    );
    expect(process.exitCode).toBe(1);
  });
});

describe('default bounded runner (fake npx shim on PATH)', () => {
  test('the production argv reaches the spawned process verbatim', () => {
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const argvLog = join(root, 'npx-argv.txt');
    const claudeSkills = join(home, '.claude', 'skills');
    mkdirSync(claudeSkills, { recursive: true });
    for (const name of ['node', 'npx']) {
      const shim = join(bin, name);
      // The shim delivers as well as logging: a zero exit that writes no
      // verifiable skill directory is a failure in its own right.
      writeFileSync(
        shim,
        `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvLog}"\ncp -R "$4/." "${claudeSkills}/" 2>/dev/null || true\nexit 0\n`,
        'utf8',
      );
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
      process.exitCode = savedExitCode ?? 0;
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
      process.exitCode = savedExitCode ?? 0;
    }

    const record = readSkillsInstallRecord(genieHome);
    expect(record?.collisions).toEqual([{ dir: join(claudeSkills, 'wish'), skill: 'wish' }]);
    const collisionLine = lines.find((line) => line.includes('collision:'));
    expect(collisionLine).toContain(
      `collision: ${join(claudeSkills, 'wish')} (wish) — a foreign skill dir that changed while this install ran; its previous contents are backed up to `,
    );
    const backupRoot = (collisionLine as string).split('backed up to ')[1] as string;
    expect(backupRoot.startsWith(join(genieHome, 'state-backups', 'skills-collision-'))).toBe(true);
    // The backup holds the ORIGINAL bytes; the live path now holds ours.
    expect(readFileSync(join(backupRoot, '.claude', 'skills', 'wish', 'SKILL.md'), 'utf8')).toBe(
      '# a foreign wish skill\n',
    );
    expect(readFileSync(join(claudeSkills, 'wish', 'SKILL.md'), 'utf8')).toBe('# wish\n');
  });
});
