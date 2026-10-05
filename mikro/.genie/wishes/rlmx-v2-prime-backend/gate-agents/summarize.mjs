#!/usr/bin/env node
/**
 * summarize.mjs — extract the gate measurements table from the recorded
 * artifacts (run JSONs, score JSONs, probes, exercises). Every number the
 * gate report quotes can be re-derived by re-running this against the
 * committed records.
 *
 *   node summarize.mjs runs      — per-task table for both legs
 *   node summarize.mjs scores    — mechanical rubric c2/c3 summary
 *   node summarize.mjs probes    — pre-flight probe summary
 *   node summarize.mjs exercises — concurrency/abort summary
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const runsDir = join(__dirname, "runs");
const probesDir = join(__dirname, "probes");
const exercisesDir = join(runsDir, "exercises");

const LEGS = ["legacy", "prime"];
const TASKS = [1, 2, 3, 4, 5, 6];

function runOf(leg, t) {
  const file = join(runsDir, `gate-v2-${leg}`, `task-${t}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")) : null;
}
function scoreOf(leg, t) {
  const file = join(runsDir, `gate-v2-${leg}`, `task-${t}.score.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")) : null;
}

const parseFooter = (footer) => {
  const model = /· ([\w./-]+) · (\d+) iterations? · ([\d,]+) in \/ ([\d,]+) out · (\$[\d.]+) · ([\d.]+)s/.exec(footer ?? "");
  const budget = /budget hit: ([\w-]+)/.exec(footer ?? "");
  return model
    ? { model: model[1], iterations: Number(model[2]), tokensIn: Number(model[3].replace(/,/g, "")), tokensOut: Number(model[4].replace(/,/g, "")), cost: Number(model[5].slice(1)), seconds: Number(model[6]), budget: budget?.[1] ?? null }
    : null;
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? null : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

const cmd = process.argv[2];

if (cmd === "runs") {
  for (const leg of LEGS) {
    console.log(`\n=== ${leg} ===`);
    let totalCost = 0, totalIn = 0, totalOut = 0, fails = 0;
    const walls = [], colds = [], readies = [];
    for (const t of TASKS) {
      const r = runOf(leg, t);
      if (!r) { console.log(`task ${t}: NO RUN RECORD`); continue; }
      const f = parseFooter(r.footer);
      totalCost += f?.cost ?? 0;
      totalIn += f?.tokensIn ?? 0;
      totalOut += f?.tokensOut ?? 0;
      if (!r.ok) fails += 1;
      walls.push(r.wallSeconds); colds.push(r.firstProgressMs ?? null); readies.push(r.serverReadyMs ?? null);
      console.log(
        `task ${t}: ok=${r.ok} wall=${r.wallSeconds}s iter=${f?.iterations ?? "-"} in=${f?.tokensIn ?? "-"} out=${f?.tokensOut ?? "-"} cost=$${(f?.cost ?? 0).toFixed(4)} budget=${f?.budget ?? "-"} ` +
        `firstProgress=${r.firstProgressMs ?? "-"}ms serverReady=${r.serverReadyMs ?? "-"}ms rootGit=${r.provenance?.rootGit?.head?.slice(0, 7) ?? r.provenance?.rootGit?.error ?? "?"} ` +
        `replTimeout=${r.provenance?.replTimeoutMs ?? "null"} runTimeout=${r.provenance?.runTimeoutMs ?? "null"} ${r.ok ? "" : "ERR:" + ((r.error ?? r.answer ?? "").slice(0, 90))}`
      );
    }
    const okCold = colds.filter((x) => x !== null);
    const okReady = readies.filter((x) => x !== null);
    console.log(
      `TOTALS: cost=$${totalCost.toFixed(4)} tokensIn=${totalIn} tokensOut=${totalOut} fails=${fails}/6 ` +
      `wallP50=${median(walls)}s coldMedian=${median(okCold)}ms serverReadyMedian=${median(okReady)}ms`
    );
  }
}

if (cmd === "scores") {
  for (const leg of LEGS) {
    console.log(`\n=== ${leg} scores ===`);
    for (const t of TASKS) {
      const s = scoreOf(leg, t);
      if (!s) { console.log(`task ${t}: NO SCORE RECORD`); continue; }
      console.log(
        `task ${t}: c2=${s.criterion2.pass ? "PASS" : "FAIL " + s.criterion2.failures.join("; ")} c3=${s.criterion3.pass ? "PASS" : "FAIL " + s.criterion3.failures.join("; ")} ` +
        `cites=${s.citations.length} factsNeed=${s.need}/${s.factTotal} termHits=${s.factSignals.filter((f) => f.termHit).length} pathHits=${s.factSignals.filter((f) => f.namesAnchorPath).length} baseHits=${s.factSignals.filter((f) => f.namesBasename).length} root=${s.root}`
      );
    }
  }
}

if (cmd === "probes") {
  for (const leg of LEGS) {
    const file = join(probesDir, `probe-${leg}.json`);
    if (!existsSync(file)) { console.log(`${leg}: NO PROBE`); continue; }
    const p = JSON.parse(readFileSync(file, "utf-8"));
    console.log(`\n=== ${leg} probe ===`);
    console.log(JSON.stringify(p, null, 2));
  }
}

if (cmd === "exercises") {
  for (const name of readdirSync(exercisesDir).sort()) {
    const rec = JSON.parse(readFileSync(join(exercisesDir, name), "utf-8"));
    console.log(`\n=== ${name} ===`);
    if (rec.assertions) console.log("assertions:", JSON.stringify(rec.assertions, null, 2));
    if (rec.slotA) console.log("slotA:", JSON.stringify({ ok: rec.slotA.ok, wall: rec.slotA.wallSeconds, answer: rec.slotA.answer?.slice(0, 300) }, null, 2));
    if (rec.slotB) console.log("slotB:", JSON.stringify({ ok: rec.slotB.ok, wall: rec.slotB.wallSeconds, answer: rec.slotB.answer?.slice(0, 300) }, null, 2));
    if (rec.observed) console.log("observed:", JSON.stringify(rec.observed, null, 2));
    if (rec.footer) console.log("footer:", rec.footer);
    if (rec.isError !== undefined) console.log("isError:", rec.isError, "| answer head:", rec.answer?.slice(0, 150));
  }
}

if (!["runs", "scores", "probes", "exercises"].includes(cmd)) {
  console.error("usage: summarize.mjs <runs|scores|probes|exercises>");
  process.exit(2);
}
