#!/usr/bin/env node
/**
 * author-explore-tasks.mjs — build explore tasks that no transcript contains.
 *
 * `mine-explore-tasks.mjs` cuts tasks out of work somebody already did. That is
 * the right way to get an *eval* suite, and it is why the frozen suite was mined
 * rather than written. It has one failure mode, and this host hit it: the corpus
 * runs out. Measured on 2026-07-27 over 745 transcripts and every window up to
 * 720h (the whole corpus is 8 days old), the miner finds **8** explore-class
 * candidates, **7** of which stand on the same files in the same repo as a
 * frozen eval task and are dropped by the subject test. One survives. A training
 * suite of one is not a training suite, and lowering the significance screen
 * does not help — measured at `--min-read-ops 4/3/2/1`, the yield stays 1,
 * because what rejects the rest is the fact bar and the mutation bar, not the
 * screen.
 *
 * So the remainder is authored, and this script is the machinery that keeps
 * "authored" from meaning "asserted". A hand-written checklist is worth exactly
 * as much as its verification, so every fact here is put through a check that is
 * **stricter than the miner's**:
 *
 *   - the anchor `path:line` must exist under the task root;
 *   - the fact's term must be on the anchor line itself — no ±3 slack, no
 *     re-anchoring to where the term lives today, no falling back to another
 *     line the claim cites. The miner allows all three because a repo moves
 *     between a session and the mining run; an authored fact is written against
 *     the tree as it stands, so it gets none of them;
 *   - the term must be specific enough to point at a line — the miner's bound,
 *     unchanged: at most `MAX_ANCHOR_HITS` (8) occurrences in the file, or 5% of
 *     its lines, whichever is smaller;
 *   - the term must appear in the claim as written, so a reader sees the link
 *     between the sentence and the quoted line rather than taking it on trust;
 *   - the claim must be a claim: `MIN_CLAIM_CHARS`..`MAX_CLAIM_CHARS`, the
 *     miner's bounds;
 *   - the reference answer must pass criteria 2 and 3 itself — every `path:line`
 *     it writes about the root must resolve there — which is the same rejection
 *     the miner applies to a native answer before it will emit the task;
 *   - every fact's anchor must actually be cited in the reference answer, so the
 *     checklist is a checklist *of that answer* and not a wish list beside it.
 *
 * Anything that fails is refused, loudly, with the file and line it failed on.
 * The bar can only reject tasks; there is no path through this script that
 * writes a fact it could not verify.
 *
 * **Disjointness** is enforced by the same mechanism the miner uses and against
 * the same metadata: an excluded suite's task files are read for their *task
 * root, session id and anchor files only* — never their question text, never
 * their answer — and an authored task standing on ≥`--subject-overlap` of an
 * excluded task's anchor files in the same root is refused. The measured
 * overlap is recorded for every task, clash or not, so the disjointness claim
 * can be recomputed from both suites' checklists instead of believed.
 *
 * **What is honestly different from a mined task**, stated in each file it
 * writes and once more here:
 *
 *   - The question was written for this suite. It is not a verbatim transcript
 *     line, and the file says so in its heading rather than borrowing the
 *     miner's "verbatim from the transcript".
 *   - There is no native arm. A mined task's ground truth is a real session's
 *     answer, which is what makes the D6/P3 asymmetry conservative — native
 *     scores 100% by construction and the gate is therefore harder for mikro.
 *     An authored task has no such session, so it carries **no native baseline
 *     and no native token accounting**, and `score-task.mjs --native` will not
 *     run against it. It is a training input, not a gate input.
 *   - The rubric is the frozen one, unchanged: ≥90% of required facts, all
 *     citations resolve, no fabrication.
 *
 *   node scripts/author-explore-tasks.mjs --spec <spec.json> --out <dir> \
 *     --exclude-tasks .genie/wishes/<wish>/tasks --run-json authored-run.json
 *   node scripts/author-explore-tasks.mjs --spec <spec.json> --dry-run
 *
 * Spec shape:
 *
 *   { "authoredBy": "…", "startAt": 2, "tasks": [ {
 *       "root": "/abs/path", "slug": "short-id", "question": "…",
 *       "answer": "…the reference answer, with path:line citations…",
 *       "fitness": true | false, "fitnessNote": "…why held out…",
 *       "facts": [ { "claim": "…", "anchor": "src/x.ts:42", "term": "ident",
 *                    "kind": "symbol" | "quote" } ] } ] }
 *
 * `fitness` (default true) is the optimizer-selection flag, and it exists
 * because "the task is valid" and "the task is a usable training signal" are
 * different questions. A task authored about the same tree, and off the same
 * investigation, that produced the prompt being tuned is still a correct task —
 * every fact is machine-verified — but selecting on it closes a loop: the
 * ground truth and the candidate prompt share an author and a reading of the
 * code. Such a task is written, verified and kept as a held-out diagnostic, and
 * `fitness: false` says so in the task file's own header and in the run record,
 * so an optimizer harness can honour it mechanically instead of a README asking
 * a human to remember.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const SPEC = flag("--spec", "");
const OUT_DIR = flag("--out", "") ? resolve(flag("--out", "")) : null;
const RUN_JSON = flag("--run-json", "authored-run.json");
const EXCLUDE_TASKS_DIR = flag("--exclude-tasks", "") ? resolve(flag("--exclude-tasks", "")) : null;
const SUBJECT_OVERLAP = Number(flag("--subject-overlap", "0.34"));
const DRY_RUN = args.includes("--dry-run");

if (!SPEC) {
  process.stderr.write("usage: author-explore-tasks.mjs --spec <spec.json> [--out <dir>] [--dry-run]\n");
  process.exit(2);
}
if (!DRY_RUN && !OUT_DIR) {
  process.stderr.write("--out is required unless --dry-run\n");
  process.exit(2);
}

/** The miner's bounds, restated here rather than imported: see the header. */
const MAX_ANCHOR_HITS = 8;
const MAX_ANCHOR_DENSITY = 0.05;
const MIN_CLAIM_CHARS = 40;
const MAX_CLAIM_CHARS = 260;
const MIN_VERIFIED_FACTS = 3;
const IDENT_CHAR = /[\w$]/;
const CITATION = /(?<![\w.@-])(\/?(?:[\w.@-]+\/)+[\w.-]+\.[A-Za-z][\w]*)(?::(\d+))?\b/g;

/** Whole-token containment — `STORE` must not match inside `RESTORE`. */
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
const matches = (line, term, kind) =>
  kind === "symbol" ? hasIdentifier(line, term) : line.replace(/\s+/g, " ").includes(term);

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
 * The excluded suite's exclusion metadata — root, session, anchor files. Byte
 * for byte the parse `mine-explore-tasks.mjs` uses, and for the same reason: a
 * training suite whose author read the eval suite's questions is not disjoint
 * from it in the way that matters, so nothing else is read.
 */
function excludedSuite(dir) {
  const out = { dir, sessions: new Set(), subjects: [], files: [] };
  const names = readdirSync(dir).filter((n) => /^\d+\.md$/.test(n));
  if (!names.length) throw new Error(`--exclude-tasks: no task files in ${dir}`);
  for (const name of names.sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
    const text = readFileSync(join(dir, name), "utf-8");
    const root = /^\| Task root \(the mikro arm's `--dir`\) \| `([^`]+)` \|$/m.exec(text)?.[1];
    const session = /^\| Session \| `([^`]+)` \|$/m.exec(text)?.[1];
    if (!root || !session) throw new Error(`--exclude-tasks: ${name} has no root/session row`);
    const anchorFiles = new Set();
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

/** Containment against the smaller checklist — the miner's formula, unchanged. */
function strongestSubjectOverlap(root, anchorFiles) {
  if (!excluded || !anchorFiles.size) return null;
  let strongest = null;
  for (const other of excluded.subjects) {
    if (other.root !== root) continue;
    const shared = [...anchorFiles].filter((f) => other.anchorFiles.has(f));
    const overlap = shared.length / Math.min(anchorFiles.size, other.anchorFiles.size || 1);
    if (!strongest || overlap > strongest.overlap) {
      strongest = { task: other.file, root, overlap: Number(overlap.toFixed(2)), shared };
    }
  }
  return strongest;
}

// ── verification ──────────────────────────────────────────────────────────

const problems = [];
function reject(taskId, message) {
  problems.push(`${taskId}: ${message}`);
}

function verifyFact(taskId, root, fact, index) {
  const id = `${taskId} F${index + 1}`;
  const { claim, anchor, term } = fact;
  const kind = fact.kind === "quote" ? "quote" : "symbol";
  const m = /^(.*):(\d+)$/.exec(anchor ?? "");
  if (!m) return reject(id, `anchor ${JSON.stringify(anchor)} is not path:line`);
  const [, relPath, lineRaw] = m;
  const lineNo = Number(lineRaw);
  if (isAbsolute(relPath)) return reject(id, `anchor ${anchor} must be relative to the task root`);
  const abs = join(root, relPath);
  const lines = linesOf(abs);
  if (!lines) return reject(id, `${relPath} is not readable under ${root}`);
  if (lineNo < 1 || lineNo > lines.length) {
    return reject(id, `${anchor} is out of range — the file has ${lines.length} lines`);
  }
  const text = lines[lineNo - 1].trim();
  // The checklist renders the line inside backticks and `verify-native.mjs`
  // reads it back with a non-greedy match to the first backtick: a line
  // carrying one would truncate its own evidence.
  if (text.includes("`")) return reject(id, `${anchor} carries a backtick; pick a line that does not`);
  if (!text) return reject(id, `${anchor} is blank — a blank line anchors nothing`);
  if (!term) return reject(id, "no term: a fact must name what links its claim to its line");
  if (!matches(text, term, kind)) {
    return reject(id, `${anchor} does not carry ${kind} \`${term}\` — the line is ${JSON.stringify(text)}`);
  }
  if (!claim.includes(term)) {
    return reject(id, `the claim does not contain \`${term}\`, so the link to the line is not visible`);
  }
  if (claim.length < MIN_CLAIM_CHARS) return reject(id, `claim is ${claim.length} chars, under ${MIN_CLAIM_CHARS}`);
  if (claim.length > MAX_CLAIM_CHARS) return reject(id, `claim is ${claim.length} chars, over ${MAX_CLAIM_CHARS}`);

  const cap = Math.max(2, Math.min(MAX_ANCHOR_HITS, Math.round(lines.length * MAX_ANCHOR_DENSITY)));
  let hits = 0;
  for (const line of lines) if (matches(line, term, kind)) hits += 1;
  if (hits > cap) {
    return reject(id, `\`${term}\` is on ${hits} lines of ${relPath} (cap ${cap}) — too common to anchor a line`);
  }
  return {
    anchor: `${relPath}:${lineNo}`,
    claim,
    kind,
    term,
    hits,
    evidence: text,
    matched: `${kind === "quote" ? "quoted" : "symbol"} \`${term}\` — ${hits} line${hits === 1 ? "" : "s"} in this file`,
  };
}

/** Criteria 2 and 3 against the reference answer, exactly as the miner does. */
function verifyAnswerCitations(taskId, root, answer) {
  const cited = new Set();
  const failures = [];
  for (const [, relPath, lineRaw] of answer.matchAll(CITATION)) {
    const abs = isAbsolute(relPath) ? relPath : join(root, relPath);
    let lines = null;
    try {
      lines = statSync(abs).isFile() ? linesOf(abs) : null;
    } catch {
      lines = null;
    }
    if (!lines) {
      failures.push(`${relPath}${lineRaw ? `:${lineRaw}` : ""} — no such file under the task root`);
      continue;
    }
    if (!lineRaw) continue;
    if (Number(lineRaw) < 1 || Number(lineRaw) > lines.length) {
      failures.push(`${relPath}:${lineRaw} — the file has ${lines.length} lines`);
      continue;
    }
    cited.add(`${relPath}:${lineRaw}`);
  }
  for (const f of failures) reject(taskId, `reference answer fails criterion 2/3: ${f}`);
  return cited;
}

// ── rendering ─────────────────────────────────────────────────────────────

/**
 * The frozen suite's layout, so the same tools read both: `verify-native.mjs`
 * finds the root row and the checklist, `score-task.mjs` finds the root, the
 * checklist and the `states at least **N of the M**` sentence, `run-task.mjs`
 * finds the fenced question. The two honest differences — an authored question
 * heading and no native-arm section — are the two places it deliberately
 * diverges, and both are called out in the file itself.
 */
function renderTask(task, n, meta) {
  const factCount = task.facts.length;
  const required = Math.ceil(factCount * 0.9);
  const misses = factCount - required;
  const lines = [
    `# Task ${n} — ${task.title}`,
    "",
    "| Field | Value |",
    "|-------|-------|",
    `| Task root (the mikro arm's \`--dir\`) | \`${task.root}\` |`,
    `| Provenance | **authored for the training suite** — not mined from a transcript |`,
    `| Session | \`authored-${task.slug}\` |`,
    `| Authored | ${meta.authoredAt} by ${meta.authoredBy} |`,
    `| Verified against | \`${task.rootGit ?? "not a git tree"}\` |`,
    `| Required facts | ${factCount} (pass needs ${required}) |`,
    `| Anchor-file overlap with the eval suite | ${
      task.overlap
        ? `${Math.round(task.overlap.overlap * 100)}% (strongest, vs \`${task.overlap.task}\`; bar is ${Math.round(
            SUBJECT_OVERLAP * 100
          )}%)`
        : "no eval task shares this root"
    } |`,
    `| Optimizer fitness set | ${
      task.fitness
        ? "**included** — the optimizer may select on this task"
        : `**HELD OUT** — never select on this task. ${task.fitnessNote ?? "no reason recorded"}`
    } |`,
    "",
    "## Why this task is authored, and what that costs",
    "",
    "The frozen eval suite is mined from real sessions, which is what makes its",
    "ground truth a real answer somebody needed. This host's corpus yields **no**",
    "further explore-class candidate once the sittings the eval suite came from",
    "are excluded, so every task in the training suite is written rather than",
    "mined. Two things follow, and neither is hidden:",
    "",
    "- **The question was written for this suite**, not lifted from a transcript.",
    "- **There is no native arm.** A mined task's ground truth is a real session's",
    "  answer, so native passes criterion 1 by construction and the gate is harder",
    "  for `mikro` — the disclosed D6/P3 asymmetry. This task has no such session:",
    "  it carries no native baseline and no native token accounting, and",
    "  `score-task.mjs --native` does not run against it. **It is a training",
    "  input, never a gate input.**",
    "",
    "What is *not* different: every required fact below was verified against the",
    "tree by `scripts/author-explore-tasks.mjs` under a bar stricter than the",
    "miner's — the term must sit on the anchor line itself, with no slack and no",
    "re-anchoring — and the rubric is the frozen one.",
    "",
    "## Question (authored for the training suite)",
    "",
    "```text",
    task.question,
    "```",
    "",
    "## Reference answer (authored, and the source of the checklist)",
    "",
    "```text",
    task.answer,
    "```",
    "",
    "## Required facts (repo-verified — the rubric scores against these)",
    "",
    "Every fact below is a `path:line` claim the reference answer makes about",
    `\`${task.root}\`, re-checked against that tree at authoring time. Each names the`,
    "term that links the claim to the line — an identifier the claim itself uses or",
    "a fragment it quotes — and that term is on the cited line, and is rare enough",
    "in the file to point at it (at most 8 occurrences, or 5% of the file,",
    "whichever is smaller). `exact` is the only kind an authored fact can have: a",
    "fact written against the tree as it stands has nothing to re-anchor from.",
    "",
  ];

  task.facts.forEach((fact, i) => {
    lines.push(`- [ ] **F${i + 1}** (exact) \`${fact.anchor}\``);
    lines.push(`  - claim: ${fact.claim}`);
    lines.push(`  - anchored on: ${fact.matched}`);
    lines.push(`  - verified: \`${fact.evidence}\``);
  });
  lines.push("");

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
    "   fails the task.",
    "3. **No fabrication** — no invented path, symbol, or line number: a",
    "   `path:line` that names a file the task root does not have is a fabrication,",
    "   and one fails the task regardless of the other two.",
    "",
    "Pass = all three. This is the frozen suite's rubric, unchanged.",
    "",
    "### Baseline (checked at authoring time, not assumed)",
    "",
    `- Criterion 1: ${factCount}/${factCount} for the reference answer — the checklist is lifted`,
    "  from it, and every anchor below is cited in it (enforced, not assumed).",
    `- Criterion 2: ${task.citedInRoot} \`path:line\` citation(s) in the reference answer name a`,
    "  file in the task root; all resolve. A task where one did not is not written.",
    "- Criterion 3: no `path:line` in the reference answer names a file the task",
    "  root does not have — same rejection rule.",
    "",
    "## How to run the mikro arm",
    "",
    "```bash",
    `mikro mcp --dir ${task.root}   # then call mikro_explore with the question above`,
    "```",
    "",
    "Authored by `scripts/author-explore-tasks.mjs`; every fact machine-verified",
    "against the tree at the revision in the header.",
    ""
  );
  return lines.join("\n");
}

// ── main ──────────────────────────────────────────────────────────────────

/**
 * The revision each task was verified at. An authored fact is a claim about a
 * tree at a moment; without the revision, "verified" has no referent, and the
 * next person to run `verify-native.mjs --dir` cannot tell a drifted anchor from
 * a wrong one.
 */
function headOf(root) {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const spec = JSON.parse(readFileSync(resolve(SPEC), "utf-8"));
const authoredAt = new Date().toISOString().slice(0, 19) + "Z";
const startAt = Number(spec.startAt ?? 1);
const prepared = [];

for (const [i, raw] of (spec.tasks ?? []).entries()) {
  const taskId = raw.slug ?? `task-${i + 1}`;
  if (!raw.root || !existsSync(raw.root)) {
    reject(taskId, `task root ${raw.root} does not exist`);
    continue;
  }
  const root = raw.root.replace(/\/+$/, "");
  const facts = [];
  for (const [j, fact] of (raw.facts ?? []).entries()) {
    const verified = verifyFact(taskId, root, fact, j);
    if (verified) facts.push(verified);
  }
  if (facts.length < MIN_VERIFIED_FACTS) {
    reject(taskId, `${facts.length} verified fact(s), under the ${MIN_VERIFIED_FACTS} floor`);
  }
  const cited = verifyAnswerCitations(taskId, root, raw.answer ?? "");
  for (const fact of facts) {
    if (!cited.has(fact.anchor)) {
      reject(taskId, `F${facts.indexOf(fact) + 1} anchors \`${fact.anchor}\`, which the reference answer never cites`);
    }
  }
  const anchorFiles = new Set(facts.map((f) => f.anchor.replace(/:\d+$/, "")));
  const overlap = strongestSubjectOverlap(root, anchorFiles);
  if (overlap && overlap.overlap >= SUBJECT_OVERLAP) {
    reject(
      taskId,
      `subject clash: ${Math.round(overlap.overlap * 100)}% of its anchor files are also ` +
        `anchor files of eval task ${overlap.task} in the same root (${overlap.shared.join(", ")})`
    );
    continue;
  }
  // Default true: a task is a fitness-set member unless the spec deliberately
  // holds it out. A held-out task must say why — an unexplained exclusion is
  // indistinguishable from a mistake.
  const fitness = raw.fitness !== false;
  if (!fitness && !raw.fitnessNote) {
    reject(taskId, "fitness: false requires a fitnessNote saying why the task is held out");
  }
  prepared.push({
    root,
    slug: raw.slug,
    title: raw.title ?? raw.question.split("\n")[0].slice(0, 90),
    question: raw.question,
    answer: raw.answer,
    facts,
    overlap,
    fitness,
    fitnessNote: raw.fitnessNote ?? null,
    anchorFiles: [...anchorFiles],
    citedInRoot: cited.size,
    rootGit: headOf(root),
  });
}

if (problems.length) {
  process.stderr.write(`# author-explore-tasks: ${problems.length} problem(s), nothing written\n`);
  for (const p of problems) process.stderr.write(`#   ✗ ${p}\n`);
  process.exit(1);
}

process.stdout.write(
  `# author-explore-tasks: ${prepared.length} task(s) verified, ` +
    `${prepared.reduce((n, t) => n + t.facts.length, 0)} fact(s), ` +
    `${new Set(prepared.map((t) => t.root)).size} root(s), ` +
    `${prepared.filter((t) => t.fitness).length} in the fitness set, ` +
    `${prepared.filter((t) => !t.fitness).length} held out\n`
);
for (const [i, task] of prepared.entries()) {
  process.stdout.write(
    `#  ${startAt + i}. ${task.facts.length} facts · ${task.root.replace(process.env.HOME ?? "~", "~")} · ` +
      `overlap ${task.overlap ? `${Math.round(task.overlap.overlap * 100)}% vs ${task.overlap.task}` : "n/a (no shared root)"} · ` +
      `${task.fitness ? "fitness" : "HELD OUT"} · ${task.title.slice(0, 60)}\n`
  );
}

if (DRY_RUN) {
  process.stdout.write("# author-explore-tasks: --dry-run, nothing written\n");
  process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });
const meta = { authoredAt, authoredBy: spec.authoredBy ?? "unattributed" };
prepared.forEach((task, i) => {
  writeFileSync(join(OUT_DIR, `${startAt + i}.md`), renderTask(task, startAt + i, meta), "utf-8");
});

writeFileSync(
  join(OUT_DIR, RUN_JSON),
  `${JSON.stringify(
    {
      authoredAt,
      authoredBy: meta.authoredBy,
      argv: args,
      spec: resolve(SPEC),
      written: prepared.length,
      startAt,
      strictness:
        "term on the anchor line itself (no ±3 slack, no re-anchoring), term in the claim, " +
        `≤${MAX_ANCHOR_HITS} occurrences or ${MAX_ANCHOR_DENSITY * 100}% of the file, ` +
        `claim ${MIN_CLAIM_CHARS}..${MAX_CLAIM_CHARS} chars, every anchor cited in the reference answer, ` +
        "reference answer passes criteria 2 and 3",
      disjointFrom: {
        excludeTasksDir: excluded ? excluded.dir : null,
        excludedTaskFiles: excluded ? excluded.files : [],
        subjectTest:
          `an authored task is refused when ≥${SUBJECT_OVERLAP * 100}% of the files its facts ` +
          "anchor on are also anchor files of an excluded task in the same root",
        measured: prepared.map((task, i) => ({
          file: `${startAt + i}.md`,
          root: task.root,
          anchorFiles: task.anchorFiles.length,
          strongestOverlapWith: task.overlap?.task ?? null,
          anchorFileOverlap: task.overlap?.overlap ?? null,
          sharedFiles: task.overlap?.shared ?? [],
          note: task.overlap ? null : "no eval task shares this root, so the subject test cannot clash",
        })),
      },
      /**
       * The optimizer's selection contract, machine-readable so a harness does
       * not have to trust a README. `heldOut` tasks are verified and runnable —
       * they are excluded from *selection*, not from the suite.
       */
      fitnessSet: {
        included: prepared.map((t, i) => (t.fitness ? `${startAt + i}.md` : null)).filter(Boolean),
        heldOut: prepared
          .map((t, i) => (t.fitness ? null : { file: `${startAt + i}.md`, reason: t.fitnessNote }))
          .filter(Boolean),
        contract:
          "an optimizer may compute fitness only over `included`; `heldOut` tasks are diagnostics " +
          "and scoring them is reporting, never selection",
      },
      tasks: prepared.map((task, i) => ({
        file: `${startAt + i}.md`,
        root: task.root,
        rootGit: task.rootGit,
        session: `authored-${task.slug}`,
        requiredFacts: task.facts.length,
        factsToPass: Math.ceil(task.facts.length * 0.9),
        inRootCitations: task.citedInRoot,
        anchorFiles: task.anchorFiles,
        fitness: task.fitness,
        fitnessNote: task.fitnessNote,
      })),
    },
    null,
    2
  )}\n`,
  "utf-8"
);

process.stdout.write(
  `# author-explore-tasks: wrote ${prepared.length} task file(s) and ${RUN_JSON} to ${OUT_DIR}\n`
);
