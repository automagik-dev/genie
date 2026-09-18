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
  injection_attempts: z.array(z.string()).default([]),
});

/** wish-context — one intent sentence → the facts a scout needs, cited. */
export const WishContext = z.object({
  intent: nonEmpty,
  facts: z.array(z.object({ claim: nonEmpty, evidence: nonEmpty })).min(1),
  related: z
    .array(z.object({ kind: z.enum(['wish', 'brainstorm', 'pr', 'issue', 'commit']), ref: nonEmpty, why: nonEmpty }))
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

export const SCHEMAS = {
  'issue-triage': IssueTriage,
  'wish-context': WishContext,
  'review-prep': ReviewPrep,
} as const;

export type AgentName = keyof typeof SCHEMAS;
export const AGENT_NAMES = Object.keys(SCHEMAS) as AgentName[];
export const isAgentName = (value: string): value is AgentName => value in SCHEMAS;
