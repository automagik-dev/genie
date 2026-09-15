import sourcePackage from '../../../package.json';
declare const __GENIE_BUILD_VERSION__: string;
import { type ManagerConfig, resolveManagerConfig, schemaOf, socketDeadlineOf } from './config';
import { compatible, execute, hostEnvironment, resolveExecutable } from './process';
import { type HostContext, type RuntimeVerdict, createRuntime, requireService } from './runtime';
import type { Registry } from './service';

/**
 * The MANAGER row: the bare package `@automagik/genie-dsh-board`.
 *
 * It owns everything the three sub-rows must not each own a copy of — the one
 * resolved Genie executable and its compatibility verdict, the one trust fence,
 * and workspace resolution — and publishes them as the cordis service
 * `genieRuntime`. It registers exactly one route of its own, `/health`, which
 * reports the verdict, the resolved config, and which sub-rows are mounted.
 * The browser gates its panels on that last field.
 */

export { SOCKET_MARGIN_MS } from './config';
export const name = 'genie-dsh-board';
export const inject = ['workspaceRegistry', 'webServer', 'connection'];
export const minimumGenieVersion =
  typeof __GENIE_BUILD_VERSION__ === 'undefined' ? sourcePackage.version : __GENIE_BUILD_VERSION__;
/** The socket deadline for the DEFAULT handler budget; a configured row derives its own. */
export const SOCKET_DEADLINE_MS = socketDeadlineOf(resolveManagerConfig());
export const Config = schemaOf(resolveManagerConfig);

/** Run the executable once and decide whether mutating routes may exist at all. */
async function verdictOf(config: ManagerConfig): Promise<RuntimeVerdict> {
  try {
    const executable = resolveExecutable();
    const version = (
      await execute(executable, ['--version'], process.cwd(), hostEnvironment('dsh-host'), {
        expires: Date.now() + config.deadlineMs,
        bytes: 0,
        limit: config.outputBudgetBytes,
      })
    ).trim();
    if (!compatible(version, minimumGenieVersion)) throw new Error(`Genie ${minimumGenieVersion} or newer is required`);
    return { executable, version, compatible: true, error: '' };
  } catch (failure) {
    // Degraded mode: the error is recorded, health stays up, and only the
    // mutating routes are withheld. The read-only catalogs need no binary.
    return {
      executable: '',
      version: '',
      compatible: false,
      error: failure instanceof Error ? failure.message : 'Genie unavailable',
    };
  }
}

export async function apply(ctx: HostContext, rawConfig?: unknown): Promise<void> {
  const config = resolveManagerConfig(rawConfig);
  // Validate every required host service once, here, with a named error.
  requireService<Registry>(ctx, 'workspaceRegistry', 'list');
  requireService<HostContext['webServer']>(ctx, 'webServer', 'register');
  requireService<HostContext['connection']>(ctx, 'connection', 'requestRejection');
  const verdict = await verdictOf(config);
  const runtime = createRuntime(ctx, config, verdict);
  ctx.effect(() => {
    const disposers = [
      ctx.provide('genieRuntime', runtime),
      runtime.route('/api/genie-board/health', 'GET', () => ({
        compatible: runtime.compatible,
        version: runtime.version,
        executable: runtime.executable,
        minimumGenieVersion,
        error: runtime.error,
        mounted: runtime.mounted(),
        config: { manager: runtime.config, ...runtime.rows() },
      })),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, 'genie: runtime service and health route');
}
