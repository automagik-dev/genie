#!/usr/bin/env node
/**
 * mine-explore-tasks.mjs — build the explore parity suite out of real work.
 *
 * The parity gate is only worth running on tasks somebody actually needed
 * answered. Synthetic questions are written to be answerable, which is exactly
 * the bias that would make a cheap model look like it reached parity. So this
 * script reads this host's own Claude Code transcripts (`~/.claude/projects`)
 * and lifts out the explore-class work: a question, a run of read-only
 * searching and reading, and the answer that came back.
 *
 * What makes a transcript segment explore-class here:
 *
 *   - it starts with a human question (not a slash command, not a hook or
 *     tool-result echo),
 *   - it asks where something lives or why it behaves that way — not for a
 *     verdict: a plan/design/PR review is read-only too, but a verdict is not
 *     a citation, and the wish scopes this suite to explore-class work,
 *   - it mutates nothing — no Edit/Write, no mutating shell, no delegated
 *     subagent whose work happened where this script cannot see it,
 *   - it does real searching and reading (Grep/Read/Glob plus read-only Bash),
 *   - and it ends in a substantive answer.
 *
 * **What becomes a required fact.** Only a `path:line` citation the native
 * answer made about the task root, whose surrounding sentence says something,
 * and whose own words are still findable in that file today. "Its own words"
 * is the whole of the verification, and it is deliberately narrow: the *term*
 * that links a claim to a line is either a code identifier the claim names or a
 * fragment it quotes, and it must be **specific enough to point at a line** —
 * a token smeared over a tenth of the file (`STAGE` in a build script, `config`
 * in a loader) corroborates nothing, so a claim that can only be anchored on
 * one of those is dropped rather than decorated with an evidence line that is
 * evidence for nothing. Every emitted fact names the term it was anchored on,
 * so the link between claim and quoted line is auditable rather than asserted.
 *
 * Resolution is content-anchored rather than line-number-anchored: a repo moves
 * between the session and the mining run, so a claim whose code slid down the
 * file is re-anchored to where it lives now (with the drift recorded), and one
 * whose terms are gone is excluded under its own heading. Anchoring on the
 * stale number instead would penalise the arm that cites the *current* line
 * correctly, which is the opposite of what the rubric is for. Drift is only
 * recorded when there really was drift: a sentence that cites `:34` and
 * `:139-144` in one breath is anchored at whichever of *its own* lines carries
 * the term, and that is not a repo that moved.
 *
 * Four things are deliberately **not** facts, because none of them is a
 * checkable statement about the answer:
 *
 *   - a bare path with no line ("file exists, 527 lines") — true of the file,
 *     silent about the claim, and equally true for an arm that never read it;
 *   - an identifier looked up somewhere in the tree — "this word appears in
 *     some file" pairs an arbitrary line with whatever sentence first mentioned
 *     the word, which is how a heading ends up "verified" against a test
 *     fixture;
 *   - a claim with nothing checkable in it. "Line 139 is not blank" is a fact
 *     about the file's whitespace; it says nothing about whether the answer was
 *     right, and a claim whose sentence names no identifier and quotes no
 *     fragment cannot be scored consistently by either arm's scorer;
 *   - a claim about a sibling tree. The rlmx arm sees one directory
 *     (`rlmx mcp --dir`), so a claim outside it is structurally unanswerable.
 *     Those citations are resolved and listed under their own heading —
 *     reporting them as "path not found" would read as native having been
 *     wrong when it was simply talking about somewhere else — but they are out
 *     of scope for both arms.
 *
 * Those verified facts — and only those — become the required-facts checklist.
 * This is the deliberately conservative asymmetry the design calls out (D6/P3):
 * ground truth comes from the native arm, so native scores 100% by
 * construction, which makes the gate harder for rlmx and can never manufacture
 * a false pass. That construction is *checked*, not assumed: a task whose own
 * native answer fails criterion 2 or 3 (a citation into the task root that does
 * not resolve, or a `path:line` no listed tree has) is not emitted, because a
 * suite where the ground-truth arm fails the rubric cannot be scored honestly.
 *
 * Window: the past 24h, widened when 24h does not yield enough significant
 * tasks (the wish's stated fallback for a quiet day). Every attempt is recorded
 * in `mining-run.json`, so a reader can audit that the widening was earned
 * rather than chosen. Real tasks only, either way.
 *
 * Secrets: transcripts contain whatever was typed at them, so every verbatim
 * string is redacted on the way out (API keys, bearer tokens, JWTs, private
 * keys, `KEY=value` pairs). Redaction is applied to the text that gets written,
 * not to the text that gets matched, so a redacted secret can never resolve
 * into a "fact".
 *
 * ── Mining a second, disjoint suite ───────────────────────────────────────
 *
 * A frozen eval suite is only an eval suite while nothing tunes against it. A
 * training suite therefore has to be *disjoint* from it, and disjointness has to
 * be enforced by the miner rather than by a promise: the same host, the same
 * window and the same filter will otherwise re-surface the very segments the
 * eval suite was cut from. Four opt-in flags do that, and **none of them is on
 * by default** — a bare `node scripts/mine-explore-tasks.mjs` selects exactly
 * what it selected when it cut the frozen suite (the record it writes gains the
 * `argv`/`windowLadder` provenance keys described below, and nothing else):
 *
 *   --exclude-sessions a,b,c   drop these session ids outright (or `@file`)
 *   --exclude-tasks <dir>      read an existing suite's task files for their
 *                              *exclusion metadata only* — session id, task
 *                              root, and the set of files its required facts
 *                              anchor on — and drop both those sessions and any
 *                              candidate that anchors on the same files in the
 *                              same root. Question text is never read: the
 *                              subject test is the anchor-file overlap, which is
 *                              what "the same subject" actually means for a
 *                              suite scored on required facts.
 *   --disjoint-by <mode>       `session+subject` (default) or `subject`. See
 *                              below — on a host whose whole explore-class yield
 *                              comes from the sittings the eval suite was cut
 *                              from, the session gate is not a filter, it is a
 *                              floor of zero.
 *   --run-json <name>          write the run record under another name, so a
 *                              second suite does not overwrite the first's.
 *
 * `--min-read-ops <n>` (default 5, the value the frozen suite was cut at) is a
 * fifth knob and a *screening* one: see `MIN_READ_OPS`. It changes which
 * segments are worth verifying, never what counts as a fact.
 *
 * ── `--disjoint-by subject` ───────────────────────────────────────────────
 *
 * The default composes two independent gates: drop the eval suite's *sittings*
 * outright, then drop any survivor standing on the same files in the same repo.
 * The first is a proxy for the second and a coarse one: a session is a person
 * at a keyboard for an afternoon, not a subject. When a host's entire
 * explore-class yield comes from those same afternoons — measured, not assumed:
 * every candidate this repo's corpus produces at 24/168/336/720h is inside them
 * — the session gate does not make the training suite disjoint, it makes it
 * empty, and it eliminates every candidate *before* the subject test ever runs,
 * so the disjointness that gets reported is vacuous.
 *
 * `--disjoint-by subject` keeps the second gate and drops the first. What it
 * gives up is stated plainly: a train task may come from a sitting an eval task
 * also came from. What it keeps is the test that decides whether two tasks are
 * about the same thing — the anchor-file overlap — now actually exercised, with
 * both its outcomes recorded in the run JSON (`droppedForSubjectOverlap` and
 * `keptFromSharedSession`), so the disjointness claim is checkable against both
 * suites' metadata instead of being true by emptiness. `--exclude-sessions`
 * still drops what it is given, under either mode.
 *
 * **It is a different criterion, not a cheaper way to meet the same one.** If
 * the thing being satisfied is written as "disjoint *by session*", this mode
 * does not satisfy it — it replaces it, and that needs saying out loud and
 * agreeing before the suite is used, not discovering afterwards from a task
 * header. This wish's round-2 training suite was cut this way once and had to
 * be re-cut under the default: `.genie/wishes/rlmx-explore-offload/parity/
 * round2/train-tasks/README.md` records what that cost. When the default
 * yields nothing, "the corpus is empty" is itself a publishable measurement —
 * `written: 0` with the excluded sittings named — and authoring the suite is
 * the honest alternative to relaxing the gate.
 *
 * ── `--host-read-idioms` ──────────────────────────────────────────────────
 *
 * Also opt-in, and a *false-negative fix*, not a lowered bar. `classifyBash`
 * decides read vs mutate on a stage's verb; on this host four read idioms fall
 * through it and cost segments the read ops that make them significant. Counted
 * over the same 336h window this suite is mined from:
 *
 *   - `rtk proxy <verb>` — 615 stages. `rtk` is already a RUNNER, but the raw
 *     escape hatch is two words, so the verb that gets classified is `proxy`.
 *   - `sed -n '140,270p' file` — 1045 stages. Paging through a file is the
 *     host's most common read after `rg`; `sed -i` is already caught as a
 *     mutation before this point, and a redirecting `sed` by the REDIRECT rule.
 *   - `export PATH=… && <read>` — 617 stages. `export` is a no-op prefix like
 *     `cd`, but it is classified as the stage's verb, and the first non-read
 *     stage ends classification, so it discards the read that follows it.
 *   - `… >/dev/null` — a discard is not a write. The REDIRECT rule is otherwise
 *     kept exactly as it is: it is what catches `> file`, and it should.
 *
 * Nothing here touches what becomes a *fact*: the verification rules, the
 * thresholds, and the criterion-2/3 rejection of a task whose own native answer
 * fails the rubric are identical under the flag. It only changes which segments
 * are read-heavy enough to be worth verifying.
 *
 *   node scripts/mine-explore-tasks.mjs
 *   node scripts/mine-explore-tasks.mjs --dry-run
 *   node scripts/mine-explore-tasks.mjs --hours 168 --max-tasks 8
 *   node scripts/mine-explore-tasks.mjs --hours 336 --host-read-idioms \
 *     --exclude-tasks .genie/wishes/<wish>/tasks --out <dir> \
 *     --run-json train-mining-run.json
 *
 * Every run records its own `argv` and the `windowLadder` it would climb, so a
 * record can be reproduced from the record. The widening ladder is a flag
 * (`--wide-hours`, default `168,336,720`), which means the attempts list alone
 * does not say what was run: a record that stops at 336h is either a default run
 * that found its floor or a run whose ladder ended there, and only the argv
 * tells them apart.
 */

import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PROJECTS = resolve(flag("--projects", join(homedir(), ".claude", "projects")));
const OUT_DIR = resolve(
  flag("--out", join(repoRoot, ".genie", "wishes", "rlmx-explore-offload", "tasks"))
);
const HOURS = Number(flag("--hours", "24"));
/**
 * The widening ladder, in order. 168h is the wish's stated mitigation for a
 * quiet 24h; the rungs past it exist because "explore-class, non-review, and
 * the native answer passes its own rubric" is a much narrower filter than the
 * first cut of this script used, and a suite that is short of the floor is
 * worth more than a suite padded with work of the wrong class.
 */
const WIDE_HOURS = flag("--wide-hours", "168,336,720")
  .split(",")
  .map((h) => Number(h.trim()))
  .filter((h) => Number.isFinite(h) && h > 0);
const MIN_TASKS = Number(flag("--min-tasks", "5"));
const MAX_TASKS = Number(flag("--max-tasks", "6"));
/**
 * Suite diversity. A parity gate answered by six tasks from one operator's one
 * sitting on one subsystem measures that subsystem, not explore-class work —
 * the risk WISH.md:414 names, which widening the window alone does not fix
 * (a quiet week widens into the *same* sitting). So a session contributes at
 * most `--max-per-session` tasks and a repository at most `--max-per-root`,
 * and the window widens when the *diversified* suite is short, not when the
 * raw candidate list is.
 */
const MAX_PER_SESSION = Number(flag("--max-per-session", "2"));
const MAX_PER_ROOT = Number(flag("--max-per-root", "3"));
const DRY_RUN = args.includes("--dry-run");
const EXPLAIN = args.includes("--explain");
/** The run record's filename. A second suite must not overwrite the first's. */
const RUN_JSON = flag("--run-json", "mining-run.json");
/** See the header: opt-in, off by default, and a false-negative fix only. */
const HOST_READ_IDIOMS = args.includes("--host-read-idioms");

/**
 * Disjointness. `--exclude-sessions` takes ids directly or `@path` to a file of
 * them (one per line, `#` comments allowed); `--exclude-tasks` takes a suite
 * directory and reads its task files' metadata. Both are empty by default, and
 * when both are empty the exclusion machinery is inert — no filtering, and no
 * extra keys in the run record.
 */
function sessionList(spec) {
  if (!spec) return [];
  const raw = spec.startsWith("@") ? readFileSync(resolve(spec.slice(1)), "utf-8") : spec;
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith("#"))
    ),
  ];
}
const EXCLUDE_SESSIONS = new Set(sessionList(flag("--exclude-sessions", "")));
const EXCLUDE_TASKS_DIR = flag("--exclude-tasks", "") ? resolve(flag("--exclude-tasks", "")) : null;
/**
 * Which gate enforces disjointness from `--exclude-tasks`: both the sitting and
 * the subject (default), or the subject alone. See the header. Ids passed to
 * `--exclude-sessions` are dropped under either mode — that flag is an explicit
 * instruction, not an inference from a suite.
 */
const DISJOINT_MODES = new Set(["session+subject", "subject"]);
const DISJOINT_BY = flag("--disjoint-by", "session+subject");
if (!DISJOINT_MODES.has(DISJOINT_BY)) {
  process.stderr.write(`--disjoint-by: expected one of ${[...DISJOINT_MODES].join(", ")}\n`);
  process.exit(2);
}
/**
 * How much anchor-file overlap counts as "the same subject". A task is defined
 * by the files its required facts stand on, so two tasks in one repo whose
 * checklists rest on largely the same files are asking about the same
 * subsystem, whatever their wording. Measured as containment (shared ÷ smaller
 * set) rather than Jaccard, so a small checklist that sits entirely inside a
 * big one is caught rather than diluted.
 */
const SUBJECT_OVERLAP = Number(flag("--subject-overlap", "0.34"));

/**
 * An existing suite's *exclusion metadata*, and nothing else. Three lines per
 * task file are parsed — the task root, the session id, and the `path:line`
 * anchors of its required facts — because those are what "already used" means.
 * The question text and the native answer are deliberately not read: a training
 * suite mined by a process that ingested the eval suite's questions is not
 * disjoint from it in the way that matters.
 */
function excludedSuite(dir) {
  const out = { dir, sessions: new Set(), subjects: [], files: [] };
  let names;
  try {
    names = readdirSync(dir).filter((n) => /^\d+\.md$/.test(n));
  } catch {
    throw new Error(`--exclude-tasks: cannot read ${dir}`);
  }
  if (!names.length) throw new Error(`--exclude-tasks: no task files in ${dir}`);
  for (const name of names.sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
    const text = readFileSync(join(dir, name), "utf-8");
    const root = /^\| Task root \(the rlmx arm's `--dir`\) \| `([^`]+)` \|$/m.exec(text)?.[1];
    const session = /^\| Session \| `([^`]+)` \|$/m.exec(text)?.[1];
    if (!root || !session) throw new Error(`--exclude-tasks: ${name} has no root/session row`);
    const anchorFiles = new Set();
    // `- [ ] **F1** (exact) `a/b.ts:12` (also `c/d.ts:3`, `e.ts:9`)` — every
    // backticked `path:line` on a checklist line, primary and secondary alike.
    for (const line of text.split("\n")) {
      if (!/^- \[ \] \*\*F\d+\*\* \((?:exact|re-anchored)\)/.test(line)) continue;
      for (const [, anchor] of line.matchAll(/`([^`]+?):\d+`/g)) anchorFiles.add(anchor);
    }
    out.sessions.add(session);
    out.subjects.push({ file: name, root, session, anchorFiles });
    out.files.push(name);
  }
  return out;
}

const excluded = EXCLUDE_TASKS_DIR ? excludedSuite(EXCLUDE_TASKS_DIR) : null;
if (excluded && DISJOINT_BY === "session+subject") {
  for (const s of excluded.sessions) EXCLUDE_SESSIONS.add(s);
}
/** Suite sittings deliberately left in the pool, for the record to disclose. */
const SHARED_SESSIONS = new Set(
  excluded && DISJOINT_BY === "subject" ? [...excluded.sessions].filter((s) => !EXCLUDE_SESSIONS.has(s)) : []
);
const EXCLUSIONS_ACTIVE = EXCLUDE_SESSIONS.size > 0 || excluded !== null;
/**
 * Why each dropped candidate was dropped — the disjointness audit trail. Under
 * `--disjoint-by subject` the trail has to carry the *negative* cases too: a
 * candidate out of a shared sitting that the subject test cleared is the half of
 * the claim that emptiness would otherwise make unfalsifiable.
 */
const exclusionLog = { bySession: [], bySubject: [] };

/**
 * How much does this candidate stand on the same files, in the same repo, as the
 * tasks the excluded suite already uses? The strongest overlap it has with any
 * of them, whether or not it clears the bar — the caller compares against
 * `SUBJECT_OVERLAP` to decide, and records the number either way, so a suite's
 * disjointness can be re-derived from the record rather than believed. Session
 * exclusion catches the same sitting; this catches the same subject, which is
 * the thing that actually has to be disjoint.
 */
function strongestSubjectOverlap(task) {
  if (!excluded) return null;
  const ours = new Set(task.facts.flatMap((f) => f.anchors.map((a) => a.replace(/:\d+$/, ""))));
  if (!ours.size) return null;
  let strongest = null;
  for (const other of excluded.subjects) {
    if (other.root !== task.root) continue;
    const shared = [...ours].filter((f) => other.anchorFiles.has(f));
    const overlap = shared.length / Math.min(ours.size, other.anchorFiles.size || 1);
    if (!strongest || overlap > strongest.overlap) {
      strongest = {
        task: other.file,
        root: other.root,
        overlap: Number(overlap.toFixed(2)),
        shared,
        anchorFiles: ours.size,
      };
    }
  }
  return strongest;
}

/** Thresholds that define "significant" — stated here so the bar is auditable. */
/**
 * How much reading makes a segment worth verifying. A flag, defaulting to the
 * value the frozen suite was cut at, because "significant" is a *screening*
 * heuristic and not part of what makes a task checkable: what a task rests on is
 * its verified facts, and that bar (`--min-facts`, `MIN_VERIFIED_FACTS`) is
 * unchanged by lowering this one. A training suite mined on a host whose
 * explore-class yield is thin can trade screening strictness for tasks; an eval
 * suite should not, and the run record says which was done.
 */
const MIN_READ_OPS = Number(flag("--min-read-ops", "5"));
const MIN_ANSWER_CHARS = 300;
const MIN_QUESTION_CHARS = 15;
const MIN_VERIFIED_FACTS = 3;
/** A claim shorter than this is a label ("**File:**", a heading), not a claim. */
const MIN_CLAIM_CHARS = 40;
/**
 * A claim is quoted into the checklist so criterion 1 ("the answer makes the
 * same claim") can be scored; it is clipped at a word boundary, because half a
 * sentence — "…the staging tree is assembled at `sc" — is not a statement
 * either arm's scorer can rule on.
 */
const MAX_CLAIM_CHARS = 260;
/** Trees other than the task root that the answer is allowed to have cited. */
const MAX_SIBLING_ROOTS = 4;
/**
 * A question longer than this is a work order, not an explore question — a
 * reviewer's brief or an engineer's spec. Those are read-heavy too, but they
 * are not the class this suite is about, and a task nobody can restate is a
 * task nobody can re-run.
 */
const MAX_QUESTION_CHARS = 3_000;
const MAX_ANSWER_CHARS = 4_000;

// ── redaction ─────────────────────────────────────────────────────────────

/**
 * Patterns for material that must never reach a file in the repo. Deliberately
 * over-eager: a redacted false positive costs a reader nothing, a leaked key
 * costs a rotation.
 */
const SECRETS = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, "$1 [REDACTED]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED private key]"],
  [/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, "[REDACTED jwt]"],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "[REDACTED key]"],
  [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g, "[REDACTED token]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED aws key]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED google key]"],
];

/**
 * `NAME=<value>` where the name smells like a credential. Applied last and
 * *conditionally*, because the shape is also how ordinary code reads a key:
 * `const apiKey = process.env.GEMINI_API_KEY;`, `inputPerToken: 0.0000015,` and
 * `const RLMX_API_KEY_ENV_MAP: Record<string, string> = {` all match the
 * name half. Redacting those corrupts the evidence line a reader is told to
 * re-check against the file — a quote that does not match the file is worse
 * than no quote — so the value is tested for being an opaque literal rather
 * than an expression naming one. The shaped-secret rules above are
 * unconditional and catch the real thing regardless.
 */
const NAMED_SECRET =
  /\b([A-Za-z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*)(\s*[:=]\s*)(["'`]?)([^\s"'`,;]{8,})\3/gi;

function looksLikeSecretValue(value) {
  // Anything with bracket/brace/angle punctuation is an expression or a type.
  if (!/^[A-Za-z0-9_.\-+/=~]{8,}$/.test(value)) return false;
  if (/^[\d._]+$/.test(value)) return false; // a number
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value)) return false; // process.env.X
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(value)) return false; // an env-var *name*
  if (/[a-z]{3,}-[a-z]{3,}/.test(value)) return false; // a slug: gemini-3.1-flash-lite
  // A credential mixes character classes; a lone word or a lone number does not.
  return [/[a-z]/, /[A-Z]/, /\d/].filter((re) => re.test(value)).length >= 2;
}

function redact(text) {
  let out = String(text ?? "");
  for (const [pattern, replacement] of SECRETS) out = out.replace(pattern, replacement);
  return out.replace(NAMED_SECRET, (match, name, sep, quote, value) =>
    looksLikeSecretValue(value) ? `${name}${sep}[REDACTED]` : match
  );
}

// ── transcript reading ────────────────────────────────────────────────────

/** Wrapper blocks the harness injects around a human turn — not the question. */
const ENVELOPE = [
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<task-notification>[\s\S]*?<\/task-notification>/g,
  /<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g,
];

/** Machine turns that look like user messages but are not a human asking. */
const NOT_A_HUMAN_TURN =
  /^<(?:task-notification|local-command-stdout|command-name|system-reminder|user-prompt-submit-hook)|^Caveat: The messages below|^\[Request interrupted/;

function humanText(entry, allowSidechain = false) {
  if (entry.type !== "user" || entry.isMeta) return null;
  if (entry.isSidechain && !allowSidechain) return null;
  const content = entry.message?.content;
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    // A turn carrying tool_result blocks is the harness answering the model.
    if (content.some((c) => c?.type === "tool_result")) return null;
    text = content
      .filter((c) => c?.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  if (!text.trim()) return null;
  if (NOT_A_HUMAN_TURN.test(text.trim())) return null;
  let cleaned = text;
  for (const pattern of ENVELOPE) cleaned = cleaned.replace(pattern, " ");
  return cleaned.trim();
}

// ── shell classification ──────────────────────────────────────────────────

/** Verbs that read. `rtk <verb>` is this host's token-compressing proxy. */
const READ_VERBS = new Set([
  "rg", "grep", "egrep", "fgrep", "cat", "head", "tail", "less", "nl", "wc",
  "ls", "find", "tree", "file", "stat", "du", "diff", "jq", "yq", "awk",
  "column", "sort", "uniq", "basename", "dirname", "realpath", "readlink",
  "pwd", "env", "which", "type", "date", "echo", "printf", "test",
]);
const READ_SUBCOMMANDS = {
  git: new Set(["log", "show", "diff", "status", "blame", "grep", "branch", "remote", "ls-files", "describe", "rev-parse", "config", "stash"]),
  gh: new Set(["pr", "issue", "run", "repo", "api", "release", "search"]),
  npm: new Set(["ls", "view", "outdated", "audit"]),
  node: new Set(["--version", "-v"]),
};
/** Anything that writes, installs, deploys, or reaches out to change state. */
const MUTATING = /\b(rm|mv|cp|mkdir|rmdir|touch|tee|chmod|chown|ln|kill|pkill|truncate|dd|install|systemctl|service|docker|incus|podman|kubectl|helm|terraform|ansible|ssh|scp|rsync|apt|apt-get|dnf|pacman|brew|pip|pip3|uv|poetry|cargo|make|cmake|gradle|mvn)\b/;
const MUTATING_GIT = /\bgit\s+(commit|push|checkout|switch|reset|revert|merge|rebase|cherry-pick|clean|add|tag|apply|am|worktree|init|clone|pull|fetch)\b/;
const MUTATING_PKG = /\b(npm|bun|pnpm|yarn)\s+(i|install|add|remove|uninstall|run|exec|publish|link|update)\b/;
const REDIRECT = /(^|[^0-9<>])>>?[^&]/;
const SED_INPLACE = /\bsed\s+[^|;]*-i\b/;

/** Wrappers that run another command: the verb that matters is the next word. */
const RUNNERS = new Set(["sudo", "timeout", "command", "xargs", "env", "nohup", "stdbuf", "rtk"]);

/**
 * "read" | "mutate" | "other" — "other" is tolerated but never counted.
 *
 * The mutation verbs are matched against each stage's **verb**, not against the
 * whole command line: `rg docker` and `grep -rn "make" src/` search for a word,
 * they do not run it, and testing the raw string threw away read-only segments
 * for mentioning one.
 */
function classifyBash(command) {
  const cmd = String(command ?? "");
  // A discard is not a write, but `> file` is — so only `/dev/null` is exempt,
  // and only under the flag. Everything else the REDIRECT rule catches, it keeps.
  const redirectable = HOST_READ_IDIOMS ? cmd.replace(/>>?\s*\/dev\/null/g, " ") : cmd;
  if (SED_INPLACE.test(cmd) || REDIRECT.test(redirectable)) return "mutate";

  // Split on shell separators, drop `cd <dir>` and env assignments, then look
  // at the verb of each remaining stage.
  const stages = cmd
    .split(/\|\||&&|[|;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  let sawRead = false;
  for (const stage of stages) {
    const words = stage.split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    let verb = words[0];
    let rest = words.slice(1);
    // `export PATH=…` has had its assignment dropped by the filter above, so it
    // is a bare no-op prefix: skipping it is what `cd` already gets, and not
    // skipping it ends classification before the read it precedes.
    if (HOST_READ_IDIOMS && verb === "export" && rest.length === 0) continue;
    while (verb === "cd" || RUNNERS.has(verb)) {
      if (verb === "cd") {
        verb = undefined;
        break;
      }
      // `rtk proxy <verb>`: the raw escape hatch is two words, so unwrapping
      // `rtk` alone leaves `proxy` as the verb that gets classified.
      const unwrapProxy = HOST_READ_IDIOMS && verb === "rtk" && rest[0] === "proxy";
      verb = rest[0];
      rest = rest.slice(1);
      if (unwrapProxy) {
        verb = rest[0];
        rest = rest.slice(1);
      }
    }
    if (!verb) continue;
    const base = verb.replace(/^.*\//, "");
    // `sed -i` was already a mutation above and `sed … > file` a REDIRECT one;
    // what is left pages through a file, which is this host's commonest read.
    if (HOST_READ_IDIOMS && base === "sed") {
      sawRead = true;
      continue;
    }
    if (MUTATING.test(base)) return "mutate";
    if (base === "git" && MUTATING_GIT.test(stage)) return "mutate";
    if (MUTATING_PKG.test(`${base} ${rest[0] ?? ""}`)) return "mutate";
    if (READ_VERBS.has(base)) {
      sawRead = true;
      continue;
    }
    const sub = READ_SUBCOMMANDS[base];
    if (sub && rest.some((w) => sub.has(w))) {
      sawRead = true;
      continue;
    }
    return "other";
  }
  return sawRead ? "read" : "other";
}

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "NotebookRead"]);
const WRITE_TOOLS = new Set([
  "Edit", "Write", "MultiEdit", "NotebookEdit", "TaskCreate", "TaskUpdate",
  "SendMessage", "Artifact", "CronCreate", "CronDelete", "RemoteTrigger",
]);
/** A delegated run's real work is invisible here, so it disqualifies a segment. */
const DELEGATION_TOOLS = new Set(["Agent", "Task", "Workflow", "Skill"]);

// ── segmentation ──────────────────────────────────────────────────────────

async function* entriesOf(file) {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf-8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.startsWith("{")) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // A truncated tail line is normal on a live session file.
    }
  }
}

function emptySegment(question, entry) {
  return {
    question,
    file: null,
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    gitBranch: entry.gitBranch,
    startedAt: entry.timestamp,
    endedAt: entry.timestamp,
    readOps: 0,
    otherOps: 0,
    mutations: 0,
    toolCounts: {},
    files: new Set(),
    texts: [],
    lastToolIndex: -1,
    usage: { input: 0, cacheRead: 0, cacheCreate: 0, output: 0 },
  };
}

/** Walk one transcript file, cutting it into question → work → answer segments. */
async function segmentsOf(file) {
  // A delegated run's transcript is one task from its first message to its
  // last: the prompt is the question, and the later user turns are the parent
  // steering it, not a new question. Cutting there would orphan the answer.
  const delegated = file.includes(`${sep}subagents${sep}`);
  const out = [];
  let seg = null;
  for await (const entry of entriesOf(file)) {
    const question = humanText(entry, delegated);
    if (question !== null && !(delegated && seg)) {
      if (seg) out.push(seg);
      seg = emptySegment(question, entry);
      seg.file = file;
      seg.delegated = delegated;
      seg.agent = entry.slug ?? entry.agentId;
      continue;
    }
    if (!seg || entry.type !== "assistant") continue;
    if (entry.isSidechain && !delegated) continue;

    seg.endedAt = entry.timestamp ?? seg.endedAt;
    const usage = entry.message?.usage ?? {};
    seg.usage.input += usage.input_tokens ?? 0;
    seg.usage.cacheRead += usage.cache_read_input_tokens ?? 0;
    seg.usage.cacheCreate += usage.cache_creation_input_tokens ?? 0;
    seg.usage.output += usage.output_tokens ?? 0;

    for (const block of entry.message?.content ?? []) {
      if (block?.type === "text" && block.text?.trim()) {
        seg.texts.push({ text: block.text, afterTools: seg.readOps + seg.otherOps });
        continue;
      }
      if (block?.type !== "tool_use") continue;
      const name = block.name;
      seg.toolCounts[name] = (seg.toolCounts[name] ?? 0) + 1;

      if (WRITE_TOOLS.has(name) || DELEGATION_TOOLS.has(name)) {
        seg.mutations += 1;
        continue;
      }
      if (READ_TOOLS.has(name)) {
        seg.readOps += 1;
        const path = block.input?.file_path ?? block.input?.path ?? block.input?.pattern;
        if (typeof path === "string") seg.files.add(path);
        continue;
      }
      if (name === "Bash") {
        const kind = classifyBash(block.input?.command);
        if (kind === "read") seg.readOps += 1;
        else if (kind === "mutate") seg.mutations += 1;
        else seg.otherOps += 1;
        continue;
      }
      seg.otherOps += 1;
    }
  }
  if (seg) out.push(seg);
  return out;
}

// ── fact verification ─────────────────────────────────────────────────────

/**
 * `path/to/file.ext` with an optional `:line`, absolute or relative. The
 * leading `/` is part of the match on purpose: a lookbehind that rejected it
 * would make every absolute citation invisible, and an answer that ranged over
 * several trees writes them absolute.
 */
const CITATION = /(?<![\w.@-])(\/?(?:[\w.@-]+\/)+[\w.-]+\.[A-Za-z][\w]*)(?::(\d+))?\b/g;
const IDENTIFIER = /(?<![\w$])([A-Za-z_$][\w$]{4,})(?![\w$])/g;
/** Absolute paths a question or an answer names — the candidate task trees. */
const ABS_PATH = /(?<![\w/])(\/(?:[\w.@-]+\/)+[\w.@-]+)/g;

function isCodeIdentifier(token) {
  return token.includes("_") || /[a-z][A-Z]/.test(token) || /^[A-Z]{3,}/.test(token);
}

/**
 * `a.yml/b.yml/c.yml` and `bun.lock/package.json` are prose slash-lists, not
 * paths: a *directory* component carrying its own file extension is the tell.
 * Left in, they become "citations" that resolve nowhere and would fail the
 * native arm on its own rubric for a formatting habit.
 */
function looksLikePath(relPath) {
  const parts = relPath.split("/");
  return parts.slice(0, -1).every((part) => !/^.+\.[A-Za-z][\w]*$/.test(part));
}

/**
 * Whole-identifier match. `String.includes` finds `STORE` inside `RESTORE`,
 * which is how a claim about a state store ends up anchored to
 * `RESTORE = os.environ["RESTORE_SIG"]` in an unrelated test.
 */
const IDENT_CHAR = /[\w$]/;
function hasIdentifier(line, token) {
  for (let from = 0; ; ) {
    const i = line.indexOf(token, from);
    if (i < 0) return false;
    const before = i === 0 ? "" : line[i - 1];
    const after = line[i + token.length] ?? "";
    if (!IDENT_CHAR.test(before) && !IDENT_CHAR.test(after)) return true;
    from = i + 1;
  }
}

/** The longest prefix of an absolute path that exists as a directory. */
function existingDirOf(absPath) {
  let dir = absPath;
  while (dir.length > 1) {
    try {
      return statSync(dir).isDirectory() ? dir : dirname(dir);
    } catch {
      dir = dirname(dir);
    }
  }
  return null;
}

/**
 * Trees the session ranged over: its cwd plus the absolute directories its
 * question or answer names. A delegated explore run is often spawned in one
 * checkout and asked about another, so the cwd is a candidate, not the answer.
 */
function candidateRoots(cwd, texts) {
  const home = homedir();
  const roots = [];
  const seen = new Set();
  // `$HOME` is never a task root: `rlmx mcp --dir ~` is not a question about a
  // repository, and a session that ran there is asking about a tree it names.
  const add = (dir) => {
    if (!dir || seen.has(dir) || dir === home || !dir.startsWith(home + sep)) return;
    seen.add(dir);
    // Nested candidates would double-count the same tree; the first one wins.
    if (roots.some((r) => dir.startsWith(r + sep) || r.startsWith(dir + sep))) return;
    roots.push(dir);
  };
  add(cwd);
  for (const text of texts) {
    for (const [, candidate] of String(text).matchAll(ABS_PATH)) {
      if (roots.length > MAX_SIBLING_ROOTS) return roots;
      const dir = existingDirOf(candidate);
      if (dir === candidate) add(dir); // named a tree, not a file
    }
  }
  return roots;
}

/**
 * The task root is the tree the answer is *about* — the candidate the most of
 * its citations resolve in — not necessarily the directory the session happened
 * to run in. It is the one directory the rlmx arm gets (`rlmx mcp --dir`), so
 * choosing the cwd when the question was "explore /home/namastex/prod/brain"
 * would hand that arm a tree the question is not about and score it on claims
 * it structurally cannot reach. Ties go to the cwd.
 */
function chooseRoot(candidates, citations) {
  let best = candidates[0];
  let bestHits = -1;
  for (const root of candidates) {
    const hits = new Set();
    for (const [, relPath] of citations) {
      if (resolveIn(root, relPath)) hits.add(relPath);
    }
    if (hits.size > bestHits) {
      best = root;
      bestHits = hits.size;
    }
  }
  return { root: best, siblings: candidates.filter((r) => r !== best) };
}

const fileCache = new Map();
function linesOf(abs) {
  if (!fileCache.has(abs)) {
    try {
      fileCache.set(abs, readFileSync(abs, "utf-8").split("\n"));
    } catch {
      fileCache.set(abs, null);
    }
  }
  return fileCache.get(abs);
}

/**
 * Every file in a tree, indexed by basename. Answers abbreviate paths —
 * `omni/checkpoints.ts` for `src/lib/omni/checkpoints.ts` — and treating that
 * habit as an invented path would fail the ground-truth arm on its own
 * criterion 3 for a formatting shorthand.
 */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "target", ".venv", "__pycache__", "coverage", "vendor"]);
const INDEX_BUDGET = 40_000;
const indexCache = new Map();
function fileIndex(root) {
  if (indexCache.has(root)) return indexCache.get(root);
  const index = new Map();
  const stack = [root];
  let seen = 0;
  while (stack.length && seen < INDEX_BUDGET) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      seen += 1;
      const hits = index.get(entry.name);
      const abs = join(dir, entry.name);
      if (hits) hits.push(abs);
      else index.set(entry.name, [abs]);
    }
  }
  indexCache.set(root, index);
  return index;
}

/** Resolve a citation under one root, or null if that root does not have it. */
function resolveIn(root, relPath) {
  const abs = isAbsolute(relPath) ? relPath : resolve(root, relPath);
  if (abs.startsWith(root + sep)) {
    try {
      if (statSync(abs).isFile()) return abs;
    } catch {
      // Fall through to the abbreviated-path lookup.
    }
  }
  // `a/b.ts` may be the tail of exactly one real path. One match is a
  // shorthand; several are ambiguous, and an ambiguous citation is no anchor.
  const parts = relPath.split("/");
  const hits = (fileIndex(root).get(parts[parts.length - 1]) ?? []).filter((candidate) =>
    candidate.endsWith(sep + parts.join(sep))
  );
  if (hits.length <= 1) return hits[0] ?? null;
  // A nested checkout (`.claude/worktrees/…`) or a vendored copy duplicates a
  // whole tree, so identical tails are common; the shallowest is the one the
  // answer meant. Two at the same depth stay ambiguous, and an ambiguous
  // citation anchors nothing.
  const depth = (p) => p.split(sep).length;
  const shallowest = Math.min(...hits.map(depth));
  const best = hits.filter((h) => depth(h) === shallowest);
  return best.length === 1 ? best[0] : null;
}

/** How far from the cited line a term may sit and still count as that line. */
const ANCHOR_SLACK = 3;
/**
 * How many lines of a file a term may occur on and still point at one of them.
 * `TARBALL` (6 of 231 lines in a build script) narrows a citation to a line;
 * `STAGE` (24 of the same 231) narrows it to "somewhere in this file", and
 * pairing that with a claim about the `tar` invocation produces an evidence
 * line that is evidence for nothing. Both a hard cap and a density bound,
 * because a 60-line file and a 6,000-line one do not share a threshold.
 */
const MAX_ANCHOR_HITS = 8;
const MAX_ANCHOR_DENSITY = 0.05;
/** A quoted fragment shorter than this matches by accident, not by content. */
const MIN_QUOTE_CHARS = 10;
/** Words per shingle when a quoted sentence is matched against a line. */
const SHINGLE_WORDS = 4;
const MIN_SHINGLE_CHARS = 12;

const normalizeLine = (line) => line.replace(/\s+/g, " ").trim();

/** A term named back to the reader: clipped on a word boundary, never mid-token. */
function shortTerm(text, cap) {
  const flat = normalizeLine(text);
  if (flat.length <= cap) return flat;
  const window = flat.slice(0, cap);
  const word = window.lastIndexOf(" ");
  return `${(word > cap * 0.5 ? window.slice(0, word) : window).trim()}…`;
}

/**
 * Match a quoted fragment against a line. Whole containment for a short quote;
 * for a sentence, any run of `SHINGLE_WORDS` consecutive words — an answer
 * quotes across a line break and adds `**emphasis**`, so demanding the whole
 * fragment verbatim would reject quotes that plainly came from the file.
 */
function quoteShingles(text) {
  const words = text.split(" ").filter(Boolean);
  if (words.length <= SHINGLE_WORDS) return text.length >= MIN_QUOTE_CHARS ? [text] : [];
  const out = [];
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i++) {
    const shingle = words.slice(i, i + SHINGLE_WORDS).join(" ");
    if (shingle.length >= MIN_SHINGLE_CHARS) out.push(shingle);
  }
  return out.length ? out : [text];
}

/**
 * Substring containment, with the same whole-token rule identifiers get at
 * whichever ends of the phrase are word characters: `genie install` must not
 * match inside "diagnostic checks on genie installation".
 */
function containsPhrase(line, phrase) {
  const startsWord = /^[\w$]/.test(phrase);
  const endsWord = /[\w$]$/.test(phrase);
  for (let from = 0; ; ) {
    const i = line.indexOf(phrase, from);
    if (i < 0) return false;
    const before = i === 0 ? "" : line[i - 1];
    const after = line[i + phrase.length] ?? "";
    if ((!startsWord || !IDENT_CHAR.test(before)) && (!endsWord || !IDENT_CHAR.test(after))) return true;
    from = i + 1;
  }
}

function makeTerm(kind, text) {
  if (kind === "symbol") return { kind, text, match: (line) => hasIdentifier(line, text) };
  const shingles = quoteShingles(text);
  if (shingles.length === 0) return null;
  return {
    kind,
    text,
    match: (line) => {
      const norm = normalizeLine(line);
      return shingles.some((s) => containsPhrase(norm, s));
    },
  };
}

/**
 * Which lines of a file a term occurs on, giving up once it is clear the term
 * is too common to anchor anything (`null`). The cap is also the early exit,
 * so a ubiquitous token costs a partial scan rather than a full one.
 */
const hitCache = new Map();
function hitsOf(abs, lines, term, cap) {
  const key = `${abs} ${cap} ${term.kind} ${term.text}`;
  if (hitCache.has(key)) return hitCache.get(key);
  const hits = [];
  let ubiquitous = false;
  for (let i = 0; i < lines.length; i++) {
    if (!term.match(lines[i])) continue;
    hits.push(i + 1);
    if (hits.length > cap) {
      ubiquitous = true;
      break;
    }
  }
  const result = ubiquitous || hits.length === 0 ? null : hits;
  hitCache.set(key, result);
  return result;
}

/** The line where a symbol is declared, when one of its occurrences declares it. */
function declarationOf(lines, hits, term) {
  if (term.kind !== "symbol") return null;
  const escaped = term.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declares = new RegExp(
    `(?:\\b(?:function|class|const|let|var|export|def|type|interface|enum|struct|fn|async)\\b[^\\n]*\\b${escaped}\\b)|(?:^\\s*(?:-\\s*)?${escaped}\\s*[:=(])`
  );
  return hits.find((line) => declares.test(lines[line - 1])) ?? null;
}

/**
 * Verify one `path:line` claim against the tree the session ran in.
 *
 * Line-existence alone is not verification: repos move, and a stale line number
 * whose content no longer matches the claim would seed the rubric with a fact
 * that penalises the arm that cites the *current* line correctly. Neither is
 * "the cited line is not blank" — that is a fact about the file's whitespace.
 * So a claim is verified against **its own terms**: an identifier it names or a
 * fragment it quotes, each specific enough to point at a line (see
 * `MAX_ANCHOR_HITS`).
 *
 *   exact       — a term sits on or beside the cited line, or on another line
 *                 this same claim cites (a sentence naming `:34` and `:139` is
 *                 anchored at whichever of them carries the term — not drift)
 *   re-anchored — the term moved; the fact survives at its current line
 *                 (its declaration, when one of the occurrences declares it),
 *                 and the drift is recorded
 *   otherwise   — the claim no longer anchors anything and is excluded
 *
 * The winning term is reported with the fact, so the link between the claim and
 * the quoted line is auditable instead of asserted.
 */
function verifyLine(abs, relPath, lineNo, terms, spans) {
  const lines = linesOf(abs);
  if (!lines) return { ok: false, reason: "unreadable" };
  if (lineNo < 1 || lineNo > lines.length) {
    return { ok: false, reason: `file now has ${lines.length} lines` };
  }
  if (terms.length === 0) {
    return { ok: false, reason: "the claim names no identifier and quotes no fragment to verify" };
  }

  const cap = Math.max(2, Math.min(MAX_ANCHOR_HITS, Math.round(lines.length * MAX_ANCHOR_DENSITY)));
  let best = null;
  let sawTerm = false;
  for (const term of terms) {
    const hits = hitsOf(abs, lines, term, cap);
    if (!hits) continue;
    sawTerm = true;

    const near = hits
      .filter((line) => Math.abs(line - lineNo) <= ANCHOR_SLACK)
      .sort((a, b) => Math.abs(a - lineNo) - Math.abs(b - lineNo))[0];
    const claimed = hits.find((line) => spans.some(([from, to]) => line >= from && line <= to));
    // A relocation lands on the occurrence closest to where the answer looked —
    // code slides, it rarely teleports — with a declaration winning an exact tie.
    const closest = [...hits].sort((a, b) => Math.abs(a - lineNo) - Math.abs(b - lineNo));
    const tied = closest.filter((l) => Math.abs(l - lineNo) === Math.abs(closest[0] - lineNo));
    const line = near ?? claimed ?? declarationOf(lines, tied, term) ?? closest[0];

    // Nearest wins first, a line the claim itself cites next, a relocation last;
    // a quoted fragment outranks a bare identifier at equal standing, and the
    // rarer term breaks the tie.
    const rank =
      (near ? 300 - Math.abs(near - lineNo) : claimed ? 200 : 100) +
      (term.kind === "quote" ? 30 : 0) +
      (cap - hits.length);
    if (best && rank <= best.rank) continue;
    best = {
      rank,
      ok: true,
      kind: near || claimed ? "exact" : "re-anchored",
      anchor: `${relPath}:${line}`,
      evidence: lines[line - 1].trim().slice(0, 160),
      matched: `${term.kind === "quote" ? "quoted" : "symbol"} \`${shortTerm(term.text, 80)}\` — ${
        hits.length
      } line${hits.length === 1 ? "" : "s"} in this file`,
      note:
        near || line === lineNo
          ? undefined
          : claimed
            ? `anchored at :${line}, one of the lines this claim itself cites — the citation \`:${lineNo}\` names the same sentence`
            : `native cited :${lineNo}; \`${shortTerm(term.text, 48)}\` is at :${line} today`,
    };
  }

  if (best) return best;
  const listed = terms
    .slice(0, 3)
    .map((t) => (t.kind === "quote" ? `"${t.text.slice(0, 30)}"` : t.text))
    .join(", ");
  return {
    ok: false,
    reason: sawTerm
      ? `${listed} are too common in this file to anchor a line`
      : `none of ${listed} remain in this file`,
  };
}

/**
 * The terms a claim offers up for checking: fragments it quotes and identifiers
 * it names. Both are taken from the claim **as written into the task file**, so
 * every fact rests only on words a reader can see next to the evidence line —
 * the previous version harvested identifiers from a window that reached past
 * the claim, which is how a sentence about a `tar` invocation ended up anchored
 * on `STAGE` from the code block below it.
 */
function claimTerms(claim) {
  const terms = [];
  const seen = new Set();
  const add = (kind, text) => {
    const key = `${kind} ${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    const term = makeTerm(kind, text);
    if (term) terms.push(term);
  };

  // Quoted fragments: `code` and "prose", minus the markdown emphasis an answer
  // sprinkles inside them. A quote that is only a path is a citation, not
  // content — `CLAIM_PATHS` leaving nothing behind is the test.
  for (const match of claim.matchAll(/`([^`\n]{4,160})`|"([^"\n]{8,160})"/g)) {
    const raw = normalizeLine((match[1] ?? match[2]).replace(/\*\*|__/g, ""));
    if (raw.length < MIN_QUOTE_CHARS) continue;
    // Backticks pair left to right, so a one-character span (`~`) leaves its
    // neighbours to pair across the prose between them. A fragment opening on
    // punctuation that cannot open a code span is that mis-pairing, not a quote.
    if (/^[)\]},;:|]/.test(raw)) continue;
    // A bare filename is a citation, not content: "the claim says `config.yaml`
    // and this file mentions `config.yaml`" anchors a topic, not a line.
    if (/^[\w.@-]+\.[A-Za-z][\w]*$/.test(raw)) continue;
    if (raw.replace(CLAIM_PATHS, " ").replace(/[^A-Za-z0-9]+/g, "").length < 6) continue;
    add("quote", raw);
  }

  // Paths are stripped before identifiers are read: `RUNBOOK.md` would
  // otherwise contribute `RUNBOOK`, which then matches any line of that file.
  const prose = claim.replace(CLAIM_PATHS, " ");
  for (const [, token] of prose.matchAll(/`([A-Za-z_$][\w$.]{4,})`/g)) {
    const head = token.split(".")[0];
    if (isCodeIdentifier(head)) add("symbol", head);
  }
  for (const [, token] of prose.matchAll(IDENTIFIER)) {
    if (isCodeIdentifier(token)) add("symbol", token);
  }
  return terms;
}

/**
 * The line ranges a claim cites for its own file — `x.ts:70-121` and the bare
 * `:34` an answer uses once the file is established. A term found inside one of
 * them is anchored where the claim put it, so it is not drift, and recording a
 * "drift" there would invent a repo change that never happened.
 */
const SPAN_WITH_PATH = /((?:[\w.@-]+\/)*[\w.-]+\.[A-Za-z][\w]*):(\d+)(?:\s*[-–]\s*(\d+))?/g;
const BARE_SPAN = /(?<![\w./-]):(\d+)(?:\s*[-–]\s*(\d+))?/g;
function claimSpans(claim, displayPath) {
  const base = displayPath.split("/").pop();
  const spans = [];
  for (const [, path, from, to] of claim.matchAll(SPAN_WITH_PATH)) {
    if (!path.endsWith(base)) continue;
    spans.push([Number(from), Number(to ?? from)]);
  }
  for (const [, from, to] of claim.matchAll(BARE_SPAN)) spans.push([Number(from), Number(to ?? from)]);
  return spans;
}

/**
 * What is left of a line once its paths, line numbers and markdown are taken
 * away — i.e. whether it says anything a scorer could check. "**File:**
 * `x.ts:111-132`:" reduces to "File", which is a label, not a claim.
 */
const CLAIM_PATHS = /\/?(?:[\w.@-]+\/)+[\w.-]+\.[A-Za-z][\w]*(?::\d+(?:[-,:]\d+)*)?/g;
function claimSubstance(claim) {
  return claim.replace(CLAIM_PATHS, " ").replace(/[^A-Za-z0-9]+/g, " ").trim();
}

/**
 * The sentence or bullet an anchor sits in — what the fact actually claims. A
 * heading, a bare "**File:**" label, or a code-fence header that is nothing but
 * the path says nothing a scorer can check, so neighbouring lines are pulled in
 * until the claim carries a statement: forward first (a bullet's continuation),
 * then backward (the prose that introduced the quoted snippet).
 */
function claimAround(answer, index) {
  const start = answer.lastIndexOf("\n", index) + 1;
  let end = answer.indexOf("\n", index);
  if (end < 0) end = answer.length;
  let claim = answer.slice(start, end).trim();
  const thin = () => claim.length < MIN_CLAIM_CHARS || claimSubstance(claim).length < 15;

  let cursor = end;
  while (cursor < answer.length && (thin() || /^#{1,6}\s/.test(claim))) {
    const nextEnd = answer.indexOf("\n", cursor + 1);
    const next = answer.slice(cursor + 1, nextEnd < 0 ? answer.length : nextEnd).trim();
    cursor = nextEnd < 0 ? answer.length : nextEnd;
    if (!next || /^[`~]{3}/.test(next)) continue;
    // A heading is a section label; what follows it is the claim, not a suffix.
    claim = /^#{1,6}\s/.test(claim) ? next : `${claim} ${next}`;
  }
  for (let back = start - 1; thin() && back > 0; ) {
    const lineStart = answer.lastIndexOf("\n", back - 1) + 1;
    const previous = answer.slice(lineStart, back).trim();
    back = lineStart - 1;
    if (!previous || /^[`~]{3}/.test(previous) || claimSubstance(previous).length < 15) continue;
    claim = `${previous} ${claim}`;
  }
  return clipClaim(claim);
}

/**
 * Clip a claim to something a scorer can rule on. Criterion 1 asks whether the
 * answer "makes the same claim", so a statement cut mid-token — "…the staging
 * tree is assembled at `sc" — is unscoreable by either arm: the cut falls on a
 * sentence end when there is one in reach, otherwise a word boundary, and an
 * ellipsis says the sentence continues. An odd backtick left by the cut is
 * closed so the checklist still renders as markdown.
 */
function clipClaim(claim) {
  const flat = claim.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_CLAIM_CHARS) return flat;
  const window = flat.slice(0, MAX_CLAIM_CHARS);
  const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("; "), window.lastIndexOf(" — "));
  const word = window.lastIndexOf(" ");
  const cut = sentence >= MAX_CLAIM_CHARS * 0.6 ? sentence + 1 : word > 0 ? word : MAX_CLAIM_CHARS;
  let clipped = flat.slice(0, cut).trim().replace(/[,;:—-]$/, "");
  if ((clipped.match(/`/g)?.length ?? 0) % 2 === 1) clipped += "`";
  return `${clipped} …`;
}

/** Two anchors under the same sentence are one claim with two pointers. */
function claimKey(claim) {
  return claim.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Mine the answer for `path:line` claims about the task root and check each
 * against the repository. What survives becomes the required-facts checklist;
 * everything else is recorded under its own heading, with the reason, so the
 * suite can be audited without re-mining.
 */
function extractFacts(answer, citations, root, siblings) {
  const byClaim = new Map();
  const dropped = [];
  const crossTree = [];
  const unresolved = [];
  const citedPaths = [];
  const seen = new Set();
  let inRoot = 0;
  const citationFailures = [];

  /** Where a citation lives, if any listed tree has it. */
  const locate = (relPath) => {
    const abs = resolveIn(root, relPath);
    if (abs) return { abs, root, display: abs.slice(root.length + 1) };
    for (const sibling of siblings) {
      const found = resolveIn(sibling, relPath);
      if (found) return { abs: found, root: sibling, display: found.slice(sibling.length + 1) };
    }
    return null;
  };

  for (const match of citations) {
    const [, relPath, lineRaw] = match;
    const found = locate(relPath);
    // Dedupe on where a citation lands, not on how it was spelled: the same
    // line cited absolute and relative is one claim.
    const key = `${found?.abs ?? relPath}:${lineRaw ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const claim = claimAround(answer, match.index);
    const inTaskRoot = found?.root === root;
    const anchor = `${found?.display ?? relPath}${lineRaw ? `:${lineRaw}` : ""}`;

    // A bare path is existence-checked and reported, never scored: "file
    // exists, 527 lines" is a fact about the file, not about the answer, and an
    // arm that never opened it can state it just as well.
    if (!lineRaw) {
      if (!found) continue;
      if (inTaskRoot) citedPaths.push({ path: found.display, lines: (linesOf(found.abs) ?? []).length, claim });
      else crossTree.push({ anchor, root: found.root, claim });
      continue;
    }

    const lineNo = Number(lineRaw);
    if (!found) {
      unresolved.push({ anchor, claim, reason: "no listed tree has this file" });
      continue;
    }
    if (!inTaskRoot) {
      crossTree.push({ anchor, root: found.root, claim });
      continue;
    }

    const abs = found.abs;
    inRoot += 1;
    // Checked before verification: a bare citation cannot be scored however
    // well it anchors, and it supplies no terms to anchor it with either.
    if (claim.length < MIN_CLAIM_CHARS || claimSubstance(claim).length < 15) {
      dropped.push({ anchor, claim, reason: "claim is a bare citation — nothing to score" });
      continue;
    }

    // The terms come from the claim as it will be written into the task file,
    // so a reader sees everything the fact rests on in one place.
    const result = verifyLine(
      abs,
      found.display,
      lineNo,
      claimTerms(claim),
      claimSpans(claim, found.display)
    );
    if (!result.ok) {
      // A line past the end of the file is a criterion-2 failure for whoever
      // wrote it; a term that has since moved out of the file is not — the
      // citation still lands on a real line, it just cannot anchor a fact.
      const lines = linesOf(abs) ?? [];
      if (lineNo < 1 || lineNo > lines.length) citationFailures.push({ anchor, reason: result.reason });
      dropped.push({ anchor, claim, reason: result.reason });
      continue;
    }

    const grouped = byClaim.get(claimKey(claim));
    if (grouped) {
      if (!grouped.anchors.includes(result.anchor)) grouped.anchors.push(result.anchor);
      continue;
    }
    byClaim.set(claimKey(claim), {
      kind: result.kind,
      anchors: [result.anchor],
      claim,
      evidence: result.evidence,
      matched: result.matched,
      note: result.note,
      // The answer's own spelling, when it abbreviated the path.
      pathNote:
        isAbsolute(relPath) || relPath === found.display
          ? undefined
          : `native wrote \`${relPath}\`; that file is at \`${found.display}\``,
    });
  }

  return {
    facts: [...byClaim.values()],
    dropped,
    crossTree,
    unresolved,
    citedPaths,
    citations: { inRoot, failures: citationFailures },
  };
}

// ── scoring + selection ───────────────────────────────────────────────────

const QUESTION_SHAPE =
  /\?|^\s*(where|how|what|which|why|who|when|does|do|is|are|can|should|find|check|explain|investigate|look|analyze|analyse|compare|verify|confirm|audit|trace|list|show|read|review|tell)\b/i;

/**
 * Read-only work splits into two shapes on this host: someone asking where
 * something lives and why it behaves that way, and someone commissioning a
 * judgement (plan review, design review, PR review). Both are read-heavy and
 * mutate nothing, but only the first is the class this gate is about — a
 * verdict is not a citation, and WISH.md scopes the suite to "real
 * explore-class tasks". So a review commission is rejected outright rather
 * than sorted to the tail: half a suite of the wrong class weakens whatever
 * verdict the parity gate reaches.
 */
const REVIEW_COMMISSION = [
  /^\s*(?:you are (?:reviewing|the reviewer)|perform an?\b[^.\n]*\breview\b|(?:independent\s+)?(?:plan|design|pr|code)\s+re-?review\b)/i,
  /\b(?:return|give|report|render)\s+(?:a\s+)?verdict\b/i,
  // Uppercase on purpose: these are the review harness's verdict tokens, not
  // ordinary words, so the case is the signal.
  /\bVERDICT\s*:|\b(?:FIX-FIRST|BLOCKED)\b|\bSHIP\b\s*(?:\/|$|\n)/,
];
const isReviewCommission = (question) => REVIEW_COMMISSION.some((re) => re.test(question));

function answerOf(seg) {
  if (seg.texts.length === 0) return "";
  // The answer is what came after the last tool call; a preamble ("let me
  // check…") is narration, not a finding.
  const tail = seg.texts.filter((t) => t.afterTools === seg.readOps + seg.otherOps);
  const chosen = tail.length ? tail : seg.texts.slice(-1);
  return chosen.map((t) => t.text).join("\n\n").trim();
}

/** A task, or the reason this segment is not one — `--explain` tallies them. */
function evaluate(seg) {
  if (seg.mutations > 0) return { reject: "mutated something" };
  if (seg.readOps < MIN_READ_OPS) return { reject: `<${MIN_READ_OPS} read ops` };
  const question = seg.question;
  if (question.length < MIN_QUESTION_CHARS) return { reject: "question too short" };
  if (question.length > MAX_QUESTION_CHARS) return { reject: "work order, not a question" };
  if (!QUESTION_SHAPE.test(question)) return { reject: "not phrased as a question" };
  if (isReviewCommission(question)) return { reject: "review commission, not explore-class" };
  const answer = answerOf(seg);
  if (answer.length < MIN_ANSWER_CHARS) return { reject: "no substantive answer" };
  const cwd = seg.cwd && existsSync(seg.cwd) ? seg.cwd : null;
  if (!cwd) return { reject: "cwd gone" };

  const citations = [...answer.matchAll(CITATION)].filter(([, relPath]) => looksLikePath(relPath));
  const candidates = candidateRoots(cwd, [question, answer]);
  if (candidates.length === 0) return { reject: "no usable task root" };
  const { root, siblings } = chooseRoot(candidates, citations);
  const mined = extractFacts(answer, citations, root, siblings);
  /** What a near miss looked like — `--explain` prints these. */
  const detail =
    `${root.replace(homedir(), "~")} · ${mined.facts.length} facts, ` +
    `${mined.citations.inRoot} in-root citations, ${mined.crossTree.length} cross-tree, ` +
    `${mined.dropped.length} dropped, ${mined.unresolved.length} unresolved · ${titleOf(question).slice(0, 60)}`;
  if (mined.facts.length < MIN_VERIFIED_FACTS) {
    return { reject: `<${MIN_VERIFIED_FACTS} verifiable facts`, detail };
  }
  // Decision 6 says native scores 100% by construction. Construction covers
  // criterion 1 — the checklist is lifted from this answer — but not criteria
  // 2 and 3, so they are checked here. A task whose ground-truth arm fails the
  // rubric cannot be scored "identically to both arms".
  if (mined.citations.failures.length > 0) {
    return {
      reject: "native citation does not resolve (criterion 2)",
      detail: `${detail} · ${mined.citations.failures.map((f) => `${f.anchor} (${f.reason})`).join(", ")}`,
    };
  }
  if (mined.unresolved.length > 0) {
    return {
      reject: "native cites a file no listed tree has (criterion 3)",
      detail: `${detail} · ${mined.unresolved.map((u) => u.anchor).join(", ")}`,
    };
  }

  const score =
    mined.facts.length * 3 + seg.readOps + Math.min(seg.files.size, 10) + classFit(question);
  return { task: { ...seg, cwd, root, siblings, question, answer, ...mined, score } };
}

/**
 * Explore-class fit, as a score adjustment. Review commissions are rejected
 * outright above, so what is left is ordering among genuine questions: a short,
 * question-shaped ask is closer to what a host would delegate than a long brief.
 */
function classFit(question) {
  let fit = 0;
  if (question.length <= 900) fit += 10; // a question, not a brief
  if (/\?/.test(question)) fit += 6;
  return fit;
}

// ── output ────────────────────────────────────────────────────────────────

function excerpt(text, cap) {
  const clipped = text.length > cap ? `${text.slice(0, cap)}\n\n[… truncated at ${cap} chars]` : text;
  return redact(clipped);
}

function titleOf(question) {
  const firstLine = question.split("\n").find((l) => l.trim().length > 10) ?? question;
  return redact(firstLine.replace(/\s+/g, " ").trim().slice(0, 90));
}

function renderTask(task, n, meta) {
  const totalTokens =
    task.usage.input + task.usage.cacheRead + task.usage.cacheCreate + task.usage.output;
  const tools = Object.entries(task.toolCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}×${count}`)
    .join(", ");
  const factCount = task.facts.length;
  const required = Math.ceil(factCount * 0.9);
  const misses = factCount - required;

  const lines = [
    `# Task ${n} — ${titleOf(task.question)}`,
    "",
    "| Field | Value |",
    "|-------|-------|",
    `| Task root (the rlmx arm's \`--dir\`) | \`${task.root}\` |`,
    ...(task.root === task.cwd
      ? []
      : [`| Native session cwd | \`${task.cwd}\` — the answer is about the root above |`]),
    `| Git branch | \`${task.gitBranch ?? "unknown"}\` |`,
    `| Session | \`${task.sessionId}\` |`,
    `| Asked | ${task.startedAt} |`,
    `| Mining window | ${meta.window} (mined ${meta.minedAt}) |`,
    `| Native read ops | ${task.readOps} of ${task.readOps + task.otherOps} tool calls |`,
    `| Native tool calls | ${tools} |`,
    `| Distinct paths touched | ${task.files.size} |`,
    `| Required facts | ${factCount} (pass needs ${required}) |`,
    `| Significance score | ${task.score} |`,
    "",
    "## Question (verbatim from the transcript)",
    "",
    "```text",
    excerpt(task.question, MAX_QUESTION_CHARS),
    "```",
    "",
    "## Native answer trace (verbatim, the ground-truth arm)",
    "",
    "```text",
    excerpt(task.answer, MAX_ANSWER_CHARS),
    "```",
    "",
    "## Required facts (repo-verified — the rubric scores against these)",
    "",
    `Every fact below is a \`path:line\` claim the native answer made about`,
    `\`${task.root}\`, re-checked against that tree at mining time. Verification is`,
    "content-anchored, not line-number-anchored: a **term the claim itself**",
    "**supplies** — an identifier it names or a fragment it quotes — must still be",
    "in that file, and must be specific enough to point at a line (a token spread",
    "across more than a few lines of the file anchors nothing, and a claim that",
    "offers no term at all is dropped rather than 'verified' against a non-blank",
    "line). `exact` — the term is on or beside the cited line, or on another line",
    "this same claim cites. `re-anchored` — the term moved; the anchor is where it",
    "lives today and the drift is noted. Each fact names the term it was anchored",
    "on and quotes the line, so a reader can re-check without re-mining.",
    "",
  ];

  task.facts.forEach((fact, i) => {
    // One sentence can carry a dozen anchors; a checklist entry is unreadable
    // with all of them, and the first few are enough to re-check the claim.
    const extra = fact.anchors.slice(1, 5);
    const more = fact.anchors.length - 1 - extra.length;
    const also = extra.length
      ? ` (also \`${extra.join("`, `")}\`${more > 0 ? `, +${more} more` : ""})`
      : "";
    lines.push(`- [ ] **F${i + 1}** (${fact.kind}) \`${fact.anchors[0]}\`${also}`);
    lines.push(`  - claim: ${redact(fact.claim)}`);
    lines.push(`  - anchored on: ${redact(fact.matched)}`);
    lines.push(`  - verified: \`${redact(fact.evidence)}\``);
    if (fact.note) lines.push(`  - ${fact.kind === "re-anchored" ? "drift" : "note"}: ${redact(fact.note)}`);
    if (fact.pathNote) lines.push(`  - path: ${redact(fact.pathNote)}`);
  });
  lines.push("");

  if (task.siblings.length) {
    lines.push(
      "## Scope: trees outside the rubric",
      "",
      "The native session ranged over more than one tree. `rlmx mcp --dir` shows",
      "the rlmx arm exactly one, so the parts of the question that live in these",
      "trees are structurally unanswerable by that arm and are **out of scope for**",
      "**both arms** — not required facts, not scored under criteria 2 or 3:",
      "",
      ...task.siblings.map((root) => `- \`${root}\``),
      ""
    );
  }

  if (task.crossTree.length) {
    lines.push(
      "### Native claims verified in one of those trees (out of scope, not missing)",
      "",
      ...task.crossTree.map(
        (item) => `- \`${item.anchor}\` — resolves under \`${item.root}\`; claim: ${redact(item.claim)}`
      ),
      ""
    );
  }

  if (task.citedPaths.length) {
    lines.push(
      "## Paths the answer cites without a line (existence-checked, not scored)",
      "",
      "A bare path is a fact about the file, not about the answer: an arm that",
      "never opened it can state it just as well, so these discriminate nothing.",
      "",
      ...task.citedPaths.slice(0, 12).map((item) => `- \`${item.path}\` — exists, ${item.lines} lines`),
      ...(task.citedPaths.length > 12 ? [`- … ${task.citedPaths.length - 12} more`] : []),
      ""
    );
  }

  if (task.dropped.length) {
    lines.push(
      "## Native claims that no longer anchor a fact (excluded from the checklist)",
      "",
      "These citations still land on a real line — they pass criterion 2 — but",
      "they cannot anchor a fact a scorer could check: either the symbols the claim",
      "named have left the file, or the sentence around the citation says nothing",
      "beyond the path itself.",
      "",
      ...task.dropped.map((item) => `- \`${item.anchor}\` — ${item.reason}; claim: ${redact(item.claim)}`),
      ""
    );
  }

  lines.push(
    "## Rubric (fixed before scoring; applied identically to both arms)",
    "",
    `1. **Required facts** — the answer states at least **${required} of the ${factCount}**`,
    `   facts above (⌈0.9 × ${factCount}⌉ = ${required}; ${misses === 0 ? "no miss" : `${misses} miss${misses === 1 ? "" : "es"}`} allowed).`,
    ...(misses === 0
      ? [
          `   With ${factCount} facts the wish's ≥90% bar rounds to every one of them; that is`,
          "   the bar, recorded here so the gate is auditable rather than surprising.",
        ]
      : []),
    "   A fact counts as stated when the answer makes the same claim; wording may",
    "   differ, the anchor may not.",
    "2. **Citations resolve** — every `path:line` in the answer that names a file",
    `   under \`${task.root}\` must resolve to a real line there. One that does not`,
    "   fails the task. Citations naming a file in a listed out-of-scope tree are",
    "   not scored under this criterion (see the scope section, when present).",
    "3. **No fabrication** — no invented path, symbol, or line number: a",
    "   `path:line` that names a file neither the task root nor a listed tree has",
    "   is a fabrication, and one fails the task regardless of the other two.",
    "",
    "Pass = all three. Scored the same way for the native arm and for `rlmx_explore`.",
    "",
    "### Native arm baseline (checked at mining time, not assumed)",
    "",
    `- Criterion 1: ${factCount}/${factCount} — the checklist is lifted from this answer, so native`,
    "  states every fact by construction (the disclosed D6/P3 asymmetry).",
    `- Criterion 2: ${task.citations.inRoot} \`path:line\` citation(s) name a file in the task root;`,
    "  all resolve. A task where one did not is not written at all.",
    "- Criterion 3: no `path:line` in this answer is missing from both the task",
    "  root and the listed trees — same rejection rule.",
    "",
    "## Token accounting (reported, never gated)",
    "",
    "| Arm | Method | Premium tokens |",
    "|-----|--------|----------------|",
    `| native | this segment's assistant turns: input + cacheRead + cacheCreate + output | ${totalTokens.toLocaleString("en-US")} |`,
    "| rlmx | main-session call delta: prompt + result bytes ÷ 4 | _filled in by the parity run_ |",
    "",
    `Native breakdown: ${task.usage.input.toLocaleString("en-US")} in, ` +
      `${task.usage.cacheRead.toLocaleString("en-US")} cacheRead, ` +
      `${task.usage.cacheCreate.toLocaleString("en-US")} cacheCreate, ` +
      `${task.usage.output.toLocaleString("en-US")} out.`,
    "",
    "## How to run the rlmx arm",
    "",
    "```bash",
    `rlmx mcp --dir ${task.root}   # then call rlmx_explore with the question above`,
    "```",
    "",
    `Mined by \`scripts/mine-explore-tasks.mjs\` from \`${task.file.replace(homedir(), "~")}\`.`,
    "Verbatim excerpts are redacted for secrets.",
    ""
  );

  return lines.join("\n");
}

// ── main ──────────────────────────────────────────────────────────────────

/**
 * Every `.jsonl` under the projects root, at any depth. Main-thread sessions
 * sit directly in a project directory; a delegated run's own transcript lives
 * under `<session>/subagents/`, and those are explore-class work too — a
 * read-only subagent is exactly the shape this suite is about.
 */
function transcriptFiles(sinceMs) {
  const files = [];
  const stack = [PROJECTS];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      if (entry.name === "journal.jsonl") continue;
      // mtime is the cheap pre-filter; per-entry timestamps decide membership.
      try {
        if (statSync(abs).mtimeMs >= sinceMs) files.push(abs);
      } catch {
        // Rotated away mid-scan.
      }
    }
  }
  return files;
}

async function mine(hours) {
  const sinceMs = Date.now() - hours * 3_600_000;
  const files = transcriptFiles(sinceMs);
  const tasks = [];
  const rejected = {};
  const nearMisses = [];
  // Each widening attempt re-scans from scratch, so the audit trail is the
  // final attempt's, not the union of every attempt's.
  exclusionLog.bySession = [];
  exclusionLog.bySubject = [];
  const seenExcluded = new Map();
  for (const file of files) {
    for (const seg of await segmentsOf(file)) {
      const startedMs = Date.parse(seg.startedAt ?? "");
      if (!Number.isFinite(startedMs) || startedMs < sinceMs) continue;
      // Session exclusion happens before evaluation, not after selection: an
      // excluded sitting should not even be verified, let alone ranked.
      if (EXCLUDE_SESSIONS.has(seg.sessionId)) {
        rejected["excluded session"] = (rejected["excluded session"] ?? 0) + 1;
        seenExcluded.set(seg.sessionId, (seenExcluded.get(seg.sessionId) ?? 0) + 1);
        continue;
      }
      const verdict = evaluate(seg);
      if (verdict.task) {
        const overlap = strongestSubjectOverlap(verdict.task);
        if (overlap && overlap.overlap >= SUBJECT_OVERLAP) {
          rejected["excluded subject (same files, same repo)"] =
            (rejected["excluded subject (same files, same repo)"] ?? 0) + 1;
          exclusionLog.bySubject.push({
            session: verdict.task.sessionId,
            askedAt: verdict.task.startedAt,
            root: verdict.task.root,
            clashesWith: overlap.task,
            anchorFileOverlap: overlap.overlap,
            sharedFiles: overlap.shared.slice(0, 8),
          });
          continue;
        }
        verdict.task.subjectOverlap = overlap;
        tasks.push(verdict.task);
      } else {
        rejected[verdict.reject] = (rejected[verdict.reject] ?? 0) + 1;
        // A segment that got as far as fact extraction is the interesting kind
        // of rejection: it says where the bar actually bit.
        if (verdict.detail) nearMisses.push(`${verdict.reject}: ${verdict.detail}`);
      }
    }
  }
  exclusionLog.bySession = [...seenExcluded]
    .map(([session, segments]) => ({ session, segmentsDropped: segments }))
    .sort((a, b) => b.segmentsDropped - a.segmentsDropped);
  tasks.sort((a, b) => b.score - a.score);
  return { hours, files: files.length, tasks, rejected, nearMisses };
}

/**
 * The suite, highest-scoring first, under the diversity caps. Score alone
 * concentrates: one long sitting against one repository produces several
 * high-scoring segments in a row, and a suite drawn from it measures that
 * subsystem rather than explore-class work. A skipped task is recorded with
 * the cap that skipped it, so the trade is visible rather than silent.
 */
function selectSuite(tasks) {
  const perSession = new Map();
  const perRoot = new Map();
  const picked = [];
  const skipped = [];
  for (const task of tasks) {
    if (picked.length >= MAX_TASKS) break;
    const sessions = perSession.get(task.sessionId) ?? 0;
    const roots = perRoot.get(task.root) ?? 0;
    if (sessions >= MAX_PER_SESSION || roots >= MAX_PER_ROOT) {
      skipped.push({
        score: task.score,
        root: task.root,
        session: task.sessionId,
        cap: sessions >= MAX_PER_SESSION ? `${MAX_PER_SESSION} per session` : `${MAX_PER_ROOT} per repo`,
        title: titleOf(task.question).slice(0, 60),
      });
      continue;
    }
    perSession.set(task.sessionId, sessions + 1);
    perRoot.set(task.root, roots + 1);
    picked.push(task);
  }
  return { picked, skipped, sessions: perSession.size, roots: perRoot.size };
}

/**
 * Every window that was tried, in order, with what it yielded. The widening is
 * the wish's mitigation for a quiet window; recording the attempts is what lets
 * a reader see that it was earned rather than chosen. The floor is checked
 * against the *diversified* suite: a window that yields eight tasks from two
 * sittings has not produced five tasks this gate can use.
 */
const attempts = [];
let run = await mine(HOURS);
let suite = selectSuite(run.tasks);
attempts.push({
  windowHours: run.hours,
  transcriptsScanned: run.files,
  candidatesFound: run.tasks.length,
  selectable: suite.picked.length,
});
for (const wide of WIDE_HOURS) {
  if (suite.picked.length >= MIN_TASKS || wide <= run.hours) break;
  process.stdout.write(
    `# mine-explore-tasks: ${suite.picked.length} selectable task(s) in ${run.hours}h ` +
      `(${run.tasks.length} candidate(s), floor is ${MIN_TASKS}, caps ${MAX_PER_SESSION}/session ` +
      `${MAX_PER_ROOT}/repo) — widening to ${wide}h\n`
  );
  run = await mine(wide);
  suite = selectSuite(run.tasks);
  attempts.push({
    windowHours: run.hours,
    transcriptsScanned: run.files,
    candidatesFound: run.tasks.length,
    selectable: suite.picked.length,
  });
}
const { hours, files, tasks, rejected, nearMisses } = run;

if (EXPLAIN) {
  for (const [reason, count] of Object.entries(rejected).sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`#   rejected ${String(count).padStart(5)} — ${reason}\n`);
  }
  for (const miss of nearMisses) process.stdout.write(`#   near miss — ${miss}\n`);
}

const selected = suite.picked;
const widened = attempts.length > 1;
const meta = {
  hours,
  minedAt: new Date().toISOString().slice(0, 19) + "Z",
  window: widened
    ? `past ${hours}h — widened from ${attempts
        .slice(0, -1)
        .map((a) => `${a.windowHours}h (${a.selectable} selectable of ${a.candidatesFound})`)
        .join(", then ")}, below the ${MIN_TASKS}-task floor`
    : `past ${hours}h`,
};

if (EXCLUSIONS_ACTIVE) {
  process.stdout.write(
    `# mine-explore-tasks: disjointness on (--disjoint-by ${DISJOINT_BY}) — ` +
      `${EXCLUDE_SESSIONS.size} excluded session(s)` +
      `${excluded ? `, subjects from ${excluded.files.length} task file(s) in ${excluded.dir}` : ""}\n`
  );
  if (SHARED_SESSIONS.size) {
    process.stdout.write(
      `#  — ${SHARED_SESSIONS.size} suite sitting(s) left in the pool; the anchor-file ` +
        "subject test is the only disjointness gate\n"
    );
  }
  for (const s of exclusionLog.bySession) {
    process.stdout.write(`#  — excluded session ${s.session} (${s.segmentsDropped} segment(s) dropped)\n`);
  }
  for (const s of exclusionLog.bySubject) {
    process.stdout.write(
      `#  — excluded subject: ${s.root.replace(homedir(), "~")} overlaps ${s.clashesWith} ` +
        `at ${Math.round(s.anchorFileOverlap * 100)}% of its anchor files\n`
    );
  }
}

process.stdout.write(
  `# mine-explore-tasks: scanned ${files} transcript(s) over ${hours}h → ` +
    `${tasks.length} explore-class task(s), writing ${selected.length} from ` +
    `${suite.sessions} session(s) across ${suite.roots} repo(s)\n`
);
for (const [i, task] of selected.entries()) {
  process.stdout.write(
    `#  ${i + 1}. score ${task.score} · ${task.facts.length} facts · ${task.readOps} read ops · ` +
      `${task.root.replace(homedir(), "~")} · ${titleOf(task.question).slice(0, 60)}\n`
  );
}
for (const skip of suite.skipped) {
  process.stdout.write(
    `#  — skipped (cap ${skip.cap}) score ${skip.score} · ${skip.root.replace(homedir(), "~")} · ${skip.title}\n`
  );
}

if (DRY_RUN) {
  process.stdout.write("# mine-explore-tasks: --dry-run, nothing written\n");
  process.exit(selected.length >= MIN_TASKS ? 0 : 1);
}

mkdirSync(OUT_DIR, { recursive: true });
// A re-run replaces the suite rather than interleaving with an older numbering.
for (const stale of readdirSync(OUT_DIR)) {
  if (/^\d+\.md$/.test(stale)) rmSync(join(OUT_DIR, stale));
}
selected.forEach((task, i) => {
  writeFileSync(join(OUT_DIR, `${i + 1}.md`), renderTask(task, i + 1, meta), "utf-8");
});

/**
 * Disclosure block, present only when this run was mined under an opt-in flag.
 * A default run's record is byte-for-byte the shape it always had; a run that
 * excluded a suite or widened the read classifier says so, in the record, next
 * to the suite it produced.
 */
const provenance = {};
if (EXCLUSIONS_ACTIVE) {
  provenance.disjointFrom = {
    mode: DISJOINT_BY,
    excludeTasksDir: excluded ? excluded.dir : null,
    excludedTaskFiles: excluded ? excluded.files : [],
    excludedSessions: [...EXCLUDE_SESSIONS].sort(),
    subjectTest: excluded
      ? `a candidate is dropped when ≥${SUBJECT_OVERLAP * 100}% of the files its required ` +
        "facts anchor on are also anchor files of an excluded task in the same root"
      : "not applied (no --exclude-tasks)",
    sessionsSeenAndDropped: exclusionLog.bySession,
    droppedForSubjectOverlap: exclusionLog.bySubject,
    // The negative half of the same test. Under `--disjoint-by subject` the
    // excluded suite's sittings stay in the pool, so every written task carries
    // its strongest measured overlap against that suite — a number a reader can
    // recompute from both suites' checklists, rather than a claim resting on an
    // empty result set.
    sharedSessionsNotExcluded: [...SHARED_SESSIONS].sort(),
    keptFromSharedSession: selected
      .map((task, i) => ({
        file: `${i + 1}.md`,
        root: task.root,
        session: task.sessionId,
        fromSharedSession: SHARED_SESSIONS.has(task.sessionId),
        anchorFiles: task.subjectOverlap?.anchorFiles ?? null,
        strongestOverlapWith: task.subjectOverlap?.task ?? null,
        anchorFileOverlap: task.subjectOverlap?.overlap ?? null,
        sharedFiles: task.subjectOverlap?.shared?.slice(0, 8) ?? [],
      }))
      .filter((row) => row.strongestOverlapWith !== null),
  };
}
if (HOST_READ_IDIOMS) {
  provenance.hostReadIdioms = {
    enabled: true,
    changes: [
      "`rtk proxy <verb>` unwrapped to <verb> (the two-word raw escape hatch)",
      "`sed` without -i and without a redirect counted as a read (paging a file)",
      "bare `export` skipped as a no-op stage prefix, like `cd`",
      "`>/dev/null` not counted as a redirect (a discard is not a write)",
    ],
    unchanged:
      "fact verification, all thresholds, and the criterion-2/3 rejection of a " +
      "task whose own native answer fails the rubric",
  };
}

writeFileSync(
  join(OUT_DIR, RUN_JSON),
  `${JSON.stringify(
    {
      minedAt: meta.minedAt,
      // The record's own reproduction command. `windowAttempts` alone cannot be
      // read backwards into a command: the ladder is a flag, so a run that
      // stopped at 336h either found its floor or ran out of rungs.
      argv: args,
      windowLadder: [HOURS, ...WIDE_HOURS.filter((h) => h > HOURS)],
      windowHours: hours,
      windowAttempts: attempts,
      widenedBecause: widened
        ? `the ${attempts[0].windowHours}h window yielded ${attempts[0].selectable} selectable task(s) ` +
          `of ${attempts[0].candidatesFound} candidate(s), below the ${MIN_TASKS}-task floor`
        : null,
      transcriptsScanned: files,
      candidatesFound: tasks.length,
      written: selected.length,
      ...provenance,
      diversity: {
        sessions: suite.sessions,
        repos: suite.roots,
        maxPerSession: MAX_PER_SESSION,
        maxPerRoot: MAX_PER_ROOT,
        skippedForDiversity: suite.skipped,
      },
      thresholds: {
        minReadOps: MIN_READ_OPS,
        minAnswerChars: MIN_ANSWER_CHARS,
        minVerifiedFacts: MIN_VERIFIED_FACTS,
        minClaimChars: MIN_CLAIM_CHARS,
        maxClaimChars: MAX_CLAIM_CHARS,
        maxAnchorHits: `${MAX_ANCHOR_HITS} lines, or ${MAX_ANCHOR_DENSITY * 100}% of the file, whichever is smaller`,
        mutationsAllowed: 0,
        reviewCommissions: "rejected — a verdict is not a citation (WISH.md:66)",
        factKinds:
          "path:line claims about the task root only, anchored on a term the claim itself supplies (exact | re-anchored)",
      },
      tasks: selected.map((task, i) => ({
        file: `${i + 1}.md`,
        score: task.score,
        root: task.root,
        sessionCwd: task.cwd,
        siblingRoots: task.siblings,
        session: task.sessionId,
        askedAt: task.startedAt,
        readOps: task.readOps,
        requiredFacts: task.facts.length,
        factsToPass: Math.ceil(task.facts.length * 0.9),
        inRootCitations: task.citations.inRoot,
        crossTreeClaims: task.crossTree.length,
        droppedClaims: task.dropped.length,
        nativeTokens:
          task.usage.input + task.usage.cacheRead + task.usage.cacheCreate + task.usage.output,
      })),
    },
    null,
    2
  )}\n`,
  "utf-8"
);

process.stdout.write(
  `# mine-explore-tasks: wrote ${selected.length} task file(s) and ${RUN_JSON} to ${OUT_DIR}\n`
);
if (selected.length < MIN_TASKS) {
  process.stdout.write(
    `# mine-explore-tasks: ${selected.length} of the ${MIN_TASKS}-task floor — the run record says what was ` +
      "scanned and what was excluded; exit 1\n"
  );
}
process.exit(selected.length >= MIN_TASKS ? 0 : 1);
