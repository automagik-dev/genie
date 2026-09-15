/**
 * m17: the documented recovery for a `skills-retirement-*` backup.
 *
 * The recipe used to be a plain `cp -a <backup>/. $HOME/`, which copies the
 * backup's own directory metadata onto the agent homes that already exist — a
 * `drwxr-xr-x ~/.claude` silently became `drwx------`, because the backup root
 * is created 0700 and the mirrored parents inherit it. These tests extract the
 * commands straight out of README.md and prove they restore the removed tree
 * WITHOUT touching the modes of directories that are still there.
 */

import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const README = readFileSync(join(import.meta.dir, '..', 'README.md'), 'utf8');

/** The two restore commands the README prescribes, as literal shell lines. */
function documentedRestoreCommands(): string[] {
  const section = README.split('#### Restoring from a retirement backup')[1];
  if (section === undefined) throw new Error('README lost its retirement-restore section');
  const block = section.split('```bash')[1]?.split('```')[0];
  if (block === undefined) throw new Error('README lost the retirement-restore command block');
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('cp ') || line.startsWith('rsync '));
}

/**
 * A home whose `.claude` already exists at 0755 plus a 0700 backup root that
 * mirrors it — exactly the shape `ensureRetirementBackupRoot` writes.
 */
function fixture(): { root: string; home: string; backup: string; live: string } {
  const root = mkdtempSync(join(tmpdir(), 'genie-retirement-restore-'));
  const home = join(root, 'home');
  const live = join(home, '.claude', 'skills');
  mkdirSync(live, { recursive: true });
  chmodSync(join(home, '.claude'), 0o755);
  chmodSync(live, 0o755);
  writeFileSync(join(live, 'keep.md'), '# still installed\n');

  const backup = join(root, 'skills-retirement-2026-09-15T17-01-01-104Z');
  const archived = join(backup, '.claude', 'skills', 'trace');
  mkdirSync(archived, { recursive: true, mode: 0o700 });
  chmodSync(join(backup, '.claude'), 0o700);
  chmodSync(join(backup, '.claude', 'skills'), 0o700);
  writeFileSync(join(archived, 'SKILL.md'), '# previous trace\n');
  return { root, home, backup, live };
}

function run(command: string, env: Record<string, string>): void {
  const result = Bun.spawnSync(['bash', '-c', command], { env: { ...process.env, ...env }, stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`restore failed: ${result.stderr.toString()}`);
}

describe('documented retirement-backup restore', () => {
  test('README prescribes a mode-preserving restore, never a bare `cp -a`', () => {
    const commands = documentedRestoreCommands();
    expect(commands.filter((command) => command.startsWith('cp '))).toHaveLength(1);
    expect(commands.filter((command) => command.startsWith('rsync '))).toHaveLength(1);
    for (const command of commands) {
      if (command.startsWith('cp ')) expect(command).toContain('--no-preserve=mode');
      else expect(command).toContain('--no-perms');
    }
  });

  test.each([0, 1])('documented command %i restores the tree and leaves existing modes alone', (index) => {
    const commands = documentedRestoreCommands();
    const command = commands[index];
    if (command === undefined) throw new Error(`README documents fewer than ${index + 1} restore commands`);
    const { root, home, backup, live } = fixture();
    try {
      if (!Bun.which('rsync') && command.startsWith('rsync')) return;
      const before = statSync(join(home, '.claude')).mode & 0o777;
      expect(before).toBe(0o755);

      run(command.replaceAll('$BK', backup).replaceAll('"$HOME/"', `"${home}/"`), { BK: backup, HOME: home });

      // The removed tree is back...
      expect(readFileSync(join(live, 'trace', 'SKILL.md'), 'utf8')).toBe('# previous trace\n');
      expect(readFileSync(join(live, 'keep.md'), 'utf8')).toBe('# still installed\n');
      // ...and the pre-existing directories kept their modes.
      expect(statSync(join(home, '.claude')).mode & 0o777).toBe(0o755);
      expect(statSync(live).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
