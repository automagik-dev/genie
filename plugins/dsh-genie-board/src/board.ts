import { resolveBoardConfig, schemaOf } from './config';
import { type HostContext, body, requireRuntime } from './runtime';
import { BoardService } from './service';

/**
 * The BOARD sub-row: `@automagik/genie-dsh-board/board`.
 *
 * Registers the workspace list, the board read and the one mutating action,
 * all through the manager's fence. It never resolves an executable of its own:
 * without the `genieRuntime` service it registers nothing at all.
 */

export const name = 'genie-dsh-board-board';
export const inject = ['genieRuntime'];
export const Config = schemaOf(resolveBoardConfig);

export function apply(ctx: HostContext, rawConfig?: unknown): void {
  const config = resolveBoardConfig(rawConfig);
  const runtime = requireRuntime(ctx);
  ctx.effect(() => {
    // Degraded mode: without a compatible binary the board reads stay as a bare
    // workspace list and the mutating action is withheld entirely.
    const service = runtime.compatible
      ? new BoardService(runtime.registry, runtime.executable, undefined, () => runtime.budget())
      : undefined;
    const disposers = [
      runtime.mount('board', { ...config }),
      runtime.route('/api/genie-board/workspaces', 'GET', () =>
        service ? service.workspaces() : runtime.registry.list().map(({ id, title }) => ({ id, title })),
      ),
    ];
    if (service)
      disposers.push(
        runtime.route('/api/genie-board/action', 'POST', async (req) => service.request(await body(req)), true),
      );
    return () => {
      for (const dispose of disposers) dispose();
      service?.dispose();
    };
  }, 'genie: board routes');
}
