#!/usr/bin/env node
/**
 * tokens.mjs <roundLabel> — premium-token accounting for one round.
 *
 * Reported, never gated (decision 7).
 *
 *   native = the Explore segment's assistant turns as recorded in the task
 *            file: input + cacheRead + cacheCreate + output. Those are the
 *            tokens the premium model was actually billed for.
 *   rlmx   = the host-session delta for the one tool call: the characters the
 *            host sent (the request arguments) plus the characters it got back
 *            (the whole result text, answer + footer), divided by 4. Nothing
 *            the delegated agent burned on khal appears here — that is the
 *            point of the offload, and it is reported separately as khal cost.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const parityDir = dirname(fileURLToPath(import.meta.url));
const wishDir = resolve(parityDir, "..");
const round = process.argv[2];

const rows = [];
for (let n = 1; n <= 6; n++) {
  const t = readFileSync(join(wishDir, "tasks", `${n}.md`), "utf-8");
  const nativeTok = Number(
    /\| native \| this segment's assistant turns[^|]*\| ([\d,]+) \|/.exec(t)[1].replace(/,/g, "")
  );
  const breakdown = /Native breakdown: ([^\n]+)/.exec(t)?.[1] ?? "";
  let rec;
  try {
    rec = JSON.parse(readFileSync(join(parityDir, "runs", round, `task-${n}.json`), "utf-8"));
  } catch {
    rows.push({ task: n, nativeTok, breakdown, rlmxTok: null });
    continue;
  }
  const rlmxTok = Math.round((rec.requestChars + rec.resultChars) / 4);
  const cost = /· (\$[\d.]+) ·/.exec(rec.footer ?? "")?.[1] ?? "n/a";
  const khal = /· ([\d,]+) in \/ ([\d,]+) out ·/.exec(rec.footer ?? "");
  rows.push({
    task: n,
    nativeTok,
    breakdown,
    rlmxTok,
    requestChars: rec.requestChars,
    resultChars: rec.resultChars,
    ratio: (nativeTok / rlmxTok).toFixed(0),
    khalIn: khal?.[1] ?? "n/a",
    khalOut: khal?.[2] ?? "n/a",
    khalCost: cost,
    wallSeconds: rec.wallSeconds,
  });
}

const totalNative = rows.reduce((a, r) => a + r.nativeTok, 0);
const totalRlmx = rows.reduce((a, r) => a + (r.rlmxTok ?? 0), 0);
console.log(JSON.stringify({ round, rows, totalNative, totalRlmx, ratio: (totalNative / totalRlmx).toFixed(0) }, null, 2));
