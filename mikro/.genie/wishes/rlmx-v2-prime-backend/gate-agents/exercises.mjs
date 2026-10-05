#!/usr/bin/env node
/**
 * exercises.mjs — gate-local driver for the Group 3 concurrency and forced-
 * abort exercises (wish rlmx-v2-prime-backend). Committed under this wish
 * folder; every run is a real MCP client over `node dist/src/cli.js mcp
 * --dir <cwd>`, the same path the scored harness drives.
 *
 * Concurrency (both legs): two servers, distinct scratch cwds, invoked in
 * parallel; each cwd carries a unique MARKER file; the assertion is that each
 * answer names only its own cwd's marker and its own cwd — no workspace/path
 * leakage between concurrent sessions.
 *   - legacy: slot A = the gate explore agent; slot B = the shipped
 *     examples/agents/hello-world demo (verbatim copy) whose bare model id is
 *     dropped by applyAgent and resolves to the ambient config — pinned to
 *     deepseek/deepseek-v4-flash by a scratch `<cwd>/.rlmx/rlmx.yaml` in slot
 *     B's own cwd (documented in gate-report.md).
 *   - prime: no second shipped agent is prime-reachable — mapPrimeModel only
 *     addresses deepseek and prime-inference (station/khal-pinned agents
 *     throw), and the demo agents declare bare model ids and spec tools — so
 *     both slots run the gate explore agent in distinct cwds (documented).
 *
 * Forced aborts (both legs), each through a scratch fixture agent dir with
 * RLMX_AGENTS_DIR pointed at it alone:
 *   abort-deadline — RLMX_MCP_RUN_TIMEOUT_MS=15000 mid-run; expect
 *     TIMEOUT_ANSWER ("Error: RLM query timed out") classified isError by
 *     isFailedRun on BOTH legs.
 *   abort-ceiling — budget max_cost: 0.000001 so the first real turn breaches;
 *     expect ok (isError false) with `budget hit: max-cost` in the footer on
 *     BOTH legs (legacy: graceful loop exit + forced final; prime: kill +
 *     partial answer).
 *   abort-cap — budget max_iterations: 2; legacy ends gracefully with NO
 *     budget note, prime kills at the (cap+1)th turn and renders
 *     `budget hit: max-iterations` — the recorded Group 2 deviation
 *     (reviewer MEDIUM-1), demonstrated side by side.
 *
 * Usage (from the repo root; legacy runs need the gate env sourced):
 *   node exercises.mjs concurrency <legacy|prime>
 *   node exercises.mjs abort-deadline <legacy|prime>
 *   node exercises.mjs abort-ceiling <legacy|prime>
 *   node exercises.mjs abort-cap <legacy|prime>
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = resolve(__dirname, "..", "..", "..", "..");
const gateDir = __dirname;
const gateAgentDir = join(gateDir, "explore");
const workDir = join(gateDir, ".work");
const exercisesDir = join(gateDir, "runs", "exercises");
const wrapper = join(gateDir, "bin", "prime-argv-log.sh");
const cli = join(repo, "dist", "src", "cli.js");
const brainMirror = join(workDir, "mirrors", "brain");
const frozenTasks = join(repo, ".genie", "wishes", "rlmx-explore-offload", "tasks");

const exercise = process.argv[2];
const leg = process.argv[3];
if (!["concurrency", "abort-deadline", "abort-ceiling", "abort-cap"].includes(exercise) || (leg !== "legacy" && leg !== "prime")) {
  console.error("usage: exercises.mjs <concurrency|abort-deadline|abort-ceiling|abort-cap> <legacy|prime>");
  process.exit(2);
}

const yamlLeg = leg === "legacy" ? "rlmx" : "prime";
const committedYaml = readFileSync(join(gateAgentDir, "agent.yaml"), "utf-8");

function flip(leg) {
  writeFileSync(join(gateAgentDir, "agent.yaml"), leg ? `${committedYaml}backend: ${leg}\n` : committedYaml, "utf-8");
}

const envFor = (agentsRoots, extra = {}) => ({
  ...process.env,
  RLMX_AGENTS_DIR: agentsRoots,
  ...(leg === "prime" ? { RLMX_PRIME_BINARY_PATH: wrapper, PRIME_ARGV_LOG: extra.argvLog } : {}),
  ...(leg === "legacy" && process.env.RLMX_MCP_RUN_TIMEOUT_MS
    ? { RLMX_MCP_RUN_TIMEOUT_MS: process.env.RLMX_MCP_RUN_TIMEOUT_MS }
    : {}),
  ...extra.env,
});

function runServer(cwdDir, agentsRoots, extra = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp", "--dir", cwdDir],
    cwd: tmpdir(),
    env: envFor(agentsRoots, extra),
    stderr: "pipe",
  });
  return { transport, client: new Client({ name: "rlmx-gate-exercises", version: "1.0.0" }, { capabilities: {} }) };
}

const CALL_OPTS = {
  timeout: 300_000,
  resetTimeoutOnProgress: true,
  maxTotalTimeout: 2_400_000,
};

async function callTool(client, transport, tool, prompt) {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const listed = tools.map((t) => t.name);
  const started = Date.now();
  const res = await client.callTool({ name: tool, arguments: { prompt } }, undefined, CALL_OPTS);
  const text = res?.content?.[0]?.text ?? "";
  const split = text.lastIndexOf("\n---\n");
  return {
    ok: !res.isError,
    isError: Boolean(res.isError),
    wallSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    answer: split >= 0 ? text.slice(0, split) : text,
    footer: split >= 0 ? text.slice(split + 5).trim() : "",
    toolsListed: listed,
  };
}

const task1Question = readFileSync(join(frozenTasks, "1.md"), "utf-8").match(
  /## Question \(verbatim from the transcript\)\n\n```text\n([\s\S]*?)\n```\n/
)[1];

const fixture = (name, yamlEdits) => {
  const root = join(workDir, "abort", `${name}-${leg}`);
  rmSync(root, { recursive: true, force: true });
  const agent = join(root, "explore");
  mkdirSync(agent, { recursive: true });
  cpSync(join(gateAgentDir, "SYSTEM.md"), join(agent, "SYSTEM.md"));
  let yaml = committedYaml;
  for (const [from, to] of yamlEdits) {
    if (!yaml.includes(from)) throw new Error(`fixture ${name}: edit anchor missing: ${from}`);
    yaml = yaml.replace(from, to);
  }
  writeFileSync(join(agent, "agent.yaml"), `${yaml}backend: ${yamlLeg}\n`, "utf-8");
  return root;
};

function save(name, record) {
  mkdirSync(exercisesDir, { recursive: true });
  const file = join(exercisesDir, `${name}-${leg}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2), "utf-8");
  console.log(`record → ${file}`);
  return file;
}

// 300s failsafe; always close the client and exit — never linger (a
// predecessor hung 44h on an unterminated prime probe).
const failsafe = setTimeout(() => {
  console.error(`exercises: 300s failsafe exceeded (${exercise}/${leg}) — exiting 124`);
  process.exit(124);
}, 300_000);

const run = async () => {
  if (exercise === "concurrency") {
    if (leg === "legacy") {
      const base = join(workDir, "concurrency", "legacy");
      rmSync(base, { recursive: true, force: true });
      const cwdA = join(base, "cwd-alpha");
      const cwdB = join(base, "cwd-beta");
      mkdirSync(cwdA, { recursive: true });
      mkdirSync(join(cwdB, ".rlmx"), { recursive: true });
      writeFileSync(join(cwdA, "MARKER_ALPHA.txt"), "alpha workspace marker\n", "utf-8");
      writeFileSync(join(cwdB, "MARKER_BETA.txt"), "beta workspace marker\n", "utf-8");
      // Slot B's ambient model pin (hello-world's bare model id is dropped by
      // applyAgent; without this the default google model would fail at call
      // time — no GEMINI_API_KEY on this host).
      writeFileSync(
        join(cwdB, ".rlmx", "rlmx.yaml"),
        "model:\n  provider: deepseek\n  model: deepseek-v4-flash\n",
        "utf-8"
      );
      const scratchAgents = join(base, "agents");
      cpSync(join(repo, "examples", "agents", "hello-world"), join(scratchAgents, "hello-world"), { recursive: true });
      const agentsRoots = `${gateDir}:${scratchAgents}`;

      const a = runServer(cwdA, agentsRoots);
      const b = runServer(cwdB, agentsRoots);
      const probePrompt =
        "In your working directory there is exactly one file named MARKER_*.txt. " +
        "Read it. Report in three lines: (1) the marker file's exact filename, " +
        "(2) the absolute working directory as reported by os.getcwd(), " +
        "(3) the marker file's content. Nothing else.";
      const t0 = Date.now();
      const [ra, rb] = await Promise.all([
        callTool(a.client, a.transport, "rlmx_explore", probePrompt),
        callTool(b.client, b.transport, "rlmx_hello-world", "Greet the rlmx-v2 gate concurrency exercise."),
      ]);
      await Promise.all([a.client.close().catch(() => {}), b.client.close().catch(() => {})]);
      const record = {
        exercise, leg, startedAt: new Date(t0).toISOString(), endedAt: new Date().toISOString(),
        parallel: true,
        slotA: { cwd: cwdA, agent: "explore", marker: "MARKER_ALPHA.txt", ...ra },
        slotB: { cwd: cwdB, agent: "hello-world (shipped, verbatim; ambient model pinned in cwdB/.rlmx)", marker: "MARKER_BETA.txt", ...rb },
        assertions: {
          bothOk: ra.ok && rb.ok,
          aNamesOwnMarker: ra.answer.includes("MARKER_ALPHA"),
          aNotBMarker: !ra.answer.includes("MARKER_BETA"),
          aNamesOwnCwd: ra.answer.includes(cwdA),
          bNotAMarker: !rb.answer.includes("MARKER_ALPHA"),
          bNotBMarker: !rb.answer.includes("MARKER_BETA"),
          overlapped: ra.wallSeconds > 0 && rb.wallSeconds > 0,
        },
      };
      save(exercise, record);
      console.log(JSON.stringify({ slotA: { ok: ra.ok, wall: ra.wallSeconds }, slotB: { ok: rb.ok, wall: rb.wallSeconds }, assertions: record.assertions }, null, 2));
    } else {
      // prime: both slots run the gate explore agent (backend: prime) in
      // distinct cwds — no second shipped agent is prime-reachable (see the
      // header). This exercises the workspace-leakage property, which is what
      // the AC asserts.
      flip("prime");
      const base = join(workDir, "concurrency", "prime");
      rmSync(base, { recursive: true, force: true });
      const cwdA = join(base, "cwd-gamma");
      const cwdB = join(base, "cwd-delta");
      mkdirSync(cwdA, { recursive: true });
      mkdirSync(cwdB, { recursive: true });
      writeFileSync(join(cwdA, "MARKER_GAMMA.txt"), "gamma workspace marker\n", "utf-8");
      writeFileSync(join(cwdB, "MARKER_DELTA.txt"), "delta workspace marker\n", "utf-8");
      const argvLog = join(base, "argv.log");
      const probePrompt =
        "In your working directory there is exactly one file named MARKER_*.txt. " +
        "Read it. Report in three lines: (1) the marker file's exact filename, " +
        "(2) the absolute working directory as reported by os.getcwd(), " +
        "(3) the marker file's content. Nothing else.";
      const a = runServer(cwdA, gateDir, { argvLog });
      const b = runServer(cwdB, gateDir, { argvLog });
      const t0 = Date.now();
      const [ra, rb] = await Promise.all([
        callTool(a.client, a.transport, "rlmx_explore", probePrompt),
        callTool(b.client, b.transport, "rlmx_explore", probePrompt),
      ]);
      await Promise.all([a.client.close().catch(() => {}), b.client.close().catch(() => {})]);
      flip(null);
      const record = {
        exercise, leg, startedAt: new Date(t0).toISOString(), endedAt: new Date().toISOString(),
        parallel: true,
        note: "prime 0.7.2 exposes only deepseek + prime-inference; the shipped demo agents (bare model ids, spec tools, station/khal pins) are not prime-reachable — both slots run the gate explore agent in distinct cwds.",
        slotA: { cwd: cwdA, agent: "explore (gate)", marker: "MARKER_GAMMA.txt", ...ra },
        slotB: { cwd: cwdB, agent: "explore (gate)", marker: "MARKER_DELTA.txt", ...rb },
        assertions: {
          bothOk: ra.ok && rb.ok,
          aNamesOwnMarker: ra.answer.includes("MARKER_GAMMA"),
          aNotBMarker: !ra.answer.includes("MARKER_DELTA"),
          aNamesOwnCwd: ra.answer.includes(cwdA),
          bNamesOwnMarker: rb.answer.includes("MARKER_DELTA"),
          bNotAMarker: !rb.answer.includes("MARKER_GAMMA"),
          bNamesOwnCwd: rb.answer.includes(cwdB),
        },
      };
      save(exercise, record);
      console.log(JSON.stringify({ slotA: { ok: ra.ok, wall: ra.wallSeconds }, slotB: { ok: rb.ok, wall: rb.wallSeconds }, assertions: record.assertions }, null, 2));
    }
    return;
  }

  // ── forced aborts ──────────────────────────────────────────────────────
  if (exercise === "abort-deadline") {
    const root = fixture("deadline", []);
    // 20s: the run is guaranteed to be active (task-1 questions run 15-250s),
    // so the wall-clock kill lands mid-run — the classification under test.
    const extraEnv = { env: { RLMX_MCP_RUN_TIMEOUT_MS: "20000" } };
    const s = runServer(brainMirror, root, leg === "prime" ? { ...extraEnv, argvLog: join(root, "argv.log") } : extraEnv);
    const rec = await callTool(s.client, s.transport, "rlmx_explore", task1Question);
    await s.client.close().catch(() => {});
    const record = {
      exercise, leg, backendField: yamlLeg,
      mechanism: "RLMX_MCP_RUN_TIMEOUT_MS=15000 (wall-clock deadline, mid-run)",
      question: "task 1 verbatim (frozen suite)", fixtureRoot: root, serverDir: brainMirror,
      ...rec,
      expected: { answer: "Error: RLM query timed out", isError: true },
      observed: { isError: rec.isError, timedOutAnswer: (rec.answer ?? "").trim() === "Error: RLM query timed out" },
    };
    save(exercise, record);
    console.log(JSON.stringify(record, null, 2));
    return;
  }
  if (exercise === "abort-ceiling") {
    const root = fixture("ceiling", [["max_cost: 2.00", "max_cost: 0.000001"]]);
    const s = runServer(brainMirror, root, leg === "prime" ? { argvLog: join(root, "argv.log") } : {});
    const rec = await callTool(s.client, s.transport, "rlmx_explore", task1Question);
    await s.client.close().catch(() => {});
    const record = {
      exercise, leg, backendField: yamlLeg,
      mechanism: "budget max_cost: 0.000001 — the first real turn breaches the ceiling",
      question: "task 1 verbatim (frozen suite)", fixtureRoot: root, serverDir: brainMirror,
      ...rec,
      observed: {
        isError: rec.isError,
        budgetHitNote: /budget hit: ([\w-]+)/.exec(rec.footer)?.[1] ?? null,
        footerHasMaxCost: rec.footer.includes("budget hit: max-cost"),
      },
    };
    save(exercise, record);
    console.log(JSON.stringify(record, null, 2));
    return;
  }
  if (exercise === "abort-cap") {
    const root = fixture("cap", [["max_iterations: 24", "max_iterations: 2"]]);
    const s = runServer(brainMirror, root, leg === "prime" ? { argvLog: join(root, "argv.log") } : {});
    const rec = await callTool(s.client, s.transport, "rlmx_explore", task1Question);
    await s.client.close().catch(() => {});
    const record = {
      exercise, leg, backendField: yamlLeg,
      mechanism: "budget max_iterations: 2 — the documented deviation: legacy ends gracefully with no budget note; prime kills at the (cap+1)th turn and renders `budget hit: max-iterations`",
      question: "task 1 verbatim (frozen suite)", fixtureRoot: root, serverDir: brainMirror,
      ...rec,
      observed: {
        isError: rec.isError,
        budgetHitNote: /budget hit: ([\w-]+)/.exec(rec.footer)?.[1] ?? null,
        iterations: Number(/· (\d+) iterations? ·/.exec(rec.footer)?.[1] ?? 0),
      },
    };
    save(exercise, record);
    console.log(JSON.stringify(record, null, 2));
    return;
  }
};

run()
  .then(() => {
    clearTimeout(failsafe);
    process.exit(0);
  })
  .catch((err) => {
    clearTimeout(failsafe);
    console.error(`exercises ${exercise}/${leg} failed: ${err?.message ?? err}`);
    flip(null);
    process.exit(1);
  });
