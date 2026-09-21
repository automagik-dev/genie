/**
 * Types for the shipped ESM helper beside this file.
 *
 * The helper is plain JavaScript because it runs from a skill payload on a host
 * that has no TypeScript. `scripts/wishes-lint.ts` imports it, and that script is
 * now part of the `genie wish lint` command surface — so it entered the `tsc`
 * program, where an untyped import is an error rather than an `any`. This
 * declaration is the type boundary; `scripts/design-review-evidence.test.ts`
 * keeps it byte-identical with the `skills/wish/references/` copy.
 */

export declare class DesignEvidenceError extends Error {}

export declare const DESIGN_REVIEW_START: string;
export declare const DESIGN_REVIEW_END: string;
export declare const DESIGN_REVIEW_VERDICTS: Set<string>;

export interface DesignReviewEvidence {
  verdict: string;
  reviewedSha256: string;
  reviewer: string;
  reviewedAt: string;
}

export declare function readDesign(designPath: string): string;
export declare function writeDesign(designPath: string, contents: string): void;
/** The design body with the evidence block removed — what the digest is taken over. */
export declare function reviewableDesign(source: string): string;
export declare function designReviewDigest(source: string): string;
export declare function parseDesignReviewEvidence(source: string): Partial<DesignReviewEvidence> | null;
/** Every reason this design's evidence block is not current, SHIP-verdict evidence. */
export declare function designReviewViolations(source: string): string[];
export declare function stampDesignReview(source: string, evidence: Partial<DesignReviewEvidence>): string;
export declare function runDesignReviewEvidenceCli(): void;
