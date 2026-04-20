/**
 * Shared scaffold helpers for the 15 event/span types not fully implemented
 * in Group 2. Each scaffold schema still carries tier tagging on every field
 * so the CI lint passes, and still runs redactFreeText on free-form strings.
 *
 * Group 3 replaces each scaffold with its fully elaborated schema.
 */

import { z } from 'zod';
import { hashEntity, redactFreeText, tokenizePath } from '../redactors.js';
import { tagTier } from '../tier.js';

export const hashedEntity = (ns: string) =>
  tagTier(
    z
      .string()
      .min(1)
      .max(256)
      .transform((v) => hashEntity(ns, v)),
    'A',
  );

export const publicId = tagTier(z.string().min(1).max(256), 'B');
export const publicLabel = tagTier(z.string().min(1).max(128), 'C');
export const publicNumber = tagTier(z.number().finite(), 'C');
export const publicFlag = tagTier(z.boolean(), 'C');
export const publicTimestamp = tagTier(z.string().min(1).max(64), 'C');
export const publicPath = tagTier(z.string().max(1024).transform(tokenizePath), 'B');
export const redactedText = tagTier(z.string().max(4096).transform(redactFreeText), 'B');
