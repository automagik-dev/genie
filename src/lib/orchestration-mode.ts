import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { OrchestrationConfigSchema } from '../types/genie-config.js';
import { getGenieConfigPath } from './genie-config.js';

export type OrchestrationMode = 'standalone' | 'orca';

export const LOCAL_LIFECYCLE_DISABLED_CODE = 'local_lifecycle_disabled_in_orca_mode' as const;
export const INVALID_ORCHESTRATION_AUTHORITY_CODE = 'invalid_orchestration_authority' as const;

const OrchestrationAuthoritySchema = z
  .object({
    orchestration: OrchestrationConfigSchema.strict().optional(),
  })
  .passthrough();

export class InvalidOrchestrationAuthorityError extends Error {
  readonly code = INVALID_ORCHESTRATION_AUTHORITY_CODE;

  constructor() {
    super(`${INVALID_ORCHESTRATION_AUTHORITY_CODE}: config orchestration.mode must be either "standalone" or "orca"`);
    this.name = 'InvalidOrchestrationAuthorityError';
  }
}

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

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new InvalidOrchestrationAuthorityError();
  }

  const parsed = OrchestrationAuthoritySchema.safeParse(raw);
  if (!parsed.success) throw new InvalidOrchestrationAuthorityError();
  return parsed.data.orchestration?.mode ?? 'standalone';
}

/** Fail closed before any local lifecycle store can be opened or changed. */
export function assertLocalLifecycleEnabled(): void {
  if (resolveOrchestrationMode() === 'orca') throw new LocalLifecycleDisabledError();
}
