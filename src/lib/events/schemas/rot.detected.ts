/**
 * Event: rot.detected — a self-healing detector observed drift.
 *
 * Wish: genie-self-healing-observability-b1-detectors (Group 3a).
 *
 * Emitted by every `DetectorModule` that ships under `src/detectors/`. The
 * event is a single shared shape: a `pattern_id` identifies which detector
 * fired, `entity_id` is the subject (team name, agent id, etc — hashed at
 * parse time), and `observed_state_json` carries the structured evidence.
 *
 * Strategy decision: one shared `rot.detected` schema rather than a distinct
 * type per detector. Reasons:
 *   1. Every rot emission has the same semantic — "detector observed drift".
 *   2. Keeping the registry surface to one type keeps the closed-world
 *      invariant testable without a schemas.test.ts fixture per detector.
 *   3. Cross-pattern queries ("show me all rot in the last hour") become a
 *      single `type='rot.detected'` filter instead of a UNION.
 *
 * Per-pattern structure still lives inside `observed_state_json`, and each
 * detector's render() function is the local source of truth for which keys
 * it populates. The schema validates keys are snake_case and values are
 * scalars, nulls, or primitive arrays so we keep JSON serializability
 * without opening the door to arbitrary objects (no open-world types —
 * emit-discipline lint enforces the closed list).
 *
 * V1 is measurement only. Consumers of this event are watchers and future
 * triage tooling; no remediation logic reads it.
 */

import { z } from 'zod';
import { hashEntity, redactFreeText } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'rot.detected' as const;
export const KIND = 'event' as const;

/**
 * Detector identifier. Kebab-case with a `pattern-<N>-` prefix so humans can
 * map a fire back to the module file in `src/detectors/`. Tier C (public
 * label — pattern ids are non-sensitive metadata).
 */
const PatternIdSchema = tagTier(
  z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'pattern_id must be kebab/dot/underscore lowercase'),
  'C',
);

/**
 * Subject entity that triggered the fire — team name, agent id, etc. Hashed
 * at parse time (tier A) so raw identifiers never land in JSONB.
 */
const EntityIdSchema = tagTier(
  z
    .string()
    .min(1)
    .max(256)
    .transform((v) => hashEntity('entity', v)),
  'A',
);

/**
 * Structured evidence map. Values are restricted to scalars, nulls, and
 * primitive arrays — no arbitrary nested objects, no open-world schemas.
 * Free-text string values run through redactFreeText so any secret-shaped
 * substring is scrubbed before write.
 */
const ObservedValueSchema = tagTier(
  z.union([
    z.string().max(4096).transform(redactFreeText),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(z.string().max(1024).transform(redactFreeText)).max(256),
    z.array(z.number().finite()).max(256),
  ]),
  'B',
  'evidence scalar — free text runs through redactFreeText',
);

const ObservedStateSchema = tagTier(
  z
    .record(
      z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9_]+$/, 'observed_state key must be snake_case'),
      ObservedValueSchema,
    )
    .refine((obj) => Object.keys(obj).length <= 32, {
      message: 'observed_state_json cannot exceed 32 keys',
    }),
  'B',
  'per-pattern evidence record — keys documented by each detector module',
);

export const schema = z
  .object({
    pattern_id: PatternIdSchema,
    entity_id: EntityIdSchema,
    observed_state_json: ObservedStateSchema,
  })
  .strict();

export type RotDetectedPayload = z.infer<typeof schema>;
