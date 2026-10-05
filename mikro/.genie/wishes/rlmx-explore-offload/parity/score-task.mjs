#!/usr/bin/env node
/**
 * score-task.mjs — mechanical half of the fixed rubric, applied identically to
 * both arms (decision 6).
 *
 * Criterion 2 (citations resolve) and criterion 3 (no fabrication) are decided
 * here, by opening the files: a `path:line` naming a file under the task root
 * must resolve to a real line there; one naming a file that neither the task
 * root nor a listed out-of-scope tree has is a fabrication.
 *
 * Criterion 1 (required facts) is a claim-level judgement — "the answer makes
 * the same claim; wording may differ, the anchor may not" — so this script only
 * prepares it: for every checklist fact it reports whether the answer names the
 * anchor file and whether it carries the term the fact was anchored on. The
 * scorer reads those signals plus the answer and decides.
 *
 *   node score-task.mjs <runJsonPath|--native> <taskNumber> [--tasks-dir <dir>] [--root <dir>]
 *
 * `--tasks-dir` defaults to the frozen eval suite, `<wish>/tasks`, so behaviour
 * without the flag is unchanged. **Nothing about the rubric or the conventions
 * moves with it** — this argument only says which task file the checklist and
 * root are read from.
 *
 * It was added with the guard below rather than on its own. `run-task.mjs` grew
 * a `--tasks-dir` so round 2's training suite could be driven at all; the
 * moment that existed, a training run could be handed to a scorer that reads
 * `<wish>/tasks/<n>.md` unconditionally, and would then be scored against the
 * *frozen eval task of the same number* — a wrong number that looks exactly
 * like a right one. So a run JSON that records its own `tasksDir` must agree
 * with the directory being scored, and the scorer refuses when it does not.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wishDir = resolve(__dirname, "..");

const argv = process.argv.slice(2);
const tdAt = argv.indexOf("--tasks-dir");
const tasksDirArg = tdAt >= 0 ? argv[tdAt + 1] : null;
if (tdAt >= 0) {
  if (!tasksDirArg) {
    console.error("--tasks-dir requires a directory");
    process.exit(2);
  }
  argv.splice(tdAt, 2);
}
// Gate extension (wish rlmx-v2-prime-backend, Group 3): score citations
// against a re-pointed task root. The task file still supplies the frozen
// root for the record; criterion 2/3 resolution, the basename index, and the
// in-root checks all use the override (the tree the run actually read).
const rAt = argv.indexOf("--root");
const rootArg = rAt >= 0 ? argv[rAt + 1] : null;
if (rAt >= 0) {
  if (!rootArg) {
    console.error("--root requires a directory");
    process.exit(2);
  }
  argv.splice(rAt, 2);
}
const [source, taskArg] = argv;
if (!source || !taskArg) {
  console.error("usage: score-task.mjs <runJsonPath|--native> <taskNumber> [--tasks-dir <dir>] [--root <dir>]");
  process.exit(2);
}

const tasksDir = tasksDirArg ? resolve(tasksDirArg) : join(wishDir, "tasks");
const taskFile = join(tasksDir, `${taskArg}.md`);
if (!existsSync(taskFile)) {
  console.error(`task ${taskArg}: no such file ${taskFile}`);
  process.exit(2);
}

/**
 * A run records the suite it came from; refuse to score it against another.
 * Silently scoring a training run against the frozen eval task of the same
 * number produces a plausible-looking number for a comparison nobody made.
 * Runs recorded before `run-task.mjs` carried `tasksDir` have no such field and
 * are scored as before.
 */
if (source !== "--native") {
  const runPath = isAbsolute(source) ? source : resolve(source);
  if (existsSync(runPath)) {
    const recorded = JSON.parse(readFileSync(runPath, "utf-8"))?.tasksDir;
    if (recorded && resolve(recorded) !== tasksDir) {
      console.error(
        `suite mismatch: ${runPath}\n` +
          `  the run was produced from ${recorded}\n` +
          `  but this scorer was pointed at ${tasksDir}\n` +
          `  pass --tasks-dir ${recorded} — scoring a run against another suite's task file is a wrong number, not a comparison.`
      );
      process.exit(2);
    }
  }
}

const taskText = readFileSync(taskFile, "utf-8");
const rootFrozen = /\| Task root \(the rlmx arm's `--dir`\) \| `([^`]+)` \|/.exec(taskText)[1];
// Gate extension: re-pointed root (see the --root flag above). Unset, the
// frozen root is used — unchanged behavior for every pre-existing run.
const root = rootArg ? resolve(rootArg) : rootFrozen;

/** Out-of-scope trees: listed under "## Scope: trees outside the rubric". */
const scopeSection = /## Scope: trees outside the rubric\n([\s\S]*?)\n## /.exec(taskText)?.[1] ?? "";
const outOfScope = [...scopeSection.matchAll(/^- `([^`]+)`$/gm)]
  .map((m) => m[1])
  .map((s) => s.replace(/:\d.*$/, ""))
  .filter((s) => s.startsWith("/"));

/** Checklist facts. */
const facts = [];
const factRe =
  /^- \[ \] \*\*(F\d+)\*\* \((exact|re-anchored)\) `([^`]+)`([^\n]*)\n((?:  [^\n]*\n)+)/gm;
let fm;
while ((fm = factRe.exec(taskText))) {
  const body = fm[5];
  const anchoredOn = /anchored on: (?:quoted|symbol) `([\s\S]*?)` —/.exec(body)?.[1] ?? "";
  const verified = /verified: `([\s\S]*?)`\n/.exec(body)?.[1] ?? "";
  const claim = /claim: ([\s\S]*?)\n  - anchored on/.exec(body)?.[1] ?? "";
  const extraAnchors = [...(fm[4] ?? "").matchAll(/`([^`]+)`/g)].map((x) => x[1]);
  facts.push({
    id: fm[1],
    kind: fm[2],
    anchor: fm[3],
    extraAnchors,
    anchoredOn: anchoredOn.replace(/…$/, ""),
    verified,
    claim: claim.trim(),
  });
}
const need = Number(/states at least \*\*(\d+) of the (\d+)\*\*/.exec(taskText)[1]);

/** The answer under test. */
let answer;
let meta = {};
if (source === "--native") {
  /**
   * Fence-aware extraction. The native traces embed their own ```…``` code
   * blocks, so a non-greedy `([\s\S]*?)\n``` ` stops at the first *nested*
   * closing fence and scores a fraction of the trace (tasks 2/3/4 lost 3.0k,
   * 3.3k and 3.3k characters that way — an undisclosed asymmetry favouring the
   * native arm, since less text means fewer citations that can fail). The
   * trace block is delimited by the section heading on one side and the
   * `## Required facts` heading on the other, so bind to both.
   */
  const OPEN = "## Native answer trace (verbatim, the ground-truth arm)\n\n```text\n";
  const CLOSE = "\n```\n\n## Required facts";
  const from = taskText.indexOf(OPEN);
  const to = from < 0 ? -1 : taskText.indexOf(CLOSE, from + OPEN.length);
  if (from < 0 || to < 0) {
    console.error(`task ${taskArg}: native answer trace block not found`);
    process.exit(2);
  }
  answer = taskText.slice(from + OPEN.length, to);
  meta = { arm: "native", task: Number(taskArg) };
} else {
  const rec = JSON.parse(readFileSync(source, "utf-8"));
  answer = rec.answer ?? "";
  meta = {
    arm: "rlmx",
    task: rec.task,
    model: rec.model,
    round: rec.round,
    footer: rec.footer,
    wallSeconds: rec.wallSeconds,
    requestChars: rec.requestChars,
    resultChars: rec.resultChars,
    ok: rec.ok,
  };
}

/**
 * Citations: `path.ext:` followed by a numeric group (`61`, `61-115`,
 * `43,52,91`). Absolute paths included — the native answers use them.
 */
// The extension is 2+ letters on purpose: it keeps `10.10.10.x:3000` (a host
// and port, not a citation) and bare prose out of the citation set.
const CITATION = /(?<![\w.\-])(\/?(?:[\w.\-]+\/)+[\w.\-]+\.[A-Za-z][\w]+|[\w.\-]+\.[A-Za-z][\w]+):(\d+(?:\s*[-,]\s*\d+)*)/g;

function fileLines(abs) {
  try {
    if (!statSync(abs).isFile()) return null;
    return readFileSync(abs, "utf-8").split("\n").length;
  } catch {
    return null;
  }
}

const citations = [];
const seen = new Set();
for (const m of answer.matchAll(CITATION)) {
  const path = m[1];
  const nums = m[2].split(/[-,]/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  for (const line of nums) {
    const key = `${path}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({ path, line, key });
  }
}

/**
 * Shorthand back-references. Both arms write `embedding.ts:28` once
 * `src/lib/embedding.ts` has been named in the same answer — a bare basename
 * is a reference to a path the answer already gave, not a claim that the file
 * sits at the repo root. So a bare basename is resolved against the directory
 * of every directory-qualified path the answer itself mentions (plus the root),
 * and only counts as a fabrication when no directory the answer supplies — and
 * no file anywhere in the tree — has it. Applied identically to both arms.
 */
const mentionedDirs = new Set([""]);
for (const m of answer.matchAll(/(?<![\w.\-])(\/?(?:[\w.\-]+\/)+)[\w.\-]+\.[A-Za-z][\w]*/g)) {
  mentionedDirs.add(m[1]);
}

/**
 * Tree-wide index, built lazily — only shorthand citations need it.
 *
 * `SUFFIX_SHORTHAND=1` additionally resolves a *partial path* (`bench/api.ts`
 * for the real `src/bench/api.ts`) the same way a bare basename is already
 * resolved. Both readings are reported; see the report's Scoring conventions.
 */
const SUFFIX_SHORTHAND = process.env.SUFFIX_SHORTHAND === "1";
let basenameIndex = null;
let allFiles = null;
function findBySuffix(rel) {
  findByBasename(rel.split("/").pop());
  const needle = `/${rel}`;
  return allFiles.filter((p) => p.endsWith(needle));
}
function findByBasename(base) {
  if (!basenameIndex) {
    basenameIndex = new Map();
    allFiles = [];
    const stack = [root];
    const SKIP = new Set([
      ".git", "node_modules", "dist", "build", "target", ".venv", "__pycache__",
      "coverage", "vendor", ".next", ".cache",
    ]);
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP.has(e.name)) stack.push(p);
        } else if (e.isFile()) {
          const list = basenameIndex.get(e.name) ?? [];
          list.push(p);
          basenameIndex.set(e.name, list);
          allFiles.push(p);
        }
      }
    }
  }
  return basenameIndex.get(base) ?? [];
}

for (const c of citations) {
  const bare = !c.path.includes("/");
  const absDirect = isAbsolute(c.path) ? c.path : join(root, c.path);

  // A citation into a listed out-of-scope tree is not scored on either arm.
  if (outOfScope.some((t) => absDirect === t || absDirect.startsWith(t + "/"))) {
    c.verdict = "out-of-scope";
    continue;
  }

  /** Candidate absolute paths this citation could name. */
  const candidates = [];
  if (bare) {
    for (const d of mentionedDirs) {
      const p = d.startsWith("/") ? join(d, c.path) : join(root, d, c.path);
      if (!candidates.includes(p)) candidates.push(p);
    }
  } else {
    candidates.push(absDirect);
  }

  let hit = null;
  let existsSomewhere = null;
  for (const p of candidates) {
    const lines = fileLines(p);
    if (lines === null) continue;
    existsSomewhere = existsSomewhere ?? { p, lines };
    if (c.line >= 1 && c.line <= lines) {
      hit = { p, lines };
      break;
    }
  }
  if (!hit && !existsSomewhere && (bare || (SUFFIX_SHORTHAND && !isAbsolute(c.path)))) {
    // Last resort for shorthand: is that file anywhere in the tree?
    const found = bare ? findByBasename(c.path) : findBySuffix(c.path);
    for (const p of found) {
      const lines = fileLines(p);
      if (lines === null) continue;
      existsSomewhere = existsSomewhere ?? { p, lines };
      if (c.line >= 1 && c.line <= lines) {
        hit = { p, lines };
        break;
      }
    }
  }

  if (hit) {
    const inRoot = hit.p === root || hit.p.startsWith(root + "/");
    c.resolvedAs = hit.p;
    c.lines = hit.lines;
    c.verdict = inRoot ? "resolves" : "resolves-outside-root";
    c.text = readFileSync(hit.p, "utf-8").split("\n")[c.line - 1].trim().slice(0, 120);
  } else if (existsSomewhere) {
    c.resolvedAs = existsSomewhere.p;
    c.lines = existsSomewhere.lines;
    c.verdict = "line-out-of-range";
  } else {
    const inRoot = absDirect === root || absDirect.startsWith(root + "/") || bare;
    c.exists = false;
    c.verdict = inRoot ? "missing-file" : "outside-root-missing";
  }
}

const inRootCites = citations.filter(
  (c) => c.verdict === "resolves" || c.verdict === "missing-file" || c.verdict === "line-out-of-range"
);
const criterion2Failures = citations.filter(
  (c) => c.verdict === "line-out-of-range" || c.verdict === "missing-file"
);
// Criterion 3: a path:line naming a file neither the task root nor a listed
// tree has. `missing-file` (named under the root, absent) is exactly that;
// `outside-root-missing` names a path that is in no listed tree either.
const criterion3Failures = citations.filter(
  (c) => c.verdict === "missing-file" || c.verdict === "outside-root-missing"
);

/** Criterion 1 signals per fact — judged, not decided, by this script. */
const lower = answer.toLowerCase();
function mentionsPath(p) {
  const bare = p.replace(/:\d+.*$/, "");
  const base = bare.split("/").pop();
  return {
    fullPath: lower.includes(bare.toLowerCase()),
    basename: lower.includes(base.toLowerCase()),
  };
}
const factSignals = facts.map((f) => {
  const anchors = [f.anchor, ...f.extraAnchors];
  const pathHits = anchors.map((a) => ({ anchor: a, ...mentionsPath(a) }));
  const term = f.anchoredOn.replace(/\s+/g, " ").trim();
  const termCore = term.split(/[\s,]+/).filter((t) => t.length > 4);
  const termHit = term.length > 0 && lower.includes(term.toLowerCase());
  const partialTermHits = termCore.filter((t) => lower.includes(t.toLowerCase()));
  return {
    id: f.id,
    anchor: f.anchor,
    anchoredOn: term,
    claim: f.claim.slice(0, 160),
    namesAnchorPath: pathHits.some((p) => p.fullPath),
    namesBasename: pathHits.some((p) => p.basename),
    termHit,
    partialTermHits,
  };
});

const report = {
  ...meta,
  root,
  // Gate extension: the frozen root the task file names, so a re-pointed
  // score is traceable back to the frozen artifact.
  rootFrozen,
  rootOverride: rootArg ?? null,
  outOfScope,
  need,
  factTotal: facts.length,
  answerChars: answer.length,
  citations,
  criterion2: {
    scoredCitations: inRootCites.length,
    failures: criterion2Failures.map((c) => `${c.key} (${c.verdict})`),
    pass: criterion2Failures.length === 0,
  },
  criterion3: {
    failures: criterion3Failures.map((c) => `${c.key} (${c.verdict})`),
    pass: criterion3Failures.length === 0,
  },
  factSignals,
};

const outPath = source === "--native"
  ? join(__dirname, "runs", "native", `task-${taskArg}.score.json`)
  : source.replace(/\.json$/, ".score.json");
try {
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8");
} catch {
  // native dir may not exist yet
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8");
}

console.log(
  JSON.stringify(
    {
      task: report.task,
      arm: report.arm,
      model: report.model,
      answerChars: report.answerChars,
      citations: citations.length,
      c2: report.criterion2.pass ? "PASS" : `FAIL ${report.criterion2.failures.join("; ")}`,
      c3: report.criterion3.pass ? "PASS" : `FAIL ${report.criterion3.failures.join("; ")}`,
      factsNeed: `${need}/${facts.length}`,
      factTermHits: factSignals.filter((f) => f.termHit).length,
      factPathHits: factSignals.filter((f) => f.namesAnchorPath).length,
      out: outPath,
    },
    null,
    2
  )
);
if (!existsSync(outPath)) process.exit(1);
