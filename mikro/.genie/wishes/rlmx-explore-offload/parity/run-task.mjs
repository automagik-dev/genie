#!/usr/bin/env node
/**
 * run-task.mjs — drive one mined parity task through the real MCP path.
 *
 * Same shape as scripts/smoke-explore.mjs: an MCP SDK client over
 * `node dist/src/cli.js mcp --dir <task root>`, calling `rlmx_explore` with the
 * task's verbatim question. The difference is the install root — the recipe
 * goes into a scratch HOME's `~/.rlmx/agents/explore/` (discovery root #1,
 * src/mcp/agents.ts:56-68) rather than into the task repo, because the task
 * repos are the user's other checkouts and the gate must not write in them.
 * No `RLMX_AGENTS_DIR` override by default: the discovery path stays the real
 * one. (Gate extension: a caller-provided `RLMX_AGENTS_DIR` in the
 * environment is honored and replaces the default roots entirely — used by
 * the rlmx-v2-prime-backend gate, wish decision D5.)
 *
 *   node run-task.mjs <taskNumber> <model> <roundLabel>
 *        [--tasks-dir <dir>] [--recipe <dir>] [--agent <name>]
 *        [--out-dir <dir>] [--pin-child-model]
 *
 * Writes the verbatim result to parity/runs/<round>/task-<n>.json.
 *
 * **Every flag defaults to what this script did before the flag existed.** An
 * invocation with none of them drives `examples/agents/explore/` through
 * `rlmx_explore` against `<wish>/tasks/`, writes to `parity/runs/<round>/`, and
 * puts no `settings.json` in the scratch HOME — i.e. the frozen gate is
 * reproduced by the same command line it always used. The flags exist so
 * round 2's optimizer can drive a *different* recipe over a *different* suite
 * into a *different* output tree without a second copy of this driver drifting
 * away from it (round2/run-train-round.mjs is that caller).
 *
 * `--tasks-dir` defaults to the frozen eval suite, `<wish>/tasks`. It exists
 * because round 2 has a second suite — `parity/round2/train-tasks/`, the
 * training input the optimizer selects on — and without an argument the runner
 * could only ever drive the frozen six. Two consequences worth stating:
 *
 *   - The round label is the only thing separating one suite's runs from
 *     another's under `parity/runs/`. Use a label that names the suite, and
 *     read `record.tasksDir` (recorded on every run) if you have to tell them
 *     apart after the fact.
 *   - **Pointing this at the frozen suite is the only way to produce a gate
 *     number.** A training-suite run is a training-suite run; nothing about
 *     this flag makes the two comparable, and the train tasks carry no native
 *     arm to compare against (see round2/train-tasks/README.md).
 *
 * `--recipe` is what lets a second recipe be driven at all. `--agent` names the
 * directory it is installed into, and the tool called is `rlmx_<agent>` — the
 * MCP server derives the tool name from the agent directory (src/mcp/agents.ts),
 * so the two cannot be chosen independently.
 *
 * `--pin-child-model` writes `~/.rlmx/settings.json` into the scratch HOME
 * pinning `model.provider` / `model.model` / `model.sub-call-model` to `<model>`.
 * Since 6ec4822 a recursive child is pinned by `--model` on its own argv
 * (src/llm.ts:464, src/cli.ts:328-335), so this is belt-and-braces: it only
 * decides anything if a child is ever spawned without that flag, which is
 * exactly the silent-empty-answer failure of round 1 (recursion-recon.md §2.2).
 * It is off by default because the frozen gate ran without it.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const parityDir = __dirname;
const wishDir = resolve(parityDir, "..");
const repo = resolve(wishDir, "..", "..", "..");
const cli = join(repo, "dist", "src", "cli.js");

const argv = process.argv.slice(2);

/**
 * Value flags. Order-independent, each may appear once, and each falls back to
 * the constant this script used before it was a flag — so the no-flag command
 * line is unchanged in every observable way.
 */
const VALUE_FLAGS = {
  "--tasks-dir": "directory",
  "--recipe": "directory",
  "--agent": "name",
  "--out-dir": "directory",
  // Gate extension (wish rlmx-v2-prime-backend, Group 3): override the task
  // root extracted from the task file. The frozen suite records Linux-host
  // roots that are re-pointed by a recorded gate decision (D1 in
  // gate-report.md); the task files themselves stay untouched.
  "--root": "directory",
};
const flags = {};
for (;;) {
  const at = argv.findIndex((a) => a in VALUE_FLAGS);
  if (at < 0) break;
  const name = argv[at];
  const value = argv[at + 1];
  if (!value || value.startsWith("--")) {
    console.error(`${name} requires a ${VALUE_FLAGS[name]}`);
    process.exit(2);
  }
  flags[name] = value;
  argv.splice(at, 2);
}
const pinAt = argv.indexOf("--pin-child-model");
const pinChildModel = pinAt >= 0;
if (pinAt >= 0) argv.splice(pinAt, 1);

const [taskArg, model, round] = argv;
if (!taskArg || !model || !round) {
  console.error(
    "usage: run-task.mjs <taskNumber> <model> <roundLabel> [--tasks-dir <dir>] " +
      "[--recipe <dir>] [--agent <name>] [--out-dir <dir>] [--root <dir>] [--pin-child-model]"
  );
  process.exit(2);
}

const tasksDirArg = flags["--tasks-dir"] ?? null;
const recipe = flags["--recipe"] ? resolve(flags["--recipe"]) : join(repo, "examples", "agents", "explore");
const agentName = flags["--agent"] ?? "explore";
const tool = `rlmx_${agentName}`;
for (const f of ["SYSTEM.md", "agent.yaml"]) {
  if (!existsSync(join(recipe, f))) {
    console.error(`recipe ${recipe}: missing ${f}`);
    process.exit(2);
  }
}

const tasksDir = tasksDirArg ? resolve(tasksDirArg) : join(wishDir, "tasks");
const taskFile = join(tasksDir, `${taskArg}.md`);
if (!existsSync(taskFile)) {
  console.error(`task ${taskArg}: no such file ${taskFile}`);
  process.exit(2);
}
const taskText = readFileSync(taskFile, "utf-8");
const rootFrozen = /\| Task root \(the rlmx arm's `--dir`\) \| `([^`]+)` \|/.exec(taskText)?.[1];
// Gate extension: `--root` re-points the task root (recorded gate decision,
// never an edit of the task file). Without the flag the frozen root is used —
// the command line is byte-for-byte what it always was.
const root = flags["--root"] ? resolve(flags["--root"]) : rootFrozen;
/**
 * Both suites' question headings, and only those two.
 *
 * A mined task's heading says "verbatim from the transcript" because the
 * question is a line somebody actually typed; an authored training task says
 * "authored for the training suite" because it is not, and the file refuses to
 * borrow the mined suite's wording for something that was written. That is a
 * deliberate distinction (scripts/author-explore-tasks.mjs), so the runner
 * matches the two forms by name rather than accepting any `## Question (…)` —
 * a wildcard here would let a third, unaudited provenance through silently.
 */
const question =
  /## Question \((?:verbatim from the transcript|authored for the training suite)\)\n\n```text\n([\s\S]*?)\n```\n/.exec(
    taskText
  )?.[1];
if (!root || !question) {
  console.error(
    `task ${taskArg}: could not extract root/question from ${taskFile}\n` +
      `  root:     ${root ? "ok" : "missing `| Task root (the rlmx arm's \\`--dir\\`) | \\`…\\` |` row"}\n` +
      `  question: ${question ? "ok" : "missing a fenced `## Question (verbatim from the transcript|authored for the training suite)` section"}`
  );
  process.exit(2);
}

/** Scratch HOME per round+task: the recipe is installed at its global root. */
const home = join(tmpdir(), `rlmx-parity-${round}-t${taskArg}`);
const installed = join(home, ".rlmx", "agents", agentName);
mkdirSync(installed, { recursive: true });
cpSync(join(recipe, "SYSTEM.md"), join(installed, "SYSTEM.md"));
const yaml = readFileSync(join(recipe, "agent.yaml"), "utf-8");
const installedYaml = yaml.replace(/^model:.*$/m, `model: ${model}`);
writeFileSync(join(installed, "agent.yaml"), installedYaml, "utf-8");

/**
 * Optional child-model pin — see the header. `<provider>/<model>` splits on the
 * first slash, matching src/config.ts:parseModelRef; a bare model id keeps
 * whatever provider the child resolves and only pins the ids. No key is
 * written: KHAL_API_KEY reaches the child through the environment
 * (src/llm.ts:buildChildEnv passes the whole of process.env).
 */
let childModelPin = null;
if (pinChildModel) {
  const slash = model.indexOf("/");
  const provider = slash > 0 ? model.slice(0, slash) : null;
  const modelId = slash > 0 ? model.slice(slash + 1) : model;
  childModelPin = {
    ...(provider ? { "model.provider": provider } : {}),
    "model.model": modelId,
    "model.sub-call-model": modelId,
  };
  writeFileSync(join(home, ".rlmx", "settings.json"), JSON.stringify(childModelPin, null, 2) + "\n", "utf-8");
}

/**
 * Provenance the run cannot be re-derived without (added after the gate; rounds
 * r1–r15 carry none of it — see the report's Method section).
 *
 *   prompt  — SHA-256 of the exact SYSTEM.md and agent.yaml this run ran under,
 *             so "what changed in round N" is checkable rather than prose. The
 *             SYSTEM.md body is also snapshotted under parity/prompts/<sha>.md.
 *   root    — the task tree's git HEAD, so a citation that resolved at run time
 *             can be re-resolved against the tree the model actually read. The
 *             task roots are live checkouts and they move.
 */
const sha = (s) => createHash("sha256").update(s).digest("hex");
const systemText = readFileSync(join(recipe, "SYSTEM.md"), "utf-8");
const promptDigest = sha(systemText);
const promptsDir = join(parityDir, "prompts");
mkdirSync(promptsDir, { recursive: true });
writeFileSync(join(promptsDir, `${promptDigest}.md`), systemText, "utf-8");

function gitState(dir) {
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8" }).trim();
  try {
    // Each probe is isolated: a checkout whose tree trips `git status`
    // (e.g. a symlinked `docs` path git refuses) must not cost the head —
    // the SHA is what makes a run re-resolvable.
    const head = git("rev-parse", "HEAD");
    let branch = null;
    let dirty = null;
    let statusError = null;
    try {
      branch = git("rev-parse", "--abbrev-ref", "HEAD");
    } catch (e) {
      branch = null;
    }
    try {
      dirty = git("status", "--porcelain").length > 0;
    } catch (e) {
      statusError = e?.message ?? String(e);
    }
    return { head, branch, dirty, statusError };
  } catch (e) {
    return { head: null, error: e?.message ?? String(e) };
  }
}

const provenance = {
  promptSha256: promptDigest,
  promptChars: systemText.length,
  promptSnapshot: `parity/prompts/${promptDigest}.md`,
  // Digest of the installed (model-rewritten) agent.yaml — the file that ran.
  agentYamlSha256: sha(installedYaml),
  rootGit: gitState(root),
  // Gate extension: the frozen root named in the task file, when `--root`
  // re-pointed it (null = no re-pointing).
  rootFrozen,
  rlmxGit: gitState(repo),
  // Which recipe ran, under which tool name, with which harness corrections.
  // The two timeouts are recorded rather than set here: they are environment
  // corrections the caller owns (round2/run-train-round.mjs exports both), and
  // a run that silently set its own would hide which wall it was under.
  // RLMX_REPL_TIMEOUT_MS in particular decides whether a fan-out can finish at
  // all (recursion-recon.md §4.1) — `null` here means the 30s default.
  recipeDir: recipe,
  agent: agentName,
  tool,
  childModelPin,
  replTimeoutMs: process.env.RLMX_REPL_TIMEOUT_MS ?? null,
  runTimeoutMs: process.env.RLMX_MCP_RUN_TIMEOUT_MS ?? null,
};

const outDir = flags["--out-dir"] ? resolve(flags["--out-dir"]) : join(parityDir, "runs", round);
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `task-${taskArg}.json`);

/**
 * A re-run into an existing round label silently replaced the run JSON while
 * the score JSON beside it kept describing the run that had already been
 * scored — the published matrix then mixed columns from two different runs
 * (seven rows of the first gate did exactly this). A re-run is a new round;
 * say so, or pass PARITY_OVERWRITE=1 deliberately.
 */
if (existsSync(outFile) && process.env.PARITY_OVERWRITE !== "1") {
  console.error(
    `refusing to overwrite ${outFile}\n` +
      `  that run is already recorded (and probably already scored).\n` +
      `  use a new round label, or set PARITY_OVERWRITE=1 and re-score the round.`
  );
  process.exit(3);
}

/**
 * MCP client clocks. `timeout` is per-progress (it resets on every progress
 * notification), so it is really "how long may the run go silent". A recursive
 * fan-out is silent for the whole blocking wave — 205s in the round-2 smoke,
 * and longer with two tasks contending — so a recursive round raises it via
 * PARITY_CALL_TIMEOUT_MS. Unset, both numbers are the frozen gate's.
 */
const CALL_TIMEOUT_MS = Number(process.env.PARITY_CALL_TIMEOUT_MS ?? 300_000);
const MAX_TOTAL_TIMEOUT_MS = Number(process.env.PARITY_MAX_TOTAL_TIMEOUT_MS ?? 2_400_000);
provenance.callTimeoutMs = CALL_TIMEOUT_MS;
provenance.maxTotalTimeoutMs = MAX_TOTAL_TIMEOUT_MS;

const progress = [];
// Gate extension: callTool→first-progress and connect→tools-listed clocks,
// recorded in the run JSON as serverReadyMs / firstProgressMs. Both backends'
// first progress is "iteration 1" emitted before the first model reply, so
// the delta is the per-leg run-startup overhead (server boot + engine start
// for legacy; that plus the prime subprocess spawn for prime).
let callStartedMs = 0;
const LIVE_OPTS = {
  timeout: CALL_TIMEOUT_MS,
  resetTimeoutOnProgress: true,
  maxTotalTimeout: MAX_TOTAL_TIMEOUT_MS,
  onprogress: (p) => {
    if (callStartedMs > 0 && !record.firstProgressMs) {
      record.firstProgressMs = Date.now() - callStartedMs;
    }
    progress.push(p.message ?? `progress ${p.progress}`);
    process.stderr.write(`[t${taskArg}] ${p.message ?? p.progress}\n`);
  },
};

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli, "mcp", "--dir", root],
  cwd: tmpdir(),
  // Gate extension (wish rlmx-v2-prime-backend, Group 3): honor a
  // caller-provided RLMX_AGENTS_DIR, which replaces the default discovery
  // roots entirely (src/mcp/agents.ts:83-90) and makes the run hermetic.
  // Unset, the frozen-gate value "" is passed through exactly as before.
  env: { ...process.env, HOME: home, RLMX_AGENTS_DIR: process.env.RLMX_AGENTS_DIR ?? "" },
  stderr: "pipe",
});

const client = new Client({ name: "rlmx-parity", version: "1.0.0" }, { capabilities: {} });
let record = {
  task: Number(taskArg),
  // Which suite this run came from. Without it, two suites sharing a round
  // label are indistinguishable in parity/runs/ — and one of them is the gate.
  tasksDir,
  taskFile,
  suite: tasksDir === join(wishDir, "tasks") ? "frozen-eval" : "other",
  root,
  model,
  round,
  startedAt: new Date().toISOString(),
  question,
  provenance,
};

const started = Date.now();
try {
  const connectStarted = Date.now();
  await client.connect(transport);
  let stderrBuf = "";
  transport.stderr?.on("data", (chunk) => {
    stderrBuf += chunk.toString();
  });

  const { tools } = await client.listTools();
  record.serverReadyMs = Date.now() - connectStarted;
  record.toolsListed = tools.map((t) => t.name);
  if (!tools.some((t) => t.name === tool)) {
    throw new Error(`${tool} not listed; got ${record.toolsListed.join(", ")}`);
  }

  const args = { prompt: question };
  callStartedMs = Date.now();
  const res = await client.callTool({ name: tool, arguments: args }, undefined, LIVE_OPTS);
  const elapsed = Date.now() - started;
  const text = res?.content?.[0]?.text ?? "";
  const split = text.lastIndexOf("\n---\n");
  const answer = split >= 0 ? text.slice(0, split) : text;
  const footer = split >= 0 ? text.slice(split + 5).trim() : "";

  record = {
    ...record,
    ok: !res.isError,
    isError: Boolean(res.isError),
    wallSeconds: Number((elapsed / 1000).toFixed(1)),
    requestChars: JSON.stringify(args).length,
    resultChars: text.length,
    answer,
    footer,
    fullText: text,
    structuredContent: res.structuredContent ?? null,
    progress,
    stderr: stderrBuf.slice(-4000),
  };
} catch (err) {
  record = {
    ...record,
    ok: false,
    isError: true,
    wallSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    error: err?.message ?? String(err),
    progress,
  };
} finally {
  try {
    await client.close();
  } catch {
    /* already dead */
  }
}

writeFileSync(outFile, JSON.stringify(record, null, 2), "utf-8");
process.stdout.write(
  `task ${taskArg} ${record.ok ? "OK" : "ERR"} ${record.wallSeconds}s → ${outFile}\n${record.footer ?? record.error ?? ""}\n`
);
process.exit(record.ok ? 0 : 1);
