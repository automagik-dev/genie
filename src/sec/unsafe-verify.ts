// Shared contract for the `--unsafe-unverified <INCIDENT_ID>` escape hatch.
//
// This module is the ONLY source of truth for:
//   - the INCIDENT_ID regex
//   - the typed-acknowledgement string format
//   - the validator that mutating subcommands call before bypassing signature
//     verification
//
// Every mutating `genie sec` subcommand (remediate, restore, rollback, and any
// future command) MUST import `validateUnsafeUnverified` from here rather than
// re-implementing the contract. The council reviewer upgraded M2 to HIGH
// precisely because divergent implementations eroded friction.

/**
 * Canonical INCIDENT_ID shape:
 *   <UPPER_SNAKE_PREFIX>_<YYYY>_<MM>_<DD>[_<extra>]
 *
 * Examples (accepted):
 *   BURNED_KEY_2026_04_23
 *   CI_PRE_SIGNING_2026_04_23
 *   TEST_HARNESS_2026_04_23_JOB_ABC
 *   CI_PRE_SIGNING_2026_04_23_TEST_HARNESS
 *
 * Examples (rejected):
 *   foo, burned-key-2026-04-23, "", 2026_04_23_BURNED_KEY
 *
 * Implementation note: the wish-spec sketch used `[A-Z]+` for the prefix, but
 * that would fail its own documented examples (e.g., `BURNED_KEY_...` contains
 * an embedded underscore that `[A-Z]+` cannot consume). The regex below is the
 * faithful form: UPPER-snake prefix (at least one letter, trailing underscore
 * before the date), YYYY_MM_DD, and an optional alphanumeric `_extra` tail.
 */
export const INCIDENT_ID_REGEX = /^[A-Z][A-Z0-9_]*_[0-9]{4}_[0-9]{2}_[0-9]{2}(_[A-Za-z0-9_]+)?$/;

/**
 * Prefix for the verbatim acknowledgement string the operator must type on the
 * confirmation prompt. The full ack is PREFIX + INCIDENT_ID.
 */
export const TYPED_ACK_PREFIX = 'I_ACKNOWLEDGE_UNSIGNED_GENIE_';

/**
 * Documented legitimate contexts for invoking `--unsafe-unverified`. The
 * runbook (sec-incident-runbook) owns the human-side prose; this array exists
 * so CLI help text, audit-log enrichment, and telemetry stay in sync.
 *
 * Adding a new prefix requires a council-approved PR that updates both this
 * array AND the runbook. The regex itself accepts any UPPER_SNAKE prefix — the
 * enumeration is documentation, not enforcement.
 */
export const LEGITIMATE_CONTEXTS: ReadonlyArray<{
  prefix: string;
  description: string;
}> = Object.freeze([
  Object.freeze({
    prefix: 'BURNED_KEY_',
    description:
      'Public-key / keyless cert compromise confirmed by Namastex security. Signing contract is untrusted end-to-end; operator is running an unverified binary by design.',
  }),
  Object.freeze({
    prefix: 'CI_PRE_SIGNING_',
    description:
      'CI pipeline exercising a mutating subcommand before the signing workflow has run for this build. Used by release-engineering integration tests.',
  }),
  Object.freeze({
    prefix: 'TEST_HARNESS_',
    description:
      'Integration test harness for mutating subcommands. Never used in production; audit log captures the INCIDENT_ID for post-hoc filtering.',
  }),
]);

export type UnsafeUnverifiedFailure =
  | 'missing-flag'
  | 'invalid-incident-id'
  | 'missing-typed-ack'
  | 'typed-ack-mismatch';

export type UnsafeUnverifiedResult =
  | {
      ok: true;
      incidentId: string;
      typedAck: string;
      expectedTypedAck: string;
    }
  | {
      ok: false;
      reason: UnsafeUnverifiedFailure;
      expectedTypedAck?: string;
      message: string;
    };

/**
 * Build the verbatim ack string the operator must type on the confirmation
 * prompt. The output is deterministic: same INCIDENT_ID => same ack.
 *
 * Callers MUST NOT normalise or lower-case the result. The whole point of the
 * contract is that the operator types it character-for-character.
 */
export function buildTypedAck(incidentId: string): string {
  return `${TYPED_ACK_PREFIX}${incidentId}`;
}

/**
 * Validate an `--unsafe-unverified <flag>` invocation against the operator's
 * typed ack. Returns a discriminated union so the caller can branch on the
 * specific failure (logging, exit code, user-facing hint) without re-deriving
 * the reason from a string.
 *
 * Order of checks matters: the most specific failure wins so the audit log
 * captures the earliest contract breach.
 */
export function validateUnsafeUnverified(
  flag: string | undefined,
  typedAck: string | undefined,
): UnsafeUnverifiedResult {
  if (flag === undefined || flag === '') {
    return {
      ok: false,
      reason: 'missing-flag',
      message: '--unsafe-unverified requires an INCIDENT_ID argument (e.g., BURNED_KEY_2026_04_23).',
    };
  }

  if (!INCIDENT_ID_REGEX.test(flag)) {
    return {
      ok: false,
      reason: 'invalid-incident-id',
      message: `INCIDENT_ID ${JSON.stringify(flag)} does not match ${INCIDENT_ID_REGEX}.`,
    };
  }

  const expectedTypedAck = buildTypedAck(flag);

  if (typedAck === undefined || typedAck === '') {
    return {
      ok: false,
      reason: 'missing-typed-ack',
      expectedTypedAck,
      message: `Typed acknowledgement required. Type verbatim: ${expectedTypedAck}`,
    };
  }

  if (typedAck !== expectedTypedAck) {
    return {
      ok: false,
      reason: 'typed-ack-mismatch',
      expectedTypedAck,
      message: `Typed acknowledgement mismatch. Expected ${JSON.stringify(
        expectedTypedAck,
      )} but got ${JSON.stringify(typedAck)}.`,
    };
  }

  return {
    ok: true,
    incidentId: flag,
    typedAck,
    expectedTypedAck,
  };
}

/**
 * Format the contract for CLI --help or runbook output. Kept alongside the
 * regex + prefix so a change in one forces a change here.
 */
export function describeUnsafeUnverifiedContract(): string {
  const contexts = LEGITIMATE_CONTEXTS.map((c) => `  ${c.prefix}<YYYY_MM_DD>[_extra]  — ${c.description}`).join('\n');

  return [
    '--unsafe-unverified <INCIDENT_ID> requires a typed acknowledgement.',
    '',
    `  INCIDENT_ID regex:  ${INCIDENT_ID_REGEX}`,
    `  Typed ack format:  ${TYPED_ACK_PREFIX}<INCIDENT_ID>`,
    '',
    'Legitimate contexts:',
    contexts,
  ].join('\n');
}
