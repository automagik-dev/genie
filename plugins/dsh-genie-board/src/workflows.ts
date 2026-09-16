import { CatalogService } from './catalog';
import { resolveWorkflowsConfig, schemaOf } from './config';
import { type HostContext, whenRuntime } from './runtime';
import { documentName } from './skills';

/**
 * The WORKFLOWS sub-row: `@automagik/genie-dsh-board/workflows`.
 *
 * Reads `.claude/workflows/<name>.js` out of a registered workspace, listing
 * each script's phases and when-to-use guidance. Read-only, like the skills
 * row, and registered only through the manager's fence — and, like it, only
 * once `whenRuntime` hands it that fence.
 */

export const name = 'genie-dsh-board-workflows';
export const Config = schemaOf(resolveWorkflowsConfig);

export function apply(ctx: HostContext, rawConfig?: unknown): void {
  const config = resolveWorkflowsConfig(rawConfig);
  whenRuntime(ctx, (runtime, scope) => {
    scope.effect(() => {
      const catalog = new CatalogService(runtime.registry);
      const disposers = [
        runtime.mount('workflows', { ...config }),
        runtime.route('/api/genie-board/workflows', 'GET', (req) => catalog.workflows(runtime.workspaceOf(req))),
        runtime.route('/api/genie-board/workflows/document', 'GET', async (req) => ({
          text: await catalog.document(runtime.workspaceOf(req), 'workflow', documentName(req.url)),
        })),
      ];
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'genie: workflows catalog routes');
  });
}
