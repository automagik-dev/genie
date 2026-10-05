#!/usr/bin/env node
/**
 * summarize-train-round.mjs — turn one generation's run+score records into a
 * per-task found/needed table with the misses named, machine-readably.
 *
 *   node summarize-train-round.mjs <genDir>        # or: --gen <N>
 *   node summarize-train-round.mjs --gen 0 --json  # the JSON only, to stdout
 *
 * Writes `summary.json` and `summary.txt` into the generation directory and
 * prints the text form. Every line is a fixed-field record:
 *
 *   TASK <n> ok=<bool> facts=<found>/<need> weak=<k> c2=PASS|FAIL c3=PASS|FAIL …
 *     MISS <Fid> <anchor> — <one-line why>
 *     WEAK <Fid> <anchor> — <one-line why>
 *   ROUND gen=<N> facts=<found>/<need> …
 *
 * ── The fact decision here is a PROXY, and the rubric's is not ─────────────
 *
 * Criterion 1 of the frozen rubric is a claim-level judgement — *"the answer
 * makes the same claim; wording may differ, the anchor may not"* — and
 * `score-task.mjs` deliberately refuses to decide it, emitting signals for a
 * scorer to read (see its header). Nothing here weakens that: this script
 * consumes those signals unchanged and applies one **stated, mechanical** rule
 * on top, because an optimizer loop needs a number per generation and a human
 * judgement per generation is not a loop.
 *
 *   HIT  = the answer names the fact's anchor *path* AND contains the term the
 *          fact was anchored on (`namesAnchorPath && termHit`).
 *   WEAK = names the path, misses the exact term, but carries at least half of
 *          the term's long tokens. Reported, and **not** counted as found.
 *   MISS = everything else.
 *
 * This is strictly *harsher* than criterion 1 (a correct claim in other words,
 * citing another line of the same file, scores MISS here), and it is blind to
 * whether the claim is actually right (an answer that names the path and the
 * term while saying the opposite scores HIT). So:
 *
 *   **`facts=` is a training signal for comparing two prompts on the same
 *   tasks. It is not a parity number and it is not criterion 1.** A gate number
 *   comes from the frozen suite, scored by a reader, and from nowhere else.
 *
 * Criteria 2 (citations resolve) and 3 (no fabrication) are reported verbatim
 * from `score-task.mjs`, which does decide them mechanically and completely.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const round2 = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const jsonOnly = argv.includes("--json");
const genAt = argv.indexOf("--gen");
let genDir = null;
if (genAt >= 0) {
  const n = argv[genAt + 1];
  if (!n || !/^\d+$/.test(n)) {
    console.error("--gen requires a generation number");
    process.exit(2);
  }
  genDir = join(round2, "optimizer", "gens", `gen-${n}`);
} else {
  const positional = argv.find((a) => !a.startsWith("--"));
  if (!positional) {
    console.error("usage: summarize-train-round.mjs <genDir> | --gen <N> [--json]");
    process.exit(2);
  }
  genDir = resolve(positional);
}
if (!existsSync(genDir)) {
  console.error(`no such generation directory: ${genDir}`);
  process.exit(2);
}

const roundPath = join(genDir, "round.json");
const round = existsSync(roundPath) ? JSON.parse(readFileSync(roundPath, "utf-8")) : null;
const runsDir = join(genDir, "runs");
const tasks = round?.tasks ?? [];
if (!tasks.length) {
  console.error(`${roundPath}: no tasks recorded — nothing to summarize`);
  process.exit(2);
}

const num = (s) => (s === undefined || s === null ? null : Number(String(s).replace(/,/g, "")));

/** The mechanical fact rule. Stated in the header; implemented once, here. */
function classify(sig) {
  const termCore = String(sig.anchoredOn ?? "")
    .split(/[\s,]+/)
    .filter((t) => t.length > 4);
  const partial = sig.partialTermHits?.length ?? 0;
  if (sig.namesAnchorPath && sig.termHit) return { verdict: "HIT", why: null };
  if (sig.namesAnchorPath && termCore.length && partial >= Math.ceil(termCore.length / 2)) {
    return {
      verdict: "WEAK",
      why: `names the path but not the exact term \`${sig.anchoredOn}\` (${partial}/${termCore.length} of its long tokens present)`,
    };
  }
  if (!sig.namesBasename) {
    return { verdict: "MISS", why: `answer never names ${sig.anchor.replace(/:\d+$/, "").split("/").pop()}` };
  }
  if (!sig.namesAnchorPath) {
    return { verdict: "MISS", why: `names the basename only, never the path ${sig.anchor.replace(/:\d+$/, "")}` };
  }
  return {
    verdict: "MISS",
    why: `names the path but not the anchoring term \`${sig.anchoredOn}\`${termCore.length ? ` (${partial}/${termCore.length} long tokens)` : ""}`,
  };
}

const rows = [];
for (const n of tasks) {
  const runPath = join(runsDir, `task-${n}.json`);
  const scorePath = join(runsDir, `task-${n}.score.json`);
  const per = round?.perTask?.find((p) => p.task === n) ?? null;
  const row = { task: n, runJson: existsSync(runPath) ? runPath : null, scoreJson: existsSync(scorePath) ? scorePath : null };
  if (!row.scoreJson) {
    row.status = "NOSCORE";
    row.reason = per?.scoreError ?? "no score record";
    row.ok = false;
    row.exitCode = per?.exitCode ?? null;
    rows.push(row);
    continue;
  }
  const s = JSON.parse(readFileSync(scorePath, "utf-8"));
  const run = row.runJson ? JSON.parse(readFileSync(runPath, "utf-8")) : {};
  const footer = s.footer ?? run.footer ?? "";
  const facts = (s.factSignals ?? []).map((sig) => {
    const c = classify(sig);
    const anchorCited = (s.citations ?? []).some((x) => x.key === sig.anchor && x.verdict === "resolves");
    return { id: sig.id, anchor: sig.anchor, anchoredOn: sig.anchoredOn, verdict: c.verdict, why: c.why, anchorCited };
  });
  const found = facts.filter((f) => f.verdict === "HIT").length;
  const weak = facts.filter((f) => f.verdict === "WEAK").length;
  const spawnMsgs = (run.progress ?? []).filter((m) => /recursive spawn/.test(m));
  Object.assign(row, {
    status: "SCORED",
    ok: Boolean(s.ok ?? run.ok),
    root: s.root,
    model: s.model,
    need: s.need,
    factTotal: s.factTotal,
    found,
    weak,
    missed: facts.filter((f) => f.verdict === "MISS").length,
    anchorsCited: facts.filter((f) => f.anchorCited).length,
    c2: s.criterion2?.pass ? "PASS" : "FAIL",
    c2Failures: s.criterion2?.failures ?? [],
    c3: s.criterion3?.pass ? "PASS" : "FAIL",
    c3Failures: s.criterion3?.failures ?? [],
    citations: (s.citations ?? []).length,
    citationsResolved: (s.citations ?? []).filter((c) => c.verdict === "resolves" || c.verdict === "resolves-outside-root" || c.verdict === "out-of-scope").length,
    answerChars: s.answerChars,
    wallSeconds: s.wallSeconds ?? run.wallSeconds ?? null,
    iterations: num(/·\s([\d,]+)\siterations?\s·/.exec(footer)?.[1]),
    tokensIn: num(/·\s([\d,]+)\sin\s\//.exec(footer)?.[1]),
    tokensOut: num(/\/\s([\d,]+)\sout\s·/.exec(footer)?.[1]),
    costUsd: num(/·\s\$([\d.]+)\s·/.exec(footer)?.[1]),
    recursiveSpawns: Math.max(0, ...spawnMsgs.map((m) => num(/·\s(\d+)\srecursive spawn/.exec(m)?.[1]) ?? 0), 0),
    footer,
    facts,
  });
  // The mechanical pass, on the proxy above plus the two decided criteria.
  row.mechanicalPass = row.ok && row.found >= row.need && row.c2 === "PASS" && row.c3 === "PASS";
  rows.push(row);
}

const scored = rows.filter((r) => r.status === "SCORED");
const totals = {
  tasks: rows.length,
  runsOk: rows.filter((r) => r.ok).length,
  scoredTasks: scored.length,
  factsFound: scored.reduce((a, r) => a + r.found, 0),
  factsWeak: scored.reduce((a, r) => a + r.weak, 0),
  factsNeeded: scored.reduce((a, r) => a + r.need, 0),
  tasksMechanicalPass: scored.filter((r) => r.mechanicalPass).length,
  c2Failures: scored.filter((r) => r.c2 === "FAIL").length,
  c3Failures: scored.filter((r) => r.c3 === "FAIL").length,
  citations: scored.reduce((a, r) => a + r.citations, 0),
  citationsResolved: scored.reduce((a, r) => a + r.citationsResolved, 0),
  recursiveSpawns: scored.reduce((a, r) => a + (r.recursiveSpawns ?? 0), 0),
  costUsd: Number(scored.reduce((a, r) => a + (r.costUsd ?? 0), 0).toFixed(4)),
  wallSeconds: round?.wallSeconds ?? null,
};
totals.fitness = totals.factsNeeded ? Number((totals.factsFound / totals.factsNeeded).toFixed(4)) : null;

const summary = {
  gen: round?.gen ?? null,
  label: round?.label ?? null,
  model: round?.model ?? null,
  suite: round?.suite ?? null,
  tasksDir: round?.tasksDir ?? null,
  heldOutNeverRun: round?.heldOutRefused ?? [],
  // Only present on a holdout round, so regenerating any fitness round's
  // summary.json stays byte-identical.
  ...(round?.holdout
    ? {
        holdout: true,
        holdoutTasks: (round.heldOutRun ?? []).map((h) => h.task),
        holdoutIsReportingOnly: round.holdoutIsReportingOnly ?? null,
      }
    : {}),
  recipe: round?.recipe ?? null,
  envCorrections: round?.envCorrections ?? null,
  factRule: {
    HIT: "namesAnchorPath && termHit — counts as found",
    WEAK: "namesAnchorPath && >= half the term's long tokens — reported, NOT counted",
    MISS: "everything else",
    caveat:
      "a mechanical proxy for criterion 1, strictly harsher than the rubric and blind to whether the claim is correct; a training signal, never a parity number",
  },
  totals,
  tasks: rows,
};

const lines = [];
lines.push(
  `# gen-${summary.gen} · ${summary.model} · suite=${summary.suite} · recipe SYSTEM.md ${(summary.recipe?.systemSha256 ?? "").slice(0, 8)} / agent.yaml ${(summary.recipe?.agentYamlSha256 ?? "").slice(0, 8)}`
);
lines.push(`# fact rule: HIT = names anchor path AND the anchoring term. Proxy for criterion 1, harsher than it; training signal only.`);
lines.push(`# held out, never run: ${summary.heldOutNeverRun.join(", ") || "none"}`);
if (summary.holdout) {
  lines.push(
    `# HOLDOUT ROUND — task(s) ${summary.holdoutTasks.join(", ")} are HELD OUT of the fitness set and were run once, ` +
      `for reporting. The recipe was never selected on them; this number must not feed a mutation or a model choice.`
  );
}
for (const r of rows) {
  if (r.status !== "SCORED") {
    lines.push(`TASK ${r.task} NOSCORE exit=${r.exitCode} — ${r.reason}`);
    continue;
  }
  lines.push(
    `TASK ${r.task} ok=${r.ok} facts=${r.found}/${r.need} weak=${r.weak} anchorsCited=${r.anchorsCited}/${r.factTotal} ` +
      `c2=${r.c2} c3=${r.c3} cites=${r.citationsResolved}/${r.citations} pass=${r.mechanicalPass} ` +
      `iters=${r.iterations ?? "?"} spawns=${r.recursiveSpawns} wall=${r.wallSeconds}s cost=$${r.costUsd ?? "?"} chars=${r.answerChars} root=${r.root}`
  );
  for (const f of r.facts) {
    if (f.verdict === "HIT") continue;
    lines.push(`  ${f.verdict} ${f.id} ${f.anchor} — ${f.why}`);
  }
  for (const f of r.c2Failures) lines.push(`  C2FAIL ${f}`);
  for (const f of r.c3Failures) lines.push(`  C3FAIL ${f}`);
}
lines.push(
  `ROUND gen=${summary.gen} facts=${totals.factsFound}/${totals.factsNeeded} fitness=${totals.fitness ?? "n/a"} weak=${totals.factsWeak} ` +
    `tasksPassed=${totals.tasksMechanicalPass}/${totals.scoredTasks} runsOk=${totals.runsOk}/${totals.tasks} ` +
    `c2fail=${totals.c2Failures} c3fail=${totals.c3Failures} cites=${totals.citationsResolved}/${totals.citations} ` +
    `spawns=${totals.recursiveSpawns} cost=$${totals.costUsd} wall=${totals.wallSeconds}s`
);
const text = lines.join("\n") + "\n";

mkdirSync(genDir, { recursive: true });
writeFileSync(join(genDir, "summary.json"), JSON.stringify(summary, null, 2), "utf-8");
writeFileSync(join(genDir, "summary.txt"), text, "utf-8");

process.stdout.write(jsonOnly ? JSON.stringify(summary, null, 2) + "\n" : text);
