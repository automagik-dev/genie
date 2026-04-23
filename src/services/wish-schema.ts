/**
 * Zod schema + derived types for the canonical WishDocument structure.
 *
 * Source of truth for every downstream consumer: the CLI `wish` command group,
 * the `wish lint` linter, and the `/wish` skill's handoff step all read from
 * this single `WishDocument` shape. Changes to section semantics start here.
 */

import { z } from 'zod';

/** All violation rule IDs emitted by parser + linter. Literal union for exhaustiveness. */
export const VIOLATION_RULES = [
  'missing-execution-groups-header',
  'group-header-format',
  'missing-goal-field',
  'missing-deliverables-field',
  'missing-acceptance-field',
  'missing-validation-field',
  'missing-depends-on-field',
  'empty-out-scope',
  'missing-validation-command',
  'depends-on-malformed',
  'depends-on-dangling',
  'validation-not-fenced-bash',
  'metadata-table-missing-field',
  'scope-section-missing',
  'todo-placeholder-remaining',
  'missing-title',
  'missing-summary',
  'missing-execution-group',
] as const;

export type ViolationRule = (typeof VIOLATION_RULES)[number];

export const WishMetadataSchema = z.object({
  status: z.string().min(1),
  slug: z.string().min(1),
  date: z.string().min(1),
  author: z.string().min(1),
  appetite: z.string().min(1),
  branch: z.string().min(1),
  reposTouched: z.string().optional(),
  design: z.string().optional(),
});

export type WishMetadata = z.infer<typeof WishMetadataSchema>;

export const DecisionRowSchema = z.object({
  number: z.string(),
  decision: z.string(),
  rationale: z.string(),
});

export type DecisionRow = z.infer<typeof DecisionRowSchema>;

export const WaveEntrySchema = z.object({
  wave: z.string(),
  group: z.string(),
  agent: z.string(),
  description: z.string(),
});

export type WaveEntry = z.infer<typeof WaveEntrySchema>;

export const RiskRowSchema = z.object({
  risk: z.string(),
  severity: z.string(),
  mitigation: z.string(),
});

export type RiskRow = z.infer<typeof RiskRowSchema>;

/**
 * `depends-on` value:
 *   - `'none'` when the group has no upstream dependencies
 *   - otherwise a list of group references. Each ref is either `Group N` or
 *     `<slug>#<number>` (e.g., `wish-command-group-restructure#1`).
 */
export const DependsOnSchema = z.union([z.literal('none'), z.array(z.string().min(1)).min(1)]);

export type DependsOn = z.infer<typeof DependsOnSchema>;

export const ExecutionGroupSchema = z.object({
  /** The raw header line, e.g., "Group 1: Parser + schema + WishDocument type". */
  name: z.string().min(1),
  /** Numeric identifier, e.g., 1. */
  number: z.number().int().positive(),
  /** Title after the `Group N:` prefix. */
  title: z.string().min(1),
  /** First paragraph(s) after **Goal:**. */
  goal: z.string().min(1),
  /** Raw markdown content of the Deliverables block (list items, prose, tables). */
  deliverables: z.string().min(1),
  /** Checklist items parsed from the **Acceptance Criteria:** section. */
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  /** Contents of the fenced `bash` block under **Validation:**. Empty string when block is absent. */
  validation: z.string(),
  /** Parsed depends-on value. */
  dependsOn: DependsOnSchema,
  /** 1-indexed line where the `### Group N:` header appears. */
  startLine: z.number().int().positive(),
  /** 1-indexed line where the group content ends (before next group or `---`). */
  endLine: z.number().int().positive(),
});

export type ExecutionGroup = z.infer<typeof ExecutionGroupSchema>;

export const WishDocumentSchema = z
  .object({
    title: z.string().min(1),
    metadata: WishMetadataSchema,
    summary: z.string().min(1),
    scope: z.object({
      in: z.array(z.string()),
      out: z.array(z.string().min(1)).min(1, 'OUT scope must contain at least one bullet'),
    }),
    decisions: z.array(DecisionRowSchema),
    successCriteria: z.array(z.string().min(1)),
    executionStrategy: z.array(WaveEntrySchema),
    executionGroups: z.array(ExecutionGroupSchema).min(1, 'Wish must contain at least one execution group'),
    qaCriteria: z.array(z.string()),
    assumptionsRisks: z.array(RiskRowSchema),
    reviewResults: z.string(),
    filesToCreate: z.string(),
  })
  .superRefine((doc, ctx) => {
    // depends-on dangling reference check: every "Group N" ref must resolve to an
    // existing group in this document (cross-slug refs are allowed and not checked here).
    const validNumbers = new Set(doc.executionGroups.map((g) => g.number));
    for (const group of doc.executionGroups) {
      if (group.dependsOn === 'none') continue;
      for (const ref of group.dependsOn) {
        const m = /^Group\s+(\d+)$/i.exec(ref.trim());
        if (!m) continue;
        const n = Number.parseInt(m[1] as string, 10);
        if (!validNumbers.has(n)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['executionGroups'],
            message: `Group ${group.number} depends-on references non-existent Group ${n}`,
          });
        }
      }
    }
  });

export type WishDocument = z.infer<typeof WishDocumentSchema>;
