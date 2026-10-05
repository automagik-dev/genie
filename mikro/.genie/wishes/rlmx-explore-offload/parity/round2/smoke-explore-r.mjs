#!/usr/bin/env node
/**
 * smoke-explore-r.mjs — drive `examples/agents/explore-r/` through the real MCP
 * path and prove that recursion actually fires.
 *
 * Shape is `scripts/smoke-explore.mjs` + `parity/run-task.mjs`, with three
 * deliberate differences:
 *
 *   1. **Nothing is written inside the checkout.** The recipe is installed into
 *      a scratch `HOME`'s `~/.rlmx/agents/explore-r/` — discovery root #1,
 *      `src/mcp/agents.ts:56-68` — exactly as `run-task.mjs:51-56` does. No
 *      `RLMX_AGENTS_DIR` override; the discovery path stays the real one.
 *   2. **That scratch HOME also carries `~/.rlmx/settings.json`**, pinning
 *      `model.provider` / `model.model` / `model.sub-call-model`. This is the
 *      only mechanism that pins a *recursive child's* model: the child is a
 *      fresh `rlmx` CLI process whose argv carries no `--model`
 *      (`src/llm.ts:457-469`), so it resolves its own config from
 *      `~/.rlmx/settings.json` > `<--dir>/.rlmx/rlmx.yaml` > the hardcoded
 *      google default (`src/cli.ts:34-38`, `:324-325`). Without the pin the
 *      children here would run `google/gemini-3.1-flash-lite-preview` with no
 *      key and return the empty string, silently. Full evidence:
 *      `parity/round2/recursion-recon.md` §2.2. The API key is NOT written —
 *      it is inherited from the environment.
 *   3. **A `/proc` poller records the children's verbatim argv.** MCP progress
 *      reports a spawn *count* (`src/mcp/server.ts:628-633`, fed by the
 *      `RecurseEvent` producer at `src/rlm.ts:441-443`), which proves the call
 *      happened but not what ran. The poller reads `/proc/<pid>/cmdline` for
 *      processes carrying both `dist/src/cli.js` and `--no-session` — the
 *      signature `buildRlmChildArgs` gives every child and nothing else has —
 *      so the record holds the actual command line, including the fact that no
 *      `--model` is on it. Read-only; it perturbs nothing.
 *
 * The subject and the root are the same tree — this checkout — so a `file:line`
 * the agent emits is resolvable by this script against the very tree the agent
 * read.
 *
 * The question is self-authored for this smoke. It is not one of the six frozen
 * parity tasks and not a task-mining candidate; it exists only here, and it was
 * chosen to be genuinely three-way partitionable (config / budget / mcp) so the
 * decomposition the recipe teaches has something to decompose.
 *
 *   export KHAL_API_KEY=…
 *   node .genie/wishes/rlmx-explore-offload/parity/round2/smoke-explore-r.mjs [label]
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const round2 = __dirname;
const repo = resolve(round2, "..", "..", "..", "..", "..");
const cli = join(repo, "dist", "src", "cli.js");
const recipe = join(repo, "examples", "agents", "explore-r");

const label = process.argv[2] ?? "smoke-1";
const AGENT = "explore-r";
const TOOL = "rlmx_explore-r";

if (!process.env.KHAL_API_KEY && !process.env.RLMX_KHAL_API_KEY) {
  console.error("KHAL_API_KEY is not set — export it in the shell, never in a file.");
  process.exit(2);
}

/**
 * One self-authored question about this repository. Four parts, deliberately
 * sited in four unrelated subsystems (custom providers / the Python REPL
 * transport / the REPL's optional battery loading / the context-size to
 * storage-mode switch), so that a run which does not partition has to walk the
 * tree four times serially. The first smoke of this recipe (`smoke-1`) used a
 * three-grep question and the model — correctly, on the economics — answered it
 * itself without fanning out; that record is kept beside this one.
 */
const QUESTION =
  "In this repository, answer four separate things, each under its own heading. " +
  "(1) Which source files define rlmx's own custom LLM providers (not the ones " +
  "the underlying LLM library ships), and for each: what base URL does it " +
  "default to and which environment variable carries its API key? " +
  "(2) How does the Python REPL subprocess receive code to execute and return " +
  "its output — name the transport and every message type on it, from both the " +
  "TypeScript side and the Python side. " +
  "(3) What exactly decides whether the Gemini 'batteries' are loaded into the " +
  "REPL namespace, and where are they loaded from? " +
  "(4) How does a run decide that its context is too large for the model, and " +
  "what does it switch on when that happens? " +
  "Give a file:line citation for every claim.";

const log = (m) => process.stdout.write(`# smoke-explore-r: ${m}\n`);

// ── scratch HOME ────────────────────────────────────────────────────────────
const home = join(tmpdir(), `rlmx-explore-r-${label}`);
rmSync(home, { recursive: true, force: true });
const installed = join(home, ".rlmx", "agents", AGENT);
mkdirSync(installed, { recursive: true });
cpSync(join(recipe, "SYSTEM.md"), join(installed, "SYSTEM.md"));
cpSync(join(recipe, "agent.yaml"), join(installed, "agent.yaml"));

/**
 * The child-model pin. Values mirror `examples/agents/explore-r/agent.yaml`'s
 * `model:` so parent and children run the same model — which is what "the
 * recursive variant of explore on flash" has to mean. No secret goes in here.
 */
const shippedModel = /^model:\s*(\S+)/m.exec(readFileSync(join(recipe, "agent.yaml"), "utf-8"))?.[1];
if (!shippedModel) {
  console.error("examples/agents/explore-r/agent.yaml declares no model");
  process.exit(2);
}
const [pinProvider, ...pinRest] = shippedModel.split("/");
const pinModel = pinRest.join("/");
const settings = {
  "model.provider": pinProvider,
  "model.model": pinModel,
  "model.sub-call-model": pinModel,
};
writeFileSync(join(home, ".rlmx", "settings.json"), JSON.stringify(settings, null, 2) + "\n", "utf-8");
log(`installed ${AGENT} at ${installed}`);
log(`child-model pin: ${JSON.stringify(settings)}`);

// ── provenance ──────────────────────────────────────────────────────────────
const sha = (s) => createHash("sha256").update(s).digest("hex");
const systemText = readFileSync(join(recipe, "SYSTEM.md"), "utf-8");
const yamlText = readFileSync(join(recipe, "agent.yaml"), "utf-8");
function gitState(dir) {
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf-8" }).trim();
  try {
    return { head: git("rev-parse", "HEAD"), branch: git("rev-parse", "--abbrev-ref", "HEAD"), dirty: git("status", "--porcelain").length > 0 };
  } catch (e) {
    return { head: null, error: e?.message ?? String(e) };
  }
}
const provenance = {
  agent: AGENT,
  promptSha256: sha(systemText),
  promptChars: systemText.length,
  agentYamlSha256: sha(yamlText),
  model: shippedModel,
  childModelPin: settings,
  rlmxGit: gitState(repo),
  runTimeoutMs: process.env.RLMX_MCP_RUN_TIMEOUT_MS ?? "900000",
  replTimeoutMs: process.env.RLMX_REPL_TIMEOUT_MS ?? "600000",
};

// ── child-process poller (hard recursion evidence) ──────────────────────────
/**
 * Every recursive child is `node <cli.js> "<prompt>" --output json --stats … --no-session`
 * (`src/llm.ts:558-566` + `buildRlmChildArgs`, `src/llm.ts:457-469`). The MCP
 * server process is `node <cli.js> mcp --dir …` and carries no `--no-session`,
 * so that flag is an exact discriminator. Read-only scan of /proc.
 */
const childProcs = new Map();
function pollChildren() {
  let pids;
  try {
    pids = readdirSync("/proc").filter((d) => /^\d+$/.test(d));
  } catch {
    return;
  }
  for (const pid of pids) {
    if (childProcs.has(pid)) continue;
    let raw;
    try {
      raw = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
    } catch {
      continue;
    }
    const argv = raw.split("\0").filter(Boolean);
    if (argv.length < 3) continue;
    if (!argv.some((a) => a.endsWith("dist/src/cli.js"))) continue;
    if (!argv.includes("--no-session")) continue;
    childProcs.set(pid, {
      pid: Number(pid),
      seenAtMs: Date.now(),
      argv,
      hasModelFlag: argv.includes("--model"),
    });
  }
}

// ── citation scoring (same conventions as scripts/smoke-explore.mjs) ────────
const CITATION = /(?<![\w./-])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][\w]*):(\d+)\b/g;

function resolveCitation(relPath, lineNo) {
  const abs = resolve(repo, relPath);
  if (!abs.startsWith(repo + sep)) return null;
  let text;
  try {
    text = readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  if (lineNo < 1 || lineNo > lines.length) return null;
  return { path: relPath, line: lineNo, text: lines[lineNo - 1].trim() };
}

function identifiers(text) {
  const out = new Set();
  for (const [token] of text.matchAll(/[A-Za-z_$][\w$]{4,}/g)) {
    if (token.includes("_") || /[a-z][A-Z]/.test(token) || /^[A-Z]{3,}/.test(token)) out.add(token);
  }
  return out;
}
const sharedIdentifiers = (line, answer) => {
  const inAnswer = identifiers(answer);
  return [...identifiers(line)].filter((t) => inAnswer.has(t));
};
function citationsIn(answer) {
  const seen = new Set();
  const out = [];
  for (const [, path, lineRaw] of answer.matchAll(CITATION)) {
    const key = `${path}:${lineRaw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, line: Number(lineRaw), key });
  }
  return out;
}
const promptText = [systemText, yamlText, QUESTION].join("\n");
const promptTokens = identifiers(promptText);

// ── run ─────────────────────────────────────────────────────────────────────
const progress = [];
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli, "mcp", "--dir", repo],
  cwd: tmpdir(),
  env: {
    ...process.env,
    HOME: home,
    RLMX_AGENTS_DIR: "",
    RLMX_MCP_RUN_TIMEOUT_MS: process.env.RLMX_MCP_RUN_TIMEOUT_MS ?? "900000",
    // Without this the fan-out block is killed at 30s (src/repl.ts:81-87) and
    // the whole run dies with no answer — the rejection escapes rlmLoop because
    // `repl.execute` at src/rlm.ts:681 is unwrapped. See smoke/smoke-2.json.
    RLMX_REPL_TIMEOUT_MS: process.env.RLMX_REPL_TIMEOUT_MS ?? "600000",
  },
  stderr: "pipe",
});

const client = new Client({ name: "smoke-explore-r", version: "1.0.0" }, { capabilities: {} });
let record = {
  label,
  agent: AGENT,
  tool: TOOL,
  root: repo,
  model: shippedModel,
  startedAt: new Date().toISOString(),
  question: QUESTION,
  provenance,
};

const started = Date.now();
const poller = setInterval(pollChildren, 250);
try {
  await client.connect(transport);
  let stderrBuf = "";
  transport.stderr?.on("data", (c) => {
    stderrBuf += c.toString();
  });

  const { tools } = await client.listTools();
  record.toolsListed = tools.map((t) => t.name);
  const agentTool = tools.find((t) => t.name === TOOL);
  if (!agentTool) throw new Error(`${TOOL} not listed; got ${record.toolsListed.join(", ")}`);
  record.toolDescription = agentTool.description;
  log(`✓ ${TOOL} discovered (shape label in description: ${/shape=(\S+)\)/.exec(agentTool.description)?.[1]})`);

  const res = await client.callTool({ name: TOOL, arguments: { prompt: QUESTION } }, undefined, {
    timeout: 300_000,
    resetTimeoutOnProgress: true,
    maxTotalTimeout: 2_400_000,
    onprogress: (p) => {
      const m = p.message ?? `progress ${p.progress}`;
      progress.push(m);
      process.stderr.write(`[explore-r] ${m}\n`);
      pollChildren();
    },
  });

  const elapsed = Date.now() - started;
  const text = res?.content?.[0]?.text ?? "";
  const split = text.lastIndexOf("\n---\n");
  const answer = split >= 0 ? text.slice(0, split) : text;
  const footer = split >= 0 ? text.slice(split + 5).trim() : "";

  const candidates = citationsIn(answer);
  const resolved = [];
  const unresolved = [];
  for (const c of candidates) {
    const hit = resolveCitation(c.path, c.line);
    (hit ? resolved : unresolved).push(hit ?? c);
  }
  const grounded = resolved.filter((r) => sharedIdentifiers(r.text, answer).length > 0);
  const novel = grounded.filter(
    (r) =>
      !promptText.includes(`${r.path}:${r.line}`) &&
      sharedIdentifiers(r.text, answer).some((t) => !promptTokens.has(t))
  );

  const spawnMessages = progress.filter((m) => /recursive spawn/.test(m));
  const spawnsReported = Math.max(
    0,
    ...spawnMessages.map((m) => Number(/·\s(\d+)\srecursive spawn/.exec(m)?.[1] ?? 0))
  );

  record = {
    ...record,
    ok: !res.isError,
    isError: Boolean(res.isError),
    wallSeconds: Number((elapsed / 1000).toFixed(1)),
    iterations: Number(/·\s(\d+)\siterations?\s·/.exec(footer)?.[1] ?? 0),
    answer,
    footer,
    fullText: text,
    structuredContent: res.structuredContent ?? null,
    progress,
    recursion: {
      spawnsReportedByProgress: spawnsReported,
      spawnProgressMessages: spawnMessages,
      childProcessesObserved: [...childProcs.values()].map((c) => ({
        ...c,
        secondsIntoRun: Number(((c.seenAtMs - started) / 1000).toFixed(1)),
      })),
    },
    citations: {
      candidates: candidates.map((c) => c.key),
      resolved: resolved.map((r) => ({ ...r })),
      unresolved: unresolved.map((u) => u.key ?? `${u.path}:${u.line}`),
      groundedCount: grounded.length,
      novel: novel.map((r) => `${r.path}:${r.line}`),
    },
    stderr: stderrBuf.slice(-6000),
  };
} catch (err) {
  record = {
    ...record,
    ok: false,
    isError: true,
    wallSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    error: err?.message ?? String(err),
    progress,
    recursion: {
      spawnsReportedByProgress: progress.filter((m) => /recursive spawn/.test(m)).length,
      childProcessesObserved: [...childProcs.values()],
    },
  };
} finally {
  clearInterval(poller);
  try {
    await client.close();
  } catch {
    /* already dead */
  }
}

const outDir = join(round2, "smoke");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `${label}.json`);
writeFileSync(outFile, JSON.stringify(record, null, 2), "utf-8");

log(`${record.ok ? "OK" : "ERR"} in ${record.wallSeconds}s → ${outFile}`);
log(`  ${record.footer ?? record.error ?? ""}`);
log(`  recursion: ${record.recursion.spawnsReportedByProgress} spawn(s) reported, ` +
    `${record.recursion.childProcessesObserved.length} child process(es) observed`);
if (record.citations) {
  log(`  citations: ${record.citations.resolved.length}/${record.citations.candidates.length} resolve, ` +
      `${record.citations.groundedCount} grounded, ${record.citations.novel.length} novel`);
  for (const r of record.citations.resolved) log(`    ✓ ${r.path}:${r.line} → ${r.text.slice(0, 70)}`);
  for (const u of record.citations.unresolved) log(`    ✗ ${u} does not resolve`);
}
process.exit(record.ok ? 0 : 1);
