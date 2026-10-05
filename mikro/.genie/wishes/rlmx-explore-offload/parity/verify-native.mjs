#!/usr/bin/env node
/**
 * verify-native.mjs — independent re-check of the ground truth the native arm
 * defines (decision 6).
 *
 * The task files record a native baseline computed at mining time. This
 * re-derives the checkable half of it now, against the trees as they stand:
 * every required fact's anchor `path:line` must exist under the task root, and
 * the line there must still carry the fact's recorded `verified:` text. A fact
 * that no longer anchors would mean the ground truth had drifted under the
 * gate, which is the one way a "conservative asymmetry" could become unfair in
 * the other direction.
 *
 * Default: the frozen suite, tasks 1..6, exactly as it has always run. With
 * `--dir <suite>` it checks any other mined suite the same way — a training
 * suite has to clear the same ground-truth bar as the eval suite, or it is not
 * the same standard — discovering `<n>.md` rather than assuming six of them.
 * The default path never enters the discovery branch, so its output is
 * unchanged whatever else ever lands in the frozen directory.
 *
 *   node parity/verify-native.mjs
 *   node parity/verify-native.mjs --dir parity/round2/train-tasks
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const wishDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dirArg = process.argv.indexOf("--dir");
const suiteDir = dirArg >= 0 && process.argv[dirArg + 1] ? resolve(process.argv[dirArg + 1]) : null;

/** Frozen suite: the literal 1..6 it has always used. Otherwise: discovered. */
let taskNumbers = [1, 2, 3, 4, 5, 6];
if (suiteDir) {
  let names;
  try {
    names = readdirSync(suiteDir);
  } catch {
    console.log(`no such suite directory: ${suiteDir}`);
    process.exit(1);
  }
  taskNumbers = names
    .filter((n) => /^\d+\.md$/.test(n))
    .map((n) => parseInt(n, 10))
    .sort((a, b) => a - b);
  if (!taskNumbers.length) {
    console.log(`${suiteDir}: no task files — an empty suite verifies nothing`);
    process.exit(1);
  }
}
const tasksDir = suiteDir ?? join(wishDir, "tasks");

let allOk = true;
const rows = [];

for (const n of taskNumbers) {
  const t = readFileSync(join(tasksDir, `${n}.md`), "utf-8");
  const root = /\| Task root \(the rlmx arm's `--dir`\) \| `([^`]+)` \|/.exec(t)[1];
  const factRe =
    /^- \[ \] \*\*(F\d+)\*\* \((exact|re-anchored)\) `([^`]+)`([^\n]*)\n((?:  [^\n]*\n)+)/gm;
  let m;
  let ok = 0;
  let bad = [];
  while ((m = factRe.exec(t))) {
    const [, id, , anchor, , body] = m;
    const verified = /verified: `([\s\S]*?)`\n/.exec(body)?.[1] ?? "";
    const [path, lineRaw] = [anchor.replace(/:\d+$/, ""), Number(/:(\d+)$/.exec(anchor)?.[1])];
    const abs = join(root, path);
    let verdict = "ok";
    try {
      if (!statSync(abs).isFile()) throw new Error("not a file");
      const lines = readFileSync(abs, "utf-8").split("\n");
      if (lineRaw < 1 || lineRaw > lines.length) verdict = "line-out-of-range";
      else if (verified && lines[lineRaw - 1].trim() !== verified.trim()) {
        verdict = `text-mismatch: got ${JSON.stringify(lines[lineRaw - 1].trim().slice(0, 80))}`;
      }
    } catch (e) {
      verdict = `missing (${e.message})`;
    }
    if (verdict === "ok") ok += 1;
    else bad.push(`${id} ${anchor} → ${verdict}`);
  }
  const total = ok + bad.length;
  if (bad.length) allOk = false;
  rows.push({ task: n, root, anchorsVerified: `${ok}/${total}`, failures: bad });
  console.log(`task ${n}: ${ok}/${total} fact anchors still resolve with their recorded text`);
  for (const b of bad) console.log(`  ✗ ${b}`);
}

console.log(allOk ? "\nNATIVE GROUND TRUTH VERIFIED" : "\nNATIVE GROUND TRUTH DRIFTED");
process.exit(allOk ? 0 : 1);
