// The Genie Bots and their wishes. A team may have many Genies, one per repository (its
// Bot's workDir), each in a color no other Genie wears; genie-create adds one for a folder.
// grant_wish makes the wish its own clone of the project, on a new wish/<slug> branch, and
// hands the wish to a Tasks session there (rt.startTask): the team runs it, shows it as a
// thread under Genie while it works, resumes it after a restart, and brings its final
// report back to Genie's chat when it ends. The wish starts from its repository's base as
// the remote has it right now (binding.js), in a copy with no push route. When it ends,
// this module counts what moved, fetches the branches that hold work back into the project,
// and writes down the outcome and the evidence (wishes.js), so ended wishes stay listed
// under Genie with what really happened: a local branch is never called done or delivered.
// A follow-up wish may be scoped to branches an earlier wish made (`branches`), so it can
// repair and publish exactly those and nothing else.
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { fetchBase, hasHttpUserinfo, remoteDisplay, resolveBinding } from './binding.js';
import {
  addPublishRemote,
  aheadOf,
  branchExists,
  cloneForWish,
  commitOf,
  currentBranch,
  fetchWishBranch,
  gitProblem,
  gitRunner,
  grantBranches,
  initRepo,
  topLevel,
} from './git.js';
import { WISH_VERSION, awaitsEnd, endedState, newEvidence, noteCommand, taskOutcome, turnOutcome } from './wishes.js';

export const GENIE_KIND = 'genie';
export const GENIE_NAMES = ['Genie', 'Genie Bot', 'The Genie'];
export const GENIE_PROJECT = 'genie';
export const WISHES_KEPT = 30;
// A tool's text result, drawn as the team's own tools draw theirs (bots-dsh src/host/tools.js).
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] };

export const GENIE_INSTRUCTIONS = [
  'You are Genie: you grant wishes in your project, the folder you live in.',
  'Talk with the user in plain words. When they want something built, changed or fixed in the project, agree on the wish in a sentence or two, then call grant_wish with a short title and the whole wish written so it stands on its own.',
  "Each wish runs as its own thread, in its own copy of the project on a branch wish/<name> made from the project's base as its remote has it now, so your chat stays clean. A plain wish cannot push: it commits in its copy, and nothing is published or merged.",
  'When it ends, its report comes back to you, and its row under you shows the outcome in one of these words: Local branch (it committed, and its branch was brought back into the project), No change (no branch moved), Stopped, Failed or Lost (the team no longer has its record). Tell the user that word and, in a line or two, what was done and where. For a local branch, say "local branch, not published": it is in the project for them to review, and nothing was pushed, merged or opened as a pull request unless a scoped follow-up says it published.',
  'When the user asks a follow-up wish to repair or publish branches an earlier wish made, pass exactly those names as grant_wish branches: that is the only scope in which a wish may push. Never give it the project branch it was made from, and never a branch the user did not name.',
  'If grant_wish answers that something is missing (git, a project folder), give the user exactly the fix it names.',
  'Do not do the wish yourself in this chat.',
].join('\n');

// A Genie's colors, one per Genie: the first is the color Genie's own art is painted in
// (magenta, ~325°), so the first Genie and one saved before Genies had colors keep that look.
// Bot team color ids (bots-dsh characters.js).
export const GENIE_COLORS = Object.freeze([
  'magenta',
  'violet',
  'blue',
  'cyan',
  'green',
  'yellow',
  'orange',
  'red',
  'aurora',
  'brown',
  'gray',
  'black',
]);

/** The color a Genie wears. */
export const genieColorOf = (bot) => bot?.color ?? GENIE_COLORS[0];

/** The first Genie color no Genie in `genies` wears, or undefined when every one is taken. */
export function freeGenieColor(genies) {
  const taken = new Set(genies.map(genieColorOf));
  return GENIE_COLORS.find((color) => !taken.has(color));
}

/** A name for a new Genie in `repo`: Genie while that is free, else Genie <repo>, numbered past a clash. */
export function genieNameFor(repo, taken) {
  if (!taken('Genie')) return 'Genie';
  const stem = `Genie ${basename(repo)}`.slice(0, 34).trim();
  if (!taken(stem)) return stem;
  let n = 2;
  while (taken(`${stem} ${n}`)) n += 1;
  return `${stem} ${n}`;
}

export const GENIE_BOT = Object.freeze({
  kind: GENIE_KIND,
  // The team keeps a role to ROLE_MAX (24) characters (bots-dsh roster.js).
  role: 'Grants your wishes',
  instructions: GENIE_INSTRUCTIONS,
});

/** A branch-safe short name for a wish title. */
export function slugOf(title) {
  const slug = String(title ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug === '' ? 'wish' : slug;
}

/** What the wish thread is told: the wish, where to work, what it may touch and how to finish. */
export function wishBrief({ title, wish, folder, branch, base, branches = [], canPublish = false }) {
  // A wish that was given branches may change those too, and push only them when the project
  // has a remote; every other branch keeps the plain wish rule.
  const scope =
    branches.length === 0
      ? ' This copy has no push route, by design: commit here, never merge or touch any other branch, and if the wish asked you to push or open a pull request, say in your final report that you could not.'
      : [
          ` This wish was also given these existing branches: ${branches.join(', ')}. Commit your repairs on them.`,
          canPublish
            ? ' Publish each one with git push publish <branch>, and open or update its pull request; never force-push, merge, or deploy.'
            : ' The project has no git remote, so they cannot be published: commit the repairs and say so in your final report.',
          ' Do not push, merge, or touch any branch not listed here.',
        ].join('');
  return [
    'You are a Genie wish thread. Grant exactly this one wish, then report.',
    '',
    `Wish: ${title}`,
    wish,
    '',
    `Work only in ${folder}: your own copy of the project, on branch ${branch} (made from ${base.slice(0, 12)}). Run every command there and use absolute paths under it.`,
    '1. Read the project first (README, AGENTS.md or CLAUDE.md when present) and plan in a few lines.',
    '2. Make the change.',
    "3. Run the project's own checks or tests when it has them, and fix what fails.",
    `4. Commit everything on ${branch} with a clear message (git add -A, then git commit).${scope}`,
    '5. End with a short final report: what changed (files), how you checked it (commands and their results), and anything left open.',
    'If you need a decision you cannot make, stop and ask it in your final report.',
  ].join('\n');
}

// Where the wishes' copies live: in the team workspace, where a Tasks session may write
// (DSH's workspace-write sandbox), whichever folder the project itself is in.
export function wishesRoot(teamFolder, env = process.env) {
  if (env.GENIE_WISHES_DIR) return env.GENIE_WISHES_DIR;
  return typeof teamFolder === 'string' ? join(teamFolder, 'wishes') : join(homedir(), '.genie', 'wishes');
}

export function install(rt) {
  const { ctx } = rt;
  const file = () => join(rt.home, 'genie.json');

  let data;
  const load = () => {
    if (data !== undefined) return data;
    try {
      const parsed = JSON.parse(readFileSync(file(), 'utf8'));
      data = { genieCreated: parsed.genieCreated === true, wishes: Array.isArray(parsed.wishes) ? parsed.wishes : [] };
    } catch {
      data = { genieCreated: false, wishes: [] };
    }
    return data;
  };
  // Written whole to a temp file, flushed to disk, then renamed over the old one, so a crash
  // leaves either the old list or the new one.
  const save = () => {
    const temp = `${file()}.tmp`;
    const fd = openSync(temp, 'w');
    try {
      writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file());
  };

  const genieBots = () => Object.values(rt.state?.bots ?? {}).filter((bot) => bot.kind === GENIE_KIND);

  // The first Genie, made once (the plugin loads on every start): an existing Genie is kept,
  // and one the user deleted is not made again. More come from createGenie.
  async function ensureGenie() {
    await rt.load();
    if (rt.readOnly() !== undefined) return undefined;
    const existing = genieBots()[0];
    if (existing !== undefined) return existing;
    if (load().genieCreated) return undefined;
    // The team's workspace holds Genie's first project, as the welcome's Omni Bot does.
    await rt.ensureWorkspace?.();
    const team = rt.teamFolder?.();
    const project = typeof team === 'string' ? join(team, GENIE_PROJECT) : undefined;
    if (project !== undefined) mkdirSync(project, { recursive: true });
    const name = GENIE_NAMES.find((candidate) => rt.findBot?.(candidate) === undefined) ?? `Genie ${Date.now()}`;
    const bot = await rt.createBot({
      ...GENIE_BOT,
      name,
      color: GENIE_COLORS[0],
      workDir: project,
      pickModel: await noModel(),
    });
    load().genieCreated = true;
    save();
    return bot;
  }

  // With a default model already served (Connect AI done), a new Genie takes it and greets at
  // once; with none, its greeting waits until Connect AI gives it one.
  const noModel = async () => (await Promise.resolve(rt.defaultModel?.()).catch(() => undefined)) === undefined;

  // The repository a Genie lives in, or null when its folder is not in one.
  const repoOf = (bot) => {
    const folder = bot.workDir ?? rt.workDirOf?.({ botId: bot.id });
    return typeof folder === 'string' ? topLevel(folder) : Promise.resolve(null);
  };
  const genieView = (bot) => ({ id: bot.id, name: bot.name, color: genieColorOf(bot) });

  // A Genie for the repository `folder` is in: the one already living there, else a new one in
  // the first free Genie color. One at a time, so two quick presses make one Genie.
  let creating = Promise.resolve();
  function createGenie({ folder } = {}) {
    const run = creating.then(async () => {
      await rt.load();
      const readOnly = rt.readOnly();
      if (readOnly !== undefined) throw new Error(readOnly);
      if (typeof folder !== 'string' || folder.trim() === '')
        throw new Error('Pick the repository this Genie will live in.');
      const repo = await topLevel(folder.trim());
      if (repo === null)
        throw new Error(`${folder.trim()} is not in a git repository. Pick a repository, or run git init there first.`);
      for (const bot of genieBots()) if ((await repoOf(bot)) === repo) return { bot: genieView(bot), existed: true };
      const color = freeGenieColor(genieBots());
      if (color === undefined)
        throw new Error(`Every Genie color is taken (${GENIE_COLORS.length} Genies). Remove a Genie to add another.`);
      const name = genieNameFor(repo, (candidate) => rt.findBot?.(candidate) !== undefined);
      const bot = await rt.createBot({ ...GENIE_BOT, name, color, workDir: repo, pickModel: await noModel() });
      load().genieCreated = true;
      save();
      return { bot: genieView(bot), existed: false };
    });
    creating = run.catch(() => {});
    return run;
  }

  const ready = (async () => {
    try {
      await ensureGenie();
    } catch (error) {
      rt.warn?.('genie: the Genie Bot was not made: %s', error?.message ?? error);
    }
  })();

  // Genie's own folder starts as a repository; a folder the user picked is never changed.
  async function repositoryFor(bot) {
    const folder = bot.workDir ?? rt.workDirOf?.({ botId: bot.id }) ?? rt.teamFolder?.();
    if (typeof folder !== 'string' || !existsSync(folder)) {
      return { error: "Genie has no project folder. Pick one in Genie's settings (Working folder), then ask again." };
    }
    let top = await topLevel(folder);
    if (top === null) {
      const own = basename(folder) === GENIE_PROJECT;
      if (!own) {
        return {
          error: `The folder ${folder} is not a git repository. Run git init there, or pick a git repository as Genie's working folder in its settings.`,
        };
      }
      const made = await initRepo(folder);
      if (!made.ok) return { error: `Genie could not start a repository in ${folder}: ${made.error}` };
      top = await topLevel(folder);
    }
    return { repo: top };
  }

  // The branches a follow-up wish may change besides its own: branches the project already has,
  // never the one the project is on (the integration branch a wish is made from), nor the base
  // wishes start from, nor main/master. Returns the clean scope, or the sentence to answer with.
  async function scopedBranches(repo, branches, base, g) {
    if (branches === undefined) return [];
    if (!Array.isArray(branches) || branches.some((name) => typeof name !== 'string'))
      return 'The wish did not start: branches must be a list of branch names.';
    const integration = await currentBranch(repo, g);
    const scope = [];
    for (const raw of branches) {
      const name = raw.trim();
      if (name === '' || scope.includes(name)) continue;
      if (name === integration || name === 'main' || name === 'master')
        return `The wish did not start: ${name} is the project's integration branch, which a wish never pushes or merges. Name the branches an earlier wish made.`;
      if (name === base)
        return `The wish did not start: ${name} is the branch wishes start from, which a wish never pushes or merges. Name the branches an earlier wish made.`;
      if (!(await branchExists(repo, name, g)))
        return `The wish did not start: ${name} is not a branch in ${repo} to give it.`;
      scope.push(name);
    }
    return scope;
  }

  async function grantWish({ bot, title, wish, branches }) {
    const problem = await gitProblem();
    if (problem !== null) return problem;
    const where = await repositoryFor(bot);
    if (where.error) return where.error;
    const { repo } = where;
    // Every git command the host runs for this wish from here on is in its evidence.
    const evidence = newEvidence();
    const gitOptions = { env: {}, note: (command) => noteCommand(evidence, command) };
    const g = gitRunner(gitOptions);
    const bound = await resolveBinding(repo, g);
    if (bound.error !== undefined) return `The wish did not start: ${bound.error}`;
    gitOptions.env = bound.env;
    const { binding } = bound;
    const scope = await scopedBranches(repo, branches, binding.base, g);
    if (typeof scope === 'string') return scope;
    // A scoped follow-up's copy gets the remote's URL as `publish` (#3184): one that carries
    // credentials in it would copy them there, so it is refused instead.
    if (scope.length > 0 && hasHttpUserinfo(bound.url)) {
      const display = remoteDisplay(bound.url);
      return `The wish did not start: the URL of the remote ${binding.remote} has a user name or password written into it, and a follow-up that publishes would copy it into its copy. Remove it (git remote set-url ${binding.remote} ${display}) and let a credential helper keep it (git config credential.helper <helper>), then ask again.`;
    }
    let baseSha = bound.sha;
    if (binding.baseSource !== 'local') {
      const fresh = await fetchBase(bound, g);
      if (fresh.error !== undefined) return `The wish did not start: ${fresh.error}`;
      baseSha = fresh.sha;
    }
    const root = join(wishesRoot(rt.teamFolder?.()), basename(repo));
    let slug = slugOf(title);
    for (
      let n = 2;
      (await branchExists(repo, `wish/${slug}`, g)) ||
      load().wishes.some((w) => w.slug === slug) ||
      existsSync(join(root, slug));
      n++
    ) {
      slug = `${slugOf(title)}-${n}`;
    }
    const branch = `wish/${slug}`;
    mkdirSync(root, { recursive: true });
    const folder = join(root, slug);
    const made = await cloneForWish(repo, folder, branch, baseSha, { g, plain: scope.length === 0 });
    if (!made.ok) {
      rmSync(folder, { recursive: true, force: true });
      return `The wish did not start: ${made.error}`;
    }
    // The given branches become local branches in the wish's copy; the binding's remote
    // becomes its `publish` remote, since the copy's origin is only the project folder.
    const publishTo = scope.length === 0 ? null : bound.url;
    const starts = {};
    if (scope.length > 0) {
      const given = await grantBranches(folder, scope, g);
      const published = publishTo === null ? { ok: true } : await addPublishRemote(folder, publishTo, g);
      if (!given.ok || !published.ok) {
        rmSync(folder, { recursive: true, force: true });
        return `The wish did not start: ${given.error ?? published.error}`;
      }
      for (const name of scope) starts[name] = await commitOf(folder, `refs/heads/${name}`, g, 'given-start');
    }
    evidence.baseSha = baseSha;
    const text = wishBrief({
      title,
      wish,
      folder,
      branch,
      base: baseSha,
      branches: scope,
      canPublish: publishTo !== null,
    });
    // bots-dsh with startTask's cwd (automagik PR #9) opens the thread in its folder with
    // the Bots' preset; an older one ignores both and the brief's absolute path still holds.
    const sessionId = await rt.startTask({
      title: `Wish: ${title}`,
      text,
      from: bot.id,
      cwd: folder,
      agentPreset: 'standard',
    });
    const entry = {
      v: WISH_VERSION,
      slug,
      title,
      branch,
      branches: scope,
      starts,
      folder,
      repo,
      binding,
      baseSha,
      sessionId,
      botId: bot.id,
      at: Date.now(),
      state: 'working',
      evidence,
    };
    const list = load().wishes;
    list.unshift(entry);
    list.splice(WISHES_KEPT);
    save();
    // A first turn can end before the entry above was saved, while no listener knew the
    // wish: the team's own record says so, and the wish is settled now, not at a restart.
    const early = taskOutcome(rt.state?.tasks?.[sessionId]?.status);
    if (early !== undefined) void settle(entry, early);
    await rt.save();
    return `Wish "${title}" is granted as a thread on branch ${branch}. Its report comes back to you as a message when it ends; do not wait or poll.`;
  }

  // A wish's turn ends with an outcome (wishes.js: done, stopped, failed, lost). In its copy,
  // the host counts what moved: the wish branch against its base, each given branch against
  // the commit it was given on. The given branches are fetched back on every end (#3184);
  // the wish branch whenever it is ahead, whatever the outcome. Neither is called delivered.
  async function classify(entry, outcome) {
    if (!awaitsEnd(entry)) return;
    const evidence = entry.evidence ?? newEvidence();
    entry.evidence = evidence;
    const g = gitRunner({ note: (command) => noteCommand(evidence, command) });
    const { repo, folder, branch } = entry;
    // A v1 record (granted before v2) names its base commit `base`.
    const baseSha = entry.baseSha ?? entry.base;
    const errors = [];
    const head = await commitOf(folder, `refs/heads/${branch}`, g, 'wish-head');
    const ahead =
      head === null || typeof baseSha !== 'string' ? null : await aheadOf(folder, baseSha, head, g, 'wish-ahead');
    const given = {};
    for (const name of entry.branches ?? []) {
      const start = entry.starts?.[name];
      const tip = await commitOf(folder, `refs/heads/${name}`, g, 'given-head');
      // A v1 scoped record has no start commits: its branch moved when fetching it back
      // changes the project's branch.
      const before = start === undefined ? await commitOf(repo, `refs/heads/${name}`, g, 'given-before') : undefined;
      const back = await fetchWishBranch(repo, folder, name, g);
      if (!back.ok) errors.push(`${name}: ${back.error}`);
      let moved;
      let count = null;
      if (start === undefined) moved = (await commitOf(repo, `refs/heads/${name}`, g, 'given-after')) !== before;
      else {
        count = tip === null ? null : await aheadOf(folder, start, tip, g, 'given-ahead');
        moved = tip !== null && tip !== start;
      }
      given[name] = { start: start ?? before ?? null, head: tip, ahead: count, moved, fetch: back.code };
    }
    if (ahead !== null && ahead > 0) {
      const back = await fetchWishBranch(repo, folder, branch, g);
      if (!back.ok) errors.push(`${branch}: ${back.error}`);
    }
    let state;
    if (head === null || ahead === null) {
      // What the copy holds cannot be read, so nothing is claimed for it.
      errors.unshift(`${branch} could not be read in ${folder}`);
      state = outcome === 'done' ? 'failed' : outcome;
    } else state = endedState(outcome, ahead > 0 || Object.values(given).some((b) => b.moved));
    Object.assign(evidence, { baseSha: baseSha ?? null, headSha: head, ahead });
    if (Object.keys(given).length > 0) evidence.given = given;
    entry.state = state;
    entry.endedAt = Date.now();
    if (errors.length > 0) {
      entry.error = errors.join('; ');
      rt.warn?.('genie: wish %s: %s', branch, entry.error);
    } else entry.error = undefined; // JSON drops it
    save();
  }

  // Each wish is settled once, however its end is learnt (the live turn end, the startup pass,
  // the check right after the grant): its session is claimed here, synchronously, before any
  // await. A `lost` wish is the one exception: a task the team trimmed from its records can
  // still be running, so its live end settles it again, after the lost pass.
  const claims = new Map();
  function settle(entry, outcome) {
    const prior = claims.get(entry.sessionId);
    if (prior !== undefined && (prior.outcome !== 'lost' || outcome === 'lost')) return prior.done;
    const done = (prior?.done ?? Promise.resolve())
      .then(() => classify(entry, outcome))
      .catch((error) => rt.warn?.('genie: wish %s: %s', entry.branch, error?.message ?? error));
    claims.set(entry.sessionId, { outcome, done });
    return done;
  }

  // Live: the turn end this plugin receives says how the task ended. A turn a restart cut is
  // no end (the team resumes it), nor is a blocked one (it goes on in a fresh part). The
  // team's task record is not read here, so the order of the listeners does not matter.
  ctx.on?.('session/event', (session, event) => {
    if (event?.type !== 'turn/end' || rt.cutByRestart?.(event.data?.reason)) return;
    const outcome = turnOutcome(event.data?.reason);
    if (outcome === undefined) return;
    const wish = load().wishes.find((entry) => entry.sessionId === session?.id && awaitsEnd(entry));
    if (wish !== undefined) void settle(wish, outcome);
  });

  // Startup: a wish whose task ended while this plugin was not listening takes the team's
  // recorded status, once the team's resume pass is over. Only on a host that writes the
  // team, and only from a tasks record that was read: a wish missing from it is `lost`
  // (the team keeps its newest 60 tasks), never done.
  const reconciled = (async () => {
    await rt.load();
    if (typeof rt.resumesDone?.then !== 'function') return;
    const resumes = await rt.resumesDone;
    if (rt.readOnly() !== undefined || resumes === null || typeof resumes !== 'object') return;
    if (Object.hasOwn(resumes, 'readOnly') || Object.hasOwn(resumes, 'failed')) return;
    const tasks = rt.state?.tasks;
    if (tasks === null || typeof tasks !== 'object') return;
    const settling = [];
    for (const entry of load().wishes) {
      if (entry.v !== WISH_VERSION || entry.state !== 'working') continue;
      const outcome = Object.hasOwn(tasks, entry.sessionId) ? taskOutcome(tasks[entry.sessionId]?.status) : 'lost';
      if (outcome !== undefined) settling.push(settle(entry, outcome));
    }
    await Promise.all(settling);
  })().catch((error) => rt.warn?.('genie: the wishes were not reconciled: %s', error?.message ?? error));

  // Adding a Genie: genie-create { folder } answers { bot: { id, name, color }, existed }.
  ctx.effect(() => rt.hooks.endpoint?.('genie-create', (body) => createGenie(body ?? {})), 'genie: create a Genie');

  // The wishes, for the rows under Genie; their status is the team's task status.
  ctx.effect(
    () =>
      rt.hooks.view(() => ({
        genie: {
          // Which Genie colors are worn, so a picker offers only the free ones.
          colors: GENIE_COLORS,
          taken: genieBots().map(genieColorOf),
          // A v2 wish carries its state (wishes.js), which the row shows instead of the task status.
          wishes: load().wishes.map(({ slug, title, branch, sessionId, botId, at, state }) => ({
            slug,
            title,
            branch,
            sessionId,
            botId,
            at,
            ...(state === undefined ? {} : { state }),
          })),
        },
      })),
    'genie: wishes in the team view',
  );

  ctx.tools.register(
    defineTool({
      name: 'grant_wish',
      description:
        'Genie only. Grants one wish in your project: a new thread works on it in its own copy of the project, on a new branch from the base as the remote has it now, commits there without pushing, then reports back to you. Write the wish so it stands on its own: the thread cannot see this chat. A follow-up that must repair or publish branches an earlier wish made names them in branches: it may commit on, push and open PRs for exactly those, never merge.',
      parameters: {
        title: { type: 'string', required: true, description: 'A few words the user will see as the thread name' },
        wish: {
          type: 'string',
          required: true,
          description: 'The whole wish: the goal, what done looks like, anything to keep in mind',
        },
        branches: {
          type: 'array',
          items: { type: 'string' },
          description:
            "Optional. Existing branches an earlier wish made that this wish may change besides its own: commit repairs on them, push them to the project's remote and open or update their PRs. Only branches the user named, never the project's integration branch.",
        },
      },
      output,
      async execute(args, exec) {
        await ready;
        await rt.load();
        const self = rt.selfOf(exec.agent?.id);
        const bot = rt.botOf(self);
        if (bot?.kind !== GENIE_KIND) return 'Only Genie grants wishes. Ask Genie in its chat.';
        const readOnly = rt.readOnly();
        if (readOnly !== undefined) return readOnly;
        const title = String(args.title ?? '').trim();
        const wish = String(args.wish ?? '').trim();
        if (title === '' || wish === '') return 'A wish needs a title and the wish itself.';
        try {
          return await grantWish({ bot, title, wish, branches: args.branches });
        } catch (error) {
          return `The wish did not start: ${error?.message ?? error}`;
        }
      },
    }),
  );

  Object.assign(rt, {
    ensureGenie,
    createGenie,
    grantWish,
    genieWishes: () => load().wishes,
    genieReady: ready,
    genieReconciled: reconciled,
  });
}
