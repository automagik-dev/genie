// Set-up failures must report any partial copy left behind, keeping the original error.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { git, initRepo } from '../src/host/git.js';
import { compose, fakeTeam, grant } from './team.js';

for (const stage of ['clone', 'branch']) {
  for (const outcome of ['failed', 'uncertain', 'removed']) {
    test(`${stage} set-up failure reports cleanup ${outcome}`, async (t) => {
      const dir = fs.mkdtempSync(join(tmpdir(), 'genie-dsh-setup-'));
      const previous = process.env.GENIE_WISHES_DIR;
      process.env.GENIE_WISHES_DIR = join(dir, 'wishes');
      t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
        if (previous === undefined) Reflect.deleteProperty(process.env, 'GENIE_WISHES_DIR');
        else process.env.GENIE_WISHES_DIR = previous;
        fs.rmSync(dir, { recursive: true, force: true });
      });

      const team = fakeTeam(dir);
      const { rt, tools } = compose(team);
      await rt.genieReady;
      const genie = Object.values(team.state.bots)[0];
      assert.equal((await initRepo(genie.workDir)).ok, true);
      assert.equal((await git(['branch', 'feature/earlier'], genie.workDir)).ok, true);
      const folder = join(dir, 'wishes', 'genie', 'setup');
      const error = `${stage} setup failed`;
      const execFile = childProcess.execFile;
      t.mock.method(childProcess, 'execFile', (command, args, options, callback) => {
        if (command === 'git' && args[0] === stage) {
          fs.writeFileSync(join(folder, 'partial.txt'), 'partial copy');
          callback(Object.assign(new Error(error), { code: 1 }), '', error);
          return undefined;
        }
        return execFile(command, args, options, callback);
      });
      const rm = fs.rmSync;
      const stat = fs.lstatSync;
      if (outcome === 'failed') {
        t.mock.method(fs, 'rmSync', (path, options) => {
          if (path === folder) throw new Error('cleanup failed');
          return rm(path, options);
        });
      } else if (outcome === 'uncertain') {
        t.mock.method(fs, 'lstatSync', (path, options) => {
          const value = stat(path, options);
          return path === folder ? Object.assign(value, { ino: 0n }) : value;
        });
      }
      syncBuiltinESMExports();

      const answer = await grant(tools, genie.id, {
        title: 'Setup',
        wish: 'Make a change.',
        ...(stage === 'branch' ? { branches: ['feature/earlier'] } : {}),
      });
      const original = `The wish did not start: ${error}`;
      assert.ok(answer.startsWith(original), answer);
      if (outcome === 'removed') {
        assert.equal(answer, original);
        assert.equal(fs.existsSync(folder), false);
      } else {
        assert.equal(fs.readFileSync(join(folder, 'partial.txt'), 'utf8'), 'partial copy');
        if (outcome === 'failed') {
          assert.ok(answer.includes(`Its copy of the project was kept at ${folder}`), answer);
          assert.match(answer, /because it could not be removed/);
          assert.ok(!answer.includes('cleanup failed'), answer);
        } else {
          assert.match(answer, /A copy of the project made for this wish may remain/);
          assert.match(answer, /could not confirm which folder is the one it made/);
          assert.match(answer, /do not delete any folder on this message alone/);
          assert.ok(!answer.includes(dir), answer);
        }
      }
      assert.equal(team.record.tasks.length, 0);
      assert.deepEqual(JSON.parse(fs.readFileSync(join(team.home, 'genie.json'))).wishes, []);
    });
  }
}
