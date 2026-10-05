#!/usr/bin/env node
/**
 * run-gate.mjs — gate-local driver for the rlmx-v2-prime-backend parity gate
 * (Group 3). Committed under this wish folder; the scored workload is the
 * frozen six-task parity suite (docs/parity-explore.md) driven through the
 * real MCP path by the existing harness
 * `.genie/wishes/rlmx-explore-offload/parity/run-task.mjs`.
 *
 * What this driver adds on top of the harness, per the recorded gate
 * decisions in gate-report.md:
 *
 *   - D1 root re-pointing: the frozen task files name Linux-host roots. The
 *     driver maps them (ROOT_MAP) and passes the local checkout to the
 *     harness via its `--root` flag — the task files are never edited.
 *   - D6 mirror cwds: the server's `--dir` IS its cwd, and `loadConfig(cwd)`
 *     loads `<cwd>/.rlmx/` — and every root involved (brain, genie, and this
 *     repo) ships a `.rlmx/` with a parseable TOOLS.md tool, which prime's
 *     landed backend rejects loudly (`assertSupportedConfig`). The driver
 *     builds a scratch **mirror** per root: symlinks to every top-level
 *     entry except `.rlmx`, so `loadConfig` finds nothing and both legs run
 *     on identical default config while the REPL reads the real tree (the
 *     `.git` symlink keeps `rootGit` recorded from the checkout itself).
 *   - One gate agent directory, two legs: `backend: rlmx` / `backend: prime`
 *     is flipped in gate-agents/explore/agent.yaml per leg and restored to
 *     the committed one-line-diff state afterwards.
 *   - RLMX_AGENTS_DIR is pointed at the gate directory only, replacing the
 *     default discovery roots entirely (src/mcp/agents.ts:83) — hermetic.
 *   - Prime leg argv observation: RLMX_PRIME_BINARY_PATH points at
 *     bin/prime-argv-log.sh so every spawn (including the `--version` pin
 *     probe) is logged to PRIME_ARGV_LOG.
 *
 * Usage (run from the repo root, legacy env sourced for the legacy leg):
 *   node run-gate.mjs mirror                     build mirrors, no model calls
 *   node run-gate.mjs probe <legacy|prime>       resolved-model pre-flight
 *   node run-gate.mjs scored <legacy|prime>      the six scored tasks
 *   node run-gate.mjs score <legacy|prime>       mechanical rubric c2/c3
 *   node run-gate.mjs restore                    restore the committed yaml
 *   node run-gate.mjs verify                     pre-run hermeticity checks
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  lstatSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = resolve(__dirname, "..", "..", "..", "..");
const gateDir = __dirname;
const gateAgentDir = join(gateDir, "explore");
const workDir = join(gateDir, ".work");
const runsDir = join(gateDir, "runs");
const probesDir = join(gateDir, "probes");
const frozenTasks = join(repo, ".genie", "wishes", "rlmx-explore-offload", "tasks");
const parityDir = join(repo, ".genie", "wishes", "rlmx-explore-offload", "parity");
const runTask = join(parityDir, "run-task.mjs");
const scoreTask = join(parityDir, "score-task.mjs");
const wrapper = join(gateDir, "bin", "prime-argv-log.sh");

/** Gate model pin — both legs (Decision 7, amended). */
const GATE_MODEL = "deepseek/deepseek-v4-flash";

/** D1: frozen root → re-pointed local checkout (recorded in gate-report.md). */
const ROOT_MAP = {
  "/home/namastex/prod/brain": "/Users/feliperosa/workspace/repos/brain",
  "/home/namastex/workspace/repos/genie": "/Users/feliperosa/workspace/repos/genie",
};

const TASKS = [1, 2, 3, 4, 5, 6];
const cmd = process.argv[2];

const fail = (msg) => {
  console.error(`run-gate: ${msg}`);
  process.exit(2);
};

/** The committed gate agent.yaml (read once, before any flip). */
const committedYaml = readFileSync(join(gateAgentDir, "agent.yaml"), "utf-8");

/** Flip the single backend field; `null` restores the committed state. */
function flipBackend(leg) {
  if (leg === null) {
    writeFileSync(join(gateAgentDir, "agent.yaml"), committedYaml, "utf-8");
    return;
  }
  if (leg !== "rlmx" && leg !== "prime") fail(`unknown backend ${leg}`);
  writeFileSync(join(gateAgentDir, "agent.yaml"), `${committedYaml}backend: ${leg}\n`, "utf-8");
}

/** Fresh argv log for one leg's runs (prime observation channel). */
const argvLogPath = (label) => {
  mkdirSync(join(workDir, "argv-logs"), { recursive: true });
  return join(workDir, "argv-logs", `${label}.log`);
};

/**
 * Symlink mirror of a real tree, minus `.rlmx` (recorded decision D6).
 * `fresh` rebuilds the mirror first: the explore agent is free to write in
 * its cwd, and the first pass proved it does — it scaffolded a `.rlmx` via
 * `rlmx init` mid-run (timestamped 15:32, preserved as evidence). Those
 * writes land in the gitignored mirror, never in the checkout, and a fresh
 * rebuild per scored task keeps every task's config environment identical.
 */
function makeMirror(real, name, fresh = false) {
  const mirror = join(workDir, "mirrors", name);
  if (fresh) rmSync(mirror, { recursive: true, force: true });
  if (!existsSync(mirror)) {
    mkdirSync(mirror, { recursive: true });
    for (const entry of readdirSync(real)) {
      if (entry === ".rlmx") continue; // excluded by D6
      // lstat, not stat: a checkout entry may itself be a (possibly broken)
      // symlink — the mirror must reproduce the entry as-is.
      symlinkSync(join(real, entry), join(mirror, entry), lstatSync(join(real, entry)).isDirectory() ? "dir" : "file");
    }
  }
  return mirror;
}

/** Root row of a frozen task file. */
function frozenRootOf(taskNumber) {
  const text = readFileSync(join(frozenTasks, `${taskNumber}.md`), "utf-8");
  const m = /\| Task root \(the rlmx arm's `--dir`\) \| `([^`]+)` \|/.exec(text);
  return m?.[1] ?? null;
}

/** Frozen → real → mirror for one task; unknown roots abort (D1 is closed). */
function rootsFor(taskNumber, fresh = false) {
  const frozen = frozenRootOf(taskNumber);
  if (!frozen) fail(`task ${taskNumber}: no root row in the frozen task file`);
  const real = ROOT_MAP[frozen];
  if (!real) fail(`task ${taskNumber}: root ${frozen} is not in the recorded D1 map — refusing`);
  const name = frozen.includes("prod/brain") ? "brain" : "genie";
  return { frozen, real, mirror: makeMirror(real, name, fresh) };
}

/** Probes use a mirror of this repo (its .rlmx also parses a TOOLS.md tool). */
function probeMirror() {
  return makeMirror(repo, "rlmx");
}

/** Question extraction, same regex the harness uses (frozen task files). */
function questionOf(taskNumber) {
  const text = readFileSync(join(frozenTasks, `${taskNumber}.md`), "utf-8");
  const m = /## Question \(verbatim from the transcript\)\n\n```text\n([\s\S]*?)\n```\n/.exec(text);
  return m?.[1] ?? null;
}

const round = (leg) => `gate-v2-${leg}`;
const outDir = (leg) => join(runsDir, round(leg));

function envFor(leg, label) {
  const env = { ...process.env, RLMX_AGENTS_DIR: gateDir };
  if (leg === "prime") {
    env.RLMX_PRIME_BINARY_PATH = wrapper;
    env.PRIME_ARGV_LOG = argvLogPath(label);
  }
  return env;
}

// ── mirror ─────────────────────────────────────────────────────────────────
if (cmd === "mirror") {
  for (const t of TASKS) rootsFor(t);
  probeMirror();
  console.log(`mirrors ready under ${join(workDir, "mirrors")}`);
  process.exit(0);
}

// ── verify ────────────────────────────────────────────────────────────────
if (cmd === "verify") {
  const shipped = join(repo, "examples", "agents", "explore");
  const problems = [];
  const out = {};
  const gateSystem = readFileSync(join(gateAgentDir, "SYSTEM.md"), "utf-8");
  const shippedSystem = readFileSync(join(shipped, "SYSTEM.md"), "utf-8");
  out.systemByteIdentical = gateSystem === shippedSystem;
  if (!out.systemByteIdentical) problems.push("SYSTEM.md not byte-identical");
  const gateYaml = readFileSync(join(gateAgentDir, "agent.yaml"), "utf-8");
  const shippedYaml = readFileSync(join(shipped, "agent.yaml"), "utf-8");
  out.yamlDiffLines = shippedYaml.split("\n").filter((l, i) => l !== gateYaml.split("\n")[i]).length;
  if (out.yamlDiffLines !== 1) problems.push(`agent.yaml differs from shipped on ${out.yamlDiffLines} lines (need exactly 1)`);
  if (/^backend:/m.test(gateYaml)) problems.push("agent.yaml carries a backend field in its committed state");
  if (!/^model: deepseek\/deepseek-v4-flash$/m.test(gateYaml)) problems.push("model line is not deepseek/deepseek-v4-flash");
  // D1 heads as recorded at setup (gate-report.md D1 table).
  const D1 = {
    "/Users/feliperosa/workspace/repos/brain": "1c6c9ca",
    "/Users/feliperosa/workspace/repos/genie": "3a7e9ce74",
  };
  for (const t of TASKS) {
    const { frozen, real } = rootsFor(t);
    const head = spawnSync("git", ["-C", real, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout.trim();
    out[`task${t}`] = { frozen, real, head, headMatchesD1: head.startsWith(D1[real]) };
    if (!head.startsWith(D1[real])) problems.push(`task ${t} root ${real} is at ${head}, not the recorded D1 head`);
  }
  out.ok = problems.length === 0;
  out.problems = problems;
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}

// ── probe ─────────────────────────────────────────────────────────────────
if (cmd === "probe") {
  const leg = process.argv[3];
  if (leg !== "legacy" && leg !== "prime") fail("usage: run-gate.mjs probe <legacy|prime>");
  const yamlLeg = leg === "legacy" ? "rlmx" : "prime";
  const label = `probe-${leg}`;
  flipBackend(yamlLeg);
  try {
    const home = mkdtempSync(join(tmpdir(), `rlmx-gate-probe-${leg}-`));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(repo, "dist", "src", "cli.js"), "mcp", "--dir", probeMirror()],
      cwd: tmpdir(),
      env: { ...envFor(leg, label), HOME: home },
      stderr: "pipe",
    });
    const client = new Client({ name: "rlmx-gate-probe", version: "1.0.0" }, { capabilities: {} });
    const failsafe = setTimeout(() => {
      console.error("probe: 120s failsafe exceeded — exiting");
      process.exit(124);
    }, 120_000);
    const QUESTION =
      "In this repository, which file declares the npm package name, and on " +
      "which line? Answer with one path:line citation.";
    let probeFailed = false;
    (async () => {
      const started = Date.now();
      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        const res = await client.callTool(
          { name: "rlmx_explore", arguments: { prompt: QUESTION } },
          undefined,
          { timeout: 120_000, resetTimeoutOnProgress: true, maxTotalTimeout: 120_000 }
        );
        const text = res?.content?.[0]?.text ?? "";
        const split = text.lastIndexOf("\n---\n");
        const answer = split >= 0 ? text.slice(0, split) : text;
        const footer = split >= 0 ? text.slice(split + 5).trim() : "";
        const record = {
          leg,
          backendField: yamlLeg,
          ok: !res.isError,
          isError: Boolean(res.isError),
          wallSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
          question: QUESTION,
          answer,
          footer,
          footerModel: /· ([\w./-]+) · \d+ iteration/.exec(footer)?.[1] ?? null,
          toolsListed: tools.map((t) => t.name),
          cwd: probeMirror(),
          realCwd: repo,
          argvLog: leg === "prime" ? argvLogPath(label) : null,
        };
        if (leg === "prime") {
          record.toolErrorText = res?.isError ? (res?.content?.[0]?.text ?? "isError, no text") : null;
          const logFile = argvLogPath(label);
          if (existsSync(logFile)) {
            const lines = readFileSync(logFile, "utf-8").split("\n").filter(Boolean);
            const runLine = lines.find((l) => l.includes("--mode json")) ?? "";
            record.primeArgv = runLine;
            record.primeVersionProbes = lines.filter((l) => l === "--version").length;
            record.primeModelOk = runLine.includes(`--provider deepseek --model deepseek-v4-flash`);
            record.primeHermeticFlagsOk = ["-nc", "-ne", "-ns", "-np"].every((f) => runLine.includes(f));
            record.primeNoSystemPromptReplace = runLine.includes("--append-system-prompt") && !runLine.includes("--system-prompt");
            record.primeCwdOk = runLine.includes(`--cwd ${probeMirror()}`);
          } else {
            record.primeArgv = null;
            record.primeVersionProbes = 0;
            record.primeModelOk = false;
            record.primeHermeticFlagsOk = false;
            record.primeNoSystemPromptReplace = false;
            record.primeCwdOk = false;
            record.primeSpawnNeverHappened = true;
          }
        }
        mkdirSync(probesDir, { recursive: true });
        writeFileSync(join(probesDir, `${label}.json`), JSON.stringify(record, null, 2), "utf-8");
        console.log(JSON.stringify(record, null, 2));
      } catch (err) {
        console.error(`probe ${leg} failed: ${err?.message ?? err}`);
        probeFailed = true;
      } finally {
        clearTimeout(failsafe);
        await client.close().catch(() => {});
        flipBackend(null);
        process.exit(probeFailed ? 1 : 0); // the harness child tree must never linger
      }
    })();
  } catch (err) {
    flipBackend(null);
    throw err;
  }
}

// ── scored ────────────────────────────────────────────────────────────────
if (cmd === "scored") {
  const leg = process.argv[3];
  if (leg !== "legacy" && leg !== "prime") fail("usage: run-gate.mjs scored <legacy|prime> [taskSubset 1,3,4]");
  // Optional task subset (comma list) — used for the recorded re-runs; the
  // manifest records which subset ran.
  const subset = process.argv[4] ? process.argv[4].split(",").map((n) => Number(n)) : TASKS;
  if (subset.some((n) => !TASKS.includes(n))) fail(`bad task subset ${subset}`);
  const yamlLeg = leg === "legacy" ? "rlmx" : "prime";
  flipBackend(yamlLeg);
  const manifest = { leg, yamlLeg, gateModel: GATE_MODEL, startedAt: new Date().toISOString(), subset, tasks: [] };
  try {
    for (const t of subset) {
      const { frozen, real, mirror } = rootsFor(t, true); // fresh mirror per task (D8)
      const runArgs = [
        runTask, String(t), GATE_MODEL, round(leg),
        "--tasks-dir", frozenTasks,
        "--root", mirror,
        "--recipe", gateAgentDir,
        "--agent", "explore",
        "--out-dir", outDir(leg),
      ];
      console.log(`\n=== task ${t} (${leg}, frozen ${frozen} → ${mirror}) ===`);
      const started = Date.now();
      const res = spawnSync(process.execPath, runArgs, {
        cwd: repo,
        env: envFor(leg, `scored-${leg}`),
        stdio: "inherit",
        timeout: 45 * 60_000, // outer failsafe; the harness caps itself at 40min
      });
      manifest.tasks.push({
        task: t,
        frozenRoot: frozen,
        realRoot: real,
        mirrorRoot: mirror,
        runCommand: `node ${runArgs.join(" ")}`,
        exit: res.status,
        signal: res.signal ?? null,
        wallSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
        timedOut: Boolean(res.signal),
        runFile: join(outDir(leg), `task-${t}.json`),
      });
      if (!existsSync(join(outDir(leg), `task-${t}.json`))) {
        console.error(`task ${t}: no run JSON written`);
      }
      // Score inline, against the re-pointed checkout (D1/D9): the mirror
      // aliases the checkout 1:1 at run start, but the agent mutates its cwd
      // mid-run (it deleted mirror entries — preserved as evidence) and the
      // rubric's task root is the checkout, not the run's scratch.
      const runFile = join(outDir(leg), `task-${t}.json`);
      if (existsSync(runFile)) {
        const scoreRes = spawnSync(
          process.execPath,
          [scoreTask, runFile, String(t), "--tasks-dir", frozenTasks, "--root", real],
          { cwd: repo, encoding: "utf-8" }
        );
        manifest.tasks[manifest.tasks.length - 1].scoreExit = scoreRes.status;
        manifest.tasks[manifest.tasks.length - 1].scoreOutput = scoreRes.stdout.trim() || scoreRes.stderr.trim();
        console.log(`[score t${t}] ${scoreRes.stdout.trim() || scoreRes.stderr.trim()}`);
      }
    }
  } finally {
    flipBackend(null);
  }
  mkdirSync(join(gateDir, "runs"), { recursive: true });
  writeFileSync(join(runsDir, `manifest-${leg}.json`), JSON.stringify(manifest, null, 2), "utf-8");
  console.log(`\nmanifest → ${join(runsDir, `manifest-${leg}.json`)}`);
}

// ── score ─────────────────────────────────────────────────────────────────
if (cmd === "score") {
  const leg = process.argv[3];
  if (leg !== "legacy" && leg !== "prime") fail("usage: run-gate.mjs score <legacy|prime>");
  const outputs = { leg, scoredAt: new Date().toISOString(), tasks: [] };
  for (const t of TASKS) {
    const { real } = rootsFor(t);
    const runFile = join(outDir(leg), `task-${t}.json`);
    const res = spawnSync(
      process.execPath,
      [scoreTask, runFile, String(t), "--tasks-dir", frozenTasks, "--root", real],
      { cwd: repo, encoding: "utf-8" }
    );
    outputs.tasks.push({ task: t, runFile, scoreFile: runFile.replace(/\.json$/, ".score.json"), stdout: res.stdout.trim(), stderr: res.stderr.trim(), exit: res.status });
    console.log(`[t${t}] ${res.stdout.trim() || res.stderr.trim()}`);
  }
  writeFileSync(join(runsDir, `score-outputs-${leg}.json`), JSON.stringify(outputs, null, 2), "utf-8");
}

// ── restore ───────────────────────────────────────────────────────────────
if (cmd === "restore") {
  flipBackend(null);
  const now = readFileSync(join(gateAgentDir, "agent.yaml"), "utf-8");
  console.log(now === committedYaml ? "restored: gate agent.yaml matches the committed blob" : "restore FAILED — yaml does not match");
  process.exit(now === committedYaml ? 0 : 1);
}

if (!["mirror", "verify", "probe", "scored", "score", "restore"].includes(cmd)) {
  fail("usage: run-gate.mjs <mirror|verify|probe <leg>|scored <leg>|score <leg>|restore>");
}
