#!/usr/bin/env bun
/**
 * scripts/mikro/triage.ts — the read-only triage scout (wish-v7 slice 1a, PROVISIONAL).
 *
 *   bun scripts/mikro/triage.ts (--intent "<sentence>" | --issue <number|url>)
 *       [--dir <repo>] [--timeout-ms n] [--no-phoenix]
 *
 * `.genie/brainstorms/wish-v7/DESIGN.md` ("Triage, inline and always first") asks for ONE
 * read-only scout that returns, under the injection fence, the facts a session needs before it
 * writes anything: facts with evidence, work to resume, a candidate file set, an estimate,
 * boundary hits, injection attempts, and evidence per WRS dimension. This script is the
 * mechanical half of that and nothing more — a COMPOSITION of two microagents that already
 * exist, with every judgement the design reserves for a model left to the model:
 *
 *   - it derives NO lane. D5 ("boundaries are policy, judged by LLMs; mechanize only after a
 *     measured miss") applies to routing too: the record carries `issue-triage`'s lane when that
 *     agent ran and `null` otherwise. Nothing here maps an estimate to a lane.
 *   - it publishes NO WRS number. D13 asks for a DERIVED score; the thresholds are uncalibrated,
 *     so the record carries the five dimensions with their evidence and `calibration: 'pending'`,
 *     `actionable: false`. A 0–100 total nobody has calibrated would be read as a gate.
 *   - it is not wired into `skills/wish/SKILL.md` or `.claude/workflows/wish.js`, and it is not
 *     "inline and always first" until its p90 latency is measured. Today the consumer is an
 *     operator or an orchestrator session running it by hand.
 *
 * Two agents, sequential, one process, no new dependencies:
 *   `--issue <n>`  → `issue-triage` ("Triage issue #<n>"), then `wish-context` over a sentence
 *                    built from the issue's own title + summary.
 *   `--intent "…"` → `wish-context` alone.
 *
 * ONE JSON record goes to stdout and the same record to `<dir>/.mikro/runs/triage-<stamp>.json`
 * (gitignored). Nothing else is written, on success or on failure. A failed agent degrades the
 * record — `status: 'degraded'`, the failure class named in `degraded[]`, whatever the answer
 * VERIFIED kept, the dimensions that depended on it reading `unknown: <class>` — and still exits
 * 0. Exit 1 is for a usage error or a run that never started.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { type RunOptions, type RunResult, runAgent } from './call';
import { IssueTriage, WishContext } from './schemas';

type IssueTriageAnswer = z.infer<typeof IssueTriage>;
type WishContextAnswer = z.infer<typeof WishContext>;

// ─── Record ──────────────────────────────────────────────

/**
 * Why the record is degraded, in the vocabulary of the thing that failed:
 * `citation-gate` — the JSON validated but a cited path did not exist (the answer still carries
 * whatever verified); `schema` — the JSON did not match the agent's contract; `timeout` — the run
 * passed `--timeout-ms`; `empty` — no answer, or no JSON in it; `runner` — anything else (the MCP
 * server, the provider, a refused `--dir`, a budget hit).
 */
export const DEGRADED_CLASSES = ['citation-gate', 'schema', 'timeout', 'empty', 'runner'] as const;
export type DegradedClass = (typeof DEGRADED_CLASSES)[number];

const Dimension = z.object({ met: z.boolean(), evidence: z.string().min(1) });

/**
 * The triage record. Deliberately NOT a member of `SCHEMAS` in `schemas.ts`: that map is the
 * output contract of the `.mikro/agents/<name>/` microagents, one entry per agent, and `call.ts`
 * looks an agent's schema up there by name. Triage is a composition of two of those agents, not a
 * fourth agent, and an entry here would invent an agent that does not exist. `triage.test.ts`
 * pins that.
 */
export const TriageRecord = z.object({
  version: z.literal(1),
  /** Slice 1a: the shape, the thresholds and the consumer are all provisional. */
  provisional: z.literal(true),
  status: z.enum(['ok', 'degraded']),
  degraded: z.array(z.object({ agent: z.string(), class: z.enum(DEGRADED_CLASSES), detail: z.string() })),
  /** The operator's sentence verbatim, or `issue #<n>: <title> — <summary>` on the issue path. */
  intent: z.string(),
  facts: z.array(z.object({ claim: z.string(), evidence: z.string() })),
  related: z.array(z.object({ kind: z.string(), ref: z.string(), why: z.string() })),
  candidateFiles: z.array(z.object({ path: z.string(), reason: z.string(), isNew: z.boolean() })),
  estimate: z.object({ files: z.number().int().nonnegative(), insertions: z.number().int().nonnegative() }).nullable(),
  band: z.enum(['ideal', 'above-ideal', 'over-maximum']).nullable(),
  boundaryHits: z.union([
    z.object({
      status: z.literal('computed'),
      hits: z.array(z.object({ path: z.string(), entry: z.string() })),
      /** Denylist entries that name a judgement rather than a path shape: reported, never matched. */
      unmatchable: z.array(z.string()),
    }),
    z.object({ status: z.literal('unknown'), reason: z.string().min(1) }),
  ]),
  injectionAttempts: z.array(z.string()),
  wrs: z.object({
    calibration: z.literal('pending'),
    actionable: z.literal(false),
    dimensions: z.object({
      problem: Dimension,
      scope: Dimension,
      decisions: Dimension,
      risks: Dimension,
      criteria: Dimension,
    }),
    metCount: z.number().int().min(0).max(5),
  }),
  lane: z.object({ value: z.string().nullable(), source: z.enum(['issue-triage', 'none']) }),
  /** Every open question, untruncated. A display cap is the caller's business, never the record's. */
  questions: z.array(z.string()),
  costUsd: z.number(),
  elapsedMs: z.number(),
  runIds: z.object({ issueTriage: z.string().optional(), wishContext: z.string().optional() }),
});
export type TriageRecordValue = z.infer<typeof TriageRecord>;

// ─── wish.js policy, read at run time ────────────────────

export interface SizeBands {
  maxFiles: number;
  maxInsertions: number;
  idealFiles: number;
  idealInsertions: number;
}

export interface WishPolicy {
  /** `null` when the denylist could not be proven — boundary hits are then `unknown`, never a clean zero. */
  denylist: string[] | null;
  denylistReason: string | null;
  bands: SizeBands | null;
}

const WISH_JS = '.claude/workflows/wish.js';
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * `.claude/workflows/wish.js` is executed by the harness, never imported, so there is no module to
 * read the consequence list from. It is the SINGLE SOURCE all the same: the shipped text is parsed
 * at run time and a failure to parse it is fail-closed, because a boundary check that answers
 * "zero hits" from a file it could not read is worse than one that answers "unknown".
 */
export function extractDenylist(source: string): string[] {
  const block = /^const DENYLIST = \[([\s\S]*?)^\]$/m.exec(source);
  if (!block) throw new Error(`could not find the DENYLIST const in ${WISH_JS}`);
  const entries = [...block[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
  if (!entries.length) throw new Error(`the DENYLIST const in ${WISH_JS} declares no entries`);
  return entries;
}

/** The band constants of the same file (`MAX_FILES` … `IDEAL_INSERTIONS`), read the same way. */
export function extractBands(source: string): SizeBands {
  const num = (name: string): number => {
    const m = new RegExp(`^const ${name} = (\\d+)$`, 'm').exec(source);
    if (!m) throw new Error(`could not find the ${name} const in ${WISH_JS}`);
    return Number(m[1]);
  };
  return {
    maxFiles: num('MAX_FILES'),
    maxInsertions: num('MAX_INSERTIONS'),
    idealFiles: num('IDEAL_FILES'),
    idealInsertions: num('IDEAL_INSERTIONS'),
  };
}

export function loadWishPolicy(dir: string): WishPolicy {
  const path = join(resolve(dir), WISH_JS);
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    return { denylist: null, denylistReason: `could not read ${path}: ${message(error)}`, bands: null };
  }
  let denylist: string[] | null = null;
  let denylistReason: string | null = null;
  try {
    denylist = extractDenylist(source);
  } catch (error) {
    denylistReason = message(error);
  }
  let bands: SizeBands | null = null;
  try {
    bands = extractBands(source);
  } catch {
    // An unreadable band constant leaves `band: null`; it never invents a limit.
  }
  return { denylist, denylistReason, bands };
}

// ─── Denylist matching (a mirror of wish.js's own) ───────

// Mirrors `repoRelative` / `escapeRule` / `denylistRule` in wish.js: a trailing-slash rule is a
// prefix, a `*` rule is a path shape that never matches a colocated `*.test.ts`, a rule with a
// space is prose the script does not match, and a bare `package.json` hits the prose entry through
// wish.js's own closing fallback. `triage.test.ts` runs both matchers over one table of paths.
const escapeRule = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function repoRelative(value: string): string {
  const cleaned = String(value)
    .trim()
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '');
  if (!cleaned || cleaned.startsWith('/') || cleaned.startsWith('~')) return '';
  return cleaned.split('/').some((segment) => segment === '..') ? '' : cleaned;
}

export function denylistRule(candidate: string, denylist: string[]): string {
  const value = repoRelative(candidate);
  if (!value) return '';
  for (const rule of denylist) {
    if (rule.endsWith('/')) {
      if (value === rule.slice(0, -1) || value.startsWith(rule)) return rule;
      continue;
    }
    if (rule.includes(' ')) continue;
    if (rule.includes('*')) {
      if (value.endsWith('.test.ts')) continue;
      const parts = rule.split('*').map(escapeRule).join('[^/]*');
      if (new RegExp(`^${parts}$`).test(value)) return rule;
      continue;
    }
    if (value === rule || value.endsWith(`/${rule}`)) return rule;
  }
  return value === 'package.json' ? 'package.json scripts' : '';
}

export function denylistHits(paths: string[], denylist: string[]): { path: string; entry: string }[] {
  return paths.map((path) => ({ path, entry: denylistRule(path, denylist) })).filter((hit) => Boolean(hit.entry));
}

/**
 * The prose entries no path shape can reach. `package.json scripts` is excluded because wish.js's
 * closing fallback DOES return it for a bare `package.json`; everything else with a space in it —
 * "auth, secret and permission surfaces" — is a judgement for a reader, and saying so beats
 * pretending a clean scan covered it.
 */
export function unmatchableEntries(denylist: string[]): string[] {
  return denylist.filter((rule) => rule.includes(' ') && rule !== 'package.json scripts');
}

export type Band = 'ideal' | 'above-ideal' | 'over-maximum';

/**
 * wish.js's `sizeArithmetic` band, over the two fields a `wish-context` estimate carries. Its
 * `units` advice is deliberately not reproduced: `WishContext` declares no units, and slice 0 of
 * this design made units advisory anyway — files and insertions are the hard maxima.
 */
export function sizeBand(estimate: { files: number; insertions: number } | null, bands: SizeBands | null): Band | null {
  if (!estimate || !bands) return null;
  const { files, insertions } = estimate;
  if (!Number.isInteger(files) || files < 0 || !Number.isInteger(insertions) || insertions < 0) return 'over-maximum';
  if (files > bands.maxFiles || insertions > bands.maxInsertions) return 'over-maximum';
  if (files > bands.idealFiles || insertions > bands.idealInsertions) return 'above-ideal';
  return 'ideal';
}

// ─── Failure classification ──────────────────────────────

export interface Degradation {
  agent: string;
  class: DegradedClass;
  detail: string;
}

/** The last attempt's errors, in the vocabulary `call.ts` writes them. */
export function classifyFailure(agent: string, result: RunResult): Degradation {
  const errors = result.attempts[result.attempts.length - 1]?.errors ?? [];
  const detail = errors.slice(0, 3).join('; ').slice(0, 400) || 'the run produced no answer';
  const has = (test: (error: string) => boolean): boolean => errors.some(test);
  let cls: DegradedClass = 'runner';
  if (has((e) => /timed out after/.test(e))) cls = 'timeout';
  else if (has((e) => e.startsWith('citation:'))) cls = 'citation-gate';
  else if (has((e) => e.startsWith('schema:'))) cls = 'schema';
  else if (has((e) => /^empty answer$|no JSON object|no parseable JSON/.test(e))) cls = 'empty';
  return { agent, class: cls, detail };
}

/**
 * The citations the gate refused, as the tokens they appear as inside the answer. An `ok:false`
 * answer from the citation gate still validated against its schema, so the fields whose own
 * evidence verified are real evidence and are kept; the rest are dropped rather than carried as
 * facts nothing proves.
 */
function refusedCitations(result: RunResult): { tokens: string[]; paths: Set<string> } {
  const bad = (result.attempts[result.attempts.length - 1]?.citations ?? []).filter((c) => !c.ok);
  return {
    tokens: bad.map((c) => (c.line === null ? c.path : `${c.path}:${c.line}`)),
    paths: new Set(bad.map((c) => c.path)),
  };
}

// ─── Assembly ────────────────────────────────────────────

const NEW_FILE = /^NEW:/;

function candidatesFrom(
  context: WishContextAnswer | null,
  issue: IssueTriageAnswer | null,
  refused: Set<string>,
): TriageRecordValue['candidateFiles'] {
  const out: TriageRecordValue['candidateFiles'] = [];
  const seen = new Set<string>();
  const push = (path: string, reason: string, isNew: boolean): void => {
    if (refused.has(path) || seen.has(path)) return;
    seen.add(path);
    out.push({ path, reason, isNew });
  };
  for (const file of context?.plan.files ?? []) push(file.path, file.reason, NEW_FILE.test(file.reason));
  for (const file of issue?.candidate_files ?? []) push(file.path, file.why, false);
  return out;
}

const unique = (values: string[]): string[] => [...new Set(values.filter((v) => v.trim().length > 0))];

/** A criterion counts only when it is narrower than the full gate. */
function narrowerThanGate(command: string | undefined): string | null {
  const value = (command ?? '').trim();
  if (!value) return null;
  return value.replace(/\s+/g, ' ').toLowerCase() === 'bun run check' ? null : value;
}

interface WrsInputs {
  intent: string;
  candidateFiles: TriageRecordValue['candidateFiles'];
  band: Band | null;
  questions: string[];
  boundaryHits: TriageRecordValue['boundaryHits'];
  context: WishContextAnswer | null;
  contextDegraded: Degradation | undefined;
  anyDegraded: boolean;
}

/**
 * The five WRS dimensions of the design, derived script-side from what the run actually proved.
 * Never asked of a model, never totalled: an uncalibrated number is read as a gate, so the record
 * carries the evidence and the caller decides.
 *
 * A dimension that depends on an agent which degraded reads `unknown: <class>` and `met: false` —
 * it is never scored as if the agent had answered "none", which is exactly how a failed run would
 * otherwise come back looking like a clean one (zero open questions, zero boundary hits).
 */
export function deriveWrs(inputs: WrsInputs): TriageRecordValue['wrs'] {
  const { intent, candidateFiles, band, questions, boundaryHits, context, contextDegraded } = inputs;
  const unknown = (reason: string) => ({ met: false, evidence: `unknown: ${reason}` });

  const problem = intent.trim()
    ? { met: true, evidence: `${intent.trim().length} characters of intent` }
    : { met: false, evidence: 'the intent sentence is empty' };

  const scope = contextDegraded
    ? unknown(contextDegraded.class)
    : {
        met: candidateFiles.length > 0 && (band === 'ideal' || band === 'above-ideal'),
        evidence: `${candidateFiles.length} candidate file(s), band ${band ?? 'unknown'}`,
      };

  const decisions = contextDegraded
    ? unknown(contextDegraded.class)
    : { met: questions.length === 0, evidence: `${questions.length} open question(s)` };

  let risks: { met: boolean; evidence: string };
  if (boundaryHits.status === 'unknown') risks = unknown(boundaryHits.reason);
  else if (inputs.anyDegraded)
    risks = unknown(`${contextDegraded?.class ?? 'degraded'} — the candidate set is partial`);
  else
    risks = {
      met: boundaryHits.hits.length === 0,
      evidence: boundaryHits.hits.length
        ? `${boundaryHits.hits.length} boundary hit(s): ${boundaryHits.hits.map((h) => `${h.path} → ${h.entry}`).join('; ')}`
        : `0 boundary hit(s) over ${candidateFiles.length} candidate file(s)`,
    };

  const narrow = contextDegraded
    ? null
    : (narrowerThanGate(context?.plan.focusedTest) ?? narrowerThanGate(context?.plan.validationCommand));
  const criteria = contextDegraded
    ? unknown(contextDegraded.class)
    : narrow
      ? { met: true, evidence: `pinning test / validation command: ${narrow}` }
      : { met: false, evidence: 'no pinning test or validation command narrower than `bun run check`' };

  const dimensions = { problem, scope, decisions, risks, criteria };
  return {
    calibration: 'pending' as const,
    actionable: false as const,
    dimensions,
    metCount: Object.values(dimensions).filter((d) => d.met).length,
  };
}

// ─── Run ─────────────────────────────────────────────────

export type AgentRunner = (options: RunOptions) => Promise<RunResult>;

export interface TriageOptions {
  /** The operator's sentence, verbatim. Mutually exclusive with `issue`. */
  intent?: string;
  issue?: number;
  dir?: string;
  /** Per agent, not for the pair. */
  timeoutMs?: number;
  phoenix?: boolean;
  /** Write the record under `<dir>/.mikro/runs/`. On by default; the CLI never turns it off. */
  write?: boolean;
}

/** A compact ISO 8601 stamp with milliseconds, so two runs in the same second do not collide. */
export function recordStamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\./g, '');
}

export function parseIssueRef(raw: string): number | null {
  const value = raw.trim();
  const direct = /^#?(\d+)$/.exec(value);
  if (direct) return Number(direct[1]) || null;
  const url = /\/issues\/(\d+)(?:[?#/].*)?$/.exec(value);
  return url ? Number(url[1]) || null : null;
}

async function runOne(
  run: AgentRunner,
  agent: string,
  prompt: string,
  options: TriageOptions,
  dir: string,
  traceId: string,
  facts?: string,
): Promise<RunResult> {
  try {
    return await run({
      agent,
      prompt,
      dir,
      facts,
      traceId,
      timeoutMs: options.timeoutMs ?? 300_000,
      phoenix: options.phoenix,
      tags: { composition: 'triage', mode: options.issue === undefined ? 'intent' : 'issue' },
    });
  } catch (error) {
    // A runner that throws is a degraded record, never a stack trace on the operator's terminal.
    return {
      ok: false,
      agent,
      runId: '',
      traceId,
      dir,
      answer: undefined,
      attempts: [
        {
          attempt: 0,
          ok: false,
          errors: [`run: ${message(error)}`],
          footer: null,
          citations: [],
          elapsedMs: 0,
          raw: '',
        },
      ],
      elapsedMs: 0,
      costUsd: 0,
      tags: {},
    };
  }
}

/**
 * The whole scout. `run` is injected so `triage.test.ts` drives every path — each failure class,
 * each WRS dimension, both entry shapes — with no network, no model and no cost.
 */
export async function triage(options: TriageOptions, run: AgentRunner = runAgent): Promise<TriageRecordValue> {
  const started = Date.now();
  if (options.issue === undefined && !(options.intent ?? '').trim())
    throw new Error('nothing to triage: pass an intent sentence or an issue number');
  const dir = resolve(options.dir ?? process.cwd());
  const traceId = randomUUID();
  const degraded: Degradation[] = [];
  const runIds: TriageRecordValue['runIds'] = {};
  let costUsd = 0;

  let issueAnswer: IssueTriageAnswer | null = null;
  let issueRefused = new Set<string>();
  let sentence = (options.intent ?? '').trim();
  let intent = sentence;

  if (options.issue !== undefined) {
    intent = `issue #${options.issue}`;
    const result = await runOne(run, 'issue-triage', `Triage issue #${options.issue}`, options, dir, traceId);
    if (result.runId) runIds.issueTriage = result.runId;
    costUsd += result.costUsd;
    const parsed = IssueTriage.safeParse(result.answer);
    if (parsed.success) issueAnswer = parsed.data;
    if (!result.ok) {
      degraded.push(classifyFailure('issue-triage', result));
      issueRefused = refusedCitations(result).paths;
    }
    if (issueAnswer) {
      sentence = `${issueAnswer.title} — ${issueAnswer.summary}`.trim();
      intent = `issue #${options.issue}: ${sentence}`;
    } else {
      // Without a title and a summary there is no sentence to hand `wish-context`, and inventing
      // one would put words the issue never used into the record. The step is named as not run.
      degraded.push({
        agent: 'wish-context',
        class: 'empty',
        detail: 'not run: issue-triage returned no title and summary to build an intent sentence from',
      });
    }
  }

  let contextAnswer: WishContextAnswer | null = null;
  let contextRefused = { tokens: [] as string[], paths: new Set<string>() };
  const wantsContext = sentence.length > 0;
  if (wantsContext) {
    const result = await runOne(run, 'wish-context', `Intent: ${sentence}`, options, dir, traceId, 'auto');
    if (result.runId) runIds.wishContext = result.runId;
    costUsd += result.costUsd;
    const parsed = WishContext.safeParse(result.answer);
    if (parsed.success) contextAnswer = parsed.data;
    if (!result.ok) {
      degraded.push(classifyFailure('wish-context', result));
      contextRefused = refusedCitations(result);
    }
  }

  const keeps = (text: string): boolean => !contextRefused.tokens.some((token) => text.includes(token));
  const facts = (contextAnswer?.facts ?? []).filter((fact) => keeps(fact.evidence));
  const related = (contextAnswer?.related ?? []).filter((item) => keeps(item.ref));
  const refusedPaths = new Set([...contextRefused.paths, ...issueRefused]);
  const candidateFiles = candidatesFrom(contextAnswer, issueAnswer, refusedPaths);

  const policy = loadWishPolicy(dir);
  const boundaryHits: TriageRecordValue['boundaryHits'] = policy.denylist
    ? {
        status: 'computed',
        hits: denylistHits(
          candidateFiles.map((f) => f.path),
          policy.denylist,
        ),
        unmatchable: unmatchableEntries(policy.denylist),
      }
    : { status: 'unknown', reason: policy.denylistReason ?? `could not read ${WISH_JS} under ${dir}` };

  const estimate = contextAnswer ? contextAnswer.estimate : null;
  const band = sizeBand(estimate, policy.bands);
  const questions = unique([
    ...(contextAnswer?.open_questions ?? []),
    ...(issueAnswer?.first_question ? [issueAnswer.first_question] : []),
  ]);
  const contextDegraded = degraded.find((d) => d.agent === 'wish-context');

  const record: TriageRecordValue = {
    version: 1,
    provisional: true,
    status: degraded.length ? 'degraded' : 'ok',
    degraded,
    intent,
    facts,
    related,
    candidateFiles,
    estimate,
    band,
    boundaryHits,
    injectionAttempts: unique([
      ...(issueAnswer?.injection_attempts ?? []),
      ...(contextAnswer?.injection_attempts ?? []),
    ]),
    wrs: deriveWrs({
      intent,
      candidateFiles,
      band,
      questions,
      boundaryHits,
      context: contextAnswer,
      contextDegraded,
      anyDegraded: degraded.length > 0,
    }),
    // D5: lanes are judged, not computed. Nothing here maps an estimate to a lane.
    lane: issueAnswer ? { value: issueAnswer.lane, source: 'issue-triage' } : { value: null, source: 'none' },
    questions,
    costUsd,
    elapsedMs: Date.now() - started,
    runIds,
  };

  const validated = TriageRecord.parse(record);
  if (options.write !== false) {
    const runs = join(dir, '.mikro', 'runs');
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, `triage-${recordStamp(new Date())}.json`), `${JSON.stringify(validated, null, 2)}\n`);
  }
  return validated;
}

// ─── CLI ─────────────────────────────────────────────────

function usage(): never {
  process.stderr.write(
    'usage: bun scripts/mikro/triage.ts (--intent "<sentence>" | --issue <number|url>) [--dir <repo>] [--timeout-ms n] [--no-phoenix]\n',
  );
  process.exit(1);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const rawIssue = opt('--issue');
  const rawIntent = opt('--intent');
  if ((rawIssue === undefined) === (rawIntent === undefined)) usage();
  const issue = rawIssue === undefined ? undefined : parseIssueRef(rawIssue);
  if (rawIssue !== undefined && issue === null) usage();
  if (rawIntent !== undefined && !rawIntent.trim()) usage();
  const timeout = opt('--timeout-ms');
  try {
    const record = await triage({
      intent: rawIntent,
      issue: issue ?? undefined,
      dir: opt('--dir'),
      timeoutMs: timeout ? Number(timeout) : undefined,
      phoenix: !argv.includes('--no-phoenix'),
    });
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    process.exit(0);
  } catch (error) {
    // Nothing ran, or the record could not be written: one line, no stack trace.
    process.stderr.write(`triage: ${message(error)}\n`);
    process.exit(1);
  }
}
