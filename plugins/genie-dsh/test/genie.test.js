// The Genie Bot and grant_wish against a stand-in team runtime, with real git in temporary
// folders: what the Bot team provides (createBot, startTask, the view hook) is recorded,
// and what git does is checked on disk.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { GENIE_SUGGESTIONS, registerSuggestions } from '../src/client/suggestions.js';
import { endedWishesOf, markOf, outcomeOf } from '../src/client/wishes.js';
import {
  GENIE_COLORS,
  GENIE_INSTRUCTIONS,
  GENIE_KIND,
  freeGenieColor,
  genieNameFor,
  slugOf,
  wishBrief,
} from '../src/host/genie.js';
import { MISSING_GIT, MISSING_TOOLS_MAC, gitProblem } from '../src/host/git.js';
import { compose, gitIn, grant, guarded, hostContract, fakeTeam as makeTeam, savedWishes, until } from './team.js';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genie-dsh-'));
  process.env.GENIE_WISHES_DIR = join(dir, 'wishes');
});
afterEach(() => {
  Reflect.deleteProperty(process.env, 'GENIE_WISHES_DIR');
  rmSync(dir, { recursive: true, force: true });
});

// What the plugin uses of the Bot team's runtime (test/team.js), recording what it is asked to do.
const fakeTeam = (options) => makeTeam(dir, options);

test('a new team gets one Genie Bot, in its own project folder, with the default model', async () => {
  const team = fakeTeam();
  const { rt } = compose(team);
  await rt.genieReady;
  assert.equal(team.record.created.length, 1);
  const made = team.record.created[0];
  assert.equal(made.kind, GENIE_KIND);
  assert.equal(made.name, 'Genie');
  assert.equal(made.pickModel, false);
  assert.equal(made.workDir, join(dir, 'team', 'genie'));
  assert.ok(existsSync(made.workDir));
  assert.equal(made.avatar, undefined);
  // bots-dsh cuts a role past 24 characters.
  assert.ok(made.role.length <= 24, made.role);
});

test('Genie waits for a model when none is served yet', async () => {
  const team = fakeTeam({ noModel: true });
  const { rt } = compose(team);
  await rt.genieReady;
  assert.equal(team.record.created[0].pickModel, true);
});

test('Genie is never made twice, nor again after the user deleted it', async () => {
  const team = fakeTeam();
  await compose(team).rt.genieReady;
  // The plugin loads again on the next start: the Genie Bot is there, so nothing is made.
  await compose(team).rt.genieReady;
  assert.equal(team.record.created.length, 1);
  // The user deletes it; the next start leaves it deleted.
  team.state.bots = {};
  await compose(team).rt.genieReady;
  assert.equal(team.record.created.length, 1);
});

test('an existing genie Bot is kept, and a taken name falls back to another', async () => {
  const kept = fakeTeam({ bots: { g: { id: 'g', name: 'Mine', kind: GENIE_KIND } } });
  await compose(kept).rt.genieReady;
  assert.equal(kept.record.created.length, 0);
  const taken = fakeTeam({ bots: { x: { id: 'x', name: 'Genie' } } });
  await compose(taken).rt.genieReady;
  assert.equal(taken.record.created[0].name, 'Genie Bot');
});

test('no Genie is made while another dsh holds the team', async () => {
  const team = fakeTeam({ readOnly: 'open in another dsh' });
  await compose(team).rt.genieReady;
  assert.equal(team.record.created.length, 0);
});

test('a wish in Genie’s own folder starts a repository on dev, its own clone on wish/<slug> and a task there', async () => {
  const team = fakeTeam();
  const { rt, tools, turnEnd } = compose(team);
  await rt.genieReady;
  const genie = Object.values(team.state.bots)[0];
  const answer = await grant(tools, genie.id, { title: 'Add a README', wish: 'Write a README that says hello.' });
  assert.match(answer, /granted as a thread on branch wish\/add-a-readme/);
  const repo = genie.workDir;
  assert.equal(gitIn(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'dev');
  const folder = join(dir, 'wishes', 'genie', 'add-a-readme');
  assert.equal(gitIn(folder, 'rev-parse', '--abbrev-ref', 'HEAD'), 'wish/add-a-readme');
  // The clone carries its own .git, so a sandboxed session can commit in it.
  assert.ok(existsSync(join(folder, '.git', 'HEAD')));
  assert.equal(team.record.tasks.length, 1);
  const task = team.record.tasks[0];
  assert.equal(task.from, genie.id);
  assert.equal(task.cwd, folder);
  assert.equal(task.agentPreset, 'standard');
  assert.equal(task.title, 'Wish: Add a README');
  assert.match(task.text, /Write a README that says hello\./);
  assert.ok(task.text.includes(folder));
  // The wish is kept, and the team view carries it for the rows under Genie.
  const view = team.record.views[0]();
  assert.deepEqual(
    view.genie.wishes.map((wish) => [wish.slug, wish.sessionId, wish.botId]),
    [['add-a-readme', 'session-1', genie.id]],
  );
  const saved = JSON.parse(readFileSync(join(team.home, 'genie.json'), 'utf8'));
  assert.equal(saved.wishes[0].folder, folder);
  // The thread commits in its clone; when its turn ends, the branch comes into the project.
  writeFileSync(join(folder, 'README.md'), 'hello');
  gitIn(folder, 'add', '.');
  gitIn(folder, 'commit', '-q', '-m', 'Add README');
  assert.equal(gitIn(repo, 'branch', '--list', 'wish/*'), '');
  turnEnd('session-1');
  // The turn end is settled in the background: wait on what is saved, not on the branch, so
  // the record is read once its save has landed.
  const ended = await until(() => savedWishes(team).find((wish) => wish.state !== 'working'), 'the wish to settle');
  assert.equal(ended.state, 'local-only');
  assert.equal(ended.delivered, undefined, 'a local branch is never called delivered');
  assert.equal(gitIn(repo, 'log', '-1', '--format=%s', 'wish/add-a-readme'), 'Add README');
  // The project's own checkout is left as it was.
  assert.equal(gitIn(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'dev');
  assert.equal(existsSync(join(repo, 'README.md')), false);
});

test('a turn cut by a restart brings nothing back yet', async () => {
  const team = fakeTeam();
  team.cutByRestart = (reason) => reason?.kind === 'restart';
  const { rt, tools, turnEnd } = compose(team);
  await rt.genieReady;
  const genie = Object.values(team.state.bots)[0];
  await grant(tools, genie.id, { title: 'Later', wish: 'w' });
  turnEnd('session-1', { kind: 'restart' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(gitIn(genie.workDir, 'branch', '--list', 'wish/*'), '');
});

test('the same title twice gets its own branch', async () => {
  const team = fakeTeam();
  const { rt, tools } = compose(team);
  await rt.genieReady;
  const genie = Object.values(team.state.bots)[0];
  await grant(tools, genie.id, { title: 'Fix it', wish: 'one' });
  const second = await grant(tools, genie.id, { title: 'Fix it', wish: 'two' });
  assert.match(second, /wish\/fix-it-2/);
  // A copy's folder left on disk with no branch and no record is skipped too, never reused.
  mkdirSync(join(dir, 'wishes', 'genie', 'left-behind'), { recursive: true });
  assert.match(await grant(tools, genie.id, { title: 'Left behind', wish: 'three' }), /wish\/left-behind-2/);
});

// Issue #3182: a follow-up authorized to repair and publish the branches an earlier wish made
// must be able to act on them, where the plain brief said "do not touch any other branch".
test('a follow-up wish scoped to an earlier branch repairs and publishes it, and leaves other branches alone', async () => {
  const origin = join(dir, 'origin.git');
  gitIn(dir, 'init', '-q', '--bare', origin);
  const repo = join(dir, 'app');
  mkdirSync(repo);
  gitIn(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a');
  gitIn(repo, 'add', '.');
  gitIn(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'first');
  gitIn(repo, 'remote', 'add', 'origin', origin);
  // A wish starts from its base as the remote has it, so the remote carries it and names it.
  gitIn(repo, 'push', '-q', 'origin', 'main');
  gitIn(repo, 'remote', 'set-head', 'origin', 'main');
  // Two branches an earlier wish left behind; only the first is given to the follow-up.
  gitIn(repo, 'branch', 'wish/keep-a');
  gitIn(repo, 'branch', 'wish/keep-b');
  const untouched = gitIn(repo, 'rev-parse', 'wish/keep-b');

  const team = fakeTeam({ bots: { g: { id: 'g', name: 'Genie', kind: GENIE_KIND, workDir: repo } } });
  const { rt, tools, turnEnd } = compose(team);
  await rt.genieReady;
  const answer = await grant(tools, 'g', {
    title: 'Repair and publish the earlier wishes',
    wish: 'Repair wish/keep-a, then push it.',
    branches: ['wish/keep-a'],
  });
  assert.match(answer, /granted as a thread on branch wish\/repair-and-publish-the-earlier-wishes/);
  const task = team.record.tasks[0];
  // The brief names the given branch, allows publishing exactly it, and keeps the guardrail.
  assert.match(task.text, /existing branches: wish\/keep-a\./);
  assert.match(task.text, /git push publish <branch>/);
  assert.match(task.text, /Do not push, merge, or touch any branch not listed here/);
  assert.doesNotMatch(task.text, /Do not push, merge, or touch any other branch/);

  const folder = join(dir, 'wishes', 'app', 'repair-and-publish-the-earlier-wishes');
  // The given branch is in the wish's copy; the branch it was not given is not.
  assert.equal(gitIn(folder, 'rev-parse', 'wish/keep-a'), gitIn(repo, 'rev-parse', 'wish/keep-a'));
  assert.equal(gitIn(folder, 'branch', '--list', 'wish/keep-b'), '');
  assert.equal(gitIn(folder, 'remote', 'get-url', 'publish'), origin);

  // The thread repairs the given branch and publishes it.
  gitIn(folder, 'switch', '-q', 'wish/keep-a');
  writeFileSync(join(folder, 'a.txt'), 'repaired');
  gitIn(folder, 'commit', '-q', '-am', 'Repair a');
  gitIn(folder, 'push', '-q', 'publish', 'wish/keep-a');
  assert.equal(gitIn(origin, 'log', '-1', '--format=%s', 'wish/keep-a'), 'Repair a');

  // When the turn ends, the repair comes back into the project; the other branch does not move.
  turnEnd('session-1');
  for (let i = 0; i < 50 && gitIn(repo, 'log', '-1', '--format=%s', 'wish/keep-a') !== 'Repair a'; i++)
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(gitIn(repo, 'log', '-1', '--format=%s', 'wish/keep-a'), 'Repair a');
  assert.equal(gitIn(repo, 'rev-parse', 'wish/keep-b'), untouched);
  assert.equal(gitIn(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});

test('a wish is only given branches that exist, and never the integration branch', async () => {
  const repo = join(dir, 'app');
  mkdirSync(repo);
  gitIn(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a');
  gitIn(repo, 'add', '.');
  gitIn(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'first');
  const team = fakeTeam({ bots: { g: { id: 'g', name: 'Genie', kind: GENIE_KIND, workDir: repo } } });
  const { rt, tools } = compose(team);
  await rt.genieReady;
  assert.match(
    await grant(tools, 'g', { title: 'Missing', wish: 'w', branches: ['wish/missing'] }),
    /is not a branch in/,
  );
  assert.match(await grant(tools, 'g', { title: 'Own', wish: 'w', branches: ['main'] }), /integration branch/);
  // The tool schema itself refuses a scope that is not a list of branch names.
  await assert.rejects(grant(tools, 'g', { title: 'Bad', wish: 'w', branches: 'all' }), /must be an array/);
  assert.equal(team.record.tasks.length, 0);
});

test('a folder the user picked that is not a repository is refused, never initialised', async () => {
  const picked = join(dir, 'my-project');
  mkdirSync(picked);
  const team = fakeTeam({ bots: { g: { id: 'g', name: 'Genie', kind: GENIE_KIND, workDir: picked } } });
  const { rt, tools } = compose(team);
  await rt.genieReady;
  const answer = await grant(tools, 'g', { title: 'x', wish: 'y' });
  assert.match(answer, /is not a git repository/);
  assert.equal(existsSync(join(picked, '.git')), false);
  assert.equal(team.record.tasks.length, 0);
});

test('an existing repository is used as it is, from its current commit', async () => {
  const repo = join(dir, 'app');
  mkdirSync(repo);
  gitIn(repo, 'init', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a');
  gitIn(repo, 'add', '.');
  gitIn(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'first');
  const head = gitIn(repo, 'rev-parse', 'HEAD');
  const team = fakeTeam({ bots: { g: { id: 'g', name: 'Genie', kind: GENIE_KIND, workDir: repo } } });
  const { rt, tools } = compose(team);
  await rt.genieReady;
  await grant(tools, 'g', { title: 'Change a', wish: 'Change a.txt' });
  assert.equal(gitIn(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(gitIn(join(dir, 'wishes', 'app', 'change-a'), 'rev-parse', 'HEAD'), head);
});

test('only Genie grants wishes, and a wish needs a title and a body', async () => {
  const team = fakeTeam({ bots: { o: { id: 'o', name: 'Omni', kind: 'omni' } } });
  const { rt, tools } = compose(team);
  await rt.genieReady;
  assert.match(await grant(tools, 'o', { title: 'x', wish: 'y' }), /Only Genie grants wishes/);
  const genie = Object.values(team.state.bots).find((bot) => bot.kind === GENIE_KIND);
  assert.match(await grant(tools, genie.id, { title: ' ', wish: 'y' }), /needs a title/);
  assert.equal(team.record.tasks.length, 0);
});

test('missing git is named with its one-line fix, and a Mac never starts git without its tools', async () => {
  const started = [];
  const exec = (ok) => async (command) => {
    started.push(command);
    return { ok: ok(command) };
  };
  assert.equal(await gitProblem({ platform: 'darwin', exec: exec((c) => c !== 'xcode-select') }), MISSING_TOOLS_MAC);
  assert.deepEqual(started, ['xcode-select']);
  assert.match(MISSING_TOOLS_MAC, /xcode-select --install/);
  assert.equal(await gitProblem({ platform: 'linux', exec: exec((c) => c !== 'git') }), MISSING_GIT);
  assert.equal(await gitProblem({ platform: 'darwin', exec: exec(() => true) }), null);
});

test('slugs are branch-safe and the brief tells the thread where and how to finish', () => {
  assert.equal(slugOf('Café: add the *login* page!'), 'cafe-add-the-login-page');
  assert.equal(slugOf('???'), 'wish');
  const brief = wishBrief({ title: 'T', wish: 'W', folder: '/w', branch: 'wish/t', base: 'abcdef1234567890' });
  assert.match(brief, /Work only in \/w: your own copy of the project, on branch wish\/t \(made from abcdef123456\)/);
  // A plain wish is told why it does not push (its copy has no push route), and to say so
  // when the wish asked it to: no bare "Do not push, merge".
  assert.doesNotMatch(brief, /Do not push, merge/);
  assert.match(brief, /This copy has no push route/);
  assert.match(
    brief,
    /if the wish asked you to push or open a pull request, say in your final report that you could not/,
  );
  assert.match(brief, /final report/);

  // A wish scoped to branches an earlier wish made may act on exactly those, and on nothing
  // else: the plain rule narrows to the listed branches instead of being dropped.
  const scoped = wishBrief({
    title: 'T',
    wish: 'W',
    folder: '/w',
    branch: 'wish/t',
    base: 'abcdef1234567890',
    branches: ['wish/one', 'wish/two'],
    canPublish: true,
  });
  assert.match(scoped, /existing branches: wish\/one, wish\/two\./);
  assert.match(scoped, /git push publish <branch>/);
  assert.match(scoped, /never force-push, merge, or deploy/);
  assert.match(scoped, /Do not push, merge, or touch any branch not listed here/);
  assert.doesNotMatch(scoped, /Do not push, merge, or touch any other branch/);
  // With no remote, a scoped wish is told plainly that it can repair but not publish.
  const offline = wishBrief({
    title: 'T',
    wish: 'W',
    folder: '/w',
    branch: 'wish/t',
    base: 'abcdef1234567890',
    branches: ['wish/one'],
  });
  assert.match(offline, /no git remote, so they cannot be published/);
});

test('the rows under Genie list its ended wishes, newest first, and leave running ones to the team', () => {
  const roster = {
    tasks: { s1: { status: 'done' }, s2: { status: 'working' }, s3: { status: 'failed' } },
    genie: {
      wishes: [
        { sessionId: 's3', botId: 'g', title: 'c' },
        { sessionId: 's2', botId: 'g', title: 'b' },
        { sessionId: 's1', botId: 'g', title: 'a' },
        { sessionId: 's4', botId: 'other', title: 'd' },
      ],
    },
  };
  assert.deepEqual(
    endedWishesOf(roster, 'g').map((wish) => [wish.title, wish.status]),
    [
      ['c', 'failed'],
      ['a', 'done'],
    ],
  );
  assert.deepEqual(endedWishesOf({}, 'g'), []);
});

test('an ended wish says how it turned out: a failed one names why, a stopped one is not done', () => {
  assert.deepEqual(outcomeOf({ status: 'failed', summary: 'the provider refused the key\nat step 3' }), {
    state: 'failed',
    short: 'Failed',
    full: 'Failed: the provider refused the key',
  });
  assert.equal(outcomeOf({ status: 'failed' }).full, 'Failed');
  assert.deepEqual(outcomeOf({ status: 'stopped' }), { state: 'stopped', short: 'Stopped', full: 'Stopped' });
  assert.equal(outcomeOf({ status: 'done' }).short, 'Done');
  assert.equal(outcomeOf({ status: 'ended' }).short, 'Done');
});

test("Genie's empty chat leads with its own chips, only for a Genie, and a team without the hook gets none", () => {
  const registered = [];
  const off = registerSuggestions({
    register: (entry) => {
      registered.push(entry);
      return () => registered.pop();
    },
  });
  assert.equal(registered[0], GENIE_SUGGESTIONS);
  assert.ok(GENIE_SUGGESTIONS.order < 0, "before the team's own");
  assert.equal(GENIE_SUGGESTIONS.when({ bot: { kind: 'genie' } }), true);
  assert.equal(GENIE_SUGGESTIONS.when({ bot: { kind: 'bot' } }), false);
  const items = GENIE_SUGGESTIONS.items({ bot: { kind: 'genie' } });
  assert.equal(items.length, 3);
  for (const item of items) {
    assert.ok(item.id && item.label, item.label);
    assert.match(item.text, / $/, 'the person finishes the text');
  }
  assert.equal(items[0].text, 'I wish ');
  off();
  assert.equal(registered.length, 0);
  assert.equal(typeof registerSuggestions(undefined), 'function');
});

const repoAt = (path) => {
  mkdirSync(path, { recursive: true });
  gitIn(path, 'init', '-q');
  return path;
};

test('a Genie per repository: + Genie makes a new one in a free color, and the same repository opens its own', async () => {
  const team = fakeTeam();
  const { rt } = compose(team);
  await rt.genieReady;
  const first = Object.values(team.state.bots)[0];
  assert.equal(first.color, GENIE_COLORS[0], 'the first Genie wears the first Genie color');
  assert.equal(GENIE_COLORS[0], 'magenta', "Genie's own painting, so the first Genie keeps today's look");
  const create = team.record.endpoints.get('genie-create');
  assert.equal(typeof create, 'function', 'served as genie-create');

  const api = repoAt(join(dir, 'api'));
  const made = await create({ folder: api });
  assert.equal(made.existed, false);
  assert.deepEqual(made.bot, { id: 'bot-2', name: 'Genie api', color: GENIE_COLORS[1] });
  assert.equal(team.record.created[1].kind, GENIE_KIND);
  assert.equal(team.record.created[1].workDir, gitIn(api, 'rev-parse', '--show-toplevel'));

  // A folder inside the same repository is that repository: its Genie opens, nothing is made.
  mkdirSync(join(api, 'src'));
  assert.deepEqual(await create({ folder: join(api, 'src') }), { bot: made.bot, existed: true });
  assert.equal(team.record.created.length, 2);

  // Two quick presses for a new repository make one Genie.
  const web = repoAt(join(dir, 'web'));
  const [a, b] = await Promise.all([create({ folder: web }), create({ folder: web })]);
  assert.equal(a.bot.id, b.bot.id);
  assert.deepEqual([a.existed, b.existed].sort(), [false, true]);
  assert.equal(a.bot.color, GENIE_COLORS[2]);

  // The team view says which colors are worn.
  const view = Object.assign({}, ...team.record.views.map((fn) => fn())).genie;
  assert.deepEqual(view.taken, GENIE_COLORS.slice(0, 3));

  await assert.rejects(create({ folder: join(dir, 'team') }), /is not in a git repository/);
  await assert.rejects(create({}), /Pick the repository/);
});

test('no two Genies share a color, and a twelfth-plus Genie is refused rather than doubled', async () => {
  const bots = Object.fromEntries(
    GENIE_COLORS.map((color, i) => [`g${i}`, { id: `g${i}`, name: `G${i}`, kind: GENIE_KIND, color }]),
  );
  const team = fakeTeam({ bots });
  const { rt } = compose(team);
  await rt.genieReady;
  await assert.rejects(rt.createGenie({ folder: repoAt(join(dir, 'one-more')) }), /Every Genie color is taken/);
  assert.equal(freeGenieColor([{}]), GENIE_COLORS[1], 'a Genie saved without a color wears the first');
  assert.equal(freeGenieColor([]), GENIE_COLORS[0]);
});

test('a new Genie is called Genie while that name is free, else after its repository', () => {
  const names = new Set();
  const taken = (name) => names.has(name);
  assert.equal(genieNameFor('/x/api', taken), 'Genie');
  names.add('Genie');
  assert.equal(genieNameFor('/x/api', taken), 'Genie api');
  names.add('Genie api');
  assert.equal(genieNameFor('/y/api', taken), 'Genie api 2');
});

// T8: the fake team is the README's host contract, and nothing past it.
test('the test team is the README host contract: a member the table does not list throws', async () => {
  const members = hostContract();
  assert.ok(members.includes('rt.resumesDone') && members.includes('rt.state.tasks') && members.includes('ctx.on'));
  const team = fakeTeam();
  const { rt } = compose(team);
  await rt.genieReady;
  assert.throws(() => rt.deliver, /rt\.deliver is not in the README host contract/);
  assert.throws(() => rt.state.rooms, /rt\.state\.rooms is not in the README host contract/);
  assert.throws(() => rt.hooks.live, /rt\.hooks\.live is not in the README host contract/);
  assert.throws(() => guarded({}, 'ctx').logger, /ctx\.logger is not in the README host contract/);
  // Every member the table lists is one the plugin's host code really uses.
  const host = join(import.meta.dirname, '..', 'src', 'host');
  const source = [join(import.meta.dirname, '..', 'index.js'), ...readdirSync(host).map((name) => join(host, name))]
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n')
    .replaceAll('?.', '.');
  for (const member of members) assert.ok(source.includes(member), `${member} is listed but not used`);
});

// T9: a genie.json from before records v2 keeps every wish, and its rows read as they did.
test('a v1 genie.json loads with every wish kept, and its rows render as before', async () => {
  const team = fakeTeam({ bots: { g: { id: 'g', name: 'Genie', kind: GENIE_KIND } } });
  const v1 = [
    {
      slug: 'a',
      title: 'A',
      branch: 'wish/a',
      branches: [],
      folder: '/x/a',
      repo: '/x',
      base: 'f'.repeat(40),
      sessionId: 's1',
      botId: 'g',
      at: 3,
      delivered: true,
    },
    {
      slug: 'b',
      title: 'B',
      branch: 'wish/b',
      folder: '/x/b',
      repo: '/x',
      base: 'e'.repeat(40),
      sessionId: 's2',
      botId: 'g',
      at: 2,
      delivered: false,
      deliveryError: 'wish/b: no',
    },
    {
      slug: 'c',
      title: 'C',
      branch: 'wish/c',
      folder: '/x/c',
      repo: '/x',
      base: 'd'.repeat(40),
      sessionId: 's3',
      botId: 'g',
      at: 1,
    },
  ];
  writeFileSync(join(team.home, 'genie.json'), `${JSON.stringify({ genieCreated: true, wishes: v1 }, null, 2)}\n`);
  const { rt } = compose(team);
  await rt.genieReady;
  assert.deepEqual(rt.genieWishes(), v1);
  const view = team.record.views[0]();
  assert.deepEqual(
    view.genie.wishes.map((wish) => Object.keys(wish).sort()),
    v1.map(() => ['at', 'botId', 'branch', 'sessionId', 'slug', 'title']),
    'a v1 row carries no state, so it reads from the task status as before',
  );
  const roster = { tasks: { s1: { status: 'done' }, s2: { status: 'stopped' } }, genie: view.genie };
  assert.deepEqual(
    endedWishesOf(roster, 'g').map((wish) => [wish.title, outcomeOf(wish).short, markOf(outcomeOf(wish))]),
    [
      ['A', 'Done', '✓'],
      ['B', 'Stopped', '✕'],
      ['C', 'Done', '✓'],
    ],
  );
});

test('no v2 state renders as Done, and the instructions never call an unpublished branch mergeable', () => {
  for (const state of ['local-only', 'no-change', 'stopped', 'failed', 'lost']) {
    const outcome = outcomeOf({ state, status: 'done' });
    assert.notEqual(outcome.short, 'Done', state);
    assert.notEqual(outcome.state, 'done', state);
    assert.notEqual(markOf(outcome), '✓', state);
  }
  assert.deepEqual(
    ['local-only', 'no-change', 'stopped', 'failed', 'lost'].map((state) => outcomeOf({ state }).short),
    ['Local branch', 'No change', 'Stopped', 'Failed', 'Lost'],
  );
  assert.equal(outcomeOf({ state: 'local-only' }).full, 'Local branch, not published');
  // A v2 wish still working is not an ended row, whatever the team's status says.
  const roster = {
    tasks: { s1: { status: 'done' } },
    genie: { wishes: [{ sessionId: 's1', botId: 'g', state: 'working' }] },
  };
  assert.deepEqual(endedWishesOf(roster, 'g'), []);
  assert.doesNotMatch(GENIE_INSTRUCTIONS, /merge it when they are happy/);
  assert.match(GENIE_INSTRUCTIONS, /local branch, not published/);
});
