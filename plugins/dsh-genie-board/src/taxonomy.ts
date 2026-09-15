/**
 * The closed skill taxonomy, in the order the Skills panel groups by.
 *
 * It lives in its own dependency-free module on purpose: `catalog.ts` reads the
 * filesystem and the browser bundle must never pull `node:fs` in behind a
 * shared constant.
 */
export const SKILL_CATEGORIES = [
  'lifecycle',
  'routing',
  'delivery',
  'investigation',
  'authoring',
  'verification',
  'integration',
  'skill-ops',
] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];
