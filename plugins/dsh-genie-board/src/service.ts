import { realpath, stat } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { type Budget, DEADLINE_MS, execute, hostEnvironment } from './process';
import { type Request, aggregateSchema, boardsSchema, requestSchema } from './schema';

export interface Workspace {
  id: string;
  path: string;
  title: string;
}
export interface Registry {
  list(): Workspace[];
}
interface Selection {
  path: string;
  boards: Set<string>;
  board?: string;
  tasks?: Set<string>;
  lanes?: Set<string>;
}
export function actionArgs(request: Exclude<Request, { action: 'list' | 'load' }>, identity: string): string[] {
  switch (request.action) {
    case 'create':
      return ['task', 'create', '--title', request.title, '--board', request.boardRef];
    case 'move':
      return ['task', 'move', request.id, '--to', request.lane];
    case 'comment':
      return ['task', 'comment', '--', request.id, request.text];
    case 'block':
      return ['task', 'block', request.id, '--reason', request.text, ...(request.hold ? ['--hold'] : [])];
    case 'checkout':
      return ['task', 'checkout', request.id, '--worker', identity];
    default:
      return ['task', request.action, request.id];
  }
}
export class BoardService {
  private readonly selections = new Map<string, Selection>();
  private readonly active = new Set<string>();
  readonly identity = `dsh:${userInfo().username}@${hostname()}`;
  private readonly environment = hostEnvironment(this.identity);
  constructor(
    private readonly registry: Registry,
    private readonly binary: string,
    private readonly run = execute,
  ) {}
  workspaces() {
    const current = this.registry.list();
    const ids = new Set(current.map((workspace) => workspace.id));
    for (const id of this.selections.keys()) if (!ids.has(id)) this.selections.delete(id);
    return current.map(({ id, title }) => ({ id, title }));
  }
  async request(input: unknown): Promise<unknown> {
    const request = requestSchema.parse(input);
    this.workspaces();
    if (this.active.has(request.workspaceId)) throw new Error('Workspace operation in progress; wait and reload');
    this.active.add(request.workspaceId);
    let mutationCompleted = false;
    try {
      const workspace = this.registry.list().find((entry) => entry.id === request.workspaceId);
      if (!workspace) throw new Error('Unknown workspace');
      const path = await realpath(workspace.path);
      if (!(await stat(path)).isDirectory() || !(await stat(join(path, '.genie'))).isDirectory())
        throw new Error('Workspace must contain .genie');
      // Worktrees have a regular .git file; ordinary repositories have a directory.
      const git = await stat(join(path, '.git'));
      if (!git.isDirectory() && !git.isFile()) throw new Error('Workspace must be a physical repository');
      const previous = this.selections.get(workspace.id);
      if (previous && previous.path !== path) {
        this.selections.delete(workspace.id);
        throw new Error('Workspace changed; list boards again');
      }
      const budget: Budget = { expires: Date.now() + DEADLINE_MS, bytes: 0 };
      const run = (args: string[]) => this.run(this.binary, args, path, this.environment, budget);
      if (request.action === 'list') {
        const boards = boardsSchema.parse(JSON.parse(await run(['board', 'list', '--json'])));
        this.selections.set(workspace.id, { path, boards: new Set(boards.map((board) => board.id)) });
        return boards;
      }
      if (!previous?.boards.has(request.boardRef)) throw new Error('Unknown board; list boards first');
      if (request.action !== 'load') {
        if (previous.board !== request.boardRef) throw new Error('Board selection changed; reload');
        if ('id' in request && !previous.tasks?.has(request.id)) throw new Error('Task is outside the selected board');
        if (request.action === 'move' && !previous.lanes?.has(request.lane)) throw new Error('Unknown lane');
        await run(actionArgs(request, this.identity));
        mutationCompleted = true;
      }
      const aggregate = aggregateSchema.parse(JSON.parse(await run(['board', '--board', request.boardRef, '--json'])));
      const cards = aggregate.lanes.flatMap((lane) => lane.cards);
      if (cards.some((card) => card.boardId !== request.boardRef)) throw new Error('Foreign board card in aggregate');
      this.selections.set(workspace.id, {
        path,
        boards: previous.boards,
        board: request.boardRef,
        tasks: new Set(cards.map((card) => card.id)),
        lanes: new Set(aggregate.lanes.map((lane) => lane.name)),
      });
      return aggregate;
    } catch (error) {
      this.selections.delete(request.workspaceId);
      if (mutationCompleted)
        throw new Error('Operation may have completed, but refresh failed. Reload before making another change.');
      throw error;
    } finally {
      this.active.delete(request.workspaceId);
    }
  }
}
