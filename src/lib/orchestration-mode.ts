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
 * Why the CLI gate may not let a lifecycle verb run: Orca is the selected
 * authority, or the authority itself is unparseable. `false` is the only answer
 * that proves Genie still owns lifecycle state.
 *
 * The two refusing answers are kept DISTINCT rather than collapsed into one
 * boolean, because they are different facts and each has its own operator-facing
 * line. Telling someone with a corrupt `config.json` that "orca is the lifecycle
 * authority for this host" is a claim genie cannot support — nothing was
 * successfully read — and it sends them looking for an Orca install that may not
 * exist. Both still fail closed at exit 2: an `orchestration.mode` genie cannot
 * parse proves nothing, least of all `standalone`.
 */
export type OrcaLifecycleVerdict = 'orca' | 'invalid' | false;

export function orcaOwnsLifecycle(): OrcaLifecycleVerdict {
  try {
    return resolveOrchestrationMode() === 'orca' ? 'orca' : false;
  } catch (error) {
    // ONLY the authority's own typed failure is a verdict. An IO error, an
    // EACCES on the config, or any other throw is a real fault and must not be
    // silently relabelled as a configuration problem.
    if (error instanceof InvalidOrchestrationAuthorityError) return 'invalid';
    throw error;
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
 * The SECOND fixed literal, for the other reason the gate refuses: genie could
 * not parse `orchestration.mode` at all, so it cannot prove standalone and
 * fails closed at the same exit 2. It must NOT claim orca is the authority —
 * nothing was read, orca may not even be installed, and the first message sent
 * an operator with a corrupt `config.json` hunting for an Orca that was not
 * there. It names the unparseable field, points at the verb that reports the
 * state, and gives the same remedy, which rewrites the config and repairs it.
 */
export const ORCA_INVALID_AUTHORITY_MESSAGE =
  'Refused: `orchestration.mode` in the Genie config cannot be read, so genie cannot prove it still owns lifecycle state for this repository (it must be exactly "standalone" or "orca"). `genie doctor` reports the resolved authority. Run `genie setup --orchestration-mode standalone` to rewrite it — the previous config is backed up first.';

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
