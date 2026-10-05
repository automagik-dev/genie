#!/usr/bin/env node
/**
 * gate-table.mjs — assemble the round-2 gate table from what the frozen scorer
 * already decided, and screen criterion 1 the way round 1's audit requires.
 *
 * It decides nothing new. Criteria 2 and 3 are read verbatim from
 * `task-N.score.json` (default reading) and `task-N.score.suffix.json` (suffix
 * reading). Criterion 1 is *not* decided here — `score-task.mjs` deliberately
 * does not decide it, and neither does this. What it prints is the two
 * screening columns the round-1 report defines, plus the harsher round-2 proxy,
 * so that every task needing a fact-by-fact judgement is identified by rule
 * rather than by eye:
 *
 *   strict   = facts whose anchor path the answer names in full   (namesAnchorPath)
 *   basename = facts whose anchor basename the answer names       (namesBasename)
 *   proxy    = namesAnchorPath && termHit — the round-2 optimizer's HIT rule,
 *              strictly harsher than the rubric and reported as a floor
 *
 * JUDGE is required when a task is c2/c3-clean and reaches within 2 facts of
 * its threshold on EITHER screening column — the rule round 1's audit
 * pre-registered for every future round ("any future round must judge, not
 * screen, every c2/c3-clean run within 2 facts of threshold on either column").
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(p, "utf-8"));

const rows = [];
for (let n = 1; n <= 6; n++) {
  const runP = join(here, `task-${n}.json`);
  if (!existsSync(runP)) {
    rows.push({ task: n, missing: true });
    continue;
  }
  const run = read(runP);
  const def = read(join(here, `task-${n}.score.json`));
  const suf = read(join(here, `task-${n}.score.suffix.json`));

  const strict = def.factSignals.filter((f) => f.namesAnchorPath).length;
  const basename = def.factSignals.filter((f) => f.namesBasename).length;
  const proxy = def.factSignals.filter((f) => f.namesAnchorPath && f.termHit).length;
  const termHits = def.factSignals.filter((f) => f.termHit).length;

  const clean = def.criterion2.pass && def.criterion3.pass;
  const withinTwo = strict >= def.need - 2 || basename >= def.need - 2;

  rows.push({
    task: n,
    ok: run.ok,
    need: def.need,
    factTotal: def.factTotal,
    answerChars: def.answerChars,
    citations: def.citations.length,
    c2: def.criterion2.pass,
    c3: def.criterion3.pass,
    c2suffix: suf.criterion2.pass,
    c3suffix: suf.criterion3.pass,
    c2failures: def.criterion2.failures,
    c3failures: def.criterion3.failures,
    strict,
    basename,
    proxy,
    termHits,
    // A task cannot pass criterion 1 if fewer than `need` facts have their
    // anchor file named at all *under the strict reading* — but the generous
    // reading is not bounded by it (round-1 Scoring conventions, point 2). So
    // this is a screen, never a verdict.
    judgeRequired: clean && withinTwo,
    screenedOut: clean && !withinTwo,
    footer: run.footer ?? null,
    wallSeconds: run.wallSeconds,
    spawns: /(\d+) recursive spawns?/.exec((run.progress ?? []).join("\n"))?.[1] ?? "0",
    promptSha: run.provenance?.promptSha256?.slice(0, 8) ?? null,
    yamlSha: run.provenance?.agentYamlSha256?.slice(0, 8) ?? null,
    rootHead: run.provenance?.rootGit?.head?.slice(0, 7) ?? null,
    rlmxHead: run.provenance?.rlmxGit?.head?.slice(0, 7) ?? null,
  });
}

console.log(JSON.stringify(rows, null, 2));

console.log("\n== SCREEN ==");
for (const r of rows) {
  if (r.missing) {
    console.log(`t${r.task}: NO RUN`);
    continue;
  }
  const verdictable = r.c2 && r.c3;
  console.log(
    `t${r.task} ok=${r.ok} need=${r.need}/${r.factTotal} ` +
      `strict=${r.strict} basename=${r.basename} proxy=${r.proxy} termHits=${r.termHits} ` +
      `c2=${r.c2 ? "PASS" : "FAIL"} c3=${r.c3 ? "PASS" : "FAIL"} ` +
      `(suffix c2=${r.c2suffix ? "PASS" : "FAIL"} c3=${r.c3suffix ? "PASS" : "FAIL"}) ` +
      `cites=${r.citations} chars=${r.answerChars} wall=${r.wallSeconds}s spawns=${r.spawns} ` +
      `→ ${!verdictable ? "FAIL (c2/c3)" : r.judgeRequired ? "JUDGE REQUIRED" : "screened out"}`
  );
  for (const f of r.c2failures) console.log(`     c2 ✗ ${f}`);
  for (const f of r.c3failures) console.log(`     c3 ✗ ${f}`);
}
