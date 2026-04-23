/**
 * Tier marker helpers for Zod schemas.
 *
 * Each field on an event/span schema must carry a Tier A/B/C tag in its
 * `.describe()` metadata. The lint rule in `scripts/lint-emit-discipline.ts`
 * rejects any schema file without tier markers.
 */

import type { z } from 'zod';
import type { Tier } from './redactors.js';

export const TIER_MARKER_PREFIX = 'tier:';

/** Attach a tier tag to a schema via `.describe()`. Idempotent. */
export function tagTier<T extends z.ZodTypeAny>(schema: T, tier: Tier, note?: string): T {
  const desc = `${TIER_MARKER_PREFIX}${tier}${note ? `; ${note}` : ''}`;
  return schema.describe(desc) as T;
}

/** Read the tier tag from a schema's description. Returns null if absent. */
export function readTier(schema: z.ZodTypeAny): Tier | null {
  const desc = schema.description;
  if (!desc) return null;
  const match = desc.match(/tier:([ABC])\b/);
  return match ? (match[1] as Tier) : null;
}
