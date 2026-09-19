import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { getGenieConfigPath } from './genie-config.js';

export type OrchestrationMode = 'standalone' | 'orca';

export const LOCAL_LIFECYCLE_DISABLED_CODE = 'local_lifecycle_disabled_in_orca_mode' as const;
export const INVALID_ORCHESTRATION_AUTHORITY_CODE = 'invalid_orchestration_authority' as const;

const OrchestrationAuthoritySchema = z
  .object({
    orchestration: z
      .object({ mode: z.enum(['standalone', 'orca']) })
      .strict()
      .optional(),
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

/**
 * True when this host cannot prove Genie still owns lifecycle state — Orca is
 * the selected authority, OR the authority itself is unreadable. An
 * `orchestration.mode` genie cannot parse proves nothing, least of all
 * `standalone`, so the CLI gate fails closed; the one remedy below repairs both.
 */
export function orcaOwnsLifecycle(): boolean {
  try {
    return resolveOrchestrationMode() === 'orca';
  } catch {
    return true;
  }
}

/**
 * The root verbs Orca owns outright once it is the lifecycle authority. This is
 * the CLOSED list, by root verb only — no leaf paths, and it is defined nowhere
 * else in the tree. A verb joins or leaves it here and nowhere else, and
 * `orchestration-mode.test.ts` pins the membership so neither happens silently.
 */
export const ORCA_FORBIDDEN: ReadonlySet<string> = new Set(['task', 'board', 'idea']);

/**
 * The ONE fixed refusal. It is a literal, defined once and referenced
 * everywhere else (the CLI gate, the tests), so the refusal an operator sees
 * and the refusal a test asserts can never drift apart.
 *
 * Exit 2 — not 1 — is what the gate pairs this with. 2 is genie's established
 * "the operator must act" family: the v4 workspace gate exits 2 when there is
 * no workspace to create one, and `genie mikro call` exits 2 on a usage
 * refusal. 1 stays "the command ran and failed". An orca-mode refusal is
 * neither a crash nor a failed command — it is a host configured to send this
 * work somewhere else, and the remedy below is the single action that changes
 * that.
 */
export const ORCA_REFUSAL_MESSAGE =
  'Refused: this verb is disabled while orca is the lifecycle authority for this host. Run `genie setup --orchestration-mode standalone` to give lifecycle state back to Genie.';

/**
 * Does this invocation hit the orca gate? `rootVerb` is the first verb under
 * `genie`, `subVerb` the one below it (undefined when there is none).
 *
 * THE ONE CARVE-OUT, expressed here and nowhere else: `genie task sync` is
 * exempt. The git hooks run it on every commit, merge and rewrite, so a refusal
 * on that path printed `board snapshot not refreshed` on every single commit in
 * an orca-mode repository. It is let through to `handleSync`, which has nothing
 * to reconcile in orca mode and exits 0 in silence. No other subverb of any
 * `ORCA_FORBIDDEN` root is exempt.
 */
export function isOrcaForbiddenInvocation(rootVerb: string, subVerb: string | undefined): boolean {
  if (!ORCA_FORBIDDEN.has(rootVerb)) return false;
  if (rootVerb === 'task' && subVerb === 'sync') return false;
  return true;
}
