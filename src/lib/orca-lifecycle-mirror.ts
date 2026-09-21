/**
 * The genie → Orca board mirror: one pure map from a genie lifecycle
 * transition to the card write that represents it.
 *
 * Three properties are deliberate and load-bearing:
 *
 *   - **It is pure.** No I/O, no clock, no import of the Orca adapter. The
 *     caller passes `today`; the map is a table and a format string, so the
 *     five rows are provable in a unit test rather than observable only
 *     against a running Orca.
 *   - **It is one-way.** The only callable takes a GENIE transition and
 *     answers an Orca status; no export accepts an Orca status, so nothing in
 *     this module can turn a board column back into lifecycle truth. The
 *     documents (and, in standalone mode, `genie.db`) stay the record.
 *   - **It refuses before Orca is touched.** Every input fault — a missing or
 *     misplaced verdict, an unknown word, evidence that is empty, multi-line
 *     or over budget, a `today` that is not a calendar date — is a typed
 *     `MirrorInputError` with a machine-readable `reason`, so `genie orca
 *     mirror` can exit 2 without spawning anything.
 *
 * The comment it composes must satisfy the adapter's `oneLineText` domain
 * (NFC, one line, ≤ 512 UTF-8 bytes). Evidence is normalized to NFC and capped
 * at 300 bytes here, which leaves the fixed prefix (a 10-byte date, the
 * transition word and an optional verdict) far inside that ceiling.
 */

/** The genie lifecycle transitions that reach the card. */
export const GENIE_TRANSITIONS = ['APPROVED', 'IN_PROGRESS', 'REVIEW', 'SHIPPED', 'BLOCKED'] as const;
export type GenieTransition = (typeof GENIE_TRANSITIONS)[number];

/** The reviewer verdicts; only `REVIEW` carries one. */
export const REVIEW_VERDICTS = ['SHIP', 'FIX-FIRST', 'BLOCKED'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** Orca's four default board columns — the whole output domain of this map. */
export const ORCA_WORKSPACE_STATUSES = ['todo', 'in-progress', 'in-review', 'completed'] as const;
export type OrcaWorkspaceStatus = (typeof ORCA_WORKSPACE_STATUSES)[number];

/** The card's one status line is short on purpose: a pointer, never the evidence block. */
export const MAX_EVIDENCE_BYTES = 300;

export type MirrorInputReason =
  | 'unknown_transition'
  | 'unknown_verdict'
  | 'verdict_required'
  | 'verdict_not_allowed'
  | 'invalid_today'
  | 'evidence_empty'
  | 'evidence_not_one_line'
  | 'evidence_too_long';

/** A caller-fixable input fault: usage, never an Orca failure. */
export class MirrorInputError extends Error {
  readonly name = 'MirrorInputError';

  constructor(
    readonly reason: MirrorInputReason,
    message: string,
  ) {
    super(message);
  }
}

export interface MirrorTransitionInput {
  /** A `GENIE_TRANSITIONS` member; anything else is refused. */
  readonly to: string;
  /** A `REVIEW_VERDICTS` member — required by `REVIEW`, refused on every other transition. */
  readonly verdict?: string;
  /** One line naming the proof: group, head SHA, gap count, gate, merge SHA. */
  readonly evidence: string;
  /** The caller's clock as `YYYY-MM-DD`; this module has none. */
  readonly today: string;
}

export interface MirrorTransitionResult {
  readonly workspaceStatus: OrcaWorkspaceStatus;
  readonly comment: string;
}

interface TransitionRule {
  readonly workspaceStatus: OrcaWorkspaceStatus;
  /** The lowercase word the comment spells. */
  readonly word: string;
}

/**
 * The owner's map, verbatim. `BLOCKED` is the "waiting on a human" transition:
 * the card stays `in-progress` and the comment names the gate, because Orca's
 * four columns carry no blocked column and inventing one would make the board
 * disagree with every other workspace on the host.
 */
const TRANSITIONS: Readonly<Record<GenieTransition, TransitionRule>> = Object.freeze({
  APPROVED: { workspaceStatus: 'todo', word: 'approved' },
  IN_PROGRESS: { workspaceStatus: 'in-progress', word: 'in progress' },
  REVIEW: { workspaceStatus: 'in-review', word: 'review' },
  SHIPPED: { workspaceStatus: 'completed', word: 'shipped' },
  BLOCKED: { workspaceStatus: 'in-progress', word: 'blocked' },
});

/** The one transition that carries a verdict. */
const VERDICT_TRANSITION: GenieTransition = 'REVIEW';

function requireTransition(to: string): GenieTransition {
  const match = GENIE_TRANSITIONS.find((candidate) => candidate === to);
  if (match === undefined) {
    throw new MirrorInputError(
      'unknown_transition',
      `--to must be one of ${GENIE_TRANSITIONS.join(', ')}, not "${to}"`,
    );
  }
  return match;
}

function requireVerdict(to: GenieTransition, verdict: string | undefined): ReviewVerdict | undefined {
  if (to === VERDICT_TRANSITION && verdict === undefined) {
    throw new MirrorInputError(
      'verdict_required',
      `${VERDICT_TRANSITION} requires --verdict (${REVIEW_VERDICTS.join(', ')})`,
    );
  }
  if (to !== VERDICT_TRANSITION && verdict !== undefined) {
    throw new MirrorInputError('verdict_not_allowed', `--verdict belongs to ${VERDICT_TRANSITION} only, not to ${to}`);
  }
  if (verdict === undefined) return undefined;
  const match = REVIEW_VERDICTS.find((candidate) => candidate === verdict);
  if (match === undefined) {
    throw new MirrorInputError(
      'unknown_verdict',
      `--verdict must be one of ${REVIEW_VERDICTS.join(', ')}, not "${verdict}"`,
    );
  }
  return match;
}

/** `YYYY-MM-DD`, and a date that actually exists: `2026-02-30` is not a day. */
function requireToday(today: string): string {
  const shaped = /^\d{4}-\d{2}-\d{2}$/.test(today);
  const parsed = shaped ? new Date(`${today}T00:00:00Z`) : new Date(Number.NaN);
  if (!shaped || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== today) {
    throw new MirrorInputError('invalid_today', `today must be a calendar date spelled YYYY-MM-DD, not "${today}"`);
  }
  return today;
}

/** NFC, one line, within the card's byte budget — the adapter's comment domain, minus the prefix. */
function requireEvidence(evidence: string): string {
  const text = evidence.normalize('NFC');
  if (text.trim().length === 0) {
    throw new MirrorInputError('evidence_empty', '--evidence must name the proof; it cannot be empty');
  }
  if ([...text].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) {
    throw new MirrorInputError(
      'evidence_not_one_line',
      '--evidence must be one line: it carries no control character, newline or tab',
    );
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_EVIDENCE_BYTES) {
    throw new MirrorInputError(
      'evidence_too_long',
      `--evidence is ${bytes} UTF-8 bytes; the card's status line carries at most ${MAX_EVIDENCE_BYTES}`,
    );
  }
  return text;
}

/**
 * Map one genie transition onto the card write that represents it.
 *
 * Answers `{workspaceStatus, comment}` where the comment is
 * `<today> genie <transition>[: <verdict>] — <evidence>`. Throws
 * `MirrorInputError` — and nothing else — for every input fault.
 */
export function mirrorTransition(input: MirrorTransitionInput): MirrorTransitionResult {
  const today = requireToday(input.today);
  const to = requireTransition(input.to);
  const verdict = requireVerdict(to, input.verdict);
  const evidence = requireEvidence(input.evidence);
  const rule = TRANSITIONS[to];
  const verdictSuffix = verdict === undefined ? '' : `: ${verdict}`;
  return Object.freeze({
    workspaceStatus: rule.workspaceStatus,
    comment: `${today} genie ${rule.word}${verdictSuffix} — ${evidence}`,
  });
}
