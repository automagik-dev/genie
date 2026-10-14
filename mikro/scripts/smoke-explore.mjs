#!/usr/bin/env node
/**
 * smoke-explore.mjs — end-to-end gate for the `explore` microagent.
 *
 * smoke-mcp.mjs proves the *protocol* with a synthetic fixture agent. This
 * proves the *product*: the real `examples/agents/explore/` recipe, installed
 * the way a workspace installs it, answering a real question about a real
 * repository, with citations that are resolved mechanically against that
 * repository rather than eyeballed.
 *
 * The subject and the root are deliberately the same tree — this checkout:
 *
 *   `--dir <mikro checkout>` → the server's cwd, the discovery root, and the
 *   REPL's cwd all agree, so a `file:line` the agent emits is resolvable by
 *   this script against the very tree the agent read. Point them at different
 *   trees and a "resolvable citation" stops meaning anything.
 *
 * The agent is installed at `<checkout>/.mikro/agents/explore/` — the workspace
 * convention, discovered through the ordinary precedence path (no
 * `MIKRO_AGENTS_DIR` override, which would bypass what the gate protects). It is
 * removed again on exit; a checkout that already had one there gets it copied
 * aside first and put back, because this script rewrites the `model:` line and
 * "it was already there" must not mean "keep the smoke copy".
 *
 * Arms:
 *   station — always, and the one that **gates**. `MIKRO_SMOKE_MODEL` (default
 *             `station/Brain-35B`) keeps it runnable with no cloud key, the
 *             convention scripts/smoke-mcp.mjs and scripts/smoke-acp.mjs follow.
 *   khal    — additionally, when `KHAL_API_KEY` is set: the agent's own
 *             shipped default model, i.e. the recipe exactly as committed.
 *             Run and printed in full, but **not gated** — whether a cheap
 *             model clears the bar on one question is a model result, and the
 *             parity suite measures that across six mined tasks with a tuning
 *             and escalation ladder. A gate it fails intermittently is not one.
 *
 * Gate (per arm): the call succeeds, the answer is prose rather than a dump,
 * the run took more than one iteration, and at least one `path:line` citation
 * resolves to a real line here, is *grounded* — that line shares a code
 * identifier with the answer — **and is not in the agent's own prompt**. Each
 * step exists because the one before it can be passed without reading:
 *
 *   - bare resolution: `README.md:1` resolves in any repo and proves nothing;
 *   - grounding: cannot tell a line that was read from one that was recited;
 *   - prompt-independence: the answer has to carry a citation, and a grounding
 *     identifier, that its system prompt and the question never mention. This
 *     is the check with teeth — an earlier revision of `SYSTEM.md` carried the
 *     answer to this very question as a worked example, and a one-iteration
 *     recitation of it passed the other two;
 *   - the iteration floor is a floor, not the recitation guard: it fails an arm
 *     that answered before any REPL output came back, but a model that never
 *     emits `FINAL` runs to `budget.max_iterations` and exits through the
 *     forced-final-answer path (`src/rlm.ts`), so its count saturates and this
 *     assertion cannot bite it. Prompt-independence is what bites both.
 *
 * Whether the answer is *right* is reported, not gated — correctness across
 * models is what the parity suite measures, and a smoke test a cheap model
 * fails intermittently stops being a gate.
 *
 *   node scripts/smoke-explore.mjs
 *   node scripts/smoke-explore.mjs --no-khal
 *   MIKRO_SMOKE_MODEL=station/Brain-4B node scripts/smoke-explore.mjs
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const cli = join(root, "dist", "src", "cli.js");
const recipe = join(root, "examples", "agents", "explore");
const installed = join(root, ".mikro", "agents", "explore");

const skipKhal = process.argv.includes("--no-khal");

// Brain-35B, not the 4B smoke-mcp uses: explore has to write search code, read
// what came back, and cite it. A 4B model runs the protocol fine and fails the
// task, which would make this gate about model capacity instead of the recipe.
const STATION_MODEL = process.env.MIKRO_SMOKE_MODEL ?? "station/Brain-35B";

/**
 * One fixed question about this repo. Answerable from a single grep, with a
 * uniquely-named answer (`MIKRO_AGENTS_DIR` in src/mcp/agents.ts) so a right
 * answer is recognisable mechanically.
 */
const QUESTION =
  "In this repository, which environment variable replaces the default " +
  "agent discovery roots, and which file and line reads it? Answer with the " +
  "variable name and a file:line citation.";

/** Reported, not gated: what a correct answer looks like. */
const EXPECT_TOKEN = "MIKRO_AGENTS_DIR";
const EXPECT_FILE = "src/mcp/agents.ts";

const log = (msg) => process.stdout.write(`# smoke-explore: ${msg}\n`);

class Failed extends Error {}

/**
 * Throws rather than exiting. This script writes inside the checkout, so a
 * failure has to unwind through the cleanup — `process.exit` would leave the
 * installed agent behind as untracked files in someone's working tree.
 */
function assert(cond, msg) {
  if (!cond) throw new Failed(msg);
}
const textOf = (res) => res?.content?.[0]?.text ?? "";

const LIVE_OPTS = {
  timeout: 180_000,
  resetTimeoutOnProgress: true,
  maxTotalTimeout: 900_000,
  onprogress: (p) => log(`  … ${p.message ?? `progress ${p.progress}`}`),
};

/**
 * Citation candidates: `path/with.ext:123`. The extension requirement is what
 * keeps prose ("iteration 3:") and timestamps out.
 */
const CITATION = /(?<![\w./-])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][\w]*):(\d+)\b/g;

/** Resolve a citation against this checkout: real file, and the line exists. */
function resolveCitation(relPath, lineNo) {
  const abs = resolve(root, relPath);
  // A path that climbs out of the checkout is not a citation about this repo.
  if (!abs.startsWith(root + sep)) return null;
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

/**
 * Identifiers, not English: a token is code-like when it carries an underscore
 * or an interior capital (`MIKRO_AGENTS_DIR`, `agentRoots`). Plain words are
 * excluded because a comment line and an answer share those by accident.
 */
function identifiers(text) {
  const out = new Set();
  for (const [token] of text.matchAll(/[A-Za-z_$][\w$]{4,}/g)) {
    if (token.includes("_") || /[a-z][A-Z]/.test(token) || /^[A-Z]{3,}/.test(token)) {
      out.add(token);
    }
  }
  return out;
}

/** The code identifiers a cited line and the answer have in common. */
function sharedIdentifiers(line, answer) {
  const inAnswer = identifiers(answer);
  return [...identifiers(line)].filter((token) => inAnswer.has(token));
}

/**
 * Everything the agent was handed before it ran: its own system prompt, its
 * config, and the question. A citation that appears in there — or a grounding
 * identifier that does — is consistent with an answer composed without opening
 * the tree, so it cannot be what satisfies the gate.
 */
function promptContext() {
  const text = [
    readFileSync(join(installed, "SYSTEM.md"), "utf-8"),
    readFileSync(join(installed, "agent.yaml"), "utf-8"),
    QUESTION,
  ].join("\n");
  return { text, tokens: identifiers(text) };
}

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

/** Install the shipped recipe, with only its `model:` line swapped for `model`. */
function installAgent(model) {
  mkdirSync(installed, { recursive: true });
  cpSync(join(recipe, "SYSTEM.md"), join(installed, "SYSTEM.md"));
  const yaml = readFileSync(join(recipe, "agent.yaml"), "utf-8");
  assert(
    /^model:\s*\S+/m.test(yaml),
    'examples/agents/explore/agent.yaml has no top-level "model:" line to pin'
  );
  writeFileSync(join(installed, "agent.yaml"), yaml.replace(/^model:.*$/m, `model: ${model}`), "utf-8");
}

async function runArm(label, model, scratchHome, gating) {
  log(`── arm ${label}: ${model}${gating ? "" : " (reported, not gated)"} ─────────────────`);
  installAgent(model);

  const transport = new StdioClientTransport({
    // Spawned from the system temp dir: --dir is what has to make the server
    // agree with the checkout, exactly as a host would wire it.
    command: process.execPath,
    args: [cli, "mcp", "--dir", root],
    cwd: tmpdir(),
    env: { ...process.env, HOME: scratchHome, MIKRO_AGENTS_DIR: "" },
    stderr: "inherit",
  });

  const client = new Client({ name: "smoke-explore", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    const explore = tools.find((t) => t.name === "mikro_explore");
    assert(
      explore,
      `mikro_explore missing from tools/list; got ${tools.map((t) => t.name).join(", ")}`
    );
    assert(
      explore.description.includes("citation"),
      `the tool description must tell the host model it returns citations; got: ${explore.description}`
    );
    log("✓ mikro_explore discovered from <checkout>/.mikro/agents/ via --dir");

    const started = Date.now();
    const res = await client.callTool(
      { name: "mikro_explore", arguments: { prompt: QUESTION } },
      undefined,
      LIVE_OPTS
    );
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const text = textOf(res);
    assert(!res.isError, `mikro_explore call failed: ${text}`);

    const [answer, footer] = text.split("\n---\n");
    assert(answer && answer.trim().length > 0, "the answer body is empty");
    log(`✓ answered in ${seconds}s`);
    log(`  ${(footer ?? "").trim()}`);

    const iterations = Number(/· (\d+) iterations? ·/.exec(footer ?? "")?.[1] ?? 0);

    const candidates = citationsIn(answer);
    assert(candidates.length > 0, `no file:line citation in the answer:\n${answer}`);

    const resolved = [];
    const unresolved = [];
    for (const c of candidates) {
      const hit = resolveCitation(c.path, c.line);
      (hit ? resolved : unresolved).push(hit ?? c);
    }
    assert(
      resolved.length > 0,
      `no citation resolved against ${root}; saw ${candidates.map((c) => c.key).join(", ")}`
    );
    for (const r of resolved) log(`  ✓ ${r.path}:${r.line} → ${r.text.slice(0, 72)}`);
    for (const u of unresolved) log(`  ✗ ${u.key} does not resolve (reported, not gated)`);
    log(`✓ ${resolved.length}/${candidates.length} citations resolve to real lines`);

    // A floor, not the recitation guard: the first repl block's output only
    // comes back on the *next* iteration (`actualIterations = iteration + 1`,
    // src/rlm.ts:542), so a one-shot reply read nothing. A model that never
    // emits FINAL runs to max_iterations and leaves through the forced final
    // answer, so its count saturates and this check cannot fail it — which is
    // exactly why it is not the check the gate rests on.
    assert(
      iterations >= 2,
      `answered in ${iterations} iteration — no REPL output had come back yet, so this ` +
        `answer was composed without reading the tree:\n${answer}`
    );

    // Resolving is necessary but not sufficient: `README.md:1` resolves from
    // any repo and proves nothing. A citation is grounded when the line it
    // points at shares a code identifier with the answer — evidence that the
    // agent read what it cites rather than merely naming a plausible file.
    const grounded = resolved.filter((r) => sharedIdentifiers(r.text, answer).length > 0);
    assert(
      grounded.length > 0,
      `no citation is grounded — none of ${resolved
        .map((r) => `${r.path}:${r.line}`)
        .join(", ")} shares an identifier with the answer, so the agent has not ` +
        `shown it read this tree:\n${answer}`
    );
    log(
      `✓ ${grounded.length} grounded citation${grounded.length === 1 ? "" : "s"} ` +
        `(cited line shares an identifier with the answer) in ${iterations} iteration${
          iterations === 1 ? "" : "s"
        }`
    );

    // The one an unread answer cannot fake: a grounded citation whose anchor
    // and whose grounding identifier are both absent from everything the agent
    // was given. Recitation — of the prompt, of the question, of a memorised
    // repo — fails here whatever the iteration count says.
    const prompt = promptContext();
    const novel = grounded.filter(
      (r) =>
        !prompt.text.includes(`${r.path}:${r.line}`) &&
        sharedIdentifiers(r.text, answer).some((token) => !prompt.tokens.has(token))
    );
    assert(
      novel.length > 0,
      `no citation carries anything the prompt did not already contain — ${grounded
        .map((r) => `${r.path}:${r.line}`)
        .join(", ")} are all traceable to SYSTEM.md, agent.yaml or the question, so this ` +
        `answer is consistent with reciting the prompt:\n${answer}`
    );
    log(
      `✓ ${novel.length} of those cite${novel.length === 1 ? "s" : ""} something the agent's own ` +
        `prompt never mentions (${novel.map((r) => `${r.path}:${r.line}`).join(", ")})`
    );

    // Never a raw dump: the answer is a finding plus pointers, and a wall of
    // pasted source is the failure mode the citation contract exists to stop.
    assert(
      answer.length < 8_000,
      `answer is ${answer.length} chars — that is a dump, not an answer`
    );

    const correct =
      answer.includes(EXPECT_TOKEN) &&
      resolved.some((r) => r.path.endsWith(EXPECT_FILE));
    log(
      `  correctness (evidence, not gated): ${
        correct
          ? `HIT — named ${EXPECT_TOKEN} and cited ${EXPECT_FILE}`
          : `miss — expected ${EXPECT_TOKEN} in ${EXPECT_FILE}`
      }`
    );
    log(`  answer: "${answer.replace(/\s+/g, " ").trim().slice(0, 200)}…"`);

    return { label, model, seconds, iterations, resolved: resolved.length, correct, ok: true };
  } finally {
    try {
      await client.close();
    } catch {
      // Closing an already-dead transport is not a failure.
    }
  }
}

const scratch = mkdtempSync(join(tmpdir(), "mikro-explore-smoke-"));
const scratchHome = join(scratch, "home");
mkdirSync(scratchHome, { recursive: true });

/**
 * A checkout is allowed to ship its own `.mikro/agents/explore/`, and this script
 * overwrites it — same paths, `model:` rewritten per arm. So it is copied aside
 * before the first install and put back on the way out. Treating "it was already
 * there" as "leave whatever is there now" would hand the user the smoke copy,
 * pinned to a station model, with no backup and no warning.
 */
const preexisting = existsSync(installed);
const backup = join(scratch, "preexisting-explore");
if (preexisting) {
  cpSync(installed, backup, { recursive: true });
  log(`• ${installed} already exists — copied aside and restored on exit`);
}

/** Idempotent, and hung off `exit` too so no path out leaves the install behind. */
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  rmSync(installed, { recursive: true, force: true });
  if (preexisting) {
    try {
      cpSync(backup, installed, { recursive: true });
    } catch (err) {
      // The user's files: say so loudly and keep the copy rather than tidying.
      process.stdout.write(
        `\n! smoke-explore: could not restore ${installed}: ${err?.message ?? err}\n` +
          `! your copy is still at ${backup} (scratch dir deliberately left behind)\n`
      );
      return;
    }
  } else {
    // Leave `.mikro/agents/` behind only if something else already lives there.
    try {
      rmdirSync(join(root, ".mikro", "agents"));
    } catch {
      // Non-empty or already gone — either way, nothing to clean.
    }
  }
  rmSync(scratch, { recursive: true, force: true });
}
process.on("exit", cleanup);

let exitCode = 0;
const results = [];
try {
  results.push(await runArm("station", STATION_MODEL, scratchHome, true));

  const khalKey = process.env.KHAL_API_KEY || process.env.MIKRO_KHAL_API_KEY;
  if (skipKhal) {
    log("• khal arm skipped (--no-khal)");
  } else if (!khalKey) {
    log("• khal arm skipped (no KHAL_API_KEY) — the station arm gates the recipe");
  } else {
    const shipped = /^model:\s*(\S+)/m.exec(readFileSync(join(recipe, "agent.yaml"), "utf-8"))?.[1];
    assert(shipped, "examples/agents/explore/agent.yaml declares no model");
    // The cheap default model is exercised, never gated. Whether *this* model
    // clears the bar on *this* question is a model result, not a recipe result:
    // the parity suite measures it across 6 mined tasks with a tuning and
    // escalation ladder behind it, and a gate that a cheap model fails
    // intermittently stops being a gate. Its failures are printed in full.
    try {
      results.push(await runArm("khal", shipped, scratchHome, false));
    } catch (err) {
      if (!(err instanceof Failed)) throw err;
      log(`✗ khal arm FAILED (reported, not gated): ${err.message.split("\n")[0]}`);
      results.push({ label: "khal", model: shipped, ok: false, why: err.message.split("\n")[0] });
    }
  }

  const describe = (r) =>
    r.ok
      ? `${r.label}=${r.model} (${r.iterations} it, ${r.resolved} citation${
          r.resolved === 1 ? "" : "s"
        } resolved, ${r.seconds}s, correct=${r.correct})`
      : `${r.label}=${r.model} FAILED-NOT-GATED (${r.why})`;
  process.stdout.write(`\nSMOKE PASS: ${results.map(describe).join("; ")}\n`);
} catch (err) {
  process.stdout.write(
    `\nSMOKE FAIL: ${err instanceof Failed ? err.message : (err?.stack ?? err)}\n`
  );
  exitCode = 1;
} finally {
  cleanup();
}

process.exit(exitCode);
