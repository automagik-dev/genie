// A grant whose start throws: the wish's copy is removed only when the team refused the start
// before any turn (levelNotSet), and only while it is still the directory that grant made.
// Real git, temporary folders.
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { claimCopy, removeCopy, stillClaimed } from '../src/host/copy.js';
import { compose, gitIn, grant, fakeTeam as makeTeam } from './team.js';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genie-dsh-'));
  process.env.GENIE_WISHES_DIR = join(dir, 'wishes');
});
afterEach(() => {
  Reflect.deleteProperty(process.env, 'GENIE_WISHES_DIR');
  rmSync(dir, { recursive: true, force: true });
});

const WISH = { title: 'Add a README', wish: 'Write a README that says hello.' };
const root = () => join(dir, 'wishes', 'genie');
const copyOf = (slug = 'add-a-readme') => join(root(), slug);
// The team's own refusal of a start whose permission level did not hold (automagik #982).
const refused = () => Object.assign(new Error('The permission level could not be set'), { levelNotSet: true });

/** A Genie on a team whose startTask runs `onTask(sessionId, state, genie)`, which may throw. */
async function genieOn({ tasks, onTask } = {}) {
  const made = {};
  const team = makeTeam(dir, { tasks, onTask: (sessionId, state) => onTask?.(sessionId, state, made.genie) });
  const { rt, tools } = compose(team);
  await rt.genieReady;
  made.genie = Object.values(team.state.bots)[0];
  return { team, rt, tools, genie: made.genie };
}
const noWishSaved = (team) => {
  const file = join(team.home, 'genie.json');
  return !existsSync(file) || JSON.parse(readFileSync(file, 'utf8')).wishes.length === 0;
};

const KEPT =
  /^The wish did not start: (.+?) Its copy of the project was kept at (\S+?), because work may have run there\. /;

test('a start the team refused for its permission level leaves no copy, branch or record', async () => {
  const { team, tools, genie } = await genieOn({
    tasks: {},
    onTask: (sessionId, state, bot) => {
      state.tasks[sessionId] = { from: bot.id, status: 'failed' };
      throw refused();
    },
  });
  const answer = await grant(tools, genie.id, WISH);
  assert.equal(answer, 'The wish did not start: The permission level could not be set');
  assert.equal(existsSync(copyOf()), false);
  // The wishes folder of the project is shared by every wish and stays.
  assert.deepEqual(readdirSync(root()), []);
  assert.equal(gitIn(genie.workDir, 'branch', '--list', 'wish/*'), '');
  assert.equal(gitIn(genie.workDir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'dev');
  assert.ok(noWishSaved(team));
});

test('any other failed start keeps the copy, also when the team has no task for it', async () => {
  const { team, tools, genie } = await genieOn({
    tasks: {},
    onTask: () => {
      throw new Error('no session for you');
    },
  });
  const answer = await grant(tools, genie.id, WISH);
  assert.deepEqual(answer.match(KEPT)?.slice(1), ['no session for you', copyOf()]);
  assert.ok(existsSync(join(copyOf(), '.git', 'HEAD')));
  assert.ok(noWishSaved(team));
});

test('only the refusal’s own flag, exactly true, removes: a truthy value or a flag on the cause keeps the copy', async () => {
  const flagged = (value) => Object.assign(new Error('not the refusal'), { levelNotSet: value });
  const errors = {
    'a truthy string': flagged('true'),
    'the number 1': flagged(1),
    'an object': flagged({}),
    'a flag on the cause only': new Error('not the refusal', { cause: refused() }),
  };
  let thrown;
  const { tools, genie } = await genieOn({
    onTask: () => {
      throw thrown;
    },
  });
  for (const [name, error] of Object.entries(errors)) {
    thrown = error;
    const slug = `wish-${Object.keys(errors).indexOf(name)}`;
    const answer = await grant(tools, genie.id, { ...WISH, title: slug });
    assert.deepEqual(answer.match(KEPT)?.slice(1), ['not the refusal', copyOf(slug)], name);
    assert.ok(existsSync(join(copyOf(slug), '.git', 'HEAD')), name);
  }
});

test('a wish that ran and whose task the team already forgot keeps its work when the start then throws', async () => {
  const { tools, genie } = await genieOn({
    // The team keeps only its newest ended tasks: this one ran, ended and was evicted by
    // another Bot's start before its own flush rejected. No record of it is left.
    tasks: {},
    onTask: (sessionId, state, bot) => {
      state.tasks[sessionId] = { from: bot.id, status: 'done' };
      writeFileSync(join(copyOf(), 'work.txt'), 'made by the turn');
      Reflect.deleteProperty(state.tasks, sessionId);
      throw new Error('flush failed');
    },
  });
  const answer = await grant(tools, genie.id, WISH);
  assert.match(answer, KEPT);
  assert.equal(readFileSync(join(copyOf(), 'work.txt'), 'utf8'), 'made by the turn');
});

test('after a failed start the same title is granted again under the plain slug', async () => {
  let fail = true;
  const { team, tools, genie } = await genieOn({
    onTask: () => {
      if (fail) throw refused();
    },
  });
  assert.match(await grant(tools, genie.id, WISH), /did not start/);
  fail = false;
  assert.match(await grant(tools, genie.id, WISH), /granted as a thread on branch wish\/add-a-readme\./);
  assert.equal(team.record.tasks.at(-1).cwd, copyOf());
});

test('a start that succeeds removes nothing', async () => {
  const { team, tools, genie } = await genieOn({ tasks: {} });
  assert.match(await grant(tools, genie.id, WISH), /granted as a thread/);
  assert.equal(gitIn(copyOf(), 'rev-parse', '--abbrev-ref', 'HEAD'), 'wish/add-a-readme');
  assert.equal(JSON.parse(readFileSync(join(team.home, 'genie.json'), 'utf8')).wishes[0].folder, copyOf());
});

test('a turn that ran before the start threw keeps its work: an ended task of this Genie is no proof of none', async () => {
  let status;
  let copy;
  const { team, tools, genie } = await genieOn({
    tasks: {},
    onTask: (sessionId, state, bot) => {
      // The first turn was queued and worked in the copy; then the flush rejected.
      state.tasks[sessionId] = { from: bot.id, status };
      writeFileSync(join(copy, 'work.txt'), 'made by the turn');
      throw new Error('flush failed');
    },
  });
  for (status of ['working', 'done', 'failed', 'stopped']) {
    copy = copyOf(`wish-${status}`);
    const answer = await grant(tools, genie.id, { ...WISH, title: `wish ${status}` });
    assert.match(answer, KEPT, status);
    assert.ok(answer.includes(copy), status);
    assert.equal(readFileSync(join(copy, 'work.txt'), 'utf8'), 'made by the turn', status);
    assert.ok(noWishSaved(team));
  }
});

test('a folder that was already there is never removed: the wish takes the next slug, and only that one goes', async () => {
  const { tools, genie } = await genieOn({
    onTask: () => {
      throw refused();
    },
  });
  mkdirSync(copyOf(), { recursive: true });
  writeFileSync(join(copyOf(), 'mine.txt'), 'not a wish');
  assert.match(await grant(tools, genie.id, WISH), /did not start/);
  assert.equal(readFileSync(join(copyOf(), 'mine.txt'), 'utf8'), 'not a wish');
  assert.deepEqual(readdirSync(root()), ['add-a-readme']);
});

test('a path the look missed (a dangling link) is not claimed: the wish does not start and the link stays', async () => {
  const { team, tools, genie } = await genieOn();
  mkdirSync(root(), { recursive: true });
  symlinkSync(join(dir, 'nowhere'), copyOf());
  const answer = await grant(tools, genie.id, WISH);
  assert.match(answer, /^The wish did not start: EEXIST/);
  assert.ok(!answer.includes('was kept'));
  assert.ok(lstatSync(copyOf()).isSymbolicLink());
  assert.equal(existsSync(join(dir, 'nowhere')), false);
  assert.equal(team.record.tasks.length, 0);
});

test('two wishes of one title granted at once each get their own copy', async () => {
  const { team, tools, genie } = await genieOn();
  // The repository exists before the two race, as it does for every Genie after its first wish.
  await grant(tools, genie.id, { ...WISH, title: 'First' });
  const answers = await Promise.all([grant(tools, genie.id, WISH), grant(tools, genie.id, WISH)]);
  for (const answer of answers) assert.match(answer, /granted as a thread/);
  const folders = team.record.tasks.slice(1).map((task) => task.cwd);
  assert.deepEqual(folders.toSorted(), [copyOf(), copyOf('add-a-readme-2')]);
  for (const folder of folders) assert.ok(existsSync(join(folder, '.git', 'HEAD')));
});

test('the wishes folder swapped for a link during the start: what the link leads to is not removed', async () => {
  const elsewhere = join(dir, 'elsewhere');
  const { tools, genie } = await genieOn({
    onTask: () => {
      renameSync(root(), join(dir, 'moved'));
      mkdirSync(join(elsewhere, 'add-a-readme'), { recursive: true });
      writeFileSync(join(elsewhere, 'add-a-readme', 'theirs.txt'), 'someone else');
      symlinkSync(elsewhere, root());
      throw refused();
    },
  });
  const answer = await grant(tools, genie.id, WISH);
  // The path now leads to someone else's folder: the answer names no path and asks for no deletion.
  assert.match(answer, /^The wish did not start: The permission level could not be set A copy of the project/);
  assert.match(answer, /could not confirm which folder is the one it made/);
  assert.match(answer, /do not delete any folder on this message alone/);
  assert.ok(!answer.includes(dir), answer);
  assert.equal(readFileSync(join(elsewhere, 'add-a-readme', 'theirs.txt'), 'utf8'), 'someone else');
  // The copy this grant made is kept too: nothing is removed through a path that moved.
  assert.ok(existsSync(join(dir, 'moved', 'add-a-readme', '.git', 'HEAD')));
});

test('the error thrown is the start’s own, also when the copy cannot be removed', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root removes from a read-only folder');
  const thrown = refused();
  const { rt, tools, genie } = await genieOn({
    onTask: () => {
      chmodSync(root(), 0o555);
      throw thrown;
    },
  });
  try {
    await assert.rejects(rt.grantWish({ bot: genie, ...WISH }), (error) => error === thrown);
    assert.ok(existsSync(copyOf()));
    chmodSync(root(), 0o755);
    const answer = await grant(tools, genie.id, { ...WISH, title: 'Second' });
    assert.match(
      answer,
      /^The wish did not start: The permission level could not be set Its copy .* was kept at \S+second, because it could not be removed\. /,
    );
  } finally {
    chmodSync(root(), 0o755);
  }
});

test('a start that throws something that is not an Error still throws exactly that', async () => {
  const { rt, genie } = await genieOn({
    onTask: () => {
      throw 'plain words';
    },
  });
  await assert.rejects(rt.grantWish({ bot: genie, ...WISH }), (error) => error === 'plain words');
  assert.ok(existsSync(copyOf()));
});

test('a scoped follow-up whose start is refused leaves no copy and the given branch as it was', async () => {
  let fail = false;
  const { tools, genie } = await genieOn({
    onTask: () => {
      if (fail) throw refused();
    },
  });
  await grant(tools, genie.id, WISH);
  const repo = genie.workDir;
  gitIn(repo, 'branch', 'feature/earlier');
  const tip = gitIn(repo, 'rev-parse', 'feature/earlier');
  fail = true;
  const answer = await grant(tools, genie.id, { ...WISH, title: 'Repair it', branches: ['feature/earlier'] });
  assert.match(answer, /^The wish did not start: The permission level could not be set$/);
  assert.equal(existsSync(copyOf('repair-it')), false);
  assert.equal(gitIn(repo, 'rev-parse', 'feature/earlier'), tip);
  assert.equal(gitIn(repo, 'branch', '--list', 'wish/*'), '');
});

// ---- copy.js on its own ----

test('claimCopy refuses a path that exists and removeCopy removes only the directory it claimed', () => {
  const base = join(dir, 'copies');
  const claim = claimCopy(base, 'one');
  assert.equal(claim.identified, true);
  assert.throws(() => claimCopy(base, 'one'), { code: 'EEXIST' });
  writeFileSync(join(claim.folder, 'file'), 'x');
  // Another directory put at the same path is not the one claimed.
  renameSync(claim.folder, join(base, 'aside'));
  mkdirSync(claim.folder);
  assert.equal(removeCopy(claim), 'uncertain');
  assert.ok(existsSync(claim.folder));
  rmSync(claim.folder, { recursive: true });
  renameSync(join(base, 'aside'), claim.folder);
  // A removal that fails is answered, not thrown.
  const failing = () => {
    throw new Error('EACCES');
  };
  assert.equal(removeCopy(claim, { rm: failing }), 'failed');
  assert.equal(removeCopy(claim), 'removed');
  assert.equal(existsSync(claim.folder), false);
  // Gone already: nothing to remove, nothing thrown.
  assert.equal(removeCopy(claim), 'uncertain');
});

test('a file system with no usable inode identifies no copy, and such a copy is never removed', () => {
  const base = join(dir, 'copies');
  // Every directory reads as inode 0: another one at the same path would look the same.
  const zero = (path, options) => Object.assign(lstatSync(path, options), { ino: 0n });
  const claim = claimCopy(base, 'zero', { stat: zero });
  assert.equal(claim.identified, false);
  assert.equal(stillClaimed(claim, { stat: zero }), false);
  assert.equal(removeCopy(claim, { stat: zero }), 'uncertain');
  assert.ok(existsSync(claim.folder));
  // Inodes that change between two looks at the same directory identify nothing either.
  let n = 0n;
  const unstable = (path, options) => Object.assign(lstatSync(path, options), { ino: ++n });
  const drifting = claimCopy(base, 'drifting', { stat: unstable });
  assert.equal(drifting.identified, false);
  assert.equal(removeCopy(drifting), 'uncertain');
  assert.ok(existsSync(drifting.folder));
});

test('removeCopy keeps a claimed folder replaced by a link to another directory', () => {
  const base = join(dir, 'copies');
  const claim = claimCopy(base, 'one');
  const other = join(dir, 'other');
  mkdirSync(other);
  writeFileSync(join(other, 'theirs.txt'), 'x');
  renameSync(claim.folder, join(base, 'aside'));
  symlinkSync(other, claim.folder);
  assert.equal(removeCopy(claim), 'uncertain');
  assert.ok(existsSync(join(other, 'theirs.txt')));
});

test('removeCopy keeps a copy whose wishes folder moved and was linked back: its recorded real path is gone', () => {
  const base = join(dir, 'copies');
  const claim = claimCopy(base, 'one');
  // The same directory is still reached through the path, but not where it was claimed.
  renameSync(base, join(dir, 'moved'));
  symlinkSync(join(dir, 'moved'), base);
  assert.equal(lstatSync(claim.folder, { bigint: true }).ino, claim.ino);
  assert.equal(removeCopy(claim), 'uncertain');
  assert.ok(existsSync(join(dir, 'moved', 'one')));
});

test('a kept copy whose path no longer leads to it is not named, whatever the failure was', async () => {
  const { tools, genie } = await genieOn({
    onTask: () => {
      renameSync(root(), join(dir, 'moved'));
      mkdirSync(join(dir, 'elsewhere', 'add-a-readme'), { recursive: true });
      symlinkSync(join(dir, 'elsewhere'), root());
      throw new Error('flush failed');
    },
  });
  const answer = await grant(tools, genie.id, WISH);
  assert.match(answer, /^The wish did not start: flush failed A copy of the project made for this wish may remain/);
  assert.ok(!answer.includes(dir), answer);
  assert.ok(existsSync(join(dir, 'moved', 'add-a-readme', '.git', 'HEAD')));
});
