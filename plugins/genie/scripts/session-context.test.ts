import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Database } from 'bun:sqlite';

// The shipped artifact is under test: the byte-identical esbuild bundle the
// three manifests invoke via `node …/session-context.cjs` (see
// scripts/hook-bundle-parity.ts). Fixtures live under a temp dir and never
// touch the real genie.db or wish corpus.
const SESSION_CONTEXT = join(import.meta.dir, 'session-context.cjs');
const AGENT_ID = '11111111-2222-3333-4444-555555555555';
const AGENT_NAME = 'dream-worker-seven';

interface SeedTask {
  id: string;
  title: string;
  status: string;
  claimedBy?: string | null;
  wish?: string | null;
  group?: string | null;
}

interface RunOptions {
  env?: Record<string, string>;
  preload?: string;
  input?: Record<string, unknown>;
}

interface HookRun {
  stdout: string;
  stderr: string;
  exitCode: number;
  context: string | null;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'genie-session-context-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeWish(slug: string, status = 'APPROVED', body = ''): void {
  const dir = join(root, '.genie', 'wishes', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'WISH.md'), `| **Status** | ${status} |\n${body}`, 'utf8');
}

/** .git dir with a HEAD; a missing branch value writes a detached sha HEAD. */
function writeGit(branch?: string): void {
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), branch ? `ref: refs/heads/${branch}\n` : `${'0'.repeat(40)}\n`, 'utf8');
}

function seedDb(tasks: SeedTask[] = []): string {
  const path = join(root, '.genie', 'genie.db');
  mkdirSync(join(root, '.genie'), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec(
    'CREATE TABLE tasks (' +
      'id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, ' +
      'claimed_by TEXT, wish TEXT, group_name TEXT); ' +
      'CREATE TABLE wish_groups (wish TEXT NOT NULL, name TEXT NOT NULL);',
  );
  const insert = db.prepare(
    'INSERT INTO tasks (id, title, status, claimed_by, wish, group_name) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const task of tasks) {
    insert.run(task.id, task.title, task.status, task.claimedBy ?? null, task.wish ?? null, task.group ?? null);
  }
  db.close();
  return path;
}

async function runHook(cwd: string, options: RunOptions = {}): Promise<HookRun> {
  const args: string[] = [];
  if (options.preload) args.push('--require', options.preload);
  args.push(SESSION_CONTEXT);
  const env = { ...process.env };
  delete env.GENIE_AGENT_ID;
  delete env.GENIE_AGENT_NAME;
  delete env.GENIE_WORKER;
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  for (const [key, value] of Object.entries(options.env ?? {})) env[key] = value;
  const proc = Bun.spawn(['node', ...args], {
    cwd,
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  proc.stdin.write(JSON.stringify({ hook_event_name: 'SessionStart', cwd, ...(options.input ?? {}) }));
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let context: string | null = null;
  try {
    const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } };
    context = parsed.hookSpecificOutput?.additionalContext ?? null;
  } catch {
    // A non-JSON stdout surfaces through the expectations below.
  }
  return { stdout, stderr, exitCode, context };
}

/** Simulate a Node without node:sqlite by refusing the builtin at load time. */
function blockSqlitePreload(): string {
  const path = join(root, 'block-sqlite.cjs');
  writeFileSync(
    path,
    [
      "'use strict';",
      "const Module = require('node:module');",
      'const original = Module._load;',
      'Module._load = function (request, parent, isMain) {',
      "  if (request === 'node:sqlite') throw new Error('Cannot find module node:sqlite (simulated older Node)');",
      '  return original.apply(this, arguments);',
      '};',
      '',
    ].join('\n'),
    'utf8',
  );
  return path;
}

describe('session-context.cjs — db-backed context-aware SessionStart', () => {
  test('each of five active wish branches surfaces its own wish and no others', async () => {
    const slugs = ['headless-turn-open', 'herdr-swap', 'hooks-v2', 'spawn-context-contract', 'agent-svg-icons'];
    const statuses = ['APPROVED', 'APPROVED', 'APPROVED', 'APPROVED', 'DRAFT'];
    const tasks = slugs.flatMap((slug, index) => [
      { id: `t_${index}_base`, title: `${slug} base card`, status: 'ready', wish: slug, group: null },
      { id: `t_${index}_ready`, title: `${slug} ready card`, status: 'ready', wish: slug, group: 'g-one' },
      { id: `t_${index}_done`, title: `${slug} done card`, status: 'done', wish: slug, group: 'g-two' },
    ]);
    seedDb(tasks);
    for (let index = 0; index < slugs.length; index++) writeWish(slugs[index], statuses[index]);

    for (let index = 0; index < slugs.length; index++) {
      writeGit(`wish/${slugs[index]}`);
      const run = await runHook(root);
      expect(run.exitCode).toBe(0);
      expect(run.context).toContain(`wish=${slugs[index]} status=${statuses[index]}`);
      expect(run.context).toContain(`plan=.genie/wishes/${slugs[index]}/WISH.md`);
      // base counts group-less cards; ready counts every ready card in scope
      // (the base card itself is ready here).
      expect(run.context).toContain('- base=1 ready=2');
      expect(run.context).toContain(`t_${index}_base ready ${slugs[index]} base card`);
      expect(run.context).toContain(`t_${index}_ready ready ${slugs[index]} ready card`);
      expect(run.context).toContain(`t_${index}_done done ${slugs[index]} done card`);
      for (const other of slugs.filter((slug) => slug !== slugs[index])) {
        expect(run.context).not.toContain(`wish=${other}`);
        expect(run.context).not.toContain(`${other} base card`);
        expect(run.context).not.toContain(`${other} ready card`);
      }
    }
  });

  test('a group branch scopes tasks to exactly that group', async () => {
    writeWish('hooks-v2');
    writeGit('wish/hooks-v2-session-context');
    seedDb([
      { id: 't_base', title: 'the wish base card', status: 'ready', wish: 'hooks-v2', group: null },
      { id: 't_mine', title: 'session-context group card', status: 'in_progress', wish: 'hooks-v2', group: 'session-context' },
      { id: 't_other', title: 'budgets group card', status: 'ready', wish: 'hooks-v2', group: 'budgets' },
    ]);
    const run = await runHook(root);
    expect(run.exitCode).toBe(0);
    expect(run.context).toContain('wish=hooks-v2 status=APPROVED group=session-context');
    expect(run.context).toContain('t_mine in_progress session-context group card');
    expect(run.context).not.toContain('t_base');
    expect(run.context).not.toContain('t_other');
    expect(run.context).toContain('- base=0 ready=0');
  });

  test('claimed tasks surface for GENIE_AGENT_ID; other claims never leak', async () => {
    writeGit('dev');
    seedDb([
      { id: 't_mine', title: 'my in-progress card', status: 'in_progress', claimedBy: AGENT_ID },
      { id: 't_theirs', title: 'someone else card', status: 'in_progress', claimedBy: 'someone-else' },
      { id: 't_ready', title: 'my ready card is not a claim', status: 'ready', claimedBy: AGENT_ID },
      { id: 't_done', title: 'my done card', status: 'done', claimedBy: AGENT_ID },
    ]);
    const run = await runHook(root, { env: { GENIE_AGENT_ID: AGENT_ID } });
    expect(run.exitCode).toBe(0);
    expect(run.context).toContain(`agent=${AGENT_ID} claimed=1`);
    expect(run.context).toContain('t_mine my in-progress card');
    expect(run.context).not.toContain('t_theirs');
    expect(run.context).not.toContain('t_ready');
    expect(run.context).not.toContain('t_done');
  });

  test('claims recorded under the worker name surface when only the name is exported', async () => {
    writeGit('dev');
    seedDb([{ id: 't_name', title: 'claimed as a name', status: 'in_progress', claimedBy: AGENT_NAME }]);
    const run = await runHook(root, { env: { GENIE_AGENT_NAME: AGENT_NAME } });
    expect(run.exitCode).toBe(0);
    expect(run.context).toContain(`agent=${AGENT_NAME} claimed=1`);
    expect(run.context).toContain('t_name claimed as a name');
  });

  test('both identities match both claim spellings, id preferred in the header', async () => {
    writeGit('dev');
    seedDb([
      { id: 't_id', title: 'claimed by id', status: 'in_progress', claimedBy: AGENT_ID },
      { id: 't_name', title: 'claimed by name', status: 'in_progress', claimedBy: AGENT_NAME },
    ]);
    const run = await runHook(root, { env: { GENIE_AGENT_ID: AGENT_ID, GENIE_AGENT_NAME: AGENT_NAME } });
    expect(run.exitCode).toBe(0);
    expect(run.context).toContain(`agent=${AGENT_ID} claimed=2`);
    expect(run.context).toContain('t_id claimed by id');
    expect(run.context).toContain('t_name claimed by name');
  });

  test('a plain session gets exactly one compact line — never a listing', async () => {
    writeGit('dev');
    writeWish('hooks-v2');
    writeWish('agent-svg-icons', 'DRAFT');
    seedDb([
      { id: 't_one', title: 'a wish task', status: 'ready', wish: 'hooks-v2', group: null },
      { id: 't_two', title: 'an unrelated task', status: 'ready' },
    ]);
    const run = await runHook(root, { env: { GENIE_AGENT_ID: AGENT_ID } });
    expect(run.exitCode).toBe(0);
    expect(run.context).toBe(`repo=${basename(root)}, branch=dev, active wishes: 2`);
    expect(run.context).not.toContain('slug=');
    expect(run.context).not.toContain('t_one');
    expect(run.context).not.toContain('t_two');
  });

  test('a wish known only to the file scan (no db rows) still gets its context', async () => {
    writeGit('wish/file-only-wish');
    writeWish('file-only-wish', 'IN_PROGRESS');
    seedDb([{ id: 't_other', title: 'some other card', status: 'ready', wish: 'other-wish' }]);
    const run = await runHook(root);
    expect(run.exitCode).toBe(0);
    expect(run.context).toContain('wish=file-only-wish status=IN_PROGRESS');
    expect(run.context).toContain('- base=0 ready=0');
    expect(run.context).not.toContain('t_other');
  });

  test('a heuristic-only wish branch (unknown everywhere) falls to the one line', async () => {
    writeGit('wish/unknown-wish');
    seedDb();
    const run = await runHook(root);
    expect(run.exitCode).toBe(0);
    expect(run.context).toBe(`repo=${basename(root)}, branch=wish/unknown-wish, active wishes: 0`);
  });

  test('a detached HEAD is a plain session', async () => {
    writeGit();
    writeWish('hooks-v2');
    seedDb();
    const run = await runHook(root);
    expect(run.exitCode).toBe(0);
    expect(run.context).toBe(`repo=${basename(root)}, branch=<none>, active wishes: 1`);
  });

  test('an absent genie.db degrades to the file scan without error and says so', async () => {
    writeGit('wish/hooks-v2');
    writeWish('hooks-v2', 'IN_PROGRESS');
    const run = await runHook(root);
    expect(run.exitCode).toBe(0);
    expect(run.context).toContain('wish=hooks-v2 status=IN_PROGRESS plan=.genie/wishes/hooks-v2/WISH.md');
    expect(run.context).toContain('- tasks: unavailable (genie.db absent)');
    expect(run.stderr).toContain('[session-context] genie.db absent at');
    expect(run.stderr).toContain('falling back to wish-file scan');
  });

  test('a Node without node:sqlite degrades the same way and says so distinguishably', async () => {
    writeGit('wish/hooks-v2');
    writeWish('hooks-v2', 'IN_PROGRESS');
    seedDb();
    const run = await runHook(root, { preload: blockSqlitePreload() });
    expect(run.exitCode).toBe(0);
    expect(run.context).toContain('wish=hooks-v2 status=IN_PROGRESS plan=.genie/wishes/hooks-v2/WISH.md');
    expect(run.context).toContain('- tasks: unavailable (no sqlite driver)');
    expect(run.stderr).toContain('[session-context] node:sqlite unavailable (minimum Node 22.13)');
    expect(run.stderr).toContain('falling back to wish-file scan');
    expect(run.stderr).not.toContain('genie.db absent');
  });

  test('a garbage genie.db degrades to the file scan and logs the unreadable cause', async () => {
    writeGit('wish/hooks-v2');
    writeWish('hooks-v2');
    mkdirSync(join(root, '.genie'), { recursive: true });
    writeFileSync(join(root, '.genie', 'genie.db'), 'this is not a sqlite database', 'utf8');
    const run = await runHook(root);
    expect(run.exitCode).toBe(0);
    expect(run.context).toContain('wish=hooks-v2 status=APPROVED');
    expect(run.context).toContain('- tasks: unavailable (genie.db unreadable)');
    expect(run.stderr).toContain('[session-context] genie.db unreadable at');
  });

  test('a linked worktree reads its own branch and the shared db at the common dir', async () => {
    const main = join(root, 'main');
    const mainWish = join(main, '.genie', 'wishes', 'hooks-v2');
    mkdirSync(mainWish, { recursive: true });
    writeFileSync(join(mainWish, 'WISH.md'), '| **Status** | APPROVED |\n', 'utf8');
    const mainDb = new Database(join(main, '.genie', 'genie.db'), { create: true });
    mainDb.exec(
      'CREATE TABLE tasks (' +
        'id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, ' +
        'claimed_by TEXT, wish TEXT, group_name TEXT); ' +
        'CREATE TABLE wish_groups (wish TEXT NOT NULL, name TEXT NOT NULL);',
    );
    mainDb
      .prepare('INSERT INTO tasks (id, title, status, claimed_by, wish, group_name) VALUES (?, ?, ?, ?, ?, ?)')
      .run('t_main', 'shared db card', 'ready', null, 'hooks-v2', null);
    mainDb.close();

    const worktree = join(root, 'worktree');
    const wtGitDir = join(main, '.git', 'worktrees', 'worktree');
    mkdirSync(join(worktree, '.genie', 'wishes', 'hooks-v2'), { recursive: true });
    writeFileSync(join(worktree, '.genie', 'wishes', 'hooks-v2', 'WISH.md'), '| **Status** | IN_PROGRESS |\n', 'utf8');
    mkdirSync(wtGitDir, { recursive: true });
    writeFileSync(join(worktree, '.git'), `gitdir: ${wtGitDir}\n`, 'utf8');
    writeFileSync(join(wtGitDir, 'HEAD'), 'ref: refs/heads/wish/hooks-v2\n', 'utf8');

    const run = await runHook(worktree);
    expect(run.exitCode).toBe(0);
    expect(run.context).toContain('wish=hooks-v2 status=IN_PROGRESS');
    expect(run.context).toContain('t_main ready shared db card');
    expect(run.context).toContain('- base=1 ready=1');
    // No degradation log — Node 24's node:sqlite ExperimentalWarning may still
    // appear on stderr, but the hook itself must stay silent here.
    expect(run.stderr).not.toContain('[session-context]');
  });

  test('a separate-git-dir layout keeps the branch but refuses the db, logged', async () => {
    writeGit('wish/hooks-v2');
    writeWish('hooks-v2');
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'HEAD'), 'ref: refs/heads/wish/hooks-v2\n', 'utf8');
    rmSync(join(root, '.git'), { recursive: true, force: true });
    writeFileSync(join(root, '.git'), `gitdir: ${elsewhere}\n`, 'utf8');
    const run = await runHook(root);
    expect(run.exitCode).toBe(0);
    expect(run.context).toContain('wish=hooks-v2 status=APPROVED');
    expect(run.context).toContain('- tasks: unavailable (genie.db unavailable (external/separate git-dir layout))');
    expect(run.stderr).toContain('genie.db unavailable (external/separate git-dir layout)');
  });

  test('hostile task titles are sanitized and the whole context stays within 2KB', async () => {
    writeGit('wish/hooks-v2');
    writeWish('hooks-v2');
    const hostile = `ev\u0001il\u0002 title ${'x'.repeat(4_000)}`;
    seedDb([{ id: 't_bad', title: hostile, status: 'ready', wish: 'hooks-v2', group: null }]);
    const run = await runHook(root);
    expect(run.exitCode).toBe(0);
    const parsed = JSON.parse(run.stdout) as { hookSpecificOutput: { additionalContext: string } };
    expect(parsed.hookSpecificOutput.additionalContext).toBe(run.context);
    expect(run.context).not.toContain('\u0001');
    expect(run.context).not.toContain('\u0002');
    expect(Buffer.byteLength(run.context ?? '', 'utf8')).toBeLessThanOrEqual(2_048);
  });

  test('a traversal-shaped branch never produces a plan path', async () => {
    writeGit('wish/../../evil');
    writeWish('hooks-v2');
    seedDb();
    const run = await runHook(root);
    expect(run.exitCode).toBe(0);
    // The branch is display text only: it must never become a plan path or a
    // resolved wish.
    expect(run.context).not.toContain('plan=');
    expect(run.context).not.toContain('wish=');
  });

  test('GENIE_WORKER=1 suppresses the hook with a valid JSON envelope', async () => {
    const run = await runHook(root, { env: { GENIE_WORKER: '1' } });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe('{}');
  });

  test('importing the bundle does not execute the hook', () => {
    const require = createRequire(import.meta.url);
    const bundle = require(SESSION_CONTEXT) as unknown;
    expect(typeof bundle).toBe('object');
  });
});
