// The Genie Bot and its wishes. Genie lives in one project folder (its Bot's workDir).
// grant_wish makes the wish its own clone of the project, on a new wish/<slug> branch, and
// hands the wish to a Tasks session there (rt.startTask): the team runs it, shows it as a
// thread under Genie while it works, resumes it after a restart, and brings its final
// report back to Genie's chat when it ends. When it ends, this module fetches the wish's
// branch back into the project, and keeps the list of wishes, so ended ones stay listed
// under Genie.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { branchExists, cloneForWish, fetchWishBranch, gitProblem, headCommit, initRepo, topLevel } from './git.js';

export const GENIE_KIND = 'genie';
export const GENIE_NAMES = ['Genie', 'Genie Bot', 'The Genie'];
export const GENIE_PROJECT = 'genie';
export const WISHES_KEPT = 30;
// A tool's text result, drawn as the team's own tools draw theirs (bots-dsh src/host/tools.js).
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] };

export const GENIE_INSTRUCTIONS = [
  'You are Genie: you grant wishes in your project, the folder you live in.',
  'Talk with the user in plain words. When they want something built, changed or fixed in the project, agree on the wish in a sentence or two, then call grant_wish with a short title and the whole wish written so it stands on its own.',
  'Each wish runs as its own thread, in its own copy of the project on a branch wish/<name>, so your chat stays clean. When it ends, the branch is brought back into the project and its report comes back to you: tell the user in a line or two what was done and where (the branch), and that they can merge it when they are happy.',
  'If grant_wish answers that something is missing (git, a project folder), give the user exactly the fix it names.',
  'Do not do the wish yourself in this chat.',
].join('\n');

export const GENIE_BOT = Object.freeze({
  kind: GENIE_KIND,
  role: 'Grants wishes in your project',
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

/** What the wish thread is told: the wish, where to work and how to finish. */
export function wishBrief({ title, wish, folder, branch, base }) {
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
    `4. Commit everything on ${branch} with a clear message (git add -A, then git commit). Do not push, merge, or touch any other branch.`,
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
  const save = () => {
    const temp = `${file()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(temp, file());
  };

  const genieBots = () => Object.values(rt.state?.bots ?? {}).filter((bot) => bot.kind === GENIE_KIND);

  // The Genie Bot, made once (the plugin loads on every start): an existing genie Bot is
  // kept, and one the user deleted is not made again.
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
    // With a default model already served (Connect AI done), Genie takes it and greets at
    // once; with none, its greeting waits until Connect AI gives it one.
    const model = await Promise.resolve(rt.defaultModel?.()).catch(() => undefined);
    const bot = await rt.createBot({ ...GENIE_BOT, name, workDir: project, pickModel: model === undefined });
    load().genieCreated = true;
    save();
    return bot;
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
    const base = await headCommit(top);
    if (base === null)
      return { error: `The repository ${top} has no commit yet. Make a first commit there, then ask again.` };
    return { repo: top, base };
  }

  async function grantWish({ bot, title, wish }) {
    const problem = await gitProblem();
    if (problem !== null) return problem;
    const where = await repositoryFor(bot);
    if (where.error) return where.error;
    const { repo, base } = where;
    let slug = slugOf(title);
    for (let n = 2; (await branchExists(repo, `wish/${slug}`)) || load().wishes.some((w) => w.slug === slug); n++) {
      slug = `${slugOf(title)}-${n}`;
    }
    const branch = `wish/${slug}`;
    const root = join(wishesRoot(rt.teamFolder?.()), basename(repo));
    mkdirSync(root, { recursive: true });
    const folder = join(root, slug);
    const made = await cloneForWish(repo, folder, branch, base);
    if (!made.ok) return `The wish did not start: ${made.error}`;
    const text = wishBrief({ title, wish, folder, branch, base });
    // bots-dsh with startTask's cwd (automagik PR #9) opens the thread in its folder with
    // the Bots' preset; an older one ignores both and the brief's absolute path still holds.
    const sessionId = await rt.startTask({
      title: `Wish: ${title}`,
      text,
      from: bot.id,
      cwd: folder,
      agentPreset: 'standard',
    });
    const entry = { slug, title, branch, folder, repo, base, sessionId, botId: bot.id, at: Date.now() };
    const list = load().wishes;
    list.unshift(entry);
    list.splice(WISHES_KEPT);
    save();
    await rt.save();
    return `Wish "${title}" is granted as a thread on branch ${branch}. Its report comes back to you as a message when it ends; do not wait or poll.`;
  }

  // A wish's turn ends: its branch comes back into the project, once. A turn a restart cut
  // is not an end (the team resumes it).
  const bringBack = async (wish) => {
    const back = await fetchWishBranch(wish.repo, wish.folder, wish.branch);
    wish.delivered = back.ok;
    if (!back.ok) {
      wish.deliveryError = back.error;
      rt.warn?.('genie: wish %s stayed in %s: %s', wish.branch, wish.folder, back.error);
    }
    save();
  };
  ctx.on?.('session/event', (session, event) => {
    if (event?.type !== 'turn/end' || rt.cutByRestart?.(event.data?.reason)) return;
    const wish = load().wishes.find((entry) => entry.sessionId === session?.id && entry.delivered !== true);
    if (wish !== undefined) void bringBack(wish).catch((error) => rt.warn?.('genie: %s', error?.message ?? error));
  });

  // The wishes, for the rows under Genie; their status is the team's task status.
  ctx.effect(
    () =>
      rt.hooks.view(() => ({
        genie: {
          wishes: load().wishes.map(({ slug, title, branch, sessionId, botId, at }) => ({
            slug,
            title,
            branch,
            sessionId,
            botId,
            at,
          })),
        },
      })),
    'genie: wishes in the team view',
  );

  ctx.tools.register(
    defineTool({
      name: 'grant_wish',
      description:
        'Genie only. Grants one wish in your project: a new thread works on it in its own copy of the project on a new branch, then reports back to you. Write the wish so it stands on its own: the thread cannot see this chat.',
      parameters: {
        title: { type: 'string', required: true, description: 'A few words the user will see as the thread name' },
        wish: {
          type: 'string',
          required: true,
          description: 'The whole wish: the goal, what done looks like, anything to keep in mind',
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
          return await grantWish({ bot, title, wish });
        } catch (error) {
          return `The wish did not start: ${error?.message ?? error}`;
        }
      },
    }),
  );

  Object.assign(rt, { ensureGenie, grantWish, genieWishes: () => load().wishes, genieReady: ready });
}
