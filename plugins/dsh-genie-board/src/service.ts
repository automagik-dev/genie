import { realpath, stat } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { type Budget, DEADLINE_MS, GenieCommandError, execute, hostEnvironment } from './process';
import { type Aggregate, type Request, parseAggregate, parseBoards, parseRequest } from './schema';

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
/** A card claimed through this Host, kept alive while the plugin process lives. */
interface Claim {
  workspaceId: string;
  path: string;
  id: string;
}
/**
 * How often a DSH-held claim pulses. Genie renders a claim `running` for five
 * minutes after its last heartbeat, so a shorter period keeps a card the human
 * claimed here fresh instead of instantly `stale` and reclaimable (F8).
 */
export const KEEPALIVE_INTERVAL_MS = 4 * 60 * 1000;
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
  private readonly claims = new Map<string, Claim>();
  private timer: ReturnType<typeof setInterval> | undefined;
  readonly identity = `dsh:${userInfo().username}@${hostname()}`;
  private readonly environment = hostEnvironment(this.identity);
  constructor(
    private readonly registry: Registry,
    private readonly binary: string,
    private readonly run = execute,
    /** One fresh deadline/output budget per browser request; the manager row supplies the configured one. */
    private readonly budget: () => Budget = () => ({ expires: Date.now() + DEADLINE_MS, bytes: 0 }),
  ) {}
  workspaces() {
    const current = this.registry.list();
    const ids = new Set(current.map((workspace) => workspace.id));
    for (const id of this.selections.keys()) if (!ids.has(id)) this.selections.delete(id);
    for (const [key, claim] of this.claims) if (!ids.has(claim.workspaceId)) this.claims.delete(key);
    return current.map(({ id, title }) => ({ id, title }));
  }
  /** Stop the keep-alive timer; the Host calls this when its routes are disposed. */
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.claims.clear();
  }
  /**
   * One keep-alive round: `task heartbeat` for every card claimed through this
   * Host. A workspace with a browser request in flight is skipped (that request
   * refreshes the card anyway), and a card whose heartbeat is refused has left
   * this Host's hands, so it is dropped instead of retried forever.
   */
  async pulse(): Promise<void> {
    for (const [key, claim] of [...this.claims]) {
      if (this.active.has(claim.workspaceId)) continue;
      try {
        await this.run(this.binary, ['task', 'heartbeat', claim.id], claim.path, this.environment, this.budget());
      } catch {
        this.claims.delete(key);
      }
    }
  }
  private remember(workspaceId: string, path: string, aggregate: Aggregate): void {
    for (const lane of aggregate.lanes)
      for (const card of lane.cards) {
        const key = `${workspaceId}\u0000${card.id}`;
        if (card.claimedBy === this.identity && card.status === 'in_progress')
          this.claims.set(key, { workspaceId, path, id: card.id });
        else this.claims.delete(key);
      }
    if (this.claims.size && !this.timer) {
      this.timer = setInterval(() => void this.pulse(), KEEPALIVE_INTERVAL_MS);
      this.timer.unref?.();
    }
  }
  /**
   * Canonicalize and vet the workspace directory. Every failure answers with the
   * same operator-readable sentence: the raw `ENOENT ... <absolute path>` would
   * put a Host filesystem path in a browser response (C2).
   */
  private async resolvePath(workspace: Workspace): Promise<string> {
    const path = await realpath(workspace.path).catch(() => {
      throw new Error('Workspace path is unavailable');
    });
    if (!(await isDirectory(path))) throw new Error('Workspace path is unavailable');
    if (!(await isDirectory(join(path, '.genie'))))
      throw new Error('Workspace has no .genie directory; run `genie init` in it first');
    // Worktrees have a regular .git file; ordinary repositories have a directory.
    if (!(await exists(join(path, '.git')))) throw new Error('Workspace must be a physical repository');
    return path;
  }
  async request(input: unknown): Promise<unknown> {
    const request = parseRequest(input);
    this.workspaces();
    if (this.active.has(request.workspaceId)) throw new Error('Workspace operation in progress; wait and reload');
    this.active.add(request.workspaceId);
    let mutationCompleted = false;
    let executed = false;
    try {
      const workspace = this.registry.list().find((entry) => entry.id === request.workspaceId);
      if (!workspace) throw new Error('Unknown workspace');
      const path = await this.resolvePath(workspace);
      const previous = this.selections.get(workspace.id);
      if (previous && previous.path !== path) {
        this.selections.delete(workspace.id);
        throw new Error('Workspace changed; list boards again');
      }
      const budget: Budget = this.budget();
      const run = (args: string[]) => {
        executed = true;
        return this.run(this.binary, args, path, this.environment, budget);
      };
      if (request.action === 'list') {
        const boards = parseBoards(await run(['board', 'list', '--json']));
        this.selections.set(workspace.id, { path, boards: new Set(boards.map((board) => board.id)) });
        return boards;
      }
      if (!previous?.boards.has(request.boardRef)) throw new Error('Unknown board; list boards first');
      if (request.action !== 'load') {
        if (previous.board !== request.boardRef) throw new Error('Board selection changed; reload');
        if ('id' in request && !previous.tasks?.has(request.id)) throw new Error('Task is outside the selected board');
        if (request.action === 'move' && !previous.lanes?.has(request.lane)) throw new Error('Unknown lane');
        await run(actionArgs(request, this.identity));
        // A claim made here starts its life fresh, not `stale`: the checkout
        // records no heartbeat of its own, so the Host pulses it immediately.
        if (request.action === 'checkout') await run(['task', 'heartbeat', request.id]);
        mutationCompleted = true;
      }
      const aggregate = parseAggregate(await run(['board', '--board', request.boardRef, '--json']));
      const cards = aggregate.lanes.flatMap((lane) => lane.cards);
      if (cards.some((card) => card.boardId !== request.boardRef)) throw new Error('Foreign board card in aggregate');
      this.selections.set(workspace.id, {
        path,
        boards: previous.boards,
        board: request.boardRef,
        tasks: new Set(cards.map((card) => card.id)),
        lanes: new Set(aggregate.lanes.map((lane) => lane.name)),
      });
      this.remember(workspace.id, path, aggregate);
      return aggregate;
    } catch (error) {
      // Evidence survives exactly the failures that cannot have changed state:
      // a check that never spawned, and a command that ran and refused (Genie
      // applies a verb in one transaction, so a non-zero exit changed nothing).
      // A killed child — deadline or output overflow — is not one of those.
      if (!executed || (error instanceof GenieCommandError && !mutationCompleted)) throw error;
      this.selections.delete(request.workspaceId);
      if (mutationCompleted)
        throw new Error('Operation may have completed, but refresh failed. Reload before making another change.');
      throw error;
    } finally {
      this.active.delete(request.workspaceId);
    }
  }
}
async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (entry) => entry.isDirectory(),
    () => false,
  );
}
async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
