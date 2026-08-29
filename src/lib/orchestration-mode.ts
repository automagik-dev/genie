import { existsSync, readFileSync } from 'node:fs';
import { GenieConfigSchema } from '../types/genie-config.js';
import { getGenieConfigPath } from './genie-config.js';

export type OrchestrationMode = 'standalone' | 'orca';

export const LOCAL_LIFECYCLE_DISABLED_CODE = 'local_lifecycle_disabled_in_orca_mode' as const;

export class LocalLifecycleDisabledError extends Error {
  readonly code = LOCAL_LIFECYCLE_DISABLED_CODE;

  constructor() {
    super(
      `${LOCAL_LIFECYCLE_DISABLED_CODE}: local Genie lifecycle state is disabled because orchestration.mode is "orca"`,
    );
    this.name = 'LocalLifecycleDisabledError';
  }
}

/** Resolve lifecycle authority without creating or changing configuration. */
export function resolveOrchestrationMode(): OrchestrationMode {
  const path = getGenieConfigPath();
  if (!existsSync(path)) return 'standalone';
  try {
    const parsed = GenieConfigSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data.orchestration.mode : 'standalone';
  } catch {
    return 'standalone';
  }
}

/** Fail closed before any local lifecycle store can be opened or changed. */
export function assertLocalLifecycleEnabled(): void {
  if (resolveOrchestrationMode() === 'orca') throw new LocalLifecycleDisabledError();
}
