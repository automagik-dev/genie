#!/usr/bin/env node
/**
 * matrix.mjs — one row per (round, task): the mechanical rubric across the run.
 *
 * Every column is read from the SAME pair of files (`task-N.json` and its
 * `task-N.score.json`), and the scorer is re-run over every run JSON on disk
 * before this is regenerated, so a row cannot describe two different runs.
 *
 * No round is filtered out. `r6-partial-300s-cap` — the discarded first attempt
 * at r6, cut short by the 300s cap — is printed like any other, because the
 * report claims every round is logged.
 *
 * `SUFFIX_SHORTHAND=1` reads the `.score.suffix.json` files instead (the
 * partial-path shorthand reading); default reads the committed convention.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const parityDir = dirname(fileURLToPath(import.meta.url));
const runsDir = join(parityDir, "runs");
const suffix = process.env.SUFFIX_SHORTHAND === "1" ? ".score.suffix.json" : ".score.json";
const rounds = readdirSync(runsDir)
  .filter((d) => /^r\d/.test(d))
  .sort((a, b) => Number(/^r(\d+)/.exec(a)[1]) - Number(/^r(\d+)/.exec(b)[1]) || a.localeCompare(b));

console.log(
  "| round | model | task | iters | wall | khal cost | c2 | c3 | anchors named | basename bound | terms |"
);
console.log("|---|---|---|---|---|---|---|---|---|---|---|");
for (const round of rounds) {
  for (let n = 1; n <= 6; n++) {
    let rec, score;
    try {
      rec = JSON.parse(readFileSync(join(runsDir, round, `task-${n}.json`), "utf-8"));
      score = JSON.parse(readFileSync(join(runsDir, round, `task-${n}${suffix}`), "utf-8"));
    } catch {
      continue;
    }
    const f = /· (\d+) iterations? ·.*· (\$[\d.]+) ·/.exec(rec.footer ?? "");
    const named = score.factSignals.filter((s) => s.namesAnchorPath).length;
    const byBase = score.factSignals.filter((s) => s.namesBasename).length;
    const terms = score.factSignals.filter((s) => s.termHit).length;
    console.log(
      `| ${round} | ${rec.model} | ${n} | ${f?.[1] ?? "-"} | ${rec.wallSeconds}s | ${f?.[2] ?? "-"} | ` +
        `${score.criterion2.pass ? "PASS" : `FAIL (${score.criterion2.failures.length})`} | ` +
        `${score.criterion3.pass ? "PASS" : `FAIL (${score.criterion3.failures.length})`} | ` +
        `${named}/${score.factTotal} | ${byBase}/${score.factTotal} | ${terms} |`
    );
  }
}
