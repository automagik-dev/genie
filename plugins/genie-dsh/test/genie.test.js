// The Genie Bot and grant_wish against a stand-in team runtime, with real git in temporary
// folders: what the Bot team provides (createBot, startTask, the view hook) is recorded,
// and what git does is checked on disk.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createRuntime } from '../index.js';
import { GENIE_SUGGESTIONS, registerSuggestions } from '../src/client/suggestions.js';
import { endedWishesOf, outcomeOf } from '../src/client/wishes.js';
import { GENIE_KIND, slugOf, wishBrief } from '../src/host/genie.js';
import { MISSING_GIT, MISSING_TOOLS_MAC, gitProblem } from '../src/host/git.js';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genie-dsh-'));
  process.env.GENIE_WISHES_DIR = join(dir, 'wishes');
});
afterEach(() => {
  Reflect.deleteProperty(process.env, 'GENIE_WISHES_DIR');
  rmSync(dir, { recursive: true, force: true });
});

const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// What the plugin uses of the Bot team's runtime, recording what it is asked to do.
function fakeTeam({ bots = {}, readOnly, noModel = false } = {}) {
  const model = noModel ? undefined : { provider: 'p', model: 'm' };
  const team = join(dir, 'team');
  mkdirSync(team, { recursive: true });
  const record = { created: [], tasks: [], views: [], saves: 0 };
  const state = { bots: { ...bots } };
  const rt = {
    home: join(dir, 'home'),
    state,
    record,
    load: async () => {},
    readOnly: () => readOnly,
    save: async () => {
      record.saves += 1;
    },
    ensureWorkspace: async () => team,
    teamFolder: () => team,
    defaultModel: async () => model,
    findBot: (name) => Object.values(state.bots).find((bot) => bot.name === name),
    createBot: async (options) => {
      record.created.push(options);
      const bot = { id: `bot-${record.created.length}`, ...options };
      state.bots[bot.id] = bot;
      return bot;
    },
    startTask: async (task) => {
      record.tasks.push(task);
      return `session-${record.tasks.length}`;
    },
    selfOf: (agentId) => agentId,
    botOf: (id) => state.bots[id],
    hooks: {
      view: (fn) => {
        record.views.push(fn);
        return () => {};
      },
    },
    warn: () => {},
  };
  mkdirSync(rt.home, { recursive: true });
  return rt;
}

function compose(team) {
  const tools = new Map();
  const listeners = [];
  const ctx = {
    effect: (run) => run(),
    on: (name, listener) => listeners.push([name, listener]),
    tools: { register: (tool) => tools.set(tool.name, tool) },
  };
  const rt = createRuntime(ctx, team);
  // A Session's turn ends, as DSH reports it to every plugin.
  const turnEnd = (sessionId, reason = { kind: 'completed' }) => {
    for (const [name, listener] of listeners) {
      if (name === 'session/event') listener({ id: sessionId }, { type: 'turn/end', data: { reason } });
    }
  };
  return { rt, tools, turnEnd };
}

const grant = (tools, botId, args) => tools.get('grant_wish').execute(args, { agent: { id: botId } });

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
  for (let i = 0; i < 50 && gitIn(repo, 'branch', '--list', 'wish/*') === ''; i++)
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(gitIn(repo, 'log', '-1', '--format=%s', 'wish/add-a-readme'), 'Add README');
  assert.equal(JSON.parse(readFileSync(join(team.home, 'genie.json'), 'utf8')).wishes[0].delivered, true);
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
  assert.match(brief, /Do not push, merge, or touch any other branch/);
  assert.match(brief, /final report/);
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
