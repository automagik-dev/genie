#!/usr/bin/env node
/**
 * emit-evidence.mjs <round…> — verbatim run output for evidence-group-4.md.
 *
 * Prints, per task, exactly what the MCP call returned: the footer rlmx built
 * and the answer text the host received, plus the mechanical rubric verdict.
 * Nothing is paraphrased — the point of the evidence file is that a reader can
 * re-derive the scores from what the tool actually said.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const parityDir = dirname(fileURLToPath(import.meta.url));
const rounds = process.argv.slice(2);
const CAP = Number(process.env.EVIDENCE_CAP ?? 2600);

for (const round of rounds) {
  console.log(`\n### Round \`${round}\`\n`);
  for (let n = 1; n <= 6; n++) {
    let rec;
    let score;
    try {
      rec = JSON.parse(readFileSync(join(parityDir, "runs", round, `task-${n}.json`), "utf-8"));
      score = JSON.parse(
        readFileSync(join(parityDir, "runs", round, `task-${n}.score.json`), "utf-8")
      );
    } catch {
      continue;
    }
    const c2 = score.criterion2.pass ? "PASS" : `FAIL — ${score.criterion2.failures.join("; ")}`;
    const c3 = score.criterion3.pass ? "PASS" : `FAIL — ${score.criterion3.failures.join("; ")}`;
    const body = rec.answer ?? "";
    const shown = body.length > CAP ? `${body.slice(0, CAP)}\n[… ${body.length - CAP} more chars]` : body;
    console.log(`#### task ${n} — \`${rec.root}\`\n`);
    console.log("```text");
    console.log(`$ node run-task.mjs ${n} ${rec.model} ${round}`);
    console.log(rec.footer || `(no footer) ${rec.error ?? ""}`);
    console.log("```");
    console.log(`\nReturned answer (${body.length} chars):\n`);
    console.log("```text");
    console.log(shown);
    console.log("```");
    console.log(
      `\nMechanical rubric — citations extracted: ${score.citations.length}; ` +
        `criterion 2 (citations resolve): **${c2}**; criterion 3 (no fabrication): **${c3}**.\n`
    );
  }
}
