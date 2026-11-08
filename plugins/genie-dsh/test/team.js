// A stand-in Bot team runtime and DSH context for the tests, recording what the plugin asks
// of them. Both are Proxies over the README's host contract table: the plugin reading any
// `rt` or `ctx` member the table does not list throws, so the table stays the whole list.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '../index.js';

const PLUGIN = join(import.meta.dirname, '..');

/** The members the README's host contract table lists, as written: `rt.state.tasks`, `ctx.on`, … */
export function hostContract(readme = readFileSync(join(PLUGIN, 'README.md'), 'utf8')) {
  return [...readme.matchAll(/^\| `((?:rt|ctx)\.[\w.]+)` \|/gm)].map((match) => match[1]);
}
const CONTRACT = hostContract();

/**
 * `target` behind the contract under `prefix` (`rt`, `ctx`): a member the table does not list
 * throws; a listed one with listed members of its own (`rt.state`, `rt.hooks`, `ctx.tools`)
 * comes back guarded too. With `tests`, reads made on the Proxy itself are the tests' own and
 * pass: the plugin only ever reads the team through its runtime, which has it as prototype.
 */
export function guarded(target, prefix, { tests = false, members = CONTRACT } = {}) {
  const direct = new Map();
  for (const member of members) {
    if (!member.startsWith(`${prefix}.`)) continue;
    const [name, ...rest] = member.slice(prefix.length + 1).split('.');
    direct.set(name, direct.get(name) === true || rest.length > 0);
  }
  const proxy = new Proxy(target, {
    get(object, key, receiver) {
      if (typeof key !== 'string' || (tests && receiver === proxy)) return Reflect.get(object, key, receiver);
      if (!direct.has(key)) throw new Error(`${prefix}.${key} is not in the README host contract`);
      const value = Reflect.get(object, key, receiver);
      return direct.get(key) && value !== null && typeof value === 'object'
        ? guarded(value, `${prefix}.${key}`, { members })
        : value;
    },
  });
  return proxy;
}

export const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/**
 * The team, in `dir`: `tasks` is the team's task record (rt.state.tasks) when given, `resumesDone`
 * its resume pass, `onTask(sessionId, state)` runs as a task starts (a first turn that ends
 * before the grant saves sets its status there).
 */
export function fakeTeam(dir, { bots = {}, readOnly, noModel = false, tasks, resumesDone, onTask } = {}) {
  const model = noModel ? undefined : { provider: 'p', model: 'm' };
  const team = join(dir, 'team');
  mkdirSync(team, { recursive: true });
  const record = { created: [], tasks: [], views: [], endpoints: new Map(), saves: 0 };
  const state = { bots: { ...bots }, ...(tasks === undefined ? {} : { tasks }) };
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
      const sessionId = `session-${record.tasks.length}`;
      onTask?.(sessionId, state);
      return sessionId;
    },
    selfOf: (agentId) => agentId,
    botOf: (id) => state.bots[id],
    hooks: {
      view: (fn) => {
        record.views.push(fn);
        return () => {};
      },
      endpoint: (name, fn) => {
        record.endpoints.set(name, fn);
        return () => {};
      },
    },
    warn: () => {},
    ...(resumesDone === undefined ? {} : { resumesDone }),
  };
  mkdirSync(rt.home, { recursive: true });
  return guarded(rt, 'rt', { tests: true });
}

/** The plugin on `team`, with the DSH context it registers on. */
export function compose(team) {
  const tools = new Map();
  const listeners = [];
  const ctx = guarded(
    {
      effect: (run) => run(),
      on: (name, listener) => listeners.push([name, listener]),
      tools: { register: (tool) => tools.set(tool.name, tool) },
    },
    'ctx',
  );
  const rt = createRuntime(ctx, team);
  // A Session's turn ends, as DSH reports it to every plugin.
  const turnEnd = (sessionId, reason = { kind: 'completed' }) => {
    for (const [name, listener] of listeners) {
      if (name === 'session/event') listener({ id: sessionId }, { type: 'turn/end', data: { reason } });
    }
  };
  return { rt, tools, turnEnd };
}

export const grant = (tools, botId, args) => tools.get('grant_wish').execute(args, { agent: { id: botId } });

/** genie.json as it is on disk now. */
export const savedWishes = (team) => JSON.parse(readFileSync(join(team.home, 'genie.json'), 'utf8')).wishes;

/** Waits until `check()` is truthy on disk (a turn end settles a wish in the background), or fails. */
export async function until(check, what = 'the condition') {
  for (let i = 0; i < 200; i++) {
    let value;
    try {
      value = check();
    } catch {
      value = undefined;
    }
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}
