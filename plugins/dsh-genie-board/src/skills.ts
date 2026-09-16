import { CatalogService } from './catalog';
import { resolveSkillsConfig, schemaOf } from './config';
import { type HostContext, whenRuntime } from './runtime';

/**
 * The SKILLS sub-row: `@automagik/genie-dsh-board/skills`.
 *
 * Reads `skills/<name>/SKILL.md` out of a registered workspace. Nothing is
 * executed and nothing is written, so this row also serves in degraded mode —
 * but it still registers only through the manager's fence, and only once
 * `whenRuntime` hands it that fence.
 *
 * Its document route is its OWN path rather than the old shared
 * `/document?kind=`: two rows cannot both own one exact path, and splitting it
 * is what makes disabling this row remove exactly this row's surface.
 */

export const name = 'genie-dsh-board-skills';
export const Config = schemaOf(resolveSkillsConfig);

export function apply(ctx: HostContext, rawConfig?: unknown): void {
  const config = resolveSkillsConfig(rawConfig);
  whenRuntime(ctx, (runtime, scope) => {
    scope.effect(() => {
      const catalog = new CatalogService(runtime.registry);
      const disposers = [
        runtime.mount('skills', { ...config }),
        runtime.route('/api/genie-board/skills', 'GET', (req) => catalog.skills(runtime.workspaceOf(req))),
        runtime.route('/api/genie-board/skills/document', 'GET', async (req) => ({
          text: await catalog.document(runtime.workspaceOf(req), 'skill', documentName(req.url)),
        })),
      ];
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'genie: skills catalog routes');
  });
}

/** The requested document name, unvetted here: `CatalogService.document` is the one gate. */
export function documentName(url: string | undefined): string {
  return new URL(url ?? '/', 'http://localhost').searchParams.get('name') ?? '';
}
