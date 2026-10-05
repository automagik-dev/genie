#!/usr/bin/env node
/**
 * run-train-round.mjs — one optimizer generation over the round-2 TRAINING
 * suite, end to end and unattended.
 *
 * It drives the recipe in `optimizer/current/` over the six FITNESS tasks of
 * `round2/train-tasks/` through the real MCP path, scores each run with the
 * frozen scorer, and writes everything under `optimizer/gens/gen-<N>/`:
 *
 *   gen-<N>/recipe/{agent.yaml,SYSTEM.md}   what actually ran (snapshot)
 *   gen-<N>/runs/task-<n>.json              the verbatim run record
 *   gen-<N>/runs/task-<n>.score.json        score-task.mjs output
 *   gen-<N>/logs/task-<n>.log               the runner's stdout+stderr
 *   gen-<N>/round.json                      the manifest below
 *   gen-<N>/summary.{json,txt}              summarize-train-round.mjs
 *
 *   export KHAL_API_KEY=…                   # shell only, never in a file
 *   node run-train-round.mjs --gen 0
 *   node run-train-round.mjs --gen 3 --model khal/glm-5.2 --concurrency 2
 *
 * ── What it does NOT do, by construction ───────────────────────────────────
 *
 * **It cannot run the frozen eval suite.** `--tasks-dir` defaults to the
 * training suite and refuses `<wish>/tasks/`. The gate is a different program
 * (`parity/run-round.sh`), run once, outside this loop.
 *
 * **It cannot run a held-out task.** The fitness set and the held-out set are
 * read from `train-tasks/authored-run.json` (`fitnessSet.included` /
 * `fitnessSet.heldOut`) — not from a list typed here — and a request for a
 * held-out task is refused with its recorded reason. Selecting on `1.md` or
 * `2.md` would be tuning the prompt against ground truth authored by the same
 * investigation that wrote the prompt.
 *
 * ── The two environment corrections, and why they are here ────────────────
 *
 * 1. `RLMX_REPL_TIMEOUT_MS=600000`. `rlm_query_batched` blocks the parent's
 *    Python REPL until every child exits, and the per-block REPL clock is 30s
 *    by default (src/repl.ts:81-87). At the default the fan-out block is killed
 *    mid-wait, the rejection escapes `rlmLoop` unwrapped (src/rlm.ts:681), and
 *    the whole call returns `REPL execution timed out after 30000ms` with no
 *    answer at all — a total loss, not a degradation. Measured:
 *    round2/smoke/smoke-2.json. Recon §4.1.
 * 2. `RLMX_MCP_RUN_TIMEOUT_MS=900000`. The run wall clock, same correction the
 *    round-1 gate already made (parity/run-round.sh:17).
 *
 * Both are set on the `rlmx mcp` process this script's children spawn, and both
 * are recorded in every run record's provenance. A third knob,
 * `PARITY_CALL_TIMEOUT_MS`, raises the MCP *client's* go-silent tolerance to
 * match: a fan-out is silent for the whole blocking wave.
 *
 * ── Concurrency ───────────────────────────────────────────────────────────
 *
 * Default 2, hard-capped at 3. Each task is a parent plus up to four concurrent
 * children (src/llm.ts:667), so 2 tasks is already ~10 concurrent streams on
 * one khal key; round 1 saw first-call timeouts at 6 non-recursive agents
 * (parity/run-round.sh:5-9). 3 is available for a hurry, and is a deliberate
 * risk rather than a default.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const round2 = __dirname;
const parityDir = resolve(round2, "..");
const wishDir = resolve(parityDir, "..");
const repo = resolve(wishDir, "..", "..", "..");
const frozenTasksDir = join(wishDir, "tasks");
const optimizerDir = join(round2, "optimizer");

const die = (msg, code = 2) => {
  console.error(msg);
  process.exit(code);
};

// ── flags ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set([
  "--gen", "--model", "--tasks", "--concurrency", "--tasks-dir", "--recipe", "--label", "--task-timeout-s",
  "--gen-dir",
]);
const BOOL_FLAGS = new Set(["--dry-run", "--keep-scaffold", "--no-pin-child-model", "--allow-drift", "--holdout"]);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (BOOL_FLAGS.has(a)) {
    opt[a] = true;
  } else if (VALUE_FLAGS.has(a)) {
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) die(`${a} requires a value`);
    opt[a] = v;
  } else {
    die(
      `unknown argument: ${a}\n` +
        "usage: run-train-round.mjs --gen <N> [--model khal/deepseek-v4-flash] [--tasks 3,4,5,6,7,8]\n" +
        "                           [--concurrency 2] [--tasks-dir <dir>] [--recipe <dir>] [--label <round>]\n" +
        "                           [--gen-dir <dir>] [--task-timeout-s 2400] [--dry-run] [--keep-scaffold]\n" +
        "                           [--no-pin-child-model] [--allow-drift] [--holdout]"
    );
  }
}

if (opt["--gen"] === undefined) die("--gen <N> is required — a generation number is what names the output tree");
if (!/^\d+$/.test(opt["--gen"])) die(`--gen must be a non-negative integer (got ${opt["--gen"]})`);
const gen = Number(opt["--gen"]);
const model = opt["--model"] ?? "khal/deepseek-v4-flash";
const concurrency = Number(opt["--concurrency"] ?? 2);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) {
  die(`--concurrency must be 1..3 (got ${opt["--concurrency"]}) — see the header on why 3 is the cap`);
}
const taskTimeoutS = Number(opt["--task-timeout-s"] ?? 2400);
const recipeDir = resolve(opt["--recipe"] ?? join(optimizerDir, "current"));
const tasksDir = resolve(opt["--tasks-dir"] ?? join(round2, "train-tasks"));
const label = opt["--label"] ?? `gen-${gen}-${model.replace(/[^A-Za-z0-9]+/g, "-")}`;
const pinChildModel = !opt["--no-pin-child-model"];

// ── refusals that must never be a flag ──────────────────────────────────────
if (tasksDir === frozenTasksDir) {
  die(
    `refusing to run the frozen eval suite: ${tasksDir}\n` +
      "  this is the optimizer's training loop; the gate is run once, outside it, by parity/run-round.sh.\n" +
      "  a training loop that touches the gate has no gate."
  );
}
for (const f of ["SYSTEM.md", "agent.yaml"]) {
  if (!existsSync(join(recipeDir, f))) die(`recipe ${recipeDir}: missing ${f}`);
}

// ── fitness set, from the suite's own record ────────────────────────────────
const authoredRunPath = join(tasksDir, "authored-run.json");
if (!existsSync(authoredRunPath)) {
  die(
    `${authoredRunPath} not found — the fitness set and the held-out set are read from it.\n` +
      "  A suite that cannot say which of its tasks may be selected on is not selectable."
  );
}
const authored = JSON.parse(readFileSync(authoredRunPath, "utf-8"));
const fitness = (authored.fitnessSet?.included ?? []).map((f) => Number(f.replace(/\.md$/, "")));
const heldOut = new Map(
  (authored.fitnessSet?.heldOut ?? []).map((h) => [Number(h.file.replace(/\.md$/, "")), h.reason])
);
if (!fitness.length) die(`${authoredRunPath}: fitnessSet.included is empty — nothing to select on`);

/**
 * `--holdout` — the overfitting tripwire, and the only way a held-out task runs.
 *
 * The refusal below is the loop's load-bearing guard and it stays the default:
 * with no flag, `1.md` and `2.md` are refused exactly as before, byte for byte.
 * `--holdout` inverts it into a *reporting* mode, and it is only honest if the
 * result can never re-enter selection — so it carries three structural guards,
 * not a comment asking for restraint:
 *
 *   1. **Held-out only, no mixing.** Every requested task must be held out. A
 *      round that scored 1, 2 *and* 5 in one number would be a fitness round
 *      with contraband in it.
 *   2. **`--gen-dir` is required and must be outside `optimizer/gens/`.** A
 *      holdout round must not take a number in the `[28, 29, 28, 29]` series,
 *      because nothing in that series may have been selected on.
 *   3. **It is recorded as one.** `holdout: true` and `heldOutRun` land in
 *      `round.json`, and the summary prints a banner. A number whose provenance
 *      is only in someone's memory is a number that gets re-used.
 *
 * Run it once, after the recipe is chosen. If holdout coverage sits far below
 * fitness coverage, that is the finding — it is not an input to the next
 * mutation.
 */
const holdoutMode = Boolean(opt["--holdout"]);
const tasks = opt["--tasks"]
  ? opt["--tasks"].split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))
  : holdoutMode
    ? [...heldOut.keys()].sort((a, b) => a - b)
    : [...fitness].sort((a, b) => a - b);
for (const n of tasks) {
  if (heldOut.has(n)) {
    if (!holdoutMode) {
      die(
        `refusing task ${n}: it is HELD OUT of the fitness set.\n` +
          `  ${heldOut.get(n)}\n` +
          "  Scoring a held-out task is reporting; running one inside the optimizer loop is selection."
      );
    }
  } else if (holdoutMode) {
    die(
      `--holdout: task ${n} is NOT held out (fitnessSet.included = ${fitness.join(", ")}).\n` +
        "  A holdout round scores held-out tasks only. Mixing a fitness task into it makes one\n" +
        "  number out of a set the recipe was selected on and a set it was not."
    );
  } else if (!fitness.includes(n)) {
    die(`task ${n} is not in fitnessSet.included (${fitness.join(", ")}) — refusing to select on it`);
  }
  if (!existsSync(join(tasksDir, `${n}.md`))) die(`task ${n}: no such file ${join(tasksDir, `${n}.md`)}`);
}
if (holdoutMode && !tasks.length) die("--holdout: authored-run.json declares no held-out tasks — nothing to report on");
if (holdoutMode) {
  // Structural refusals first, before the ground-truth preflight: a holdout
  // round that is going to be refused for where it writes should not spend
  // anyone's time re-resolving fact anchors to find that out.
  if (opt["--gen-dir"] === undefined) {
    die(
      "--holdout requires --gen-dir <dir> outside optimizer/gens/.\n" +
        "  A holdout result must not occupy a generation number: nothing in the generation series\n" +
        "  may have been selected on, and a directory named gen-<N> reads as if it had been."
    );
  }
  const gensRoot = join(optimizerDir, "gens");
  const target = resolve(opt["--gen-dir"]);
  if (target === gensRoot || target.startsWith(gensRoot + "/")) {
    die(
      `--holdout: refusing to write inside the generation series (${target}).\n` +
        "  Pass a --gen-dir elsewhere, e.g. optimizer/holdout/ — see guard 2 in the --holdout note above."
    );
  }
}

// ── ground-truth preflight, over the tasks this round will actually run ─────
/**
 * `parity/verify-native.mjs` checks a whole suite; a round only spends money on
 * part of one, and the part it does not run must not be able to stop it — or to
 * let it through. These are four live checkouts and they move: on 2026-07-27
 * the product fix at 6ec4822 rewrote `src/llm.ts` and `src/mcp/server.ts` under
 * training task 1, which is held out and therefore irrelevant to a fitness
 * round, while every fitness task still verified. So the same check as
 * verify-native.mjs (identical regex, identical `verified:` comparison), scoped
 * to `tasks`. A round scored against drifted ground truth is a wrong number,
 * not a low one — hence a refusal, with `--allow-drift` to record it and go on.
 */
const taskRoot = (n) =>
  /\| Task root \(the rlmx arm's `--dir`\) \| `([^`]+)` \|/.exec(readFileSync(join(tasksDir, `${n}.md`), "utf-8"))?.[1];
for (const n of tasks) {
  if (!taskRoot(n)) die(`task ${n}: no \`| Task root … |\` row — cannot decide where it runs`);
}

const FACT_RE = /^- \[ \] \*\*(F\d+)\*\* \((exact|re-anchored)\) `([^`]+)`([^\n]*)\n((?:  [^\n]*\n)+)/gm;
const drift = [];
for (const n of tasks) {
  const t = readFileSync(join(tasksDir, `${n}.md`), "utf-8");
  const root = taskRoot(n);
  let m;
  FACT_RE.lastIndex = 0;
  while ((m = FACT_RE.exec(t))) {
    const [, id, , anchor, , body] = m;
    const verified = /verified: `([\s\S]*?)`\n/.exec(body)?.[1] ?? "";
    const path = anchor.replace(/:\d+$/, "");
    const lineNo = Number(/:(\d+)$/.exec(anchor)?.[1]);
    const abs = join(root, path);
    let verdict = "ok";
    try {
      const lines = readFileSync(abs, "utf-8").split("\n");
      if (lineNo < 1 || lineNo > lines.length) verdict = "line-out-of-range";
      else if (verified && lines[lineNo - 1].trim() !== verified.trim()) {
        verdict = `text-mismatch: got ${JSON.stringify(lines[lineNo - 1].trim().slice(0, 80))}`;
      }
    } catch (e) {
      verdict = `missing (${e.message})`;
    }
    if (verdict !== "ok") drift.push(`task ${n} ${id} ${anchor} → ${verdict}`);
  }
}
if (drift.length && !opt["--allow-drift"]) {
  die(
    `ground truth has drifted under ${drift.length} fact(s) of this round's tasks:\n` +
      drift.map((d) => `  ✗ ${d}`).join("\n") +
      "\n  re-author or re-anchor the suite, or pass --allow-drift to record it and run anyway.\n" +
      `  full check: node ${join(parityDir, "verify-native.mjs")} --dir ${tasksDir}`
  );
}

// ── key ─────────────────────────────────────────────────────────────────────
if (model.startsWith("khal/") && !process.env.KHAL_API_KEY && !process.env.RLMX_KHAL_API_KEY) {
  die("KHAL_API_KEY is not set — export it in the shell, never in a file.");
}
if (!existsSync(join(repo, "dist", "src", "cli.js"))) die(`${join(repo, "dist", "src", "cli.js")} missing — run npm run build`);

// ── output tree, and the guards on it ───────────────────────────────────────
/**
 * Where this round writes. Defaults to `optimizer/gens/gen-<N>` — byte-identical
 * to what every generation of the evolution series used, and unchanged when the
 * flag is absent. `--gen-dir` exists for the **model matrix**: an arm re-runs an
 * *already-selected* generation's recipe on another model, so it is not a new
 * generation and must not take a number in the series (which would make the
 * `[28, 29, …]` totals history read as if the prompt had mutated). Arms land
 * under `optimizer/matrix/<model-slug>/` instead, keeping `--gen` truthful about
 * which generation's recipe ran.
 */
const genDir = resolve(opt["--gen-dir"] ?? join(optimizerDir, "gens", `gen-${gen}`));
const runsDir = join(genDir, "runs");
const logsDir = join(genDir, "logs");
const snapDir = join(genDir, "recipe");
const overwrite = process.env.PARITY_OVERWRITE === "1";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const systemText = readFileSync(join(recipeDir, "SYSTEM.md"), "utf-8");
const yamlText = readFileSync(join(recipeDir, "agent.yaml"), "utf-8");

/**
 * A generation is a (recipe, suite, model) triple. If gen-N already carries a
 * *different* recipe, the number has been reused for a second thing and the
 * runs under it would no longer all describe one prompt — which is the exact
 * failure the round-1 matrix hit by re-running into a live round label.
 */
if (existsSync(join(snapDir, "SYSTEM.md")) && !overwrite) {
  const prevSystem = readFileSync(join(snapDir, "SYSTEM.md"), "utf-8");
  const prevYaml = readFileSync(join(snapDir, "agent.yaml"), "utf-8");
  if (prevSystem !== systemText || prevYaml !== yamlText) {
    die(
      `gen-${gen} already snapshots a different recipe:\n` +
        `  snapshot SYSTEM.md ${sha(prevSystem).slice(0, 8)} / agent.yaml ${sha(prevYaml).slice(0, 8)}\n` +
        `  current  SYSTEM.md ${sha(systemText).slice(0, 8)} / agent.yaml ${sha(yamlText).slice(0, 8)}\n` +
        "  use the next generation number — a generation is one recipe, or it is not a generation.",
      3
    );
  }
}
const already = tasks.filter((n) => existsSync(join(runsDir, `task-${n}.json`)));
if (already.length && !overwrite) {
  die(
    `gen-${gen} already has run record(s) for task(s) ${already.join(", ")} in ${runsDir}\n` +
      "  use the next generation number, or set PARITY_OVERWRITE=1 deliberately and re-score.",
    3
  );
}

// ── task roots, and the `.rlmx/` a run writes into them ─────────────────────
/**
 * Three of the four training roots are the user's live checkouts and carry no
 * `.rlmx/`. `runQuery` auto-scaffolds when its cwd has none (src/cli.ts:317-324)
 * and a recursive child runs with cwd = the server's `--dir`, so the first run
 * against each root writes four template files into a repository this wish does
 * not own. Rather than accept that silently, the round records what it found
 * and — unless `--keep-scaffold` — removes exactly what it created, and only
 * when nothing unexpected appeared inside.
 */
const SCAFFOLD_ALLOWED = new Set([...readdirSync(join(repo, "src", "templates", "default")), "sessions", "logs", "cache"]);
const roots = [...new Set(tasks.map(taskRoot))];
const rootState = roots.map((root) => ({ root, rlmxExistedBefore: existsSync(join(root, ".rlmx")) }));

function gitState(dir) {
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf-8" }).trim();
  try {
    return { head: git("rev-parse", "HEAD"), branch: git("rev-parse", "--abbrev-ref", "HEAD"), dirty: git("status", "--porcelain").length > 0 };
  } catch (e) {
    return { head: null, error: e?.message ?? String(e) };
  }
}

// ── the environment corrections (see header) ────────────────────────────────
const envCorrections = {
  RLMX_REPL_TIMEOUT_MS: process.env.RLMX_REPL_TIMEOUT_MS ?? "600000",
  RLMX_MCP_RUN_TIMEOUT_MS: process.env.RLMX_MCP_RUN_TIMEOUT_MS ?? "900000",
  PARITY_CALL_TIMEOUT_MS: process.env.PARITY_CALL_TIMEOUT_MS ?? "600000",
  PARITY_MAX_TOTAL_TIMEOUT_MS: process.env.PARITY_MAX_TOTAL_TIMEOUT_MS ?? "2400000",
};

const plan = {
  gen,
  label,
  model,
  concurrency,
  taskTimeoutS,
  tasks,
  // In a fitness round no held-out task is ever in `tasks`, so this is
  // `[...heldOut.keys()]` exactly as before. In a holdout round it is the
  // held-out tasks this round did NOT run, which is the only reading of
  // "refused" that stays true in both modes.
  heldOutRefused: [...heldOut.keys()].filter((n) => !tasks.includes(n)),
  ...(holdoutMode
    ? {
        holdout: true,
        heldOutRun: tasks.map((n) => ({ task: n, reason: heldOut.get(n) })),
        holdoutIsReportingOnly:
          "Scored for reporting after the recipe was selected. This number must not feed a mutation, " +
          "a revert, a Pareto comparison or a model choice — the recipe was never selected on these tasks " +
          "and that is the only reason the number means anything.",
      }
    : {}),
  tasksDir,
  suite: "round2-train",
  recipe: {
    dir: recipeDir,
    systemSha256: sha(systemText),
    systemChars: systemText.length,
    agentYamlSha256: sha(yamlText),
    declaredModel: /^model:\s*(\S+)/m.exec(yamlText)?.[1] ?? null,
    installedAs: "explore-r",
  },
  envCorrections,
  pinChildModel,
  groundTruthDrift: drift,
  groundTruthDriftAllowed: Boolean(opt["--allow-drift"]),
  roots: rootState,
  rlmxGit: gitState(repo),
  genDir,
};

console.log(`# run-train-round: gen-${gen} · ${model} · tasks ${tasks.join(",")} · concurrency ${concurrency}`);
console.log(`# recipe ${recipeDir} → SYSTEM.md ${plan.recipe.systemSha256.slice(0, 8)} / agent.yaml ${plan.recipe.agentYamlSha256.slice(0, 8)}`);
if (holdoutMode) {
  console.log(`# HOLDOUT ROUND — reporting only. Running the HELD-OUT task(s) ${tasks.join(", ")} deliberately, once.`);
  console.log(`#   this number must not feed a mutation, a revert or a model choice; see plan.holdoutIsReportingOnly`);
}
console.log(`# suite  ${tasksDir}  (held out, never run here: ${plan.heldOutRefused.join(", ") || "none"})`);
console.log(`# env    ${Object.entries(envCorrections).map(([k, v]) => `${k}=${v}`).join(" ")}`);
for (const r of rootState) {
  console.log(`# root   ${r.root}  .rlmx ${r.rlmxExistedBefore ? "pre-existing" : "ABSENT — a run will scaffold one" + (opt["--keep-scaffold"] ? " (kept)" : ", removed at the end")}`);
}
if (opt["--dry-run"]) {
  console.log("# dry run — nothing spawned");
  process.exit(0);
}

mkdirSync(runsDir, { recursive: true });
mkdirSync(logsDir, { recursive: true });
mkdirSync(snapDir, { recursive: true });
cpSync(join(recipeDir, "SYSTEM.md"), join(snapDir, "SYSTEM.md"));
cpSync(join(recipeDir, "agent.yaml"), join(snapDir, "agent.yaml"));

// ── run ─────────────────────────────────────────────────────────────────────
const runTaskJs = join(parityDir, "run-task.mjs");
const scoreTaskJs = join(parityDir, "score-task.mjs");

function runOne(n) {
  return new Promise((done) => {
    const started = Date.now();
    const logPath = join(logsDir, `task-${n}.log`);
    // Buffered in memory and written once: the score line is appended after the
    // child closes, and a WriteStream that has not finished flushing would race
    // that append and lose part of the log.
    let logBuf = "";
    const log = { write: (b) => (logBuf += b.toString()) };
    const args = [
      runTaskJs, String(n), model, label,
      "--tasks-dir", tasksDir,
      "--recipe", recipeDir,
      "--agent", "explore-r",
      "--out-dir", runsDir,
      ...(pinChildModel ? ["--pin-child-model"] : []),
    ];
    log.write(`$ node ${args.slice(1).join(" ")}\n`);
    const child = spawn(process.execPath, args, {
      cwd: repo,
      env: { ...process.env, ...envCorrections },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (b) => log.write(b));
    child.stderr.on("data", (b) => {
      log.write(b);
      process.stderr.write(b);
    });
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000);
    }, taskTimeoutS * 1000);
    child.on("close", (code) => {
      clearTimeout(killer);
      const runJson = join(runsDir, `task-${n}.json`);
      const result = {
        task: n,
        exitCode: code,
        timedOut,
        wallSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
        runJson: existsSync(runJson) ? runJson : null,
        log: logPath,
      };
      // Score whatever record exists — a failed run still has a record, and a
      // score of a failed run is a zero, not a gap in the table.
      if (result.runJson) {
        try {
          const out = execFileSync(
            process.execPath,
            [scoreTaskJs, result.runJson, String(n), "--tasks-dir", tasksDir],
            { encoding: "utf-8", cwd: repo }
          );
          result.scored = true;
          result.scoreJson = join(runsDir, `task-${n}.score.json`);
          logBuf += "\n--- score-task.mjs ---\n" + out;
        } catch (e) {
          result.scored = false;
          result.scoreError = (e?.stderr?.toString() || e?.message || String(e)).trim().slice(0, 800);
        }
      } else {
        result.scored = false;
        result.scoreError = "no run record was written";
      }
      if (result.scoreError) logBuf += `\n--- score-task.mjs FAILED ---\n${result.scoreError}\n`;
      writeFileSync(logPath, logBuf, "utf-8");
      const ok = code === 0 && result.scored;
      console.log(`# task ${n} ${ok ? "OK" : "FAIL"} exit=${code}${timedOut ? " TIMEOUT" : ""} ${result.wallSeconds}s scored=${result.scored}`);
      done(result);
    });
  });
}

const startedAt = new Date();
const t0 = Date.now();
const queue = [...tasks];
const results = [];
async function worker() {
  for (;;) {
    const n = queue.shift();
    if (n === undefined) return;
    results.push(await runOne(n));
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
results.sort((a, b) => a.task - b.task);

// ── put the untouched roots back ────────────────────────────────────────────
for (const r of rootState) {
  const dir = join(r.root, ".rlmx");
  r.rlmxExistsAfter = existsSync(dir);
  r.createdByThisRound = !r.rlmxExistedBefore && r.rlmxExistsAfter;
  r.cleanedUp = false;
  if (r.createdByThisRound && !opt["--keep-scaffold"]) {
    const entries = readdirSync(dir);
    const unexpected = entries.filter((e) => !SCAFFOLD_ALLOWED.has(e));
    if (unexpected.length) {
      r.cleanupSkipped = `unexpected entries kept: ${unexpected.join(", ")}`;
    } else {
      rmSync(dir, { recursive: true, force: true });
      r.cleanedUp = true;
      r.removed = entries;
    }
  }
}

// ── manifest ────────────────────────────────────────────────────────────────
const failed = results.filter((r) => r.exitCode !== 0 || !r.scored).map((r) => r.task);
const round = {
  ...plan,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  wallSeconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
  perTask: results,
  failedTasks: failed,
  exitCode: failed.length ? 1 : 0,
};
writeFileSync(join(genDir, "round.json"), JSON.stringify(round, null, 2), "utf-8");

// ── summary ─────────────────────────────────────────────────────────────────
let summaryOut = "";
try {
  summaryOut = execFileSync(process.execPath, [join(round2, "summarize-train-round.mjs"), genDir], {
    encoding: "utf-8",
    cwd: repo,
  });
} catch (e) {
  summaryOut = (e?.stdout?.toString() ?? "") + (e?.stderr?.toString() ?? "");
  process.stderr.write(`# summary emitter failed\n`);
}
process.stdout.write(summaryOut);

for (const r of rootState) {
  if (r.createdByThisRound) {
    console.log(`# root ${r.root}: .rlmx/ ${r.cleanedUp ? `created by this round and removed (${r.removed.join(", ")})` : `created by this round and KEPT — ${r.cleanupSkipped ?? "--keep-scaffold"}`}`);
  }
}
console.log(`# round.json → ${join(genDir, "round.json")}`);
if (failed.length) {
  console.error(`# gen-${gen} FAILED: task(s) ${failed.join(", ")} (logs in ${logsDir})`);
  process.exit(1);
}
process.exit(0);
