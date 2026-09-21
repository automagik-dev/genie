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
import { SKILLS_CLI_AGENTS, agentSkillsHome } from './skills-agents.js';
import {
  KNOWN_AGENT_SKILL_HOMES,
  SKILLS_CLI_VERSION,
  type SkillsInstallRecord,
  SkillsInstallRecordError,
  buildSkillsAddArgv,
  computeSkillDirDigest,
  existingAgentSkillHomes,
  inspectSkillsInstallRecord,
  inventoryFromSkillsDir,
  isNpmChatterLine,
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
  // A real Claude Code home: the product root that makes `claude-code` a
  // DETECTED agent (genie names only detected agents and creates no home), plus
  // one file of the product's own so the genie-created-home prune never
  // mistakes this fixture for a home genie materialized.
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), '{}\n', 'utf8');
  // And a Codex home: `codex` is a UNIVERSAL agent, so it is why the shared
  // `~/.agents/skills` home exists on a real host (skills.sh creates no
  // `.codex/skills`). Without it `~/.agents` would read as genie-created.
  mkdirSync(join(home, '.codex'), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('pinned argv', () => {
  /**
   * X2 (r2 §3.2 B). `--all` expands to `--agent '*'` inside the pinned CLI,
   * which WRITES — and therefore creates — every product home in its 77-agent
   * registry. The argv now names the agents genie detected, so a host that has
   * never installed OpenClaw never grows a `~/.openclaw`.
   */
  test('names the detected agents explicitly and never passes --all', () => {
    expect(buildSkillsAddArgv({ sourceRoot: '/home/u/.genie/skills', agents: ['claude-code', 'codex'] })).toEqual([
      'npx',
      '-y',
      'skills@1.5.23',
      'add',
      '/home/u/.genie/skills',
      '--skill',
      '*',
      '--agent',
      'claude-code',
      'codex',
      '-y',
      '--copy',
      '-g',
    ]);
    expect(buildSkillsAddArgv({ sourceRoot: '/x', agents: ['claude-code'] })).not.toContain('--all');
  });

  test('the CLI version is pinned to the verified release (wish decision 1)', () => {
    expect(SKILLS_CLI_VERSION).toBe('1.5.23');
  });

  test('the source root is the delivered tree under GENIE_HOME, never a GitHub ref', () => {
    // skills@1.5.23 IGNORES `@<ref>` and serves the default branch, so a GitHub
    // source is not a pin at all; the delivered tree is (wish B decision 1).
    expect(skillsSourceRoot('/home/u/.genie')).toBe('/home/u/.genie/skills');
    const argv = buildSkillsAddArgv({ sourceRoot: skillsSourceRoot('/home/u/.genie'), agents: ['claude-code'] });
    expect(argv.join(' ')).not.toContain('automagik-dev');
    expect(argv[4]).toBe('/home/u/.genie/skills');
  });

  test('a version that already carries the v prefix is not double-prefixed', () => {
    expect(releaseTag('v5.260830.16')).toBe('v5.260830.16');
    expect(releaseTag('5.260830.16')).toBe('v5.260830.16');
  });

  /**
   * The remedy is COPY-PASTED into a shell. An unquoted `*` expands against the
   * operator's cwd, so the pasted command installs whatever files happen to sit
   * there instead of the `--skill '*'` CLAUDE.md documents (r2 X2 secondary).
   */
  test('the remedy line is the argv verbatim, shell-quoted so a paste reproduces it', () => {
    expect(skillsInstallRemedy('/home/u/.genie/skills', ['claude-code'])).toBe(
      "Run: npx -y skills@1.5.23 add /home/u/.genie/skills --skill '*' --agent claude-code -y --copy -g",
    );
    // Quoting is by shape, not by position: an ordinary path stays bare.
    expect(skillsInstallRemedy('/home/u/.genie/skills', ['claude-code'])).toContain(
      'add /home/u/.genie/skills --skill',
    );
    // A home with a space is quoted too, so the paste still names one path.
    expect(skillsInstallRemedy('/home/my genie/skills', ['codex'])).toContain("add '/home/my genie/skills'");
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
    // A bare `~/.codex` is NOT a skill home: skills.sh creates no `.codex/skills`
    // (the fixture home already has one — it is what makes `codex` a detected
    // agent that writes the shared `~/.agents/skills`).
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
      [
        'npx',
        '-y',
        'skills@1.5.23',
        'add',
        join(genieHome, 'skills'),
        '--skill',
        '*',
        '--agent',
        'claude-code',
        'codex',
        '-y',
        '--copy',
        '-g',
      ],
    ]);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok === true && outcome.record).toEqual({
      ref: 'v5.260830.16',
      source: `local:${join(genieHome, 'skills')}`,
      cliVersion: '1.5.23',
      inventory: ['wish', 'work'],
      agentDirs: [claudeSkills, agentsSkills],
      dirDigests: expectedDigests,
      // The durable proof that this run named its agents explicitly and created
      // no product home — what keeps the next run's prune off `~/.claude`.
      agentSelection: 'explicit',
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
      `Run: npx -y skills@1.5.23 add ${join(genieHome, 'skills')} --skill '*' --agent claude-code codex -y --copy -g`,
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
    expect(outcome.ok && outcome.record.collisions).toEqual([
      { dir: join(claudeSkills, 'wish'), skill: 'wish', kind: 'foreign' },
    ]);
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
    expect(outcome.ok && outcome.record.collisions).toEqual([
      { dir: join(astrbot, 'wish'), skill: 'wish', kind: 'foreign' },
    ]);
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
    // The record puts a genie skill dir at exactly this path, so whatever its
    // bytes say now it is genie's own — `modified`, never `foreign`.
    expect(outcome.ok && outcome.record.collisions).toEqual([
      { dir: join(astrbot, 'wish'), skill: 'wish', kind: 'modified' },
    ]);
    const line = (outcome.ok ? (outcome.warnings ?? []) : []).find((entry) =>
      entry.includes('was modified locally'),
    ) as string;
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
    expect(outcome.ok && outcome.record.collisions).toEqual([
      { dir: join(astrbot, 'wish'), skill: 'wish', kind: 'foreign' },
    ]);
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
    // The post-install probe never recognized the home (its `review` is stale),
    // so only the recorded digest justified the backup. `.astrbot` exists, so
    // AstrBot is a detected agent this run targeted — hence the recorded home.
    expect(outcome.ok && outcome.record.agentDirs).toContain(astrbot);
    expect(outcome.ok && outcome.record.collisions).toEqual([
      { dir: join(astrbot, 'wish'), skill: 'wish', kind: 'foreign' },
    ]);
    const line = (outcome.ok ? (outcome.warnings ?? []) : []).find((entry) => entry.includes('collision:')) as string;
    const backupRoot = line.split('backed up to ')[1] as string;
    expect(readFileSync(join(backupRoot, '.astrbot', 'data', 'skills', 'wish', 'SKILL.md'), 'utf8')).toBe(
      "# the user's OWN wish skill\n",
    );
  });

  /**
   * X1 (r2 §3.2 A). `state-backups/` is an ARCHIVE: a root written by a
   * previous run is never deleted, moved or rewritten by a later one — not even
   * one a redundancy test judges "protects nothing", and least of all by a run
   * that installed nothing. The deleted `pruneCollisionBackups` did exactly
   * that, silently, and destroyed the dogfood host's hop-1 root.
   */
  test('a later run never deletes a pre-existing collision backup root, redundant or not', () => {
    fixtureSkillsTree(['wish']);
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    const backups = join(genieHome, 'state-backups');
    // Root 1: byte-identical to the live original — the shape the old prune
    // judged redundant and removed.
    const redundant = join(backups, 'skills-collision-2020-01-01T00-00-00-000Z');
    // Root 2: bytes nothing else on disk has.
    const divergent = join(backups, 'skills-collision-2020-01-02T00-00-00-000Z');
    const strayLive = join(home, 'workspace', 'skills', 'wish');
    mkdirSync(strayLive, { recursive: true });
    writeFileSync(join(strayLive, 'SKILL.md'), '# someone else\n', 'utf8');
    mkdirSync(join(redundant, 'workspace', 'skills', 'wish'), { recursive: true });
    writeFileSync(join(redundant, 'workspace', 'skills', 'wish', 'SKILL.md'), '# someone else\n', 'utf8');
    mkdirSync(join(divergent, '.claude', 'skills', 'wish'), { recursive: true });
    writeFileSync(join(divergent, '.claude', 'skills', 'wish', 'SKILL.md'), '# bytes nothing else has\n', 'utf8');

    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: deliveringOkRunner({ argv: [] }),
    });

    expect(outcome.ok).toBe(true);
    expect(readFileSync(join(redundant, 'workspace', 'skills', 'wish', 'SKILL.md'), 'utf8')).toBe('# someone else\n');
    expect(readFileSync(join(divergent, '.claude', 'skills', 'wish', 'SKILL.md'), 'utf8')).toBe(
      '# bytes nothing else has\n',
    );

    // …and a FAILING run destroys nothing either: the sandbox reproduction of
    // the host incident had the skills install exit 1 while the root vanished.
    const failed = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: () => ({ exitCode: 1, stdout: '', stderr: 'Local path does not exist\n' }),
    });
    expect(failed.ok).toBe(false);
    expect(existsSync(redundant)).toBe(true);
    expect(existsSync(divergent)).toBe(true);
    expect(readFileSync(join(redundant, 'workspace', 'skills', 'wish', 'SKILL.md'), 'utf8')).toBe('# someone else\n');
  });

  /** X1: anything the CURRENT run keeps is named on stdout, with a count. */
  test('a kept collision backup root is named on stdout with the number of replaced dirs', () => {
    const source = fixtureSkillsTree(['wish']);
    const claudeSkills = join(home, '.claude', 'skills');
    mkdirSync(join(claudeSkills, 'wish'), { recursive: true });
    writeFileSync(join(claudeSkills, 'wish', 'SKILL.md'), "# the user's OWN wish skill\n", 'utf8');

    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: (command, args, options) => {
        cpSync(source, claudeSkills, { recursive: true });
        return deliveringOkRunner({ argv: [] })(command, args, options);
      },
    });

    expect(outcome.ok).toBe(true);
    const kept = (outcome.warnings ?? []).find((line) => line.startsWith('skills: collision backup kept at '));
    expect(kept).toBeDefined();
    const root = collisionBackupRoots()[0] as string;
    expect(kept).toBe(`skills: collision backup kept at ${root} (1 replaced dir(s))`);
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

  /**
   * X4 (r2 §3.3 #5). On a cold npx cache npm writes `npm notice`/`npm warn` to
   * STDERR while the skills CLI writes its real error to STDOUT, so the
   * unfiltered "last stderr line" rule diagnosed every fresh machine with
   * `skills CLI exited 1: npm notice.` — a different message for the very same
   * failure once the cache was warm.
   */
  test('npm progress chatter never becomes the diagnosis; the real error does', () => {
    fixtureSkillsTree(['wish']);
    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: () => ({
        exitCode: 1,
        stdout: `Local path does not exist: ${join(genieHome, 'skills')}\n`,
        stderr: 'npm warn exec The following package was not found\nnpm notice\nnpm notice New minor version\n',
      }),
    });
    expect(outcome.ok === false && outcome.reason).toBe(
      `skills CLI exited 1: Local path does not exist: ${join(genieHome, 'skills')}`,
    );
  });

  test('a real stderr error still wins even when npm chatter follows it', () => {
    fixtureSkillsTree(['wish']);
    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: () => ({
        exitCode: 1,
        stdout: 'resolving\n',
        stderr: 'npm notice\nError: EACCES permission denied\nnpm notice New minor version\n',
      }),
    });
    expect(outcome.ok === false && outcome.reason).toBe('skills CLI exited 1: Error: EACCES permission denied');
    // `npm ERR!` is a REAL failure line, never chatter.
    expect(isNpmChatterLine('npm ERR! code E404')).toBe(false);
    expect(isNpmChatterLine('  npm notice ')).toBe(true);
    expect(isNpmChatterLine('npm warn exec')).toBe(true);
  });

  test('chatter-only output on both streams still names the last line it has', () => {
    fixtureSkillsTree(['wish']);
    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: () => ({ exitCode: 1, stdout: '', stderr: 'npm notice\nnpm notice cached\n' }),
    });
    expect(outcome.ok === false && outcome.reason).toBe('skills CLI exited 1: npm notice cached');
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
    expect(outcome.ok === false && outcome.remedy).toBe(
      skillsInstallRemedy(join(genieHome, 'skills'), ['claude-code', 'codex']),
    );
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

    // Four directories are opened or considered: `$HOME`, `.claude`, the
    // `skills` home itself and the fixture's `.codex` product root. `.genie` and
    // everything under it is pruned whole.
    const scan = scanSkillsHomes({ home, sourceRoot: source, genieHome, maxDirs: 4 });

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
        kind: 'foreign',
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

  /**
   * X3 (r2 §3.3 #14). An ABSENT record is `null`; a record that is THERE but
   * unreadable is a typed throw, so no consumer can mistake "genie cannot read
   * its own receipt" for "nothing was ever installed".
   */
  test('an absent record reads as null; a malformed one throws a typed error naming the field', () => {
    expect(readSkillsInstallRecord(genieHome)).toBeNull();
    expect(inspectSkillsInstallRecord(genieHome)).toEqual({ status: 'absent' });

    writeFileSync(skillsInstallRecordPath(genieHome), '{ not json', 'utf8');
    expect(() => readSkillsInstallRecord(genieHome)).toThrow(SkillsInstallRecordError);

    // The dogfood shape: one schema-invalid `preserved[]` entry beside a valid
    // one. It used to void the whole record silently.
    writeFileSync(
      skillsInstallRecordPath(genieHome),
      JSON.stringify({
        ref: 'v1',
        cliVersion: '1.5.23',
        inventory: ['wish'],
        agentDirs: [join(home, '.claude', 'skills')],
        preserved: [
          { agentDir: join(home, '.claude', 'skills'), skill: 'work', reason: 'user-edited' },
          { agentDir: join(home, '.claude', 'skills'), skill: '../../../etc', reason: 'traversal' },
        ],
        installedAt: 'now',
      }),
      'utf8',
    );
    const read = inspectSkillsInstallRecord(genieHome);
    expect(read.status).toBe('invalid');
    const error = read.status === 'invalid' ? read.error : null;
    expect(error).toBeInstanceOf(SkillsInstallRecordError);
    expect(error?.field).toBe('preserved.1.skill');
    expect(error?.path).toBe(skillsInstallRecordPath(genieHome));
    expect(error?.message).toContain(skillsInstallRecordPath(genieHome));
    expect(error?.message).toContain('preserved.1.skill');

    // And the installer refuses rather than installing over a record it cannot
    // read (which would widen what a later uninstall silently misses).
    fixtureSkillsTree(['wish']);
    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: okRunner({ argv: [] }),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('preserved.1.skill');
  });

  test('a traversal-carrying record is malformed too, never silently empty', () => {
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
    expect(() => readSkillsInstallRecord(genieHome)).toThrow(/inventory\.0/);

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
    expect(() => readSkillsInstallRecord(genieHome)).toThrow(/agentDirs\.0/);
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

  test('an agentDir carrying a .. segment is malformed even though it is absolute', () => {
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
    expect(() => readSkillsInstallRecord(genieHome)).toThrow(/agentDirs\.0/);
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

/**
 * The workflows channel writes ONE optional field into this record (wish
 * `global-workflows-local-mikro`, decision 4), and the skills channel — which
 * runs FIRST and rewrites the whole document — must carry it forward. Both
 * halves are regression tests: a required field would invalidate every record
 * already on disk, and a dropped one would orphan every installed workflow file
 * because `genie uninstall` removes only what the record names.
 */
describe('install record — the optional workflows field', () => {
  const workflows = {
    dir: '/home/u/.claude/workflows',
    ref: 'v5.260918.9',
    files: { 'wish.js': 'a'.repeat(64) },
  };

  /** The delivered tree, plus the post-install state the fake spawner cannot write. */
  function seedInstalledSkill(): void {
    fixtureSkillsTree(['wish']);
    for (const parent of [join(home, '.claude', 'skills'), join(home, '.agents', 'skills')]) {
      mkdirSync(join(parent, 'wish'), { recursive: true });
      writeFileSync(join(parent, 'wish', 'SKILL.md'), '# wish\n', 'utf8');
    }
  }

  function legacyRecordWithoutWorkflows(): SkillsInstallRecord {
    return {
      ref: 'v5.260830.16',
      cliVersion: SKILLS_CLI_VERSION,
      inventory: ['wish'],
      agentDirs: [join(home, '.claude', 'skills')],
      installedAt: '2026-08-30T12:00:00.000Z',
    };
  }

  test('a record without the field still parses, and reads back without it', () => {
    const legacy = legacyRecordWithoutWorkflows();
    writeFileSync(skillsInstallRecordPath(genieHome), JSON.stringify(legacy), 'utf8');
    const read = readSkillsInstallRecord(genieHome);
    expect(read).toEqual(legacy);
    expect(read?.workflows).toBeUndefined();
  });

  test('a record with the field round-trips', () => {
    const record: SkillsInstallRecord = { ...legacyRecordWithoutWorkflows(), workflows };
    writeSkillsInstallRecord(genieHome, record);
    expect(readSkillsInstallRecord(genieHome)).toEqual(record);
  });

  test('the field is traversal-proof and digest-typed, or the record is malformed', () => {
    for (const [invalid, field] of [
      [{ ...workflows, dir: 'relative/workflows' }, 'workflows.dir'],
      [{ ...workflows, dir: '/home/u/../../etc' }, 'workflows.dir'],
      [{ ...workflows, files: { '../../evil.js': 'a'.repeat(64) } }, 'workflows.files'],
      [{ ...workflows, files: { 'wish.md': 'a'.repeat(64) } }, 'workflows.files'],
      [{ ...workflows, files: { 'wish.js': 'NOTADIGEST' } }, 'workflows.files'],
    ] as const) {
      writeFileSync(
        skillsInstallRecordPath(genieHome),
        JSON.stringify({ ...legacyRecordWithoutWorkflows(), workflows: invalid }),
        'utf8',
      );
      const read = inspectSkillsInstallRecord(genieHome);
      expect(read.status).toBe('invalid');
      expect(read.status === 'invalid' ? read.error.field : '').toContain(field);
    }
  });

  test('a skills-channel install carries an existing workflows value forward verbatim', () => {
    writeSkillsInstallRecord(genieHome, { ...legacyRecordWithoutWorkflows(), workflows });
    seedInstalledSkill();

    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: okRunner({ argv: [] }),
    });

    expect(outcome.ok).toBe(true);
    // Rewritten document, untouched field — and it survives on disk, which is
    // what `genie doctor` and `genie uninstall` read back.
    expect(outcome.ok === true && outcome.record.workflows).toEqual(workflows);
    expect(readSkillsInstallRecord(genieHome)?.workflows).toEqual(workflows);
  });

  test('a skills-channel install over a record without the field writes no field', () => {
    seedInstalledSkill();
    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: okRunner({ argv: [] }),
    });
    expect(outcome.ok === true && outcome.record.workflows).toBeUndefined();
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

  /**
   * Wish decision 3 still holds — every non-`none` selection installs to every
   * DETECTED agent — but the widening stops at detection (X2): the argv names
   * those agents, so no consent level can materialize a product home.
   */
  test('every non-none selection installs to the detected agents, never --all', () => {
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
      expect(calls.argv[0]).not.toContain('--all');
      expect(calls.argv[0]?.slice(calls.argv[0].indexOf('--agent') + 1, -3)).toEqual(['claude-code', 'codex']);
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
      `Skills install failed: skills CLI exited 1: boom. Run: npx -y skills@1.5.23 add ${join(genieHome, 'skills')} --skill '*' --agent claude-code codex -y --copy -g`,
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
      '--skill',
      '*',
      '--agent',
      'claude-code',
      'codex',
      '-y',
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
    // `$4` is the source root in
    // `npx -y skills@<v> add <src> --skill * --agent <names…> -y --copy -g`.
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
    expect(record?.collisions).toEqual([{ dir: join(claudeSkills, 'wish'), skill: 'wish', kind: 'foreign' }]);
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

/**
 * X2 (r2 §3.2 B / M3). `genie install --integrations <all|claude|codex|auto>`
 * used to pass `--all`, which the pinned CLI expands to `--agent '*'` — it wrote
 * (and therefore CREATED) ~53 product homes the operator had never installed,
 * `~/.openclaw` among them, and recorded all 57 in `agentDirs`.
 */
describe('agent selection never creates a product home', () => {
  /** A runner that behaves like `skills add … --agent <names> -g`: it writes ONLY those homes. */
  function agentAwareRunner(record: { argv: string[][] }): CommandRunner {
    return (command, args) => {
      record.argv.push([command, ...args]);
      const source = args[args.indexOf('add') + 1] as string;
      const named = args.slice(args.indexOf('--agent') + 1);
      for (const agent of named) {
        if (agent.startsWith('-')) break;
        const spec = SKILLS_CLI_AGENTS.find((entry) => entry.agent === agent);
        if (spec === undefined) throw new Error(`unknown agent: ${agent}`);
        const target = agentSkillsHome(home, spec);
        mkdirSync(target, { recursive: true });
        cpSync(source, target, { recursive: true });
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
  }

  test('a home with only .claude and .codex gets exactly those two skill homes', () => {
    fixtureSkillsTree(['wish']);
    const before = readdirSync(home).sort();
    const calls = { argv: [] as string[][] };

    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: agentAwareRunner(calls),
    });

    expect(outcome.ok).toBe(true);
    const argv = calls.argv[0] as string[];
    expect(argv.slice(argv.indexOf('--agent') + 1, argv.indexOf('-y', argv.indexOf('--agent')))).toEqual([
      'claude-code',
      'codex',
    ]);
    // No product home appeared that was not there before the run.
    expect(readdirSync(home).sort()).toEqual([...before, '.agents'].sort());
    expect(existsSync(join(home, '.openclaw'))).toBe(false);
    expect(existsSync(join(home, '.adal'))).toBe(false);
    expect(existsSync(join(home, '.qwen'))).toBe(false);
    // `.agents` is the shared canonical home Codex reads, not a product home.
    expect(outcome.ok === true && outcome.record.agentDirs.sort()).toEqual(
      [join(home, '.claude', 'skills'), join(home, '.agents', 'skills')].sort(),
    );
  });

  test('a recorded genie-only product home is pruned backup-first and reported', () => {
    fixtureSkillsTree(['wish']);
    // The shape `--all` left behind: a product home holding nothing but the
    // `skills/` dir genie wrote, every entry a recorded, digest-matching skill.
    const openclaw = join(home, '.openclaw', 'skills');
    mkdirSync(join(openclaw, 'wish'), { recursive: true });
    writeFileSync(join(openclaw, 'wish', 'SKILL.md'), '# wish\n', 'utf8');
    const claudeSkills = join(home, '.claude', 'skills');
    mkdirSync(join(claudeSkills, 'wish'), { recursive: true });
    writeFileSync(join(claudeSkills, 'wish', 'SKILL.md'), '# wish\n', 'utf8');
    writeSkillsInstallRecord(genieHome, {
      ref: 'v5.260915.1',
      cliVersion: SKILLS_CLI_VERSION,
      inventory: ['wish'],
      agentDirs: [claudeSkills, openclaw],
      dirDigests: {
        [join(claudeSkills, 'wish')]: computeSkillDirDigest(join(claudeSkills, 'wish')) as string,
        [join(openclaw, 'wish')]: computeSkillDirDigest(join(openclaw, 'wish')) as string,
      },
      installedAt: '2026-09-15T00:00:00.000Z',
    });

    const calls = { argv: [] as string[][] };
    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: agentAwareRunner(calls),
      now: () => new Date('2026-09-16T00:00:00.000Z'),
    });

    expect(outcome.ok).toBe(true);
    // Gone from disk, and its bytes are in the backup root — never deleted.
    expect(existsSync(join(home, '.openclaw'))).toBe(false);
    const backupRoot = join(genieHome, 'state-backups', 'skills-prune-2026-09-16T00-00-00-000Z');
    expect(readFileSync(join(backupRoot, '.openclaw', 'skills', 'wish', 'SKILL.md'), 'utf8')).toBe('# wish\n');
    // One line per home, plus a summary.
    expect(outcome.warnings).toContain(
      `skills: pruned genie-created agent home ${join(home, '.openclaw')} — backed up to ${join(backupRoot, '.openclaw')}`,
    );
    expect(
      (outcome.warnings ?? []).some((line) => line.startsWith('skills: pruned 1 genie-created agent home(s)')),
    ).toBe(true);
    // Dropped from the record, and never named in the argv again.
    expect(outcome.ok === true && outcome.record.agentDirs).not.toContain(openclaw);
    expect(calls.argv[0]).not.toContain('openclaw');
  });

  test('a recorded home holding one foreign file is never touched', () => {
    fixtureSkillsTree(['wish']);
    const openclaw = join(home, '.openclaw', 'skills');
    mkdirSync(join(openclaw, 'wish'), { recursive: true });
    writeFileSync(join(openclaw, 'wish', 'SKILL.md'), '# wish\n', 'utf8');
    // One file of the product's own anywhere under the product root.
    writeFileSync(join(home, '.openclaw', 'config.json'), '{}\n', 'utf8');
    writeSkillsInstallRecord(genieHome, {
      ref: 'v5.260915.1',
      cliVersion: SKILLS_CLI_VERSION,
      inventory: ['wish'],
      agentDirs: [openclaw],
      dirDigests: { [join(openclaw, 'wish')]: computeSkillDirDigest(join(openclaw, 'wish')) as string },
      installedAt: '2026-09-15T00:00:00.000Z',
    });

    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: agentAwareRunner({ argv: [] }),
    });

    expect(outcome.ok).toBe(true);
    expect(readFileSync(join(home, '.openclaw', 'config.json'), 'utf8')).toBe('{}\n');
    expect(existsSync(join(openclaw, 'wish'))).toBe(true);
    expect((outcome.warnings ?? []).filter((line) => line.includes('pruned'))).toEqual([]);
  });

  test('a skill dir whose content drifted keeps its whole product home', () => {
    fixtureSkillsTree(['wish']);
    const openclaw = join(home, '.openclaw', 'skills');
    mkdirSync(join(openclaw, 'wish'), { recursive: true });
    writeFileSync(join(openclaw, 'wish', 'SKILL.md'), '# wish\n', 'utf8');
    const digest = computeSkillDirDigest(join(openclaw, 'wish')) as string;
    writeSkillsInstallRecord(genieHome, {
      ref: 'v5.260915.1',
      cliVersion: SKILLS_CLI_VERSION,
      inventory: ['wish'],
      agentDirs: [openclaw],
      dirDigests: { [join(openclaw, 'wish')]: digest },
      installedAt: '2026-09-15T00:00:00.000Z',
    });
    writeFileSync(join(openclaw, 'wish', 'SKILL.md'), '# my own edit\n', 'utf8');

    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: agentAwareRunner({ argv: [] }),
    });

    expect(outcome.ok).toBe(true);
    // Not proven genie's, so the home is kept (the install then refreshes the
    // skills inside it, exactly as `--copy` always has).
    expect(existsSync(join(home, '.openclaw'))).toBe(true);
    expect((outcome.warnings ?? []).filter((line) => line.includes('pruned'))).toEqual([]);
    expect(outcome.ok === true && outcome.record.agentDirs).toContain(openclaw);
  });

  /**
   * r2 verify §6 — the prune's second-run destruction.
   *
   * After a correct install an operator's own `~/.claude` holds nothing but the
   * `skills/` dir genie wrote, which is byte-for-byte what a genie-MATERIALIZED
   * home looks like. A content-only ownership proof therefore handed the
   * operator's real home back on the second run of the identical command:
   * install → update → the agent's skills are gone. The record's
   * `agentSelection` is the fact that tells the two apart.
   */
  test('a second run never hands back a product home this release installed into', () => {
    fixtureSkillsTree(['wish']);
    // The sb1 fixture: `~/.claude` with nothing of the product's own in it, so
    // only the record can say who created it.
    rmSync(join(home, '.claude', 'settings.json'));

    const first = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: agentAwareRunner({ argv: [] }),
    });
    expect(first.ok).toBe(true);
    expect(first.ok === true && first.record.agentSelection).toBe('explicit');
    expect(first.ok === true && first.record.agentDirs).toContain(join(home, '.claude', 'skills'));

    const second = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: agentAwareRunner({ argv: [] }),
    });

    expect(second.ok).toBe(true);
    expect((second.warnings ?? []).filter((line) => line.includes('pruned'))).toEqual([]);
    expect(existsSync(join(home, '.claude', 'skills', 'wish', 'SKILL.md'))).toBe(true);
    expect(second.ok === true && second.record.agentDirs).toContain(join(home, '.claude', 'skills'));
    expect(existsSync(join(genieHome, 'state-backups'))).toBe(false);
  });

  /**
   * r2 verify §7 — the same defect on a two-product host, where run 2 pruned
   * BOTH roots and then reported `no agent skill home detected`, leaving the
   * record pointing at two archived homes and `genie update` a permanent no-op.
   */
  test('a second run on a two-product host keeps both homes and stays installable', () => {
    fixtureSkillsTree(['wish']);
    rmSync(join(home, '.claude', 'settings.json'));
    rmSync(join(home, '.codex'), { recursive: true });
    mkdirSync(join(home, '.qwen'), { recursive: true });

    const runner = agentAwareRunner({ argv: [] });
    const first = runSkillsInstall({ version: VERSION_UNDER_TEST, genieHome, home, which: alwaysFound, spawn: runner });
    expect(first.ok === true && first.record.agentDirs.sort()).toEqual(
      [join(home, '.claude', 'skills'), join(home, '.qwen', 'skills')].sort(),
    );

    const second = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: runner,
    });

    expect(second.ok).toBe(true);
    expect(existsSync(join(home, '.claude', 'skills', 'wish'))).toBe(true);
    expect(existsSync(join(home, '.qwen', 'skills', 'wish'))).toBe(true);
    expect(second.ok === true && second.record.agentDirs.sort()).toEqual(
      [join(home, '.claude', 'skills'), join(home, '.qwen', 'skills')].sort(),
    );
  });

  /**
   * The prune is a ONE-SHOT migration off the `--all` era, so it reads an
   * `--all` era record (one without `agentSelection`) and never a record this
   * release wrote.
   */
  test('a record this release wrote is never eligible for the prune', () => {
    fixtureSkillsTree(['wish']);
    const openclaw = join(home, '.openclaw', 'skills');
    mkdirSync(join(openclaw, 'wish'), { recursive: true });
    writeFileSync(join(openclaw, 'wish', 'SKILL.md'), '# wish\n', 'utf8');
    const base = {
      ref: 'v5.260915.1',
      cliVersion: SKILLS_CLI_VERSION,
      inventory: ['wish'],
      agentDirs: [openclaw],
      dirDigests: { [join(openclaw, 'wish')]: computeSkillDirDigest(join(openclaw, 'wish')) as string },
      installedAt: '2026-09-15T00:00:00.000Z',
    } satisfies SkillsInstallRecord;
    writeSkillsInstallRecord(genieHome, { ...base, agentSelection: 'explicit' });

    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: agentAwareRunner({ argv: [] }),
    });

    expect(outcome.ok).toBe(true);
    expect(existsSync(join(home, '.openclaw'))).toBe(true);
    expect((outcome.warnings ?? []).filter((line) => line.includes('pruned'))).toEqual([]);
    // The identical record WITHOUT the field is `--all` era, and IS pruned.
    writeSkillsInstallRecord(genieHome, base);
    const legacy = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: agentAwareRunner({ argv: [] }),
    });
    expect(legacy.ok).toBe(true);
    expect(existsSync(join(home, '.openclaw'))).toBe(false);
  });

  /**
   * r2 verify §7, second half: the no-agent early return fires BEFORE the record
   * write, so a run that pruned every recorded home left the record naming them
   * all. Doctor then warned `0/n recorded homes complete … (not on disk)` and
   * prescribed `genie update`, which now reports `skipped` forever.
   */
  test('a prune that leaves no agent still drops the pruned homes from the record', () => {
    const bareHome = join(root, 'legacy-home');
    const bareGenieHome = join(bareHome, '.genie');
    mkdirSync(join(bareGenieHome, 'skills', 'wish'), { recursive: true });
    writeFileSync(join(bareGenieHome, 'skills', 'wish', 'SKILL.md'), '# wish\n', 'utf8');
    const openclaw = join(bareHome, '.openclaw', 'skills');
    mkdirSync(join(openclaw, 'wish'), { recursive: true });
    writeFileSync(join(openclaw, 'wish', 'SKILL.md'), '# wish\n', 'utf8');
    // An `--all` era record: no `agentSelection`, so the prune is eligible.
    writeSkillsInstallRecord(bareGenieHome, {
      ref: 'v5.260915.1',
      cliVersion: SKILLS_CLI_VERSION,
      inventory: ['wish'],
      agentDirs: [openclaw],
      dirDigests: { [join(openclaw, 'wish')]: computeSkillDirDigest(join(openclaw, 'wish')) as string },
      installedAt: '2026-09-15T00:00:00.000Z',
    });

    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome: bareGenieHome,
      home: bareHome,
      which: alwaysFound,
      spawn: agentAwareRunner({ argv: [] }),
      now: () => new Date('2026-09-16T00:00:00.000Z'),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.noAgents).toBe(true);
    expect(existsSync(join(bareHome, '.openclaw'))).toBe(false);
    const record = readSkillsInstallRecord(bareGenieHome) as SkillsInstallRecord;
    expect(record.agentDirs).toEqual([]);
    expect(record.dirDigests).toEqual({});
    // Stamped, so the prune never runs a second time against this record.
    expect(record.agentSelection).toBe('explicit');

    const again = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome: bareGenieHome,
      home: bareHome,
      which: alwaysFound,
      spawn: agentAwareRunner({ argv: [] }),
    });
    expect((again.warnings ?? []).filter((line) => line.includes('pruned'))).toEqual([]);
  });

  test('a host with no agent installed skips the channel instead of inventing a home', () => {
    const savedExitCode = process.exitCode;
    const bareHome = join(root, 'bare-home');
    const bareGenieHome = join(bareHome, '.genie');
    mkdirSync(join(bareGenieHome, 'skills', 'wish'), { recursive: true });
    writeFileSync(join(bareGenieHome, 'skills', 'wish', 'SKILL.md'), '# wish\n', 'utf8');
    const lines: string[] = [];
    try {
      process.exitCode = 0;
      const result = runSkillsChannelConvergence({
        selection: 'auto',
        version: VERSION_UNDER_TEST,
        genieHome: bareGenieHome,
        home: bareHome,
        which: alwaysFound,
        spawn: agentAwareRunner({ argv: [] }),
        log: (line) => lines.push(line),
      });
      expect(result.status).toBe('skipped');
      expect(lines[0]).toContain('no agent skill home detected');
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = savedExitCode;
    }
    expect(readdirSync(bareHome)).toEqual(['.genie']);
  });
});

/**
 * The r3 dogfood rehearsal defects, one regression test each (BRIEF4 D1–D6).
 * Every one of these was observed on a replica of the 2026-09-15 host before it
 * was written down here.
 */
describe('r3 rehearsal defects', () => {
  const RECORD_BASE = { cliVersion: SKILLS_CLI_VERSION, installedAt: '2026-09-15T00:00:00.000Z' } as const;

  /** `skills add … --agent <names> -g`: writes ONLY the named agents' homes. */
  function agentAwareRunner(record: { argv: string[][] } = { argv: [] }): CommandRunner {
    return (command, args) => {
      record.argv.push([command, ...args]);
      const source = args[args.indexOf('add') + 1] as string;
      for (const agent of args.slice(args.indexOf('--agent') + 1)) {
        if (agent.startsWith('-')) break;
        const spec = SKILLS_CLI_AGENTS.find((entry) => entry.agent === agent);
        if (spec === undefined) throw new Error(`unknown agent: ${agent}`);
        const target = agentSkillsHome(home, spec);
        mkdirSync(target, { recursive: true });
        cpSync(source, target, { recursive: true });
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
  }

  function seedSkillDir(dir: string, body: string): string {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), body, 'utf8');
    return computeSkillDirDigest(dir) as string;
  }

  function warningsOf(outcome: ReturnType<typeof runSkillsInstall>): string[] {
    return outcome.warnings ?? [];
  }

  // D1 ----------------------------------------------------------------------
  /**
   * `isGenieOwned` accepted byte-equality with the NEW delivered `SKILL.md` or
   * the PREVIOUS recorded digest — both proofs of an UNCHANGED dir. A genie
   * skill dir that drifted locally AND changed upstream failed both, so genie
   * told the operator their own edited skill was "a foreign skill dir that
   * changed while this install ran" and recorded it that way.
   */
  test('a recorded skill dir that drifted locally AND changed upstream reports as modified, not foreign', () => {
    fixtureSkillsTree(['wish']);
    const claudeSkills = join(home, '.claude', 'skills');
    const wish = join(claudeSkills, 'wish');
    // Genie's own delivery from the PREVIOUS release: upstream has moved on, so
    // it is not byte-equal to the delivered tree either.
    const digest = seedSkillDir(wish, '# wish (previous release)\n');
    writeSkillsInstallRecord(genieHome, {
      ...RECORD_BASE,
      ref: 'v5.260915.1',
      inventory: ['wish'],
      agentDirs: [claudeSkills],
      dirDigests: { [wish]: digest },
    });
    // …and then the operator edited it, so the recorded digest no longer holds.
    writeFileSync(join(wish, 'NOTES.md'), 'my own notes\n', 'utf8');

    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: deliveringOkRunner({ argv: [] }),
      now: () => new Date('2026-09-16T00:00:00.000Z'),
    });

    expect(outcome.ok).toBe(true);
    const backupRoot = join(genieHome, 'state-backups', 'skills-collision-2026-09-16T00-00-00-000Z');
    expect(warningsOf(outcome)).toContain(
      `skills: genie skill dir ${wish} was modified locally — previous contents backed up to ${backupRoot}`,
    );
    expect(warningsOf(outcome).some((line) => line.includes('a foreign skill dir'))).toBe(false);
    expect(outcome.ok === true && outcome.record.collisions).toEqual([{ dir: wish, skill: 'wish', kind: 'modified' }]);
    // Still backup-first: the operator's bytes are kept, whatever it is called.
    expect(readFileSync(join(backupRoot, '.claude', 'skills', 'wish', 'NOTES.md'), 'utf8')).toBe('my own notes\n');
  });

  // D2 ----------------------------------------------------------------------
  /**
   * `~/.astrbot/data/skills`: the parent-only product root left the genie-made
   * `~/.astrbot` above it looking like independent product evidence, so the
   * whole phantom chain was kept on every run.
   */
  test('a nested single-entry ancestor chain is pruned as a whole', () => {
    fixtureSkillsTree(['wish']);
    const astrbot = join(home, '.astrbot', 'data', 'skills');
    const digest = seedSkillDir(join(astrbot, 'wish'), '# wish\n');
    writeSkillsInstallRecord(genieHome, {
      ...RECORD_BASE,
      ref: 'v5.260915.1',
      inventory: ['wish'],
      agentDirs: [astrbot],
      dirDigests: { [join(astrbot, 'wish')]: digest },
    });

    const calls = { argv: [] as string[][] };
    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: agentAwareRunner(calls),
      now: () => new Date('2026-09-16T00:00:00.000Z'),
    });

    expect(outcome.ok).toBe(true);
    expect(existsSync(join(home, '.astrbot'))).toBe(false);
    const backupRoot = join(genieHome, 'state-backups', 'skills-prune-2026-09-16T00-00-00-000Z');
    expect(readFileSync(join(backupRoot, '.astrbot', 'data', 'skills', 'wish', 'SKILL.md'), 'utf8')).toBe('# wish\n');
    expect(warningsOf(outcome)).toContain(
      `skills: pruned genie-created agent home ${join(home, '.astrbot')} — backed up to ${join(backupRoot, '.astrbot')}`,
    );
    expect(outcome.ok === true && outcome.record.agentDirs).not.toContain(astrbot);
    expect(calls.argv[0]).not.toContain('astrbot');
  });

  test('a chain whose ancestor holds a second entry is kept, product root and skills alike', () => {
    fixtureSkillsTree(['wish']);
    const tabnine = join(home, '.tabnine', 'agent', 'skills');
    const digest = seedSkillDir(join(tabnine, 'wish'), '# wish\n');
    // One file of the product's own, one level above the single-entry chain.
    writeFileSync(join(home, '.tabnine', 'config.json'), '{}\n', 'utf8');
    writeSkillsInstallRecord(genieHome, {
      ...RECORD_BASE,
      ref: 'v5.260915.1',
      inventory: ['wish'],
      agentDirs: [tabnine],
      dirDigests: { [join(tabnine, 'wish')]: digest },
    });

    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: agentAwareRunner(),
    });

    expect(outcome.ok).toBe(true);
    expect(readFileSync(join(home, '.tabnine', 'config.json'), 'utf8')).toBe('{}\n');
    expect(existsSync(join(tabnine, 'wish'))).toBe(true);
    expect(warningsOf(outcome).filter((line) => line.includes('pruned'))).toEqual([]);
  });

  /**
   * The prune used to stop forever once ANY run stamped the record
   * `agentSelection: 'explicit'`, so a phantom the first explicit run failed to
   * recognize (the D2 chain above) could never be handed back. It now runs on
   * every update; what an explicit record bounds is HOW MUCH it may move.
   */
  test('an explicit record still hands back a phantom chain on the next update', () => {
    fixtureSkillsTree(['wish']);
    const astrbot = join(home, '.astrbot', 'data', 'skills');
    const claudeSkills = join(home, '.claude', 'skills');
    const astrbotDigest = seedSkillDir(join(astrbot, 'wish'), '# wish\n');
    const claudeDigest = seedSkillDir(join(claudeSkills, 'wish'), '# wish\n');
    writeSkillsInstallRecord(genieHome, {
      ...RECORD_BASE,
      ref: 'v5.260915.1',
      inventory: ['wish'],
      agentDirs: [claudeSkills, astrbot],
      dirDigests: { [join(astrbot, 'wish')]: astrbotDigest, [join(claudeSkills, 'wish')]: claudeDigest },
      agentSelection: 'explicit',
    });

    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: agentAwareRunner(),
      now: () => new Date('2026-09-16T00:00:00.000Z'),
    });

    expect(outcome.ok).toBe(true);
    // Handed back below the agent's own detection root, and the root that move
    // emptied is gone too — the chain as a whole (D2 + D3).
    expect(existsSync(join(home, '.astrbot'))).toBe(false);
    const backupRoot = join(genieHome, 'state-backups', 'skills-prune-2026-09-16T00-00-00-000Z');
    expect(readFileSync(join(backupRoot, '.astrbot', 'data', 'skills', 'wish', 'SKILL.md'), 'utf8')).toBe('# wish\n');
    expect(warningsOf(outcome)).toContain(
      `skills: pruned genie-created agent home ${join(home, '.astrbot', 'data')} — backed up to ${join(backupRoot, '.astrbot', 'data')} (also removed empty ${join(home, '.astrbot')})`,
    );
    // The operator's own product home is untouched, and still installed into.
    expect(existsSync(join(claudeSkills, 'wish', 'SKILL.md'))).toBe(true);
    expect(outcome.ok === true && outcome.record.agentDirs).toContain(claudeSkills);
  });

  // D3 ----------------------------------------------------------------------
  test('a prune under ~/.config removes the emptied product root but never ~/.config itself', () => {
    fixtureSkillsTree(['wish']);
    const kimchi = join(home, '.config', 'kimchi', 'harness', 'skills');
    const digest = seedSkillDir(join(kimchi, 'wish'), '# wish\n');
    writeSkillsInstallRecord(genieHome, {
      ...RECORD_BASE,
      ref: 'v5.260915.1',
      inventory: ['wish'],
      agentDirs: [kimchi],
      dirDigests: { [join(kimchi, 'wish')]: digest },
      agentSelection: 'explicit',
    });

    const outcome = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: agentAwareRunner(),
      now: () => new Date('2026-09-16T00:00:00.000Z'),
    });

    expect(outcome.ok).toBe(true);
    expect(existsSync(join(home, '.config', 'kimchi'))).toBe(false);
    // The shared XDG root is never a product home, and HOME is never touched.
    expect(existsSync(join(home, '.config'))).toBe(true);
    expect(existsSync(home)).toBe(true);
    const backupRoot = join(genieHome, 'state-backups', 'skills-prune-2026-09-16T00-00-00-000Z');
    expect(warningsOf(outcome)).toContain(
      `skills: pruned genie-created agent home ${join(home, '.config', 'kimchi', 'harness')} — backed up to ${join(backupRoot, '.config', 'kimchi', 'harness')} (also removed empty ${join(home, '.config', 'kimchi')})`,
    );
  });

  // D4 ----------------------------------------------------------------------
  /**
   * `collisions` describes the LAST run, so the next one dropped it while the
   * backup root it named stayed on disk forever: bytes with nothing in the
   * receipt pointing at them.
   */
  test('the record accumulates collision backup roots across runs, and never drops one', () => {
    fixtureSkillsTree(['wish', 'work']);
    const claudeSkills = join(home, '.claude', 'skills');
    seedSkillDir(join(claudeSkills, 'wish'), '# someone else entirely\n');

    const first = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: deliveringOkRunner({ argv: [] }),
      now: () => new Date('2026-09-16T00:00:00.000Z'),
    });
    expect(first.ok).toBe(true);
    const firstRoot = join(genieHome, 'state-backups', 'skills-collision-2026-09-16T00-00-00-000Z');
    expect(first.ok === true && first.record.collisionBackups).toEqual([
      { root: firstRoot, entries: [{ dir: join(claudeSkills, 'wish'), skill: 'wish', kind: 'foreign' }] },
    ]);

    // A second run with a second replaced directory — genie's own this time.
    writeFileSync(join(claudeSkills, 'work', 'SKILL.md'), '# my own work skill\n', 'utf8');
    const second = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: deliveringOkRunner({ argv: [] }),
      now: () => new Date('2026-09-17T00:00:00.000Z'),
    });

    expect(second.ok).toBe(true);
    const secondRoot = join(genieHome, 'state-backups', 'skills-collision-2026-09-17T00-00-00-000Z');
    expect(second.ok === true && second.record.collisionBackups).toEqual([
      { root: firstRoot, entries: [{ dir: join(claudeSkills, 'wish'), skill: 'wish', kind: 'foreign' }] },
      { root: secondRoot, entries: [{ dir: join(claudeSkills, 'work'), skill: 'work', kind: 'modified' }] },
    ]);
    // Both roots are still on disk: `state-backups/` is an archive.
    expect(readFileSync(join(firstRoot, '.claude', 'skills', 'wish', 'SKILL.md'), 'utf8')).toBe(
      '# someone else entirely\n',
    );
    expect(readFileSync(join(secondRoot, '.claude', 'skills', 'work', 'SKILL.md'), 'utf8')).toBe(
      '# my own work skill\n',
    );
  });

  // D5 ----------------------------------------------------------------------
  /** The doc comment immediately above `anchor`, as written in the source. */
  function docCommentAbove(source: string, anchor: string): string {
    const at = source.indexOf(anchor);
    expect(at).toBeGreaterThan(-1);
    const start = source.lastIndexOf('/**', at);
    return source.slice(start, source.indexOf('*/', start));
  }

  test('no docstring still describes `--all` as the argv this channel runs', () => {
    const source = readFileSync(join(import.meta.dir, 'skills-installer.ts'), 'utf8');
    const anchors = [
      'function collisionCandidateHomes(',
      'function collisionBackupHomes(',
      'export function snapshotSkillsCollisions(',
      'export function runSkillsChannelConvergence(',
    ];
    for (const anchor of anchors) expect(docCommentAbove(source, anchor)).not.toContain('--all');
    // The module header documents the argv the installer actually builds.
    const header = source.slice(0, source.indexOf('*/'));
    expect(header).not.toContain('--all --copy');
    for (const flag of ['--skill', '--agent', '--copy', '-g']) expect(header).toContain(flag);
    const argv = buildSkillsAddArgv({ sourceRoot: join(genieHome, 'skills'), agents: ['claude-code'] });
    expect(argv).not.toContain('--all');
    // …and the retirement-order comment no longer credits `--all` for it.
    const retirementComment = source.slice(
      source.indexOf('// RETIREMENT RUNS BEFORE THE INSTALL PASS.'),
      source.indexOf('let preserved: SkillsPreservedEntry[]'),
    );
    expect(retirementComment).not.toContain('--all');
  });

  // D6 ----------------------------------------------------------------------
  /**
   * The summary used to print FIRST, so on the rehearsal host the operator read
   * `installed 19 skill(s) … into 8 agent dir(s)` and then fifty lines of
   * directories moving — with no way to tell which count it described.
   */
  test('the transcript reports retirement, prune and collisions before the install summary', () => {
    fixtureSkillsTree(['wish']);
    const claudeSkills = join(home, '.claude', 'skills');
    const astrbot = join(home, '.astrbot', 'data', 'skills');
    const traceDigest = seedSkillDir(join(claudeSkills, 'trace'), '# trace\n');
    const astrbotDigest = seedSkillDir(join(astrbot, 'wish'), '# wish\n');
    // A genie dir the operator edited: this run replaces it (the collision).
    seedSkillDir(join(claudeSkills, 'wish'), '# my own wish\n');
    writeSkillsInstallRecord(genieHome, {
      ...RECORD_BASE,
      ref: 'v5.260915.1',
      // `trace` is recorded but no longer delivered: this release retires it.
      inventory: ['wish', 'trace'],
      agentDirs: [claudeSkills, astrbot],
      dirDigests: { [join(claudeSkills, 'trace')]: traceDigest, [join(astrbot, 'wish')]: astrbotDigest },
      agentSelection: 'explicit',
    });

    const lines: string[] = [];
    const result = runSkillsChannelConvergence({
      selection: 'auto',
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: agentAwareRunner(),
      log: (line) => lines.push(line),
      now: () => new Date('2026-09-16T00:00:00.000Z'),
    });

    expect(result.status).toBe('installed');
    const indexOfLine = (needle: string): number => lines.findIndex((line) => line.includes(needle));
    const retired = indexOfLine('skills: retired trace from');
    const pruned = indexOfLine('skills: pruned genie-created agent home');
    const collision = indexOfLine('was modified locally');
    const kept = indexOfLine('skills: collision backup kept at');
    const summary = indexOfLine('skills: installed ');
    expect([retired, pruned, collision, kept].every((index) => index >= 0)).toBe(true);
    expect(retired).toBeLessThan(pruned);
    expect(pruned).toBeLessThan(collision);
    expect(collision).toBeLessThan(kept);
    // The summary is what the host HAS, so it comes last — always.
    expect(summary).toBe(lines.length - 1);
  });
});

/**
 * Issue #2927. The retirement pass could only name what the previous record
 * named, so a plugin-era `genie-review` (2026-07-10) and a transaction dir a
 * deleted runtime left in `~/.agents/skills` survived every `genie update` as
 * `nothing to retire` — and `genie doctor` read the home as complete.
 */
describe('pre-record genie leftovers (issue #2927)', () => {
  const PM_DESCRIPTION =
    'Full PM playbook — triage backlog, prioritize, assign, track, report, escalate. Copilot, autopilot, or pair modes.';

  function seedLeftovers(): { proven: string; marker: string; nameOnly: string } {
    const agents = join(home, '.agents', 'skills');
    const claude = join(home, '.claude', 'skills');
    const proven = join(agents, 'genie-review');
    mkdirSync(proven, { recursive: true });
    writeFileSync(join(proven, 'SKILL.md'), `---\nname: genie-review\ndescription: "${PM_DESCRIPTION}"\n---\n# old\n`);
    const marker = join(agents, '.genie-codex-fallback-retirement');
    mkdirSync(join(marker, 'txn-1', 'quarantine'), { recursive: true });
    writeFileSync(join(marker, 'txn-1', 'journal.json'), '{"version":1}\n');
    const nameOnly = join(claude, 'brain');
    mkdirSync(nameOnly, { recursive: true });
    writeFileSync(join(nameOnly, 'SKILL.md'), '---\nname: brain\ndescription: Route Brain knowledge elsewhere\n---\n');
    return { proven, marker, nameOnly };
  }

  function spawnDelivering(source: string): CommandRunner {
    return () => {
      for (const dir of [join(home, '.claude', 'skills'), join(home, '.agents', 'skills')]) {
        cpSync(source, dir, { recursive: true });
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
  }

  test('with NO install record, proven dirs and marker dirs are archived backup-first and a name-only match is only reported', () => {
    const source = fixtureSkillsTree(['review']);
    const { proven, marker, nameOnly } = seedLeftovers();
    const markerDigest = computeSkillDirDigest(marker);

    const result = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: spawnDelivering(source),
    });
    expect(result.ok).toBe(true);
    expect(existsSync(proven)).toBe(false);
    expect(existsSync(marker)).toBe(false);
    // The third-party product that merely shares a retired genie NAME is untouched.
    expect(existsSync(join(nameOnly, 'SKILL.md'))).toBe(true);

    const roots = readdirSync(join(genieHome, 'state-backups')).filter((name) => name.startsWith('skills-retirement-'));
    expect(roots).toHaveLength(1);
    const backupRoot = join(genieHome, 'state-backups', roots[0] as string);
    expect(readFileSync(join(backupRoot, '.agents', 'skills', 'genie-review', 'SKILL.md'), 'utf8')).toContain('# old');
    expect(computeSkillDirDigest(join(backupRoot, '.agents', 'skills', '.genie-codex-fallback-retirement'))).toBe(
      markerDigest,
    );
    expect(result.warnings).toEqual([
      'skills: retired pre-record genie skill dir .genie-codex-fallback-retirement from 1 agent dir(s)',
      'skills: retired pre-record genie skill dir genie-review from 1 agent dir(s)',
      `skills: retirement backups under ${backupRoot}`,
      `skills: ${nameOnly} carries a retired genie skill name or description but not both, so genie does not claim it; nothing was moved — review it yourself if it is not a product you use`,
      'skills: legacy leftovers: 2 archived, 0 preserved, 1 unproven (a retired genie name or description, not both) of 3 dir(s) predating the install record',
    ]);
    // A marker dir has a leading dot, which the record schema rejects: it is never recorded.
    expect(readSkillsInstallRecord(genieHome)?.preserved ?? []).toEqual([]);
  });

  test('with a record, the pass covers recorded homes too and is silent once the leftovers are gone', () => {
    const source = fixtureSkillsTree(['review']);
    const extra = join(home, '.openclaw', 'skills');
    mkdirSync(join(extra, 'pm'), { recursive: true });
    writeFileSync(join(extra, 'pm', 'SKILL.md'), `---\nname: pm\ndescription: ${PM_DESCRIPTION}\n---\n`);
    writeSkillsInstallRecord(genieHome, {
      ref: 'v5.260914.1',
      cliVersion: SKILLS_CLI_AGENTS.length > 0 ? '1.5.23' : '1.5.23',
      inventory: ['review'],
      agentDirs: [join(home, '.claude', 'skills'), join(home, '.agents', 'skills'), extra],
      installedAt: '2026-09-14T00:00:00.000Z',
    });
    const install = () =>
      runSkillsInstall({
        version: VERSION_UNDER_TEST,
        genieHome,
        home,
        which: alwaysFound,
        spawn: spawnDelivering(source),
      });

    const first = install();
    expect(first.ok).toBe(true);
    expect(existsSync(join(extra, 'pm'))).toBe(false);
    expect(first.warnings).toContain('skills: retired pre-record genie skill dir pm from 1 agent dir(s)');

    const second = install();
    expect(second.ok).toBe(true);
    expect((second.warnings ?? []).filter((line) => line.includes('pre-record') || line.includes('legacy'))).toEqual(
      [],
    );
  });

  /**
   * Codex review on PR #2928: a RECORDED skill this release drops still carries
   * a retired description, so the legacy pass would have archived a locally
   * edited install on its own current digest — bypassing the recorded-digest
   * comparison that preserves it. Recorded paths are the record's business.
   */
  test('a recorded skill this release drops is judged by the recorded path, never by the legacy pass', () => {
    const source = fixtureSkillsTree(['review']);
    const claude = join(home, '.claude', 'skills');
    const recorded = join(claude, 'pm');
    mkdirSync(recorded, { recursive: true });
    writeFileSync(join(recorded, 'SKILL.md'), `---\nname: pm\ndescription: "${PM_DESCRIPTION}"\n---\n# shipped\n`);
    const digest = computeSkillDirDigest(recorded) as string;
    writeSkillsInstallRecord(genieHome, {
      ref: 'v5.260914.1',
      cliVersion: '1.5.23',
      inventory: ['pm'],
      agentDirs: [claude, join(home, '.agents', 'skills')],
      dirDigests: { [recorded]: digest },
      installedAt: '2026-09-14T00:00:00.000Z',
    });
    // The user edited the body and kept the shipped frontmatter.
    writeFileSync(join(recorded, 'SKILL.md'), `---\nname: pm\ndescription: "${PM_DESCRIPTION}"\n---\n# mine\n`);

    const result = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: spawnDelivering(source),
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(recorded, 'SKILL.md'), 'utf8')).toContain('# mine');
    expect(result.warnings).toContain(
      `skills: preserved retired skill ${recorded} (content changed since the recorded install); review it manually`,
    );
    expect((result.warnings ?? []).filter((line) => line.includes('pre-record'))).toEqual([]);
    expect(readSkillsInstallRecord(genieHome)?.preserved).toEqual([
      { agentDir: claude, skill: 'pm', reason: 'content changed since the recorded install', digest },
    ]);
  });

  /**
   * A dir that could not be READ while its contents were being proven carries no digest, so the
   * recorded-retirement path can only ever answer `no recorded content digest` for it. Before this,
   * the operator who fixed the permission watched every later update skip it in silence, and the
   * receipt in the record said `preserved` for ever.
   */
  test('a leftover preserved as unreadable is re-proven and archived once it can be read', () => {
    const source = fixtureSkillsTree(['review']);
    const { proven } = seedLeftovers();
    const unreadable = join(proven, 'notes.txt');
    writeFileSync(unreadable, 'x');
    chmodSync(unreadable, 0o000);
    const agents = join(home, '.agents', 'skills');
    const install = () =>
      runSkillsInstall({
        version: VERSION_UNDER_TEST,
        genieHome,
        home,
        which: alwaysFound,
        spawn: spawnDelivering(source),
      });

    const first = install();
    expect(first.ok).toBe(true);
    expect(existsSync(proven)).toBe(true);
    expect(readSkillsInstallRecord(genieHome)?.preserved).toEqual([
      { agentDir: agents, skill: 'genie-review', reason: 'unreadable while proving its contents' },
    ]);

    // The operator fixes the permission the reason named.
    chmodSync(unreadable, 0o644);

    const second = install();
    expect(second.ok).toBe(true);
    expect(existsSync(proven)).toBe(false);
    expect(second.warnings).toContain('skills: retired pre-record genie skill dir genie-review from 1 agent dir(s)');
    expect(readSkillsInstallRecord(genieHome)?.preserved ?? []).toEqual([]);
  });

  /**
   * The reconciling line is the one line whose job is to add up. Counting a pre-record dir the
   * legacy pass preserved against the RECORDED targets made it stop: `1 archived, 1 preserved,
   * 1 already absent of 2 recorded target(s)` describes three dispositions of two targets.
   */
  test('the reconciling line counts recorded dispositions, and the legacy line counts its own', () => {
    const source = fixtureSkillsTree(['review']);
    const claude = join(home, '.claude', 'skills');
    const recorded = join(claude, 'trace');
    mkdirSync(recorded, { recursive: true });
    writeFileSync(join(recorded, 'SKILL.md'), '# trace\n');
    writeSkillsInstallRecord(genieHome, {
      ref: 'v5.260914.1',
      cliVersion: '1.5.23',
      inventory: ['review', 'trace'],
      agentDirs: [claude, join(home, '.agents', 'skills')],
      dirDigests: { [recorded]: computeSkillDirDigest(recorded) as string },
      installedAt: '2026-09-14T00:00:00.000Z',
    });
    const { proven } = seedLeftovers();
    const unreadable = join(proven, 'notes.txt');
    writeFileSync(unreadable, 'x');
    chmodSync(unreadable, 0o000);

    const result = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: spawnDelivering(source),
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toContain(
      'skills: retirement: 1 archived, 0 preserved, 1 already absent of 2 recorded target(s)',
    );
    expect(result.warnings).toContain(
      'skills: legacy leftovers: 1 archived, 1 preserved, 1 unproven (a retired genie name or description, not both) of 3 dir(s) predating the install record',
    );
    chmodSync(unreadable, 0o644);
  });

  /** Codex review on PR #2928: the `--all` era wrote registry homes the four-row known table never lists. */
  test('with no record, every skills.sh registry home on disk is scanned, not only the known four', () => {
    const source = fixtureSkillsTree(['review']);
    const openclaw = join(home, '.openclaw', 'skills');
    mkdirSync(join(openclaw, 'wizard'), { recursive: true });
    writeFileSync(
      join(openclaw, 'wizard', 'SKILL.md'),
      '---\nname: wizard\ndescription: "Guided onboarding — scaffold workspace, shape agent identity, create first wish, execute, and celebrate."\n---\n',
    );
    const result = runSkillsInstall({
      version: VERSION_UNDER_TEST,
      genieHome,
      home,
      which: alwaysFound,
      spawn: spawnDelivering(source),
    });
    expect(result.ok).toBe(true);
    expect(existsSync(join(openclaw, 'wizard'))).toBe(false);
    expect(result.warnings).toContain('skills: retired pre-record genie skill dir wizard from 1 agent dir(s)');
  });
});
