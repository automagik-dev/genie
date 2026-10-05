#!/usr/bin/env node
/**
 * union-report.mjs — pool N independent replicates of the same round into one
 * per-task coverage table, per replicate and as a union.
 *
 *   node optimizer/union-report.mjs --label "gen-4 fitness" \
 *        optimizer/gens/gen-4/rep-1 optimizer/gens/gen-4/rep-2
 *
 * Writes `union.json` / `union.txt` next to the first replicate's parent unless
 * `--out <dir>` says otherwise, and prints the text form.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * `matrix/README.md` measures the run-to-run spread of this suite on a fixed
 * (recipe, model, suite) triple at **±3 facts of 34** — larger than the entire
 * range of the four optimizer generations (`[28, 29, 28, 29]`). Three live
 * replicates of task 4 alone scored 3/6, 5/6 and 4/6, and they were not the same
 * three facts each time. So a single round is not a measurement of a recipe, and
 * two rounds reported separately are two anecdotes. This script reports both
 * numbers: what each replicate found on its own, and what the replicates found
 * *between* them.
 *
 * ── What it is NOT ─────────────────────────────────────────────────────────
 *
 * **It changes no scorer and re-decides nothing.** It reads each replicate's
 * `summary.json` — already written by `summarize-train-round.mjs`, whose fact
 * rule is fixed and stated there — and reads `tasks[].facts[].verdict`
 * verbatim. `parity/score-task.mjs` decides criteria 2 and 3; this script only
 * combines the verdicts across replicates. Nothing here can make a fact count
 * that a replicate's own scorer did not already mark HIT.
 *
 * ── The three combining rules, stated ──────────────────────────────────────
 *
 * 1. **Coverage unions.** A fact counts in the union if it is `HIT` in **at
 *    least one** replicate. `WEAK` never counts, in a replicate or in the union
 *    — the fact rule does not count it and this does not soften it. The union is
 *    the answer to *"can this recipe reach this fact at all"*, and it is an
 *    upper bound on what one run delivers, deliberately reported beside the
 *    per-replicate numbers rather than instead of them.
 * 2. **Fabrications intersect the other way: a failure in EITHER replicate
 *    counts against the union.** Criterion 3 is a hard failure, not a coverage
 *    statistic — one fabricated citation makes an answer unusable, and a recipe
 *    that fabricates on one run in two fabricates. So the union's `c3` is PASS
 *    only if every replicate passed. Criterion 2 (citations resolve) is combined
 *    the same way, and unresolved citations are summed, not averaged.
 * 3. **`needed` must agree across replicates.** Same suite, same tasks, same
 *    fact count; a mismatch means the replicates are not replicates and the
 *    script refuses rather than pooling them.
 * 4. **A criterion decided over a run that produced nothing is VACUOUS, and is
 *    marked.** (added at the gen-4 closeout, 2026-07-27.) Criteria 2 and 3 are
 *    failures found *in the citations of an answer*: `score-task.mjs` walks the
 *    citations it can see, so a run that died on the REPL wall and returned a
 *    67-character non-answer has no citation to fail and is written down as
 *    `c2=PASS c3=PASS`. That PASS is the absence of a measurement, not a pass,
 *    and pooling it under rule 2 ("PASS only if EVERY replicate passed") reads
 *    as corroboration when nothing was corroborated. The combining rule is
 *    **unchanged** — nothing is re-decided here — but every task carrying such a
 *    replicate is emitted with `criteriaVacuous` in the JSON and a `VACUOUS`
 *    line in the text, and the totals carry `vacuousCriteria`. A replicate is
 *    vacuous for this purpose when it did not score, when its run is `!ok`, or
 *    when it produced zero citations.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const argv = process.argv.slice(2);
const die = (m, code = 2) => {
  console.error(m);
  process.exit(code);
};

let label = null;
let outDir = null;
const dirs = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--label") label = argv[++i];
  else if (a === "--out") outDir = argv[++i];
  else if (a.startsWith("--")) die(`unknown flag ${a}\nusage: union-report.mjs [--label <name>] [--out <dir>] <repDir> <repDir> [...]`);
  else dirs.push(resolve(a));
}
if (dirs.length < 2) die("give at least two replicate directories — a union of one replicate is that replicate");
for (const d of dirs) if (!existsSync(join(d, "summary.json"))) die(`${d}: no summary.json — run summarize-train-round.mjs there first`);

const reps = dirs.map((d) => ({ dir: d, name: basename(d), s: JSON.parse(readFileSync(join(d, "summary.json"), "utf-8")) }));

// ── the replicates must actually be replicates ──────────────────────────────
const key = (s) => `${s.recipe?.systemSha256}/${s.recipe?.agentYamlSha256}/${s.model}/${s.tasksDir}`;
const keys = new Set(reps.map((r) => key(r.s)));
if (keys.size !== 1) {
  die(
    "these are not replicates of one round — recipe, model or suite differs:\n" +
      reps.map((r) => `  ${r.name}: ${key(r.s)}`).join("\n")
  );
}
const taskSets = reps.map((r) => r.s.tasks.map((t) => t.task).join(","));
if (new Set(taskSets).size !== 1) die(`replicates ran different task sets:\n${reps.map((r, i) => `  ${r.name}: ${taskSets[i]}`).join("\n")}`);

const holdout = reps.every((r) => r.s.holdout === true);
const tasks = reps[0].s.tasks.map((t) => t.task);

// ── per task ────────────────────────────────────────────────────────────────
const rows = [];
for (const n of tasks) {
  const per = reps.map((r) => r.s.tasks.find((t) => t.task === n));
  // A replicate whose run failed to score has no `need`; it contributes no HITs
  // and must not veto the pooling. Only the scored replicates have to agree.
  const needs = [...new Set(per.filter((p) => p.status === "SCORED").map((p) => p.need))];
  if (needs.length > 1) die(`task ${n}: replicates disagree on the fact count (${needs.join(", ")}) — not replicates`);
  if (!needs.length) die(`task ${n}: no replicate scored it — nothing to pool`);
  const needed = needs[0];

  // Fact ids come from the frozen suite, so they are the same list in every
  // replicate; a fact absent from a replicate's list (a NOSCORE run) is simply
  // not a HIT there.
  const ids = [...new Set(per.flatMap((p) => (p.facts ?? []).map((f) => f.id)))].sort();
  const facts = ids.map((id) => {
    const seen = per.map((p) => (p.facts ?? []).find((f) => f.id === id) ?? null);
    const verdicts = seen.map((f) => f?.verdict ?? "NORUN");
    const anchor = seen.find((f) => f)?.anchor ?? "?";
    const anchoredOn = seen.find((f) => f)?.anchoredOn ?? "";
    return { id, anchor, anchoredOn, verdicts, unionHit: verdicts.includes("HIT") };
  });

  // ── rule 4: which replicates' criteria 2/3 decided nothing ────────────────
  // `score-task.mjs` can only fail a citation it can see. A replicate that did
  // not score, whose run is `!ok`, or that emitted no citation at all, hands
  // this script a PASS that no answer earned. The PASS is still combined
  // unchanged under rule 2; it is labelled so it cannot be read as evidence.
  const vacuousWhy = (p) => {
    if (p.status !== "SCORED") return `not scored (status=${p.status})`;
    if (!p.ok) return "run !ok — no answer to decide criteria 2/3 over";
    if ((p.citations ?? 0) === 0) return "0 citations — nothing for criteria 2/3 to fail";
    return null;
  };
  const criteriaVacuous = per
    .map((p, i) => {
      const why = vacuousWhy(p);
      return why ? { replicate: reps[i].name, why, c2: p.c2 ?? null, c3: p.c3 ?? null, answerChars: p.answerChars ?? null } : null;
    })
    .filter(Boolean);

  rows.push({
    task: n,
    needed,
    perReplicate: per.map((p) => (p.status === "SCORED" ? p.found : 0)),
    perReplicateOk: per.map((p) => Boolean(p.ok)),
    unionFound: facts.filter((f) => f.unionHit).length,
    // A fact no replicate reached. This is the residual the next generation
    // has to attack; a fact one replicate reached is a variance problem.
    unionMisses: facts.filter((f) => !f.unionHit).map((f) => ({ id: f.id, anchor: f.anchor, anchoredOn: f.anchoredOn, verdicts: f.verdicts })),
    // Reached by some replicates and not others — the variance itself, named.
    unstable: facts
      .filter((f) => f.unionHit && f.verdicts.some((v) => v !== "HIT"))
      .map((f) => ({ id: f.id, anchor: f.anchor, verdicts: f.verdicts })),
    c2: per.every((p) => p.c2 === "PASS") ? "PASS" : "FAIL",
    c3: per.every((p) => p.c3 === "PASS") ? "PASS" : "FAIL",
    // Non-empty ⇒ the c2/c3 above rest in part on a replicate that decided
    // nothing. The verdict is unchanged; its support is not what it looks like.
    criteriaVacuous,
    citations: per.map((p) => p.citations ?? 0),
    citationsResolved: per.map((p) => p.citationsResolved ?? 0),
    citationFailures: per.reduce((a, p) => a + ((p.citations ?? 0) - (p.citationsResolved ?? 0)), 0),
    fabrications: per.reduce((a, p) => a + (p.c3Failures?.length ?? 0), 0),
    spawns: per.map((p) => p.recursiveSpawns ?? 0),
    iterations: per.map((p) => p.iterations ?? null),
    wallSeconds: per.map((p) => p.wallSeconds ?? null),
    costUsd: per.map((p) => p.costUsd ?? null),
  });
}

const totals = {
  replicates: reps.length,
  tasks: rows.length,
  needed: rows.reduce((a, r) => a + r.needed, 0),
  perReplicateFound: reps.map((_, i) => rows.reduce((a, r) => a + r.perReplicate[i], 0)),
  unionFound: rows.reduce((a, r) => a + r.unionFound, 0),
  runsOk: reps.map((_, i) => rows.filter((r) => r.perReplicateOk[i]).length),
  c2Failures: rows.filter((r) => r.c2 === "FAIL").length,
  c3Failures: rows.filter((r) => r.c3 === "FAIL").length,
  // Tasks whose pooled c2/c3 rests in part on a replicate that decided nothing.
  vacuousCriteria: rows.filter((r) => r.criteriaVacuous.length).length,
  vacuousCriteriaDetail: rows.flatMap((r) => r.criteriaVacuous.map((v) => ({ task: r.task, ...v }))),
  fabrications: rows.reduce((a, r) => a + r.fabrications, 0),
  citationFailures: rows.reduce((a, r) => a + r.citationFailures, 0),
  citations: reps.map((_, i) => rows.reduce((a, r) => a + r.citations[i], 0)),
  citationsResolved: reps.map((_, i) => rows.reduce((a, r) => a + r.citationsResolved[i], 0)),
  spawnsTotal: reps.map((_, i) => rows.reduce((a, r) => a + r.spawns[i], 0)),
  spawnsMinPerRun: Math.min(...rows.flatMap((r) => r.spawns)),
  spawnsMaxPerRun: Math.max(...rows.flatMap((r) => r.spawns)),
  costUsd: reps.map((_, i) => Number(rows.reduce((a, r) => a + (r.costUsd[i] ?? 0), 0).toFixed(4))),
  wallSeconds: reps.map((r) => r.s.totals?.wallSeconds ?? null),
};
totals.perReplicateCoverage = totals.perReplicateFound.map((f) => Number((f / totals.needed).toFixed(4)));
totals.unionCoverage = Number((totals.unionFound / totals.needed).toFixed(4));
totals.replicateSpread = Math.max(...totals.perReplicateFound) - Math.min(...totals.perReplicateFound);
totals.unionLift = totals.unionFound - Math.max(...totals.perReplicateFound);

const report = {
  label: label ?? `union of ${reps.length} replicates`,
  ...(holdout
    ? {
        holdout: true,
        holdoutIsReportingOnly:
          "Held-out tasks, scored after the recipe was fixed. This number must not feed a mutation, a revert, " +
          "a Pareto comparison or a model choice.",
      }
    : {}),
  model: reps[0].s.model,
  suite: reps[0].s.suite,
  tasksDir: reps[0].s.tasksDir,
  recipe: reps[0].s.recipe,
  replicates: reps.map((r) => ({ name: r.name, dir: r.dir, label: r.s.label })),
  rules: {
    coverage: "a fact counts in the union if it is HIT in at least one replicate; WEAK never counts",
    fabrication: "criterion 3 (and criterion 2) PASS in the union only if EVERY replicate passed — a failure in either counts against the union",
    needed: "the fact count must be identical across replicates or the pooling is refused",
    provenance: "verdicts are read verbatim from each replicate's summary.json; no scorer is re-run and no rule is re-decided here",
    vacuous:
      "criteria 2 and 3 from a replicate that did not score, whose run is !ok, or that emitted 0 citations are VACUOUS — score-task.mjs had no citation to fail, so the PASS is the absence of a measurement. The combining rule is unchanged; the support is labelled (tasks[].criteriaVacuous, totals.vacuousCriteria) so a PASS cannot be read as evidence.",
  },
  totals,
  tasks: rows,
};

const lines = [];
lines.push(`# ${report.label} · ${report.model} · ${reps.length} replicates · recipe SYSTEM.md ${(report.recipe?.systemSha256 ?? "").slice(0, 8)} / agent.yaml ${(report.recipe?.agentYamlSha256 ?? "").slice(0, 8)}`);
lines.push(`# replicates: ${reps.map((r) => r.name).join(", ")}  (separate scratch HOMEs — one per run label)`);
lines.push(`# union rule: a fact counts if HIT in >=1 replicate. FABRICATION RULE: a c3 (or c2) failure in EITHER replicate counts against the union.`);
lines.push(`# VACUOUS: a c2/c3 PASS from a replicate that did not score, is !ok, or emitted 0 citations decided nothing — score-task.mjs had no citation to fail. Marked, never re-decided.`);
if (holdout) lines.push(`# HOLDOUT — reporting only. The recipe was never selected on these tasks; this number must not feed a mutation.`);
for (const r of rows) {
  const vac = r.criteriaVacuous.length ? "!" : "";
  lines.push(
    `TASK ${r.task} union=${r.unionFound}/${r.needed} per-replicate=[${r.perReplicate.join(", ")}] ` +
      `c2=${r.c2}${vac} c3=${r.c3}${vac} fabrications=${r.fabrications} citeFail=${r.citationFailures} ` +
      `spawns=[${r.spawns.join(", ")}] iters=[${r.iterations.join(", ")}] wall=[${r.wallSeconds.join(", ")}]s cost=[${r.costUsd.map((c) => `$${c}`).join(", ")}]`
  );
  for (const m of r.unionMisses) lines.push(`  UNIONMISS ${m.id} ${m.anchor} \`${m.anchoredOn}\` — [${m.verdicts.join(", ")}]`);
  for (const u of r.unstable) lines.push(`  UNSTABLE  ${u.id} ${u.anchor} — [${u.verdicts.join(", ")}] (reached by some replicates, not all)`);
  for (const v of r.criteriaVacuous)
    lines.push(`  VACUOUS   c2=${v.c2}/c3=${v.c3} from ${v.replicate} — ${v.why}; the marked \`c2=${r.c2}!\`/\`c3=${r.c3}!\` above is that PASS pooled, not corroborated`);
}
lines.push(
  `UNION facts=${totals.unionFound}/${totals.needed} coverage=${totals.unionCoverage} ` +
    `perReplicate=[${totals.perReplicateFound.join(", ")}]/${totals.needed} ` +
    `spread=${totals.replicateSpread} unionLift=+${totals.unionLift} ` +
    `runsOk=[${totals.runsOk.join(", ")}]/${totals.tasks} c2fail=${totals.c2Failures} c3fail=${totals.c3Failures} ` +
    `vacuousCriteria=${totals.vacuousCriteria} ` +
    `fabrications=${totals.fabrications} citeFail=${totals.citationFailures} ` +
    `cites=[${totals.citationsResolved.map((v, i) => `${v}/${totals.citations[i]}`).join(", ")}] ` +
    `spawns=[${totals.spawnsTotal.join(", ")}] perRun=${totals.spawnsMinPerRun}..${totals.spawnsMaxPerRun} ` +
    `cost=[${totals.costUsd.map((c) => `$${c}`).join(", ")}] wall=[${totals.wallSeconds.join(", ")}]s`
);
const text = lines.join("\n") + "\n";

const dest = resolve(outDir ?? dirname(dirs[0]));
mkdirSync(dest, { recursive: true });
writeFileSync(join(dest, "union.json"), JSON.stringify(report, null, 2), "utf-8");
writeFileSync(join(dest, "union.txt"), text, "utf-8");
process.stdout.write(text);
process.stdout.write(`# → ${join(dest, "union.txt")}\n`);
