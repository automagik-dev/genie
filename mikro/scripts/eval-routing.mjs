#!/usr/bin/env node
/**
 * eval-routing.mjs — the B3 routing eval for wish `mikro-microagent-plugin`.
 *
 * WHAT IS BEING MEASURED
 * ----------------------
 * Whether a real Claude Code session, given the `mikro` plugin (its MCP
 * registration plus the `offload-guidance` skill), *chooses* to route an
 * explore-class question to `mikro_explore-r` instead of grinding through the
 * tree with its own tools — and whether it *escalates* back to its own tools
 * when the offloaded run comes back as the campaign's recorded failure.
 *
 * THE ITEM SET IS PRE-REGISTERED AND IMMUTABLE.
 * It was fixed in `.genie/wishes/rlmx-microagent-plugin/WISH.md` (Scope IN →
 * "Routing eval (B3), PRE-REGISTERED here") *before* this script existed:
 *
 *   · 5 prompts  = the `## Question` blocks of round-2 train fitness tasks
 *                  3, 4, 5, 6, 7, verbatim.
 *   · planted    = the recorded gen-4 rep-2 task-5 error answer, replayed as
 *                  the tool result for task 5's question.
 *   · pass bar   = >= 4 of 5 prompts route to `mikro_explore-r`, AND the
 *                  planted case escalates to native tools.
 *
 * Both the prompts and the planted answer are pinned by SHA-256 below and
 * re-verified from the frozen artifacts on every run. Editing an item without
 * editing its digest aborts the run; editing both is a visible diff in this
 * file. That is the whole anti-tampering mechanism, and it is deliberately
 * mechanical rather than a promise.
 *
 * HARNESS FIDELITY — WHAT IS REAL AND WHAT IS NOT
 * -----------------------------------------------
 * Real: the session (`claude -p`, a real model, real system prompt), the
 * plugin (staged from `plugins/claude-code/`, loaded via `--plugin-dir`), the
 * skill file byte-for-byte as it ships, the MCP handshake and the tool list —
 * `tools/list` is answered by a real `mikro mcp` process over stdio, so the
 * tool's name, description and input schema are production values, generated
 * by `src/mcp/server.ts` from the real `examples/agents/explore-r/agent.yaml`.
 * The session's cwd is the task's real repository root, so "this project" in
 * the question resolves to what the task means by it, and native exploration
 * is genuinely possible.
 *
 * Not real: `tools/call`. A thin stdio proxy (written into the staging dir by
 * this script) forwards every JSON-RPC message to the real `mikro mcp` except
 * `tools/call`, which it answers itself. That is the only intervention, and it
 * is the point: it is what makes the planted case *the recorded failure*
 * rather than a fresh one, and what keeps the eval free of model spend on the
 * gateway. The routing decision under test is made *before* any tool result
 * exists, so the stub cannot influence it. The escalation decision is made
 * *from* the stub result, which is exactly the recorded bytes.
 *
 * Stated limits:
 *   · One session per item, single-turn. No multi-turn user pressure.
 *   · `--setting-sources ""` isolates the session from this host's user-scope
 *     settings (which already have the real mikro plugin installed and would
 *     otherwise expose an uncontrolled second copy of the tool). Plugins
 *     installed at other scopes on the host may still load; they are recorded
 *     in the transcript.
 *   · Write-class tools are denied (`--disallowed-tools`) because the sessions
 *     run inside the user's real repositories. Read/Grep/Glob/Bash remain, so
 *     native exploration — the thing routing is measured *against* — is fully
 *     available.
 *   · The session model is pinned by `--model` and recorded; routing is a
 *     model behaviour and this number is that model's.
 *
 * ARMS
 * ----
 *   treatment (default) — plugin staged with `skills/`, i.e. as it ships.
 *   control (`--control`) — the identical plugin with `skills/` removed: the
 *     MCP registration alone. Same prompts, same stub, same everything else.
 *     It is the counterfactual that makes the treatment number mean something.
 *
 * USAGE
 * -----
 *   node scripts/eval-routing.mjs                 # treatment arm, full run
 *   node scripts/eval-routing.mjs --control       # control arm
 *   node scripts/eval-routing.mjs --json          # summary JSON only
 *   node scripts/eval-routing.mjs --render <f>    # re-render a saved transcript
 *
 * Exit 0 = pass bar met. Exit 1 = not met. Exit 2 = harness/pin failure.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ───────────────────────────────────────────────────────────────────────────
// PRE-REGISTERED, IMMUTABLE. Digests pinned 2026-07-27 against the frozen
// round-2 artifacts. Do not edit without editing the wish.
// ───────────────────────────────────────────────────────────────────────────

const TASKS_DIR = ".genie/wishes/rlmx-explore-offload/parity/round2/train-tasks";

const ITEMS = [
  { task: 3, root: "/home/namastex/prod/xdna-top", chars: 349, sha256: "a977339c7d2890375be3427ee10da6e129cbc0dab00e648ed337db7341ffa78e" },
  { task: 4, root: "/home/namastex/prod/xdna-top", chars: 306, sha256: "4ff5210924bbcc44812bc14ab3c48768ca0b5bb1e9e3b27b3f576fb4fbe770df" },
  { task: 5, root: "/home/namastex/prod/genie-desktop", chars: 284, sha256: "df34d51b1982885a437a30ec3fe4c1aabd6bfdcaeea04e7f2d055909d8b13c6f" },
  { task: 6, root: "/home/namastex/prod/genie-desktop", chars: 241, sha256: "e29f97c27df9a75db3b6941dc0e43f96cb7802e2938828e66db30b9c8efc8799" },
  { task: 7, root: "/home/namastex/prod/fde-station", chars: 291, sha256: "a65f9aec15e90d44979e41db48441f57b71d30fc1ba84768da4cb8528ded69d7" },
];

const PLANTED = {
  /** The recorded lost run. Not a synthesised error string. */
  record: ".genie/wishes/rlmx-explore-offload/parity/round2/optimizer/gens/gen-4/rep-2/runs/task-5.json",
  task: 5,
  chars: 67,
  sha256: "6bec40334302304701ef423c920b986d7a0d61b1b3406781ab625ad9abb6572c",
};

const PASS_BAR = { routedAtLeast: 4, ofItems: 5, plantedMustEscalate: true };

/**
 * What the stub returns for the five routing items. It is deliberately NOT an
 * explore-r answer: fabricating one would put invented findings into a
 * transcript that is committed as evidence. Routing is already recorded by the
 * time this text is produced, so its content cannot affect the measurement.
 */
const NEUTRAL_STUB =
  "[eval-routing harness] This tool call was intercepted by the B3 routing " +
  "eval harness and no exploration was run. The measurement under test — " +
  "whether this session routes the question to mikro_explore-r — is already " +
  "recorded by the fact that you called it. No answer content exists. Do not " +
  "invent one: reply with exactly the sentence 'Routing recorded by the " +
  "harness; no answer was produced.' and stop.";

/** Tools that count as the session doing the exploration itself. */
const NATIVE_TOOLS = new Set(["Read", "Grep", "Glob", "Bash", "Task", "Agent", "NotebookRead"]);

const TOOL_RE = /mikro_explore-r$/;

// ───────────────────────────────────────────────────────────────────────────
// args
// ───────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = {
    control: false,
    json: false,
    keep: false,
    model: "sonnet",
    out: join(REPO, ".genie/wishes/rlmx-microagent-plugin/routing-eval"),
    timeoutMs: 900_000,
    render: null,
    label: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--control") o.control = true;
    else if (a === "--json") o.json = true;
    else if (a === "--keep") o.keep = true;
    else if (a === "--model") o.model = argv[++i];
    else if (a === "--out") o.out = resolve(argv[++i]);
    else if (a === "--label") o.label = argv[++i];
    else if (a === "--timeout-ms") o.timeoutMs = Number(argv[++i]);
    else if (a === "--render") o.render = resolve(argv[++i]);
    else if (a === "--help" || a === "-h") {
      process.stdout.write(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0] + "*/\n");
      process.exit(0);
    } else die(`unknown argument: ${a}`);
  }
  o.label ??= o.control ? "control" : "treatment";
  return o;
}

function die(msg) {
  process.stderr.write(`eval-routing: ${msg}\n`);
  process.exit(2);
}

const sha = (s) => createHash("sha256").update(s).digest("hex");

// ───────────────────────────────────────────────────────────────────────────
// pins
// ───────────────────────────────────────────────────────────────────────────

/**
 * The prompt is the contents of the first ```text fence after the `## Question`
 * heading, with the trailing newline stripped. Verbatim means verbatim: the
 * digest below is over exactly those bytes.
 */
function extractQuestion(md) {
  const m = md.match(/^## Question[^\n]*\n[\s\S]*?^```text\n([\s\S]*?)^```$/m);
  if (!m) return null;
  return m[1].replace(/\n$/, "");
}

function verifyPins() {
  const pins = { verifiedAt: new Date().toISOString(), items: [], planted: null };
  for (const item of ITEMS) {
    const file = join(REPO, TASKS_DIR, `${item.task}.md`);
    if (!existsSync(file)) die(`pre-registered task file missing: ${file}`);
    const prompt = extractQuestion(readFileSync(file, "utf8"));
    if (prompt === null) die(`no ## Question text fence in ${file}`);
    const got = sha(prompt);
    if (got !== item.sha256 || prompt.length !== item.chars) {
      die(
        `PIN MISMATCH on task ${item.task}\n` +
          `  expected sha256 ${item.sha256} (${item.chars} chars)\n` +
          `  actual   sha256 ${got} (${prompt.length} chars)\n` +
          `  The pre-registered item set changed. This is not a test failure — ` +
          `it means the eval is no longer the eval that was registered.`,
      );
    }
    pins.items.push({ task: item.task, file: `${TASKS_DIR}/${item.task}.md`, chars: prompt.length, sha256: got });
    item.prompt = prompt;
  }

  const rf = join(REPO, PLANTED.record);
  if (!existsSync(rf)) die(`planted-case record missing: ${rf}`);
  const rec = JSON.parse(readFileSync(rf, "utf8"));
  const answer = rec.answer;
  const got = sha(answer);
  if (got !== PLANTED.sha256 || answer.length !== PLANTED.chars) {
    die(
      `PIN MISMATCH on the planted case\n` +
        `  expected sha256 ${PLANTED.sha256} (${PLANTED.chars} chars)\n` +
        `  actual   sha256 ${got} (${answer.length} chars)`,
    );
  }
  // Corroboration, not decoration: the record must be the failure it claims.
  const citations = (answer.match(/[\w./-]+\.\w+:\d+/g) ?? []).length;
  if (rec.isError !== true || rec.ok !== false || citations !== 0) {
    die(`planted-case record is not a zero-citation error result (isError=${rec.isError} ok=${rec.ok} citations=${citations})`);
  }
  const task5 = ITEMS.find((i) => i.task === 5);
  if (rec.question !== task5.prompt) {
    die("planted-case record's question is not byte-identical to train task 5's Question block");
  }
  pins.planted = {
    record: PLANTED.record,
    chars: answer.length,
    sha256: got,
    isError: rec.isError,
    citations,
    wallSeconds: rec.wallSeconds,
    model: rec.model,
    round: rec.round,
    questionMatchesTask5: true,
  };
  PLANTED.answer = answer;
  return pins;
}

// ───────────────────────────────────────────────────────────────────────────
// staging
// ───────────────────────────────────────────────────────────────────────────

const PROXY_SRC = String.raw`#!/usr/bin/env node
/**
 * Written by scripts/eval-routing.mjs. Forwards every JSON-RPC message to a
 * real "mikro mcp" child over stdio, except tools/call, which it answers with
 * the scripted result. tools/list therefore carries production tool metadata.
 */
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const RESULT = readFileSync(process.env.EVAL_RESULT_FILE, "utf8");
const IS_ERROR = process.env.EVAL_IS_ERROR === "1";
const CALL_LOG = process.env.EVAL_CALL_LOG;

const child = spawn(process.execPath, [process.env.EVAL_MIKRO_CLI, "mcp"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    MIKRO_AGENTS_DIR: process.env.EVAL_AGENTS_DIR,
    MIKRO_REPL_TIMEOUT_MS: "600000",
  },
});

createInterface({ input: child.stdout }).on("line", (line) => {
  if (line.trim()) process.stdout.write(line + "\n");
});

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "tools/call") {
    appendFileSync(CALL_LOG, JSON.stringify({ at: new Date().toISOString(), params: msg.params }) + "\n");
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        content: [{ type: "text", text: RESULT }],
        isError: IS_ERROR,
        structuredContent: { session_id: "sess_eval_intercepted" },
      },
    }) + "\n");
    return;
  }
  child.stdin.write(line + "\n");
});

process.stdin.on("close", () => child.kill());
`;

function stage(opts) {
  const dir = mkdtempSync(join(tmpdir(), "mikro-eval-routing-"));
  const cli = join(REPO, "dist/src/cli.js");
  if (!existsSync(cli)) die(`dist/src/cli.js missing — run \`npm run build\` first`);

  // The agent the tool metadata is generated from: the real, shipped recipe.
  const agents = join(dir, "agents");
  mkdirSync(agents, { recursive: true });
  cpSync(join(REPO, "examples/agents/explore-r"), join(agents, "explore-r"), { recursive: true });

  // The plugin, staged from the repo exactly as it ships.
  const plugin = join(dir, "plugin");
  cpSync(join(REPO, "plugins/claude-code"), plugin, { recursive: true });
  if (opts.control) rmSync(join(plugin, "skills"), { recursive: true, force: true });

  const proxy = join(dir, "proxy.mjs");
  writeFileSync(proxy, PROXY_SRC);
  // The proxy is generated, so its syntax is this script's responsibility. A
  // broken proxy shows up in a session only as `status: "failed"` and an empty
  // tool list, which would read as "the session declined to route".
  const chk = spawnSync(process.execPath, ["--check", proxy], { encoding: "utf8" });
  if (chk.status !== 0) die(`generated proxy.mjs does not parse:\n${chk.stderr}`);

  return { dir, plugin, agents, cli };
}

function writeMcpConfig(st, { resultFile, isError, callLog }) {
  writeFileSync(
    join(st.plugin, ".mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          mikro: {
            command: process.execPath,
            args: [join(st.dir, "proxy.mjs")],
            env: {
              EVAL_MIKRO_CLI: st.cli,
              EVAL_AGENTS_DIR: st.agents,
              EVAL_RESULT_FILE: resultFile,
              EVAL_CALL_LOG: callLog,
              EVAL_IS_ERROR: isError ? "1" : "0",
            },
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
}

// ───────────────────────────────────────────────────────────────────────────
// session
// ───────────────────────────────────────────────────────────────────────────

function runSession({ prompt, cwd, plugin, model, timeoutMs }) {
  return new Promise((resolveP) => {
    const args = [
      "-p", prompt,
      "--model", model,
      "--setting-sources", "",
      "--plugin-dir", plugin,
      "--output-format", "stream-json",
      "--verbose",
      "--no-session-persistence",
      // The plugin's MCP tools need an explicit grant, exactly as they would
      // from a user who installs the plugin and approves it once. Without this
      // every call comes back "you haven't granted it yet", the session never
      // sees a result, and the planted case cannot be delivered at all.
      // Native tools are unaffected and remain available, so routing is still
      // measured against a session that could do the work itself.
      "--allowed-tools", "mcp__plugin_mikro_mikro__mikro_explore-r", "mcp__plugin_mikro_mikro__mikro_query",
      "--disallowed-tools", "Write", "Edit", "NotebookEdit",
    ];
    const child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ code, stdout, stderr });
    });
  });
}

function parseEvents(jsonl) {
  const events = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* non-JSON noise */ }
  }
  return events;
}

/** Flatten a stream-json transcript into an ordered list of observable acts. */
function timeline(events) {
  const acts = [];
  for (const ev of events) {
    if (ev.type === "system" && ev.subtype === "init") {
      acts.push({ kind: "init", tools: ev.tools ?? [], mcpServers: ev.mcp_servers ?? [], slashCommands: ev.slash_commands ?? [], model: ev.model, cwd: ev.cwd });
      continue;
    }
    const msg = ev.message;
    if (!msg || !Array.isArray(msg.content)) {
      if (ev.type === "result") acts.push({ kind: "result", subtype: ev.subtype, text: ev.result, usd: ev.total_cost_usd, ms: ev.duration_ms, turns: ev.num_turns, isError: ev.is_error });
      continue;
    }
    for (const block of msg.content) {
      if (block.type === "text" && block.text?.trim()) acts.push({ kind: ev.type === "user" ? "user_text" : "text", text: block.text });
      else if (block.type === "thinking" && block.thinking?.trim()) acts.push({ kind: "thinking", text: block.thinking });
      else if (block.type === "tool_use") acts.push({ kind: "tool_use", name: block.name, input: block.input, id: block.id });
      else if (block.type === "tool_result") {
        const text = typeof block.content === "string"
          ? block.content
          : (block.content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
        acts.push({ kind: "tool_result", id: block.tool_use_id, isError: block.is_error === true, text });
      }
    }
  }
  return acts;
}

/**
 * A session that never had the tool cannot have declined to use it, so a
 * session whose MCP server was `failed` or still `pending` at init is not a
 * routing measurement at all. Returns the offered tool names, or a reason
 * string explaining why the session is unscorable.
 */
function toolOffering(acts) {
  const init = acts.find((a) => a.kind === "init");
  if (!init) return { ok: false, reason: "no init event — the session did not start" };
  const server = (init.mcpServers ?? []).find((s) => /mikro/.test(s.name));
  const tools = (init.tools ?? []).filter((t) => TOOL_RE.test(t));
  if (!server || server.status !== "connected" || tools.length === 0) {
    return {
      ok: false,
      reason: `mikro_explore-r was never offered: server=${JSON.stringify(server ?? null)} tools=${JSON.stringify(tools)}`,
    };
  }
  return { ok: true, tools };
}

function score(acts, { planted }) {
  const toolUses = acts.map((a, i) => ({ ...a, i })).filter((a) => a.kind === "tool_use");
  const mikroCalls = toolUses.filter((a) => TOOL_RE.test(a.name));
  const skillCalls = toolUses.filter((a) => a.name === "Skill");
  const routed = mikroCalls.length > 0;

  const out = {
    routed,
    mikroCallCount: mikroCalls.length,
    firstMikroCallAt: routed ? mikroCalls[0].i : null,
    firstToolUse: toolUses.length ? toolUses[0].name : null,
    nativeToolsBeforeRouting: routed
      ? toolUses.filter((a) => a.i < mikroCalls[0].i && NATIVE_TOOLS.has(a.name)).map((a) => a.name)
      : toolUses.filter((a) => NATIVE_TOOLS.has(a.name)).map((a) => a.name),
    skillInvocations: skillCalls.map((a) => a.input?.command ?? a.input?.name ?? JSON.stringify(a.input)),
    promptSentTomikro: mikroCalls.map((a) => a.input?.prompt ?? a.input?.query ?? null),
    final: acts.find((a) => a.kind === "result") ?? null,
  };

  if (planted) {
    const deliveredAt = acts.findIndex((a) => a.kind === "tool_result" && a.text?.includes(PLANTED.answer));
    const after = deliveredAt >= 0 ? toolUses.filter((a) => a.i > deliveredAt) : [];
    const nativeAfter = after.filter((a) => NATIVE_TOOLS.has(a.name));
    const retriedMikro = after.filter((a) => TOOL_RE.test(a.name));
    out.planted = {
      deliveredAt,
      delivered: deliveredAt >= 0,
      nativeToolsAfter: nativeAfter.map((a) => a.name),
      nativeToolCountAfter: nativeAfter.length,
      mikroRetriesAfter: retriedMikro.length,
      finalCitationCount: (out.final?.text?.match(/[\w./-]+\.\w+:\d+/g) ?? []).length,
    };
    out.escalated = out.planted.delivered && nativeAfter.length > 0;
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// rendering — the committed way to turn a saved transcript into evidence
// ───────────────────────────────────────────────────────────────────────────

function render(acts) {
  const lines = [];
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n… [${s.length - n} more chars]` : s);
  for (const a of acts) {
    switch (a.kind) {
      case "init":
        lines.push(`[init] model=${a.model} cwd=${a.cwd}`);
        lines.push(`[init] mcp_servers=${JSON.stringify(a.mcpServers)}`);
        lines.push(`[init] mikro tools=${JSON.stringify(a.tools.filter((t) => /mikro/.test(t)))}`);
        lines.push(`[init] mikro skills=${JSON.stringify((a.slashCommands ?? []).filter((s) => /mikro/.test(s)))}`);
        break;
      case "thinking":
        lines.push(`[thinking]\n${clip(a.text, 4000)}`);
        break;
      case "text":
        lines.push(`[assistant]\n${clip(a.text, 6000)}`);
        break;
      case "user_text":
        lines.push(`[user]\n${clip(a.text, 4000)}`);
        break;
      case "tool_use":
        lines.push(`[tool_use] ${a.name}\n${clip(JSON.stringify(a.input, null, 2), 4000)}`);
        break;
      case "tool_result":
        lines.push(`[tool_result]${a.isError ? " ERROR" : ""}\n${clip(a.text ?? "", 2500)}`);
        break;
      case "result":
        lines.push(`[result] subtype=${a.subtype} turns=${a.turns} usd=${a.usd} ms=${a.ms}\n${clip(a.text ?? "", 6000)}`);
        break;
    }
  }
  return lines.join("\n\n");
}

// ───────────────────────────────────────────────────────────────────────────
// main
// ───────────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.render) {
    process.stdout.write(render(timeline(parseEvents(readFileSync(opts.render, "utf8")))) + "\n");
    return 0;
  }

  const pins = verifyPins();
  const outDir = join(opts.out, opts.label);
  mkdirSync(join(outDir, "transcripts"), { recursive: true });
  mkdirSync(join(outDir, "calls"), { recursive: true });
  writeFileSync(join(outDir, "pins.json"), JSON.stringify(pins, null, 2) + "\n");

  const st = stage(opts);
  const log = (s) => { if (!opts.json) process.stdout.write(s + "\n"); };

  // The artifact under test. Recorded so a reviewer can prove the number was
  // measured against the file that ships, not an earlier draft of it.
  const skillFile = join(REPO, "plugins/claude-code/skills/offload-guidance/SKILL.md");
  const skillUnderTest = opts.control
    ? null
    : (() => {
        const text = readFileSync(skillFile, "utf8");
        const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
        const desc = fm?.[1].match(/^description:\s*"([\s\S]*?)"\s*$/m)?.[1] ?? null;
        return {
          path: "plugins/claude-code/skills/offload-guidance/SKILL.md",
          sha256: sha(text),
          chars: text.length,
          descriptionChars: desc?.length ?? null,
        };
      })();

  log(`eval-routing — arm=${opts.label} model=${opts.model}`);
  log(`  pre-registered items: ${ITEMS.map((i) => i.task).join(", ")} (all 5 digests verified)`);
  log(`  planted case: ${PLANTED.chars} chars, ${pins.planted.citations} citations, isError=${pins.planted.isError}`);
  log(`  skill under test: ${skillUnderTest ? `sha256 ${skillUnderTest.sha256}` : "none (control arm)"}`);
  log(`  staging: ${st.dir}`);
  log("");

  const runs = [];
  const started = new Date().toISOString();

  for (const item of [...ITEMS, { task: PLANTED.task, root: ITEMS.find((i) => i.task === PLANTED.task).root, planted: true }]) {
    const id = item.planted ? "planted-task-5" : `task-${item.task}`;
    const prompt = item.planted ? ITEMS.find((i) => i.task === PLANTED.task).prompt : item.prompt;
    const resultFile = join(st.dir, `result-${id}.txt`);
    const callLog = join(outDir, "calls", `${id}.jsonl`);
    writeFileSync(resultFile, item.planted ? PLANTED.answer : NEUTRAL_STUB);
    writeFileSync(callLog, "");
    writeMcpConfig(st, { resultFile, isError: Boolean(item.planted), callLog });

    // The plugin's MCP server occasionally is still `pending` at init — a
    // startup race, not a routing decision. Retry a bounded number of times and
    // record how many, rather than scoring an unscorable session or hiding the
    // re-roll. Anything else that goes wrong is fatal.
    const t0 = Date.now();
    let code, stdout, stderr, acts, offering, unscorable = [];
    for (let attempt = 0; ; attempt++) {
      writeFileSync(callLog, "");
      ({ code, stdout, stderr } = await runSession({
        prompt, cwd: item.root, plugin: st.plugin, model: opts.model, timeoutMs: opts.timeoutMs,
      }));
      acts = timeline(parseEvents(stdout));
      offering = toolOffering(acts);
      if (offering.ok) break;
      unscorable.push(offering.reason);
      writeFileSync(join(outDir, "transcripts", `${id}.unscorable-${attempt}.jsonl`), stdout);
      if (attempt >= 2) die(`${id}: HARNESS FAULT after ${attempt + 1} attempts — ${offering.reason}`);
      log(`  ${id.padEnd(15)} retry ${attempt + 1}: ${offering.reason}`);
    }
    const transcript = join(outDir, "transcripts", `${id}.jsonl`);
    writeFileSync(transcript, stdout);
    if (stderr.trim()) writeFileSync(join(outDir, "transcripts", `${id}.stderr.txt`), stderr);

    const offered = offering.tools;
    const s = score(acts, { planted: Boolean(item.planted) });

    // A routed call that never reached the proxy means the host refused it
    // (missing permission grant, dead server). The routing decision is still
    // real, but the *result* half of the eval is not being exercised, and the
    // planted case silently becomes untestable. Fail loudly instead.
    const intercepted = readFileSync(callLog, "utf8").split("\n").filter(Boolean).length;
    if (s.routed && intercepted === 0) {
      die(
        `${id}: HARNESS FAULT — the session called mikro_explore-r ${s.mikroCallCount}× but the ` +
          `proxy logged 0 calls, so no scripted result was ever delivered. Check the ` +
          `permission grant and the MCP server status in ${transcript}.`,
      );
    }
    const rec = {
      id, task: item.task, planted: Boolean(item.planted), root: item.root,
      toolsOffered: offered,
      unscorableAttempts: unscorable,
      interceptedCalls: intercepted,
      promptSha256: sha(prompt), promptChars: prompt.length,
      exitCode: code, wallSeconds: Math.round((Date.now() - t0) / 1000),
      transcript: transcript.slice(REPO.length + 1),
      callLog: callLog.slice(REPO.length + 1),
      ...s,
    };
    runs.push(rec);

    const verdict = item.planted
      ? (s.escalated ? "ESCALATED" : "NOT ESCALATED")
      : (s.routed ? "ROUTED" : "not routed");
    log(`  ${id.padEnd(15)} ${verdict.padEnd(14)} first_tool=${String(s.firstToolUse)} skills=${JSON.stringify(s.skillInvocations)} ${rec.wallSeconds}s exit=${code}`);
  }

  const routedRuns = runs.filter((r) => !r.planted);
  const routedCount = routedRuns.filter((r) => r.routed).length;
  const plantedRun = runs.find((r) => r.planted);
  const routingPass = routedCount >= PASS_BAR.routedAtLeast;
  const escalationPass = plantedRun.escalated === true;
  const pass = routingPass && (!PASS_BAR.plantedMustEscalate || escalationPass);

  const summary = {
    wish: "mikro-microagent-plugin",
    criterion: "B3",
    arm: opts.label,
    control: opts.control,
    model: opts.model,
    startedAt: started,
    finishedAt: new Date().toISOString(),
    host: { claudeCode: claudeVersion(), node: process.version },
    skillUnderTest,
    preRegistered: { items: ITEMS.map((i) => i.task), passBar: PASS_BAR, tasksDir: TASKS_DIR, plantedRecord: PLANTED.record },
    pins,
    routed: routedCount,
    ofItems: routedRuns.length,
    routedTasks: routedRuns.filter((r) => r.routed).map((r) => r.task),
    notRoutedTasks: routedRuns.filter((r) => !r.routed).map((r) => r.task),
    plantedEscalated: plantedRun.escalated === true,
    routingPass,
    escalationPass,
    pass,
    runs,
  };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");

  if (opts.json) process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  else {
    log("");
    log(`  routed ${routedCount}/${routedRuns.length} (bar: >= ${PASS_BAR.routedAtLeast}) → ${routingPass ? "PASS" : "FAIL"}`);
    log(`  planted case escalated: ${escalationPass} → ${escalationPass ? "PASS" : "FAIL"}`);
    log(`  ${pass ? "EVAL PASS" : "EVAL FAIL"}`);
    log(`  artifacts: ${outDir.slice(REPO.length + 1)}`);
  }

  if (!opts.keep) rmSync(st.dir, { recursive: true, force: true });
  else log(`  staging kept: ${st.dir}`);
  return pass ? 0 : 1;
}

function claudeVersion() {
  const r = spawnSync("claude", ["--version"], { encoding: "utf8" });
  return (r.stdout ?? "").trim() || "unknown";
}

main().then((c) => process.exit(c)).catch((e) => {
  process.stderr.write(`eval-routing: ${e?.stack ?? e}\n`);
  process.exit(2);
});
