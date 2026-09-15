/**
 * The closed skill taxonomy, mirrored for the plugin.
 *
 * These two lists are the contract declared in
 * `scripts/skills-inventory-parity.ts` and enforced by `scripts/skills-lint.ts`.
 * They are MIRRORED rather than imported because this module is a dependency-
 * free package bundled by esbuild for both Node and the browser: importing the
 * repository script would drag `node:fs` into the browser bundle. `taxonomy.test.ts`
 * asserts the mirror against the canonical lists, so drift fails the gate
 * instead of silently hiding a category.
 */

/** Order is the rendering order of the Skills panel's category headers. */
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

/**
 * The widest blast radius a skill's body claims. Advisory: no route gates on
 * it, the panel only shows it.
 */
export const SKILL_MUTATES_LEVELS = ['none', 'documents', 'repo', 'external'] as const;
export type SkillMutates = (typeof SKILL_MUTATES_LEVELS)[number];
