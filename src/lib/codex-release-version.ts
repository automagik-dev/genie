/**
 * Pure, dependency-free Codex release-version grammar and control-sequence
 * sanitiser.
 *
 * Extracted from `codex-activation.ts` so that the lower-level host observation /
 * delivery-attestation module (`codex-host-observation.ts`) can validate versions
 * and sanitise bounded subprocess text WITHOUT importing the activation protocol,
 * and the activation protocol can in turn import the single delivery assessment
 * from `codex-host-observation.ts` with no import cycle. `codex-activation.ts`
 * re-exports the public members so existing importers are unchanged.
 */

/** Exact `MAJOR.YYMMDD.N` release grammar; build metadata is stripped only after a match. */
export const RELEASE_VERSION_RE = /^(\d+)\.(\d{6})\.(\d+)(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

export interface ParsedReleaseVersion {
  readonly major: number;
  readonly ymd: number;
  readonly n: number;
  /** The `MAJOR.YYMMDD.N` triple with build metadata removed; used for equality. */
  readonly canonical: string;
}

/** Parse a release version, returning null for anything that fails the exact grammar. */
export function parseReleaseVersion(raw: unknown): ParsedReleaseVersion | null {
  if (typeof raw !== 'string') return null;
  const match = RELEASE_VERSION_RE.exec(raw);
  if (!match) return null;
  const major = Number(match[1]);
  const ymd = Number(match[2]);
  const n = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(ymd) || !Number.isSafeInteger(n)) return null;
  return { major, ymd, n, canonical: `${major}.${match[2]}.${n}` };
}

/** Total numeric order over validated versions. */
export function compareReleaseVersions(a: ParsedReleaseVersion, b: ParsedReleaseVersion): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.ymd !== b.ymd) return a.ymd < b.ymd ? -1 : 1;
  if (a.n !== b.n) return a.n < b.n ? -1 : 1;
  return 0;
}

/** Strip ANSI CSI and OSC control sequences from modeled diagnostics/output. */
export function stripControl(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching ESC/BEL control bytes.
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');
}
