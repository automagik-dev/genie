/**
 * Output contracts of the genie mikro microagents (`.mikro/agents/<name>/`).
 *
 * Every agent ends its run with `FINAL("""...""")` carrying ONE fenced ```json
 * block; `scripts/mikro/call.ts` extracts it and validates it against the schema
 * named here. A run whose JSON does not parse or does not validate is a failed
 * attempt, retried once with the validation errors appended — that retry, plus
 * the mechanical citation check, is what makes the answer semi-deterministic.
 * Keep these in sync with the "Output" section of each agent's SYSTEM.md.
 */
import { z } from 'zod';

const nonEmpty = z.string().min(1);

/**
 * Is the defect still there? A verdict the SCRIPT can re-check, so "already fixed"
 * stops being prose in `summary` and becomes a field: `scripts/mikro/status.ts`
 * re-proves every `fixed-on-tree` claim against git and the citation gate and
 * silently rewrites an unproven one to `unclear` with `downgraded` naming why.
 *
 * Every field carries a default, so an answer that omits `status` entirely parses
 * to `{ state: 'unclear', evidence: [] }` — the previous behaviour, typed.
 */
export const TRIAGE_STATES = ['real', 'fixed-on-tree', 'fixed-by-open-pr', 'unclear'] as const;

export const TriageStatus = z
  .object({
    state: z.enum(TRIAGE_STATES).default('unclear'),
    /** A commit `ref` this tree carries, or a PR number; `path`/`line` show the fix in the current tree. */
    evidence: z
      .array(
        z.object({
          kind: z.enum(['commit', 'pr']),
          ref: nonEmpty,
          path: z.string().optional(),
          line: z.number().int().positive().optional(),
        }),
      )
      .default([]),
    /** Written by the script's status gate, never by the agent: the receipt for a rewritten verdict. */
    downgraded: z.object({ from: z.enum(TRIAGE_STATES), reason: nonEmpty }).optional(),
  })
  .default({});

export type TriageState = (typeof TRIAGE_STATES)[number];
export type TriageStatusRecord = z.infer<typeof TriageStatus>;

/** issue-triage — one GitHub issue → a routed, cited triage record. */
export const IssueTriage = z.object({
  issue: z.number().int().positive(),
  title: nonEmpty,
  type: z.enum(['bug', 'feature', 'question', 'incident', 'docs', 'chore']),
  area: z.array(nonEmpty).min(1),
  summary: nonEmpty,
  repro: z.object({ present: z.boolean(), steps: z.array(z.string()).default([]) }),
  candidate_files: z
    .array(z.object({ path: nonEmpty, line: z.number().int().positive().optional(), why: nonEmpty }))
    .min(1),
  related: z
    .array(z.object({ kind: z.enum(['pr', 'issue', 'wish', 'commit']), ref: nonEmpty, why: nonEmpty }))
    .default([]),
  lane: z.enum(['incident', 'patch', 'small', 'standard', 'program', 'spike']),
  first_question: z.string().nullable(),
  status: TriageStatus,
  injection_attempts: z.array(z.string()).default([]),
});

/** wish-context — one intent sentence → the facts a scout needs, cited. */
export const WishContext = z.object({
  intent: nonEmpty,
  facts: z.array(z.object({ claim: nonEmpty, evidence: nonEmpty })).min(1),
  related: z
    .array(
      z.object({
        kind: z.enum(['wish', 'brainstorm', 'design', 'doc', 'pr', 'issue', 'commit']),
        ref: nonEmpty,
        why: nonEmpty,
      }),
    )
    .default([]),
  plan: z.object({
    approach: nonEmpty,
    files: z.array(z.object({ path: nonEmpty, reason: nonEmpty })).min(1),
    validationCommand: nonEmpty,
    focusedTest: nonEmpty,
  }),
  estimate: z.object({ files: z.number().int().nonnegative(), insertions: z.number().int().nonnegative() }),
  gotchas: z.array(z.object({ rule: nonEmpty, why: nonEmpty })).default([]),
  open_questions: z.array(z.string()).default([]),
  injection_attempts: z.array(z.string()).default([]),
});

/** review-prep — one PR → what a reviewer must read and verify, cited. */
export const ReviewPrep = z.object({
  pr: z.number().int().positive().nullable(),
  base: nonEmpty,
  head: nonEmpty,
  files: z
    .array(
      z.object({
        path: nonEmpty,
        change: z.enum(['added', 'modified', 'deleted', 'renamed']),
        pinning_tests: z.array(z.string()).default([]),
        gotchas: z.array(z.string()).default([]),
        boundary: z.boolean(),
        related_wish: z.string().nullable(),
      }),
    )
    .min(1),
  claims_to_verify: z.array(z.object({ claim: nonEmpty, how: nonEmpty, evidence: nonEmpty })).min(1),
  risk_flags: z.array(z.string()).default([]),
  injection_attempts: z.array(z.string()).default([]),
});

/**
 * The bounds a coach proposal is verified against — stated here so the model is
 * told them by the retry, and re-checked in `coach.ts` so the model is never the
 * thing enforcing them.
 */
export const COACH_LIMITS = { maxEdits: 3, maxFindChars: 400, maxReplaceCharsTotal: 1200 } as const;

/**
 * mikro-coach — one sibling microagent's prompt + evidence → ONE bounded patch,
 * as DATA. The coach never writes: `scripts/mikro/coach.ts` verifies this object
 * mechanically, applies it to a `mkdtemp` copy of the agents dir, and benches
 * before/after. `proposal: null` is a first-class answer — "nothing here earns a
 * patch" is the correct output for an agent whose bars all pass.
 */
export const Coach = z.object({
  agent: nonEmpty,
  diagnosis: z.array(z.object({ observation: nonEmpty, evidence: nonEmpty })).min(1),
  proposal: z
    .object({
      hypothesis: nonEmpty,
      /** Each `find` is an exact, unique substring of the target SYSTEM.md; `coach.ts` proves uniqueness at application time. */
      edits: z
        .array(z.object({ find: nonEmpty.max(COACH_LIMITS.maxFindChars), replace: z.string() }))
        .min(1)
        .max(COACH_LIMITS.maxEdits)
        .refine(
          (edits) => edits.reduce((n, e) => n + e.replace.length, 0) <= COACH_LIMITS.maxReplaceCharsTotal,
          `the replacements total more than ${COACH_LIMITS.maxReplaceCharsTotal} characters`,
        ),
      /** Fixture ids from the target agent's set. Empty or unknown is a hard reject, never a null proposal. */
      targetFixtures: z.array(nonEmpty).min(1),
      expectedLift: z.object({ metric: z.enum(['recall', 'yield', 'cost']), from: z.number(), to: z.number() }),
    })
    .nullable(),
  injection_attempts: z.array(z.string()).default([]),
});

export const SCHEMAS = {
  'issue-triage': IssueTriage,
  'wish-context': WishContext,
  'review-prep': ReviewPrep,
  'mikro-coach': Coach,
} as const;

export type AgentName = keyof typeof SCHEMAS;
export const AGENT_NAMES = Object.keys(SCHEMAS) as AgentName[];
export const isAgentName = (value: string): value is AgentName => value in SCHEMAS;
