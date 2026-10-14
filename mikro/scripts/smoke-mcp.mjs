#!/usr/bin/env node
/**
 * smoke-mcp.mjs — end-to-end gate for `mikro mcp`.
 *
 * Spawns the real server as a subprocess and drives it with the MCP SDK's own
 * client, so this proves genuine protocol compatibility rather than our own
 * framing of it. No mocks, no stubs.
 *
 * The workspace is a real one: a temp directory holding `.mikro/mikro.yaml` and
 * `.mikro/agents/<name>/`, discovered through the ordinary precedence path.
 * `MIKRO_AGENTS_DIR` is deliberately NOT set — the override would bypass the
 * very code path this gate exists to protect. The server is spawned from a
 * *different* cwd and pointed at the workspace with `--dir`, so a passing run
 * also proves the `--dir` contract: discovery, `loadConfig`, and the run all
 * agree on the directory the flag names, not on where the process started.
 *
 * Verifies:
 *   1. initialize handshake completes, serverInfo.name === "mikro", and the
 *      server declares tools.listChanged (a capability it genuinely emits).
 *   2. tools/list exposes mikro_query plus one tool per discovered agent.yaml,
 *      each with an MCP-legal name, a spawn-style description, the Agent-tool
 *      input shape (`prompt` + deprecated `query` + `session_id`, nothing
 *      required, no anyOf), and the `{answer, session_id}` output schema.
 *   3. Argument validation: prompt accepted, query accepted, both rejected,
 *      neither rejected — the errors naming `prompt`.
 *   4. An agent directory created mid-session is listed AND callable without a
 *      reconnect, and `notifications/tools/list_changed` fires once per set
 *      change (and not at all while the set is static).
 *   5. A result carries `session_id` in structuredContent and in the footer,
 *      and `answer` in structuredContent mirroring the text block byte for
 *      byte; a follow-up call passing it resumes the same session.
 *   6. Session errors: unknown session_id, a session presented to a different
 *      tool, and a concurrent call on a busy session each fail as tool errors.
 *   7. An agent deleted mid-session stops dispatching ("Unknown tool" wins over
 *      the session the caller still holds) and the set change is announced.
 *   8. The server survives every one of those failures.
 *
 * The live legs run real rlmLoop turns against the local station/Lemonade
 * gateway — no cloud keys, same convention as scripts/smoke-acp.mjs. Override
 * with MIKRO_SMOKE_MODEL=<provider>/<model>. `--no-live` skips them and gates
 * the protocol surface alone (useful where no gateway is running).
 *
 *   node scripts/smoke-mcp.mjs
 *   node scripts/smoke-mcp.mjs --no-live
 *   MIKRO_SMOKE_MODEL=station/Brain-35B node scripts/smoke-mcp.mjs
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const cli = join(root, "dist", "src", "cli.js");
const live = !process.argv.includes("--no-live");

const MCP_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;

// A small local model keeps the live legs fast and keyless; the turn budget
// bounds each run to a couple of real iterations. Brain-4B answers a smoke
// prompt in ~1s and stays terse — larger station models are correct here too,
// just slower (MIKRO_SMOKE_MODEL overrides).
const SMOKE_MODEL = process.env.MIKRO_SMOKE_MODEL ?? "station/Brain-4B";
const slash = SMOKE_MODEL.indexOf("/");
const MODEL_PROVIDER = slash > 0 ? SMOKE_MODEL.slice(0, slash) : "station";
const MODEL_ID = slash > 0 ? SMOKE_MODEL.slice(slash + 1) : SMOKE_MODEL;

/** Codeword planted in turn 1 and recalled in turn 2 (evidence, not a gate). */
const CODEWORD = "MARMOSET92";

const log = (msg) => process.stdout.write(`# smoke-mcp: ${msg}\n`);
function assert(cond, msg) {
  if (!cond) {
    process.stdout.write(`\nSMOKE FAIL: ${msg}\n`);
    process.exit(1);
  }
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (res) => res?.content?.[0]?.text ?? "";
/** Input tokens a run reported, read back out of its own footer. */
function inputTokens(text) {
  const m = /· ([\d,]+) in \/ [\d,]+ out ·/.exec(text);
  return m ? Number(m[1].replace(/,/g, "")) : NaN;
}

/**
 * Live-call request options. Supplying `onprogress` makes the SDK client send
 * a progressToken, which is what switches the server's progress + heartbeat
 * path on — so this also exercises the notification that keeps long delegated
 * runs from tripping a client deadline.
 */
const LIVE_OPTS = {
  timeout: 120_000,
  resetTimeoutOnProgress: true,
  maxTotalTimeout: 600_000,
  onprogress: (p) => log(`  … ${p.message ?? `progress ${p.progress}`}`),
};

// ── Fixture: a real workspace root with one microagent ────────────────────
const tmp = mkdtempSync(join(tmpdir(), "mikro-mcp-smoke-"));
// A scratch HOME so the global discovery root (~/.mikro/agents) is empty and
// this machine's real agents cannot drift the assertions.
const scratchHome = join(tmp, "home");
mkdirSync(scratchHome, { recursive: true });

const agentsRoot = join(tmp, ".mikro", "agents");

function writeAgent(name, body) {
  const dir = join(agentsRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.yaml"), body, "utf-8");
  return dir;
}

mkdirSync(agentsRoot, { recursive: true });
writeFileSync(
  join(tmp, ".mikro", "mikro.yaml"),
  `model:\n  provider: ${MODEL_PROVIDER}\n  model: ${MODEL_ID}\nbudget:\n  max-tokens: 900\n`,
  "utf-8"
);
writeAgent(
  "smoke-echo",
  "schema_version: 1\nshape: single-step\ndescription: Smoke fixture agent.\n"
);

let client;
let exitCode = 0;
let listChanged = 0;

try {
  const transport = new StdioClientTransport({
    // Spawned from the system temp dir, NOT the workspace: --dir is what has
    // to make the server agree with `tmp`.
    command: process.execPath,
    args: [cli, "mcp", "--dir", tmp],
    cwd: tmpdir(),
    env: { ...process.env, HOME: scratchHome, MIKRO_AGENTS_DIR: "" },
    stderr: "inherit",
  });

  client = new Client({ name: "smoke-mcp", version: "1.0.0" }, { capabilities: {} });
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChanged += 1;
  });
  await client.connect(transport);

  const info = client.getServerVersion();
  assert(info?.name === "mikro", `expected serverInfo.name "mikro", got ${info?.name}`);
  log(`✓ handshake complete — server ${info.name} ${info.version}`);

  const caps = client.getServerCapabilities();
  assert(
    caps?.tools?.listChanged === true,
    "server must declare tools.listChanged — clients only listen when told to"
  );
  log("✓ server declares tools.listChanged");

  // ── tools/list ──────────────────────────────────────────────────────────
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  log(`✓ tools/list returned ${tools.length}: ${names.join(", ")}`);

  assert(names.includes("mikro_query"), "mikro_query must always be present");
  assert(
    names.includes("mikro_smoke-echo"),
    `agent from --dir workspace missing from tools; got ${names.join(", ")}`
  );
  log("✓ --dir workspace discovered (.mikro/agents/smoke-echo → mikro_smoke-echo)");

  // ── schema shape: isomorphic to the host's native Agent tool ────────────
  for (const tool of tools) {
    assert(MCP_TOOL_NAME.test(tool.name), `illegal MCP tool name: ${tool.name}`);
    assert(
      typeof tool.description === "string" && tool.description.trim().length > 0,
      `tool ${tool.name} has an empty description and would be invisible to the host model`
    );
    assert(
      tool.description.includes("session_id"),
      `tool ${tool.name} must tell the model how to continue (spawn-style description)`
    );

    const schema = tool.inputSchema ?? {};
    const props = schema.properties ?? {};
    for (const key of ["prompt", "query", "session_id"]) {
      assert(props[key], `tool ${tool.name} is missing the "${key}" input property`);
    }
    assert(
      Array.isArray(schema.required) && schema.required.length === 0,
      `tool ${tool.name} must leave every input optional (required: []) — got ${JSON.stringify(schema.required)}`
    );
    const encoded = JSON.stringify(schema);
    assert(
      !encoded.includes('"anyOf"') && !encoded.includes('"oneOf"'),
      `tool ${tool.name} must not express exactly-one via anyOf/oneOf — hosts surface it inconsistently`
    );

    const out = tool.outputSchema ?? {};
    // `answer` is part of the contract, not an extra: an outputSchema is also
    // permission for a client to read structuredContent *instead of* the text
    // block, so a schema promising only session_id describes a result whose
    // whole payload the host may legally discard.
    assert(
      out.properties?.session_id?.type === "string" &&
        out.properties?.answer?.type === "string" &&
        Array.isArray(out.required) &&
        out.required.includes("session_id") &&
        out.required.includes("answer"),
      `tool ${tool.name} must declare the {answer: string, session_id: string} output contract`
    );
  }
  log("✓ every tool: legal name, spawn-style description, prompt/query/session_id optional, no anyOf, {answer, session_id} output schema");

  // ── argument validation: exactly one of prompt/query ────────────────────
  const neither = await client.callTool({ name: "mikro_query", arguments: {} });
  assert(neither.isError === true, "a call with no prompt should return a tool error");
  assert(
    textOf(neither).includes("prompt"),
    `the missing-input error must name "prompt"; got: ${textOf(neither)}`
  );
  log(`✓ neither prompt nor query rejected: "${textOf(neither).slice(0, 72)}…"`);

  const blank = await client.callTool({ name: "mikro_query", arguments: { query: "   " } });
  assert(blank.isError === true, "a blank query should return a tool error");
  assert(textOf(blank).includes("prompt"), "the blank-input error must name \"prompt\"");
  log("✓ blank input rejected as a tool error");

  const both = await client.callTool({
    name: "mikro_query",
    arguments: { prompt: "a", query: "b" },
  });
  assert(both.isError === true, "passing both prompt and query should return a tool error");
  assert(
    textOf(both).includes("prompt"),
    `the both-inputs error must name "prompt"; got: ${textOf(both)}`
  );
  log(`✓ prompt+query together rejected: "${textOf(both).slice(0, 72)}…"`);

  const unknown = await client.callTool({ name: "mikro_nope", arguments: { prompt: "hi" } });
  assert(unknown.isError === true, "unknown tool should return a tool error");
  log("✓ unknown tool rejected as a tool error");

  const staleSession = await client.callTool({
    name: "mikro_query",
    arguments: { prompt: "hi", session_id: "sess_deadbeefdeadbeef" },
  });
  assert(staleSession.isError === true, "an unknown session_id should return a tool error");
  assert(
    textOf(staleSession).includes("session_id"),
    `the unknown-session error must name session_id; got: ${textOf(staleSession)}`
  );
  log(`✓ unknown session_id rejected: "${textOf(staleSession).slice(0, 72)}…"`);

  await delay(100);
  assert(
    listChanged === 0,
    `a static agent set must not notify; saw ${listChanged} list_changed`
  );
  log("✓ no spurious list_changed while the agent set is static");

  // ── live refresh: create an agent AFTER connect ─────────────────────────
  writeAgent(
    "smoke-fresh",
    "schema_version: 1\nshape: single-step\n" +
      "description: Agent created after the client connected.\n"
  );

  const afterCreate = await client.listTools();
  await delay(100);
  const createdNames = afterCreate.tools.map((t) => t.name);
  assert(
    createdNames.includes("mikro_smoke-fresh"),
    `mid-session agent missing from tools/list; got ${createdNames.join(", ")}`
  );
  assert(
    listChanged === 1,
    `expected exactly one list_changed for the new agent, saw ${listChanged}`
  );
  log("✓ agent created mid-session appears in tools/list + one list_changed");

  await client.listTools();
  await delay(100);
  assert(listChanged === 1, `a re-list of an unchanged set must not notify (saw ${listChanged})`);
  log("✓ re-listing an unchanged set stays quiet");

  // ── live legs: real turns against the local gateway ─────────────────────
  let sessionId;
  if (live) {
    log(`running live turns on ${SMOKE_MODEL} (pass --no-live to skip)…`);

    const first = await client.callTool(
      {
        name: "mikro_smoke-fresh",
        arguments: {
          prompt: `Remember the codeword ${CODEWORD}. Reply with exactly: noted ${CODEWORD} /no_think`,
        },
      },
      undefined,
      LIVE_OPTS
    );
    assert(!first.isError, `mid-session agent call failed: ${textOf(first)}`);
    log("✓ the mid-session agent is callable without a reconnect");

    const firstText = textOf(first);
    assert(firstText.includes("mikro ·"), "result must carry the cost footer");
    sessionId = first.structuredContent?.session_id;
    assert(
      typeof sessionId === "string" && sessionId.length > 0,
      "result must carry session_id in structuredContent"
    );
    assert(
      first.structuredContent?.answer === firstText,
      "structuredContent.answer must mirror the text block — a host that reads " +
        "the declared contract and drops content would otherwise see no answer"
    );
    assert(
      firstText.includes(`session ${sessionId}`),
      "the footer must echo session_id for hosts that render only text"
    );
    log(`  ${firstText.slice(firstText.lastIndexOf("mikro ·")).trim()}`);

    // Resume and session-busy in one flight: the follow-up is still running
    // when the second call on the same session arrives. The follow-up goes in
    // through the deprecated `query` alias, so this leg proves both that
    // resume works and that the old param still runs.
    const resuming = client.callTool(
      {
        name: "mikro_smoke-fresh",
        arguments: {
          query: "What was the codeword? Reply with just the word. /no_think",
          session_id: sessionId,
        },
      },
      undefined,
      LIVE_OPTS
    );
    await delay(400);
    const busy = await client.callTool({
      name: "mikro_smoke-fresh",
      arguments: { prompt: "and again", session_id: sessionId },
    });
    assert(busy.isError === true, "a concurrent call on a live session must be rejected");
    assert(
      /busy/i.test(textOf(busy)),
      `the concurrent-call error must say the session is busy; got: ${textOf(busy)}`
    );
    log(`✓ concurrent same-session call rejected: "${textOf(busy).slice(0, 72)}…"`);

    const resumed = await resuming;
    assert(!resumed.isError, `resume call failed: ${textOf(resumed)}`);
    assert(
      resumed.structuredContent?.session_id === sessionId,
      "a resumed call must stay on the same session_id"
    );
    const resumedText = textOf(resumed);
    assert(
      resumedText.split("\n---\n")[0].trim().length > 0,
      "a resumed call must return a non-empty answer"
    );
    assert(
      resumed.structuredContent?.answer === resumedText,
      "a resumed call must carry its answer in structuredContent too"
    );
    log(
      `✓ resume round-trip: same session_id, non-empty answer ` +
        `(${inputTokens(firstText)} → ${inputTokens(resumedText)} input tokens)`
    );
    log("✓ deprecated `query` alias still runs (it carried the resume turn)");
    // Whether a small local model then repeats the planted codeword is model
    // behaviour, not a protocol contract, so it is reported and never gated —
    // the same rule scripts/smoke-acp.mjs applies to its own multi-turn leg.
    // The fold itself is pinned deterministically by tests/mcp-agents.test.ts
    // (buildResumeQuery), which is where a reproducible proof belongs; the
    // token counts above are indicative only, since the number of model calls
    // a turn makes is itself model-dependent.
    const resumedAnswer = resumedText.split("\n---\n")[0].trim();
    log(
      `  prior-turn recall (evidence, not gated): ${
        resumedText.includes(CODEWORD) ? `HIT — model echoed ${CODEWORD}` : "miss"
      } — answered: "${resumedAnswer.replace(/\s+/g, " ").slice(0, 120)}"`
    );

    const crossTool = await client.callTool({
      name: "mikro_query",
      arguments: { prompt: "whose session is this?", session_id: sessionId },
    });
    assert(crossTool.isError === true, "a session_id must not be usable on another tool");
    assert(
      textOf(crossTool).includes("mikro_smoke-fresh"),
      `the cross-tool error must name the owning tool; got: ${textOf(crossTool)}`
    );
    log(`✓ cross-tool session reuse rejected: "${textOf(crossTool).slice(0, 72)}…"`);
  } else {
    log("• skipped live turns (--no-live): resume, session-busy and cross-tool reuse not exercised");
  }

  // ── live refresh: delete the agent mid-session ──────────────────────────
  rmSync(join(agentsRoot, "smoke-fresh"), { recursive: true, force: true });

  const afterDelete = await client.listTools();
  await delay(100);
  assert(
    !afterDelete.tools.map((t) => t.name).includes("mikro_smoke-fresh"),
    "a deleted agent must drop out of tools/list"
  );
  assert(listChanged === 2, `expected a second list_changed for the deletion, saw ${listChanged}`);
  log("✓ agent deleted mid-session drops out + one more list_changed");

  const orphan = await client.callTool({
    name: "mikro_smoke-fresh",
    arguments: { prompt: "still there?", ...(sessionId ? { session_id: sessionId } : {}) },
  });
  assert(orphan.isError === true, "a deleted agent must stop dispatching");
  assert(
    textOf(orphan).startsWith("Unknown tool"),
    `"Unknown tool" must win over the held session; got: ${textOf(orphan)}`
  );
  log('✓ deleted agent: "Unknown tool" wins over the caller\'s session');

  const healthy = await client.listTools();
  assert(
    healthy.tools.map((t) => t.name).includes("mikro_query"),
    "server must survive every failed call"
  );
  log("✓ server still healthy after all failed calls");

  process.stdout.write(
    `\nSMOKE PASS: handshake + --dir workspace + Agent-tool schema + live refresh ` +
      `(create/delete + list_changed) + ${live ? "sessions (resume, busy, cross-tool) + " : ""}` +
      `error isolation all verified.${live ? "" : " (protocol only — live turns skipped)"}\n`
  );
} catch (err) {
  process.stdout.write(`\nSMOKE FAIL: ${err?.stack || err}\n`);
  exitCode = 1;
} finally {
  try {
    await client?.close();
  } catch {
    // Closing an already-dead transport is not a failure.
  }
  rmSync(tmp, { recursive: true, force: true });
}

process.exit(exitCode);
