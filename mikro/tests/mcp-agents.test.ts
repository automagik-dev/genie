/**
 * Microagent discovery gate — `mikro mcp`.
 *
 * Deterministic, no-LLM proofs for the discovery contract that a live MCP
 * smoke cannot pin down precisely:
 *   1. Tool names are MCP-legal (`^[a-zA-Z0-9_-]{1,128}$`) for hostile
 *      directory names — an illegal name would make the whole tools/list
 *      response invalid, not just that one agent.
 *   2. Root precedence: a project agent shadows a global agent of the same
 *      name, so a repo can override a machine-wide default.
 *   3. A broken agent.yaml is skipped rather than taking down the server.
 *   4. Descriptions are never empty — an empty description makes an agent
 *      effectively invisible to the host model.
 *   5. The live-refresh seam: a re-scan rebuilds the advertised list and the
 *      call lookup together, and reports a set change exactly once.
 *   6. The session seam: TTL expiry, LRU eviction, per-tool orphan eviction,
 *      turn-history bounding, and the resume fold — all the parts a live smoke
 *      cannot force deterministically.
 *   7. The propose-only boundary: a `<name>.proposed/` draft is neither listed
 *      nor callable, and the rename that approves it takes effect on the next
 *      refresh without a reconnect.
 *   8. The output contract: `structuredContent` actually carries every field
 *      `outputSchema` promises — above all the answer, which a host reading the
 *      structured channel instead of the text block would otherwise never see.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverAgents,
  isProposedDir,
  splitModel,
  toToolName,
  PROPOSED_SUFFIX,
  type Microagent,
} from "../src/mcp/agents.js";
import {
  agentMaxIterations,
  applyAgent,
  buildResumeQuery,
  buildToolList,
  createAgentRegistry,
  isFailedRun,
  McpSessionStore,
  sessionResult,
  textResult,
  toolOutputSchema,
  validateAgentTools,
} from "../src/mcp/server.js";
import { EMPTY_RESPONSES_BUDGET_HIT, TIMEOUT_ANSWER } from "../src/rlm.js";
import type { MikroConfig } from "../src/config.js";

const MCP_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;

function writeAgent(
  root: string,
  name: string,
  yamlBody: string,
  system?: string
): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.yaml"), yamlBody, "utf-8");
  if (system !== undefined) {
    writeFileSync(join(dir, "SYSTEM.md"), system, "utf-8");
  }
}

describe("toToolName", () => {
  it("produces MCP-legal names for hostile directory names", () => {
    const hostile = [
      "test writer",
      "Triage/Agent",
      "brain.l1-triage",
      "über-agent",
      "___",
      "a".repeat(200),
    ];

    for (const name of hostile) {
      const tool = toToolName(name);
      assert.match(
        tool,
        MCP_TOOL_NAME,
        `${JSON.stringify(name)} produced illegal tool name ${JSON.stringify(tool)}`
      );
      assert.ok(tool.startsWith("mikro_"), `${tool} lost its prefix`);
    }
  });

  it("never collapses to a bare prefix", () => {
    // "___" sanitizes to empty; it must still yield a usable tool name.
    assert.equal(toToolName("___"), "mikro_agent");
  });
});

describe("splitModel", () => {
  it("splits provider/model on the first slash", () => {
    assert.deepEqual(splitModel("station/Brain-35B"), {
      provider: "station",
      model: "Brain-35B",
    });
    // Model ids may themselves contain slashes.
    assert.deepEqual(splitModel("openai/org/model-v1"), {
      provider: "openai",
      model: "org/model-v1",
    });
  });

  it("returns null when there is no usable provider prefix", () => {
    for (const bad of ["gemini-2.5-flash", "/leading", "trailing/", ""]) {
      assert.equal(splitModel(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});

describe("discoverAgents", () => {
  let tmp: string;
  let globalRoot: string;
  let projectRoot: string;
  const prevEnv = process.env.MIKRO_AGENTS_DIR;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "mikro-mcp-agents-"));
    globalRoot = join(tmp, "global");
    projectRoot = join(tmp, "project");
    mkdirSync(globalRoot, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });

    // Same name in both roots — project must win.
    writeAgent(
      globalRoot,
      "triage",
      "schema_version: 1\nshape: single-step\nmodel: google/gemini-2.5-flash\n",
      "Global triage agent.\n"
    );
    writeAgent(
      projectRoot,
      "triage",
      "schema_version: 1\nshape: loop\nmodel: station/Brain-35B\nsystem: SYSTEM.md\n",
      "# triage\n\nProject triage agent that classifies inbound issues.\n"
    );

    writeAgent(
      projectRoot,
      "test writer",
      "schema_version: 1\nshape: recurse\ndescription: Writes unit tests for a module.\n"
    );

    // Malformed YAML must not abort discovery of its siblings.
    const brokenDir = join(projectRoot, "broken");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "agent.yaml"), "shape: [unclosed\n", "utf-8");

    // A directory with no agent.yaml at all is simply not an agent.
    mkdirSync(join(projectRoot, "not-an-agent"), { recursive: true });

    process.env.MIKRO_AGENTS_DIR = `${globalRoot}:${projectRoot}`;
  });

  after(() => {
    if (prevEnv === undefined) delete process.env.MIKRO_AGENTS_DIR;
    else process.env.MIKRO_AGENTS_DIR = prevEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("skips broken and non-agent directories without failing", async () => {
    const agents = await discoverAgents(tmp);
    const names = agents.map((a) => a.name);
    assert.ok(!names.includes("broken"), "broken agent.yaml should be skipped");
    assert.ok(!names.includes("not-an-agent"), "dir without agent.yaml is not an agent");
    assert.deepEqual(names, ["test writer", "triage"], "expected stable sorted order");
  });

  it("lets a project agent shadow a global agent of the same name", async () => {
    const agents = await discoverAgents(tmp);
    const triage = agents.find((a) => a.name === "triage");
    assert.ok(triage, "triage agent missing");
    assert.equal(triage.spec.model, "station/Brain-35B", "project agent should win");
    assert.equal(triage.spec.shape, "loop");
  });

  it("gives every agent a legal tool name and a non-empty description", async () => {
    const agents = await discoverAgents(tmp);
    assert.ok(agents.length > 0);

    for (const agent of agents) {
      assert.match(agent.toolName, MCP_TOOL_NAME, `${agent.name} -> ${agent.toolName}`);
      assert.ok(
        agent.summary.trim().length > 0,
        `${agent.name} has an empty summary and would be invisible to the host model`
      );
    }

    const tools = agents.map((a) => a.toolName);
    assert.equal(new Set(tools).size, tools.length, "tool names must be unique");
  });

  it("prefers an explicit description over the system prompt", async () => {
    const agents = await discoverAgents(tmp);
    const writer = agents.find((a) => a.name === "test writer");
    assert.ok(writer);
    assert.equal(writer.summary, "Writes unit tests for a module.");
    assert.equal(writer.toolName, "mikro_test_writer");
  });

  it("falls back to the system prompt, skipping a heading that repeats the name", async () => {
    const agents = await discoverAgents(tmp);
    const triage = agents.find((a) => a.name === "triage");
    assert.ok(triage);
    assert.equal(
      triage.summary,
      "Project triage agent that classifies inbound issues."
    );
  });
});

describe("validateAgentTools", () => {
  let tmp: string;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "mikro-mcp-tool-validation-"));
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function agent(
    name: string,
    tools: readonly string[],
    backend?: "mikro" | "prime" | "prime-sdk"
  ): Microagent {
    const dir = join(tmp, "agents", name);
    mkdirSync(join(dir, "tools"), { recursive: true });
    return {
      name,
      toolName: toToolName(name),
      dir,
      summary: `${name} summary.`,
      spec: {
        dir,
        schemaVersion: 1,
        toolsApi: 1,
        shape: "loop",
        tools,
        extras: {},
        ...(backend ? { backend } : {}),
      },
    } as Microagent;
  }

  it("marks missing default-backend tools unavailable with a repair path", async () => {
    const [missing] = await validateAgentTools(tmp, [agent("missing", ["ghost"])]);
    assert.equal(
      missing.unavailable,
      `missing tools: ghost — add tools/ghost.{mjs,js,py} to ${missing.dir} ` +
        "or remove the declaration, then retry."
    );

    const description = buildToolList([missing])[1].description ?? "";
    assert.match(
      description,
      /^UNAVAILABLE — "missing" cannot run: missing tools: ghost/
    );
    assert.ok(description.includes(missing.unavailable));
  });

  it("leaves the same unresolved declaration to prime-sdk", async () => {
    const [agentWithPrime] = await validateAgentTools(tmp, [
      agent("prime-agent", ["ghost"], "prime-sdk"),
    ]);
    assert.equal(agentWithPrime.unavailable, undefined);
  });

  for (const name of ["web-search", "2fa", "class", "async", "await", "None", "True", "False", "two words", "echo\n"]) {
    it(`marks an existing plugin with invalid Python name ${JSON.stringify(name)} unavailable`, async () => {
      const invalid = agent(`invalid-${name.trim()}`, [name]);
      writeFileSync(join(invalid.dir, "tools", `${name}.mjs`), 'throw new Error("must not import during discovery");\n');
      const [validated] = await validateAgentTools(tmp, [invalid]);
      assert.equal(
        validated.unavailable,
        `${JSON.stringify(name)} is not a valid Python tool name — use a Python identifier that is not a keyword, and rename the tool and its file.`
      );
      assert.match(buildToolList([validated])[1].description ?? "", /^UNAVAILABLE/);
    });
  }

  it("keeps valid Unicode identifiers and soft keywords available without importing plugins", async () => {
    const names = ["echo2", "echo_value", "café", "工具", "match", "case", "type"];
    const valid = agent("valid-names", names);
    for (const name of names) {
      writeFileSync(join(valid.dir, "tools", `${name}.mjs`), 'throw new Error("must not import during discovery");\n');
    }
    const [validated] = await validateAgentTools(tmp, [valid]);
    assert.equal(validated.unavailable, undefined);
  });

  it("leaves non-Python names to the other backends", async () => {
    for (const backend of ["prime", "prime-sdk"] as const) {
      const [validated] = await validateAgentTools(tmp, [agent(`names-${backend}`, ["web-search", "class"], backend)]);
      assert.equal(validated.unavailable, undefined);
    }
  });

  it("rejects runtime names and names hidden by the REPL namespace", async () => {
    for (const name of ["FINAL", "context", "_echo", "__debug__", "𝐜𝐨𝐧𝐭𝐞𝐱𝐭"]) {
      const [reserved] = await validateAgentTools(tmp, [agent(`reserved-${name}`, [name])]);
      assert.equal(
        reserved.unavailable,
        `"${name}" is a reserved REPL name — rename the tool and its file.`
      );
    }
  });

  it("rejects declared tools that normalize to the same Python name", async () => {
    const [validated] = await validateAgentTools(tmp, [agent("normalized-collision", ["echo", "ｅｃｈｏ"])]);
    assert.match(validated.unavailable ?? "", /same Python name as "echo"/);
  });

  it("rejects a declared name that collides with a TOOLS.md tool", async () => {
    const mikroDir = join(tmp, ".mikro");
    mkdirSync(mikroDir, { recursive: true });
    writeFileSync(
      join(mikroDir, "mikro.yaml"),
      "model:\n  provider: google\n  model: gemini-2.5-flash\n",
      "utf-8"
    );
    writeFileSync(
      join(mikroDir, "TOOLS.md"),
      "## echo\n```python\ndef echo(**kwargs):\n    return kwargs\n```\n",
      "utf-8"
    );

    const colliding = agent("collision", ["echo"]);
    writeFileSync(join(colliding.dir, "tools", "echo.mjs"), "", "utf-8");
    const [validated] = await validateAgentTools(tmp, [colliding]);
    assert.equal(
      validated.unavailable,
      '"echo" collides with a TOOLS.md tool — rename one of them.'
    );
  });

  it("preserves the first unavailability cause", async () => {
    const prior = {
      ...agent("bad-model", ["ghost"]),
      unavailable: "model unavailable — repair the model.",
    };
    const [validated] = await validateAgentTools(tmp, [prior]);
    assert.equal(validated.unavailable, prior.unavailable);
  });
});

describe("MCP agent description truth", () => {
  const microagent = (
    name: string,
    tools: readonly string[],
    backend?: "mikro" | "prime" | "prime-sdk",
    unavailable?: string
  ): Microagent =>
    ({
      name,
      toolName: toToolName(name),
      dir: `/tmp/${name}`,
      summary: `${name} summary.`,
      spec: {
        dir: `/tmp/${name}`,
        schemaVersion: 1,
        toolsApi: 1,
        shape: "loop",
        tools,
        extras: {},
        ...(backend ? { backend } : {}),
      },
      ...(unavailable ? { unavailable } : {}),
    }) as Microagent;

  it("ends every available and unavailable agent description with backend and tools", () => {
    const tools = buildToolList([
      microagent("plain", []),
      microagent("sdk", ["search", "fetch"], "prime-sdk"),
      microagent("broken", ["ghost"], undefined, "missing tools: ghost — repair it."),
    ]);
    assert.match(tools[1].description ?? "", /Backend: mikro\. Tools: none declared\.$/);
    assert.match(
      tools[2].description ?? "",
      /Backend: prime-sdk\. Tools: search, fetch\.$/
    );
    assert.match(tools[3].description ?? "", /Backend: mikro\. Tools: ghost\.$/);
  });

  it("leaves the generic tool description unchanged", () => {
    const generic = buildToolList([])[0];
    assert.equal(
      generic.description,
      "Launch a general-purpose mikro agent to handle a self-contained task " +
        "autonomously (RLM loop: Python REPL plus recursion). Use it to offload " +
        "work you would otherwise grind through inline — analysis over a large " +
        "body of files, repeated extraction, wide searches. Give it a complete, " +
        "standalone prompt: it runs to completion and returns a single final " +
        "report, and cannot ask follow-up questions mid-run. The result carries " +
        "the tokens and cost it used plus a session_id; pass that session_id back " +
        "to this tool to continue the conversation."
    );
  });
});

/**
 * `VALIDATE.md` is discovered by convention — `<agentdir>/VALIDATE.md`, with
 * no `agent.yaml` key pointing at it. That makes discovery the only place it
 * can be picked up, so the three states are pinned here: shipped and readable,
 * not shipped, and shipped broken. The broken case is load-bearing: `loadOne`
 * already drops an agent whose `agent.yaml` fails to parse, and a malformed
 * schema must NOT get that treatment — the agent stays listed and callable,
 * just uncontracted.
 */
describe("discoverAgents — VALIDATE.md by convention", () => {
  let tmp: string;
  let root: string;
  const prevEnv = process.env.MIKRO_AGENTS_DIR;

  const SPEC = "schema_version: 1\nshape: loop\ndescription: d.\n";

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "mikro-validate-md-"));
    root = join(tmp, "agents");
    mkdirSync(root, { recursive: true });

    writeAgent(root, "contracted", SPEC);
    writeFileSync(
      join(root, "contracted", "VALIDATE.md"),
      '# Done\n\n```json\n{ "type": "object", "required": ["verdict"] }\n```\n',
      "utf-8"
    );

    writeAgent(root, "uncontracted", SPEC);

    writeAgent(root, "broken-schema", SPEC);
    writeFileSync(
      join(root, "broken-schema", "VALIDATE.md"),
      "# Done\n\n```json\n{ oops, not json\n```\n",
      "utf-8"
    );

    process.env.MIKRO_AGENTS_DIR = root;
  });

  after(() => {
    if (prevEnv === undefined) delete process.env.MIKRO_AGENTS_DIR;
    else process.env.MIKRO_AGENTS_DIR = prevEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("loads the schema from the agent's own directory", async () => {
    const agents = await discoverAgents(tmp);
    const agent = agents.find((a) => a.name === "contracted");
    assert.ok(agent, "contracted agent missing");
    assert.ok(agent.validate, "VALIDATE.md next to agent.yaml was not picked up");
    assert.equal(agent.validate.schema.type, "object");
    assert.deepEqual(agent.validate.schema.required, ["verdict"]);
  });

  it("leaves validate undefined when the agent ships no VALIDATE.md", async () => {
    const agents = await discoverAgents(tmp);
    const agent = agents.find((a) => a.name === "uncontracted");
    assert.ok(agent);
    assert.equal(agent.validate, undefined);
  });

  it("keeps an agent with a malformed VALIDATE.md discoverable and uncontracted", async () => {
    const agents = await discoverAgents(tmp);
    const agent = agents.find((a) => a.name === "broken-schema");
    assert.ok(agent, "a bad schema must not make the agent vanish from tools/list");
    assert.equal(agent.validate, undefined);
  });
});

describe("isProposedDir", () => {
  it("matches the reserved suffix in any casing", () => {
    for (const name of ["x.proposed", "review-lite.PROPOSED", "a.Proposed", PROPOSED_SUFFIX]) {
      assert.equal(isProposedDir(name), true, `${name} must be treated as a draft`);
    }
  });

  it("does not swallow ordinary agent names", () => {
    // The suffix is reserved, not the word: `proposed` and `.proposed-v2` are
    // real agents and must stay discoverable.
    for (const name of ["proposed", "proposals", "x.proposed-v2", "x-proposed", "explore-r"]) {
      assert.equal(isProposedDir(name), false, `${name} must remain a real agent`);
    }
  });
});

/**
 * The propose-only boundary (wish `mikro-microagent-plugin`, decision 3).
 *
 * `/microagent-create` mines transcripts and writes a *draft* agent it must
 * not be able to run. Approval is the user renaming the directory, which only
 * means something if the un-renamed draft is inert — so the two halves of
 * "inert" are pinned separately here: absent from the advertised list, and
 * absent from the map `tools/call` dispatches through
 * (`src/mcp/server.ts:771`).
 *
 * The fixture is a *valid* agent — deliberately. A draft that failed to load
 * would be skipped by `loadOne` for the wrong reason and this whole suite
 * would pass vacuously, so the control below renames that same directory and
 * requires it to appear.
 */
describe("discoverAgents — .proposed drafts", () => {
  let tmp: string;
  let root: string;
  const prevEnv = process.env.MIKRO_AGENTS_DIR;

  /** A complete, loadable agent — the kind `/microagent-create` writes. */
  const DRAFT_YAML =
    "schema_version: 1\ntools_api: 1\nshape: loop\nmodel: khal/deepseek-v4-flash\n" +
    "description: Draft mined from transcripts; awaiting approval.\nsystem: SYSTEM.md\n";

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "mikro-proposed-"));
    root = join(tmp, "agents");
    mkdirSync(root, { recursive: true });

    writeAgent(root, "review-lite.proposed", DRAFT_YAML, "# review-lite\n\nDrafted.\n");
    // An approved agent alongside it: the skip must be surgical, not a
    // blanket refusal to discover anything in a root that holds a draft.
    writeAgent(
      root,
      "explore-r",
      "schema_version: 1\nshape: recurse\ndescription: Approved explorer.\n"
    );

    process.env.MIKRO_AGENTS_DIR = root;
  });

  after(() => {
    if (prevEnv === undefined) delete process.env.MIKRO_AGENTS_DIR;
    else process.env.MIKRO_AGENTS_DIR = prevEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("does not list a valid draft, and still lists its approved neighbour", async () => {
    const agents = await discoverAgents(tmp);
    assert.deepEqual(
      agents.map((a) => a.name),
      ["explore-r"],
      "a .proposed draft must not appear in the tool list"
    );
    assert.ok(
      !agents.some((a) => a.toolName === "mikro_review-lite_proposed"),
      "the leak this rule closes is the draft surfacing as mikro_<name>_proposed"
    );
  });

  it("does not make a valid draft callable", async () => {
    // `byToolName` IS the dispatch lookup: server.ts:771 answers tools/call
    // from it, so absence here is what "not callable" means mechanically.
    const registry = createAgentRegistry(() => discoverAgents(tmp));
    const scan = await registry.refresh();
    assert.equal(
      scan.byToolName.has("mikro_review-lite_proposed"),
      false,
      "an unapproved draft must not be dispatchable"
    );
    assert.equal(scan.byToolName.size, scan.agents.length);
    assert.ok(scan.byToolName.has("mikro_explore-r"), "the approved agent stays callable");
  });

  it("activates the draft on rename, live, without a reconnect", async () => {
    // One registry, never re-created — the same object a connected server
    // holds for the life of the connection (src/mcp/server.ts:704).
    const registry = createAgentRegistry(() => discoverAgents(tmp));
    const asDraft = await registry.refresh();
    assert.equal(asDraft.byToolName.has("mikro_review-lite"), false);

    // The approval step, and the only one: a rename performed by the user.
    renameSync(join(root, "review-lite.proposed"), join(root, "review-lite"));

    const approved = await registry.refresh();
    assert.ok(
      approved.agents.some((a) => a.name === "review-lite"),
      "renaming a draft must publish it"
    );
    assert.ok(
      approved.byToolName.has("mikro_review-lite"),
      "and must make it callable on that same scan"
    );
    assert.equal(
      approved.changed,
      true,
      "the set changed, so the server emits tools/list_changed rather than waiting for a reconnect"
    );
    assert.equal(
      approved.byToolName.get("mikro_review-lite")?.spec.model,
      "khal/deepseek-v4-flash",
      "the approved agent is the very file that was drafted"
    );

    // Restore the fixture so this suite's tests stay order-independent.
    renameSync(join(root, "review-lite"), join(root, "review-lite.proposed"));
  });

  it("keeps the draft inert again once the rename is undone", async () => {
    const agents = await discoverAgents(tmp);
    assert.deepEqual(agents.map((a) => a.name), ["explore-r"]);
  });
});

/**
 * `thinking:` at discovery time.
 *
 * Two halves of one contract. A good level has to survive the trip from YAML
 * onto `spec.thinking`, or `applyAgent` has nothing to apply. A bad level has
 * to be *audible*: `loadOne` skips any agent whose spec fails to parse, so
 * without a warning the parser's clear message dies in that catch and a typo'd
 * level presents as the agent having disappeared — the hardest possible thing
 * to debug from the host side, since the tool simply is not in `tools/list`.
 */
describe("discoverAgents — thinking:", () => {
  let tmp: string;
  let root: string;
  const prevEnv = process.env.MIKRO_AGENTS_DIR;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "mikro-mcp-thinking-"));
    root = join(tmp, "agents");
    mkdirSync(root, { recursive: true });
    writeAgent(root, "deep", "schema_version: 1\nshape: loop\nthinking: high\n", "Deep.\n");
    writeAgent(root, "cheap", "schema_version: 1\nshape: single-step\n", "Cheap.\n");
    writeAgent(root, "typo", "schema_version: 1\nshape: loop\nthinking: hgih\n", "Typo.\n");
    process.env.MIKRO_AGENTS_DIR = root;
  });

  after(() => {
    if (prevEnv === undefined) delete process.env.MIKRO_AGENTS_DIR;
    else process.env.MIKRO_AGENTS_DIR = prevEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Capture the skip warnings emitted during `run`.
   *
   * Filtered to this module's own `skipping agent` lines rather than returning
   * everything written: asserting on *all* stderr would make these tests fail
   * whenever some unrelated part of the process happens to log inside the
   * window, which is exactly the kind of flake that gets a suite ignored.
   */
  async function skipWarnings(run: () => Promise<void>): Promise<string[]> {
    const written: string[] = [];
    const real = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      if (text.includes("skipping agent")) {
        written.push(text);
        return true;
      }
      return (real as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;

    try {
      await run();
    } finally {
      process.stderr.write = real;
    }
    return written;
  }

  it("carries a declared level onto the spec, and undefined when absent", async () => {
    // First scan, so it is also the one that emits the warning below.
    let agents: Microagent[] = [];
    const warnings = await skipWarnings(async () => {
      agents = await discoverAgents(tmp);
    });

    assert.deepEqual(agents.map((a) => a.name), ["cheap", "deep"]);
    assert.equal(agents.find((a) => a.name === "deep")?.spec.thinking, "high");
    assert.equal(agents.find((a) => a.name === "cheap")?.spec.thinking, undefined);

    // The invalid agent is skipped — but says why, naming the agent, the
    // offending value, and the allowed set.
    const warning = warnings.join("");
    assert.match(warning, /skipping agent "typo"/);
    assert.match(warning, /thinking must be one of/);
    assert.match(warning, /got "hgih"/);
  });

  it("warns once per directory, and never for a non-agent directory", async () => {
    mkdirSync(join(root, "not-an-agent"), { recursive: true });

    const warnings = await skipWarnings(async () => {
      await discoverAgents(tmp);
    });

    // A dir with no agent.yaml is normal, and the already-reported broken one
    // must not repeat: discovery re-runs on every request, so a repeat would
    // flood the log for the lifetime of the server.
    assert.deepEqual(warnings, [], `unexpected warning: ${warnings.join("")}`);
  });
});

/**
 * Iteration-cap regression. Two bugs found by dogfooding a real triage agent:
 *   1. `shape` was ignored entirely, so a single-step agent inherited
 *      rlmLoop's 30-iteration default — 30 iterations and 157s for one pass.
 *   2. An explicit `budget.max_iterations` must still win over the shape
 *      default, or a `loop` agent has no way to bound itself.
 */
describe("agentMaxIterations", () => {
  const asAgent = (shape: string, maxIterations?: number) =>
    ({
      name: "t",
      toolName: "mikro_t",
      dir: "/tmp/t",
      summary: "t",
      spec: {
        dir: "/tmp/t",
        schemaVersion: 1,
        toolsApi: 1,
        shape,
        tools: [],
        extras: {},
        ...(maxIterations === undefined ? {} : { budget: { maxIterations } }),
      },
    }) as unknown as Parameters<typeof agentMaxIterations>[0];

  it("caps a single-step agent at one iteration", () => {
    assert.equal(agentMaxIterations(asAgent("single-step")), 1);
  });

  it("leaves loop and recurse agents uncapped by default", () => {
    assert.equal(agentMaxIterations(asAgent("loop")), undefined);
    assert.equal(agentMaxIterations(asAgent("recurse")), undefined);
  });

  it("lets an explicit budget.max_iterations win over the shape default", () => {
    assert.equal(agentMaxIterations(asAgent("single-step", 5)), 5);
    assert.equal(agentMaxIterations(asAgent("loop", 6)), 6);
  });
});

/**
 * An agent's `model:` must carry the sub-call model with it.
 *
 * The regression: `applyAgent` spread the ambient `config.model` and replaced
 * only provider + model, so an agent on `khal/deepseek-v4-flash` under a root
 * whose mikro.yaml sets `sub-call-model: gemini-3.1-flash-lite-preview` ran
 * with `provider: khal` and a Google sub-call id. A bare `llm_query(p)` inside
 * the agent then died with `Unknown model "gemini-3.1-flash-lite-preview" for
 * provider "khal"` — and, because the REPL turns handler throws into ordinary
 * result strings, silently.
 */
describe("applyAgent model inheritance", () => {
  const ambient = (): MikroConfig =>
    ({
      model: {
        provider: "google",
        model: "gemini-3.1-flash-lite-preview",
        subCallModel: "gemini-3.1-flash-lite-preview",
      },
      budget: { maxCost: null, maxTokens: null, maxDepth: null },
      // `googleSearch` is here to prove the thinking override clones this
      // object rather than replacing it — dropping a sibling flag would
      // silently turn a configured feature off.
      gemini: { thinkingLevel: null, googleSearch: true },
      // What `loadConfig` actually produces for an omitted top-level
      // `temperature:` — null, not undefined.
      temperature: null,
    }) as unknown as MikroConfig;

  const agentWith = (spec: Record<string, unknown>) =>
    ({
      name: "explore-r",
      toolName: "mikro_explore-r",
      dir: "/tmp/explore-r",
      summary: "explore-r",
      spec: { dir: "/tmp/explore-r", schemaVersion: 1, toolsApi: 1, shape: "recurse", tools: [], extras: {}, ...spec },
    }) as unknown as Microagent;

  it("re-pins the sub-call model to the agent's own model", () => {
    const next = applyAgent(ambient(), agentWith({ model: "khal/deepseek-v4-flash" }));
    assert.deepEqual(next.model, {
      provider: "khal",
      model: "deepseek-v4-flash",
      subCallModel: "deepseek-v4-flash",
    });
  });

  it("does not leave a cross-provider sub-call model behind", () => {
    const next = applyAgent(ambient(), agentWith({ model: "khal/deepseek-v4-flash" }));
    assert.notEqual(next.model.subCallModel, "gemini-3.1-flash-lite-preview");
  });

  it("leaves the ambient model untouched when the agent declares none", () => {
    const config = ambient();
    const next = applyAgent(config, agentWith({}));
    assert.deepEqual(next.model, config.model);
  });

  it("does not mutate the ambient config in place", () => {
    const config = ambient();
    applyAgent(config, agentWith({ model: "khal/deepseek-v4-flash" }));
    assert.equal(config.model.provider, "google");
    assert.equal(config.model.subCallModel, "gemini-3.1-flash-lite-preview");
  });

  it("ignores a model string with no provider prefix, as before", () => {
    const config = ambient();
    const next = applyAgent(config, agentWith({ model: "deepseek-v4-flash" }));
    assert.deepEqual(next.model, config.model);
  });

  /**
   * `thinking:` must land on `config.gemini.thinkingLevel` — the same field
   * `--thinking` writes and the only one `rlmLoop` forwards to `llmComplete` as
   * `options.thinkingLevel`. Asserting the field (not some new per-agent
   * channel) is the point: a second mechanism would be dead weight that looks
   * live.
   */
  describe("thinking level", () => {
    it("writes the declared level onto config.gemini.thinkingLevel", () => {
      const next = applyAgent(ambient(), agentWith({ thinking: "high" }));
      assert.equal(next.gemini.thinkingLevel, "high");
    });

    it("keeps the ambient gemini flags around it", () => {
      const next = applyAgent(ambient(), agentWith({ thinking: "low" }));
      assert.equal(next.gemini.googleSearch, true);
    });

    it("does not mutate the ambient config's gemini block in place", () => {
      // `applyAgent` shallow-copies, so `next.gemini` initially aliases the
      // caller's object. Writing through that alias would leak this agent's
      // level into every later run on the same loaded config.
      const config = ambient();
      applyAgent(config, agentWith({ thinking: "high" }));
      assert.equal(config.gemini.thinkingLevel, null);
    });

    it("leaves the ambient level alone when the agent declares none", () => {
      const config = ambient();
      config.gemini.thinkingLevel = "medium";
      const next = applyAgent(config, agentWith({}));
      assert.equal(next.gemini.thinkingLevel, "medium");
      assert.equal(next.gemini, config.gemini, "should not clone needlessly");
    });

    it("outranks an ambient mikro.yaml level, like the CLI flag does", () => {
      const config = ambient();
      config.gemini.thinkingLevel = "minimal";
      const next = applyAgent(config, agentWith({ thinking: "high" }));
      assert.equal(next.gemini.thinkingLevel, "high");
    });
  });

  /**
   * `temperature:` must land on `config.temperature` — the same field
   * `--temperature` and mikro.yaml's top-level key write, and the only one
   * `rlmLoop` forwards to `llmComplete`. Same single-answer rule as
   * `thinking:`, with one extra hazard: `0` is a real value, so the merge has
   * to be written with `!= null` and never truthiness.
   */
  describe("temperature", () => {
    it("writes the declared temperature onto config.temperature", () => {
      const next = applyAgent(ambient(), agentWith({ temperature: 0.7 }));
      assert.equal(next.temperature, 0.7);
    });

    /**
     * The regression this whole field is written to avoid. `if (spec.temperature)`
     * typechecks, reads fine, and drops exactly the value a run pinning
     * sampling drift cares about most.
     */
    it("survives an exact zero through the merge", () => {
      const next = applyAgent(ambient(), agentWith({ temperature: 0 }));
      assert.equal(next.temperature, 0);
      assert.notEqual(next.temperature, null);
    });

    it("lets an exact zero outrank a non-zero ambient temperature", () => {
      const config = ambient();
      config.temperature = 1.5;
      const next = applyAgent(config, agentWith({ temperature: 0 }));
      assert.equal(next.temperature, 0);
    });

    it("leaves the ambient temperature alone when the agent declares none", () => {
      const config = ambient();
      config.temperature = 1.5;
      assert.equal(applyAgent(config, agentWith({})).temperature, 1.5);
    });

    it("leaves an unset ambient temperature unset", () => {
      assert.equal(applyAgent(ambient(), agentWith({})).temperature, null);
    });

    it("does not mutate the ambient config in place", () => {
      const config = ambient();
      applyAgent(config, agentWith({ temperature: 0 }));
      assert.equal(config.temperature, null);
    });
  });

  /**
   * A microagent is contracted by its own VALIDATE.md or by nothing at all.
   * An agent's file outranks the root project's the same way its model and
   * thinking level do — and, unlike those, *silence also wins*: an agent that
   * ships no VALIDATE.md is uncontracted even inside a repo that ships one.
   */
  describe("validate schema", () => {
    const agentValidate = {
      schema: { type: "object" as const, required: ["verdict"] },
      rawBlock: '{ "type": "object" }',
    };
    const projectValidate = {
      schema: { type: "object" as const, required: ["summary"] },
      rawBlock: '{ "type": "object" }',
    };

    it("lets the agent's schema override the project's", () => {
      const config = ambient();
      config.validate = projectValidate;
      const next = applyAgent(config, { ...agentWith({}), validate: agentValidate });
      assert.deepEqual(next.validate?.schema.required, ["verdict"]);
    });

    /**
     * The inverse of what this test asserted when the field was first landed
     * (Group 1 pinned inheritance, before enforcement existed). Once `rlmLoop`
     * *enforces* the schema, inheriting the ambient one means an uncontracted
     * agent gets judged — and flagged `validation_failed` — against a contract
     * its author never wrote, purely because of which repo the host happened
     * to be started in. `if (agent.validate)` could raise a contract but never
     * clear one, so the assignment is unconditional.
     */
    it("clears the project schema when the agent ships none", () => {
      const config = ambient();
      config.validate = projectValidate;
      const next = applyAgent(config, agentWith({}));
      assert.equal(next.validate, null);
    });

    it("stays null when neither side has one", () => {
      const config = ambient();
      config.validate = null;
      assert.equal(applyAgent(config, agentWith({})).validate, null);
    });

    it("does not leak the agent's schema back into the ambient config", () => {
      // `applyAgent` shallow-copies; an override that wrote through the copy
      // would contract every later ambient run with this agent's schema.
      const config = ambient();
      config.validate = projectValidate;
      applyAgent(config, { ...agentWith({}), validate: agentValidate });
      assert.equal(config.validate, projectValidate);
    });
  });
});

/** Minimal stand-in for a discovered agent — the registry only reads names. */
function fakeAgent(name: string, model = "station/Brain-35B"): Microagent {
  return {
    name,
    toolName: toToolName(name),
    dir: `/tmp/${name}`,
    summary: `${name} agent`,
    spec: {
      dir: `/tmp/${name}`,
      schemaVersion: 1,
      toolsApi: 1,
      shape: "loop",
      tools: [],
      extras: {},
      model,
    },
  } as unknown as Microagent;
}

/**
 * Live-refresh seam. The failure this designs out is a tool that is listed but
 * not callable: `tools/list` and `tools/call` must be answered from the same
 * scan, and a set change must be reported once — not once per request.
 */
describe("createAgentRegistry", () => {
  it("seeds the baseline on the first scan without reporting a change", async () => {
    const registry = createAgentRegistry(async () => [fakeAgent("triage")]);
    const first = await registry.refresh();
    assert.equal(first.changed, false, "a fresh connect must not emit list_changed");
    assert.deepEqual(first.removed, []);
    assert.deepEqual(
      first.agents.map((a) => a.name),
      ["triage"]
    );
  });

  it("rebuilds the call lookup from the same scan that produced the list", async () => {
    let agents = [fakeAgent("triage")];
    const registry = createAgentRegistry(async () => agents);
    await registry.refresh();

    agents = [fakeAgent("triage"), fakeAgent("explore")];
    const scan = await registry.refresh();

    for (const agent of scan.agents) {
      assert.equal(
        scan.byToolName.get(agent.toolName),
        agent,
        `${agent.toolName} is advertised but missing from the call lookup`
      );
    }
    assert.equal(scan.byToolName.size, scan.agents.length);
    assert.ok(scan.byToolName.has("mikro_explore"), "the new agent must be callable at once");
  });

  it("reports an added agent once, then goes quiet", async () => {
    let agents = [fakeAgent("triage")];
    const registry = createAgentRegistry(async () => agents);
    await registry.refresh();

    agents = [fakeAgent("triage"), fakeAgent("explore")];
    assert.equal((await registry.refresh()).changed, true);
    assert.equal(
      (await registry.refresh()).changed,
      false,
      "a static set must not produce repeat notifications"
    );
  });

  it("reports a removed agent and names it for orphan eviction", async () => {
    let agents = [fakeAgent("triage"), fakeAgent("explore")];
    const registry = createAgentRegistry(async () => agents);
    await registry.refresh();

    agents = [fakeAgent("triage")];
    const scan = await registry.refresh();
    assert.equal(scan.changed, true);
    assert.deepEqual(scan.removed, ["mikro_explore"]);
    assert.equal(scan.byToolName.has("mikro_explore"), false, "a deleted agent must stop dispatching");
  });

  it("treats a modified spec as unchanged — the set is the same", async () => {
    let agents = [fakeAgent("triage", "station/Brain-35B")];
    const registry = createAgentRegistry(async () => agents);
    await registry.refresh();

    agents = [fakeAgent("triage", "khal/deepseek-v4-flash")];
    const scan = await registry.refresh();
    assert.equal(scan.changed, false, "an edited agent.yaml is not a tool-set change");
    // …but the current spec is what gets dispatched.
    assert.equal(scan.byToolName.get("mikro_triage")?.spec.model, "khal/deepseek-v4-flash");
  });

  it("reports a concurrent double-scan of the same change only once", async () => {
    let agents = [fakeAgent("triage")];
    const registry = createAgentRegistry(async () => agents);
    await registry.refresh();

    agents = [fakeAgent("triage"), fakeAgent("explore")];
    const [a, b] = await Promise.all([registry.refresh(), registry.refresh()]);
    assert.equal(
      [a.changed, b.changed].filter(Boolean).length,
      1,
      "two requests racing on one change must emit list_changed once"
    );
  });

  /**
   * Out-of-order scan completion. Two refreshes race; the later-started scan's
   * continuation runs first. Unserialized, the earlier scan then overwrites the
   * baseline with its older tool set: a live agent is reported `removed` (its
   * sessions get evicted) and re-announced as added on the next refresh. Driven
   * deterministically here — `scan` hands out deferreds and the driver resolves
   * the newest pending one first, so nothing depends on timing.
   */
  it("never reports a false removal when scans complete out of order", async () => {
    const triage = fakeAgent("triage");
    const explore = fakeAgent("explore");
    // Per scan call, in call order: the seed, then a stale [triage] alongside
    // the fresh [triage, explore] that must win, then the settled set.
    const byCall: Microagent[][] = [[triage], [triage], [triage, explore], [triage, explore]];
    let calls = 0;
    const pending: Array<() => void> = [];
    const registry = createAgentRegistry(
      () =>
        new Promise<readonly Microagent[]>((resolve) => {
          const value = byCall[Math.min(calls++, byCall.length - 1)]!;
          pending.push(() => resolve(value));
        })
    );

    /** Settle `p`, releasing pending scans newest-first (i.e. out of order). */
    async function drive<T>(p: Promise<T>): Promise<T> {
      let done = false;
      const tracked = p.then(
        (v) => {
          done = true;
          return v;
        },
        (e) => {
          done = true;
          throw e;
        }
      );
      for (let i = 0; !done; i++) {
        assert.ok(i < 100, "refresh never settled");
        await new Promise((r) => setImmediate(r));
        pending.pop()?.();
      }
      return tracked;
    }

    await drive(registry.refresh());
    const [a, b] = await drive(Promise.all([registry.refresh(), registry.refresh()]));
    const after = await drive(registry.refresh());

    for (const scan of [a, b, after]) {
      assert.deepEqual(scan.removed, [], "a live agent must never be reported removed");
    }
    assert.equal(
      [a, b].filter((s) => s.changed).length,
      1,
      "the added agent must be reported exactly once"
    );
    assert.equal(after.changed, false, "no duplicate re-announcement on the next refresh");
    assert.ok(after.byToolName.has("mikro_explore"), "the newest scan must win the baseline");
  });
});

/**
 * Session seam. Sessions are advisory — losing one costs a fresh start, never
 * correctness — but "advisory" is only safe if the map is genuinely bounded,
 * so TTL, LRU and turn caps are pinned here rather than trusted.
 */
describe("McpSessionStore", () => {
  it("binds a session to the tool that created it", () => {
    const store = new McpSessionStore();
    const session = store.create("mikro_explore");
    assert.equal(session.toolName, "mikro_explore");
    assert.equal(store.get(session.id)?.toolName, "mikro_explore");
    assert.match(session.id, /^sess_[0-9a-f]{16}$/);
  });

  it("expires a session once its TTL has passed", () => {
    let now = 1_000;
    const store = new McpSessionStore({ ttlMs: 100, now: () => now });
    const session = store.create("mikro_query");

    now = 1_099;
    assert.ok(store.get(session.id), "a session inside its TTL must survive");

    now = 1_300;
    assert.equal(store.get(session.id), undefined, "an idle session must expire");
    assert.equal(store.size, 0, "an expired session must be swept, not just hidden");
  });

  it("keeps a session alive while it is being used", () => {
    let now = 1_000;
    const store = new McpSessionStore({ ttlMs: 100, now: () => now });
    const session = store.create("mikro_query");

    now = 1_050;
    store.get(session.id); // a use refreshes the clock
    now = 1_120;
    assert.ok(store.get(session.id), "a recently-used session must not expire");
  });

  it("evicts the least-recently-used session at the size cap", () => {
    let now = 0;
    const ids: string[] = [];
    const store = new McpSessionStore({ maxSessions: 3, now: () => ++now });
    for (let i = 0; i < 3; i++) ids.push(store.create("mikro_query").id);

    store.get(ids[1]!); // touch the middle one so the oldest is ids[0]
    const fresh = store.create("mikro_query");

    assert.equal(store.size, 3, "the cap must hold");
    assert.equal(store.get(ids[0]!), undefined, "the least-recently-used session goes first");
    assert.ok(store.get(ids[1]!), "a recently-touched session survives");
    assert.ok(store.get(fresh.id));
  });

  it("never evicts a session with a call in flight", () => {
    let now = 0;
    const store = new McpSessionStore({ maxSessions: 2, now: () => ++now });
    const busy = store.create("mikro_query");
    busy.busy = true;
    const idle = store.create("mikro_query");

    store.create("mikro_query");
    assert.ok(store.get(busy.id), "an in-flight session must not be evicted under it");
    assert.equal(store.get(idle.id), undefined, "the idle session is the eviction candidate");
  });

  it("does not expire a session while its call is in flight", () => {
    let now = 1_000;
    const store = new McpSessionStore({ ttlMs: 10, now: () => now });
    const session = store.create("mikro_query");
    session.busy = true;
    now = 5_000;
    assert.ok(store.get(session.id), "a long call must not have its own session swept");
  });

  it("evicts orphans when their agent disappears", () => {
    const store = new McpSessionStore();
    const gone = store.create("mikro_explore");
    const kept = store.create("mikro_query");

    assert.equal(store.evictTools(["mikro_explore"]), 1);
    assert.equal(store.get(gone.id), undefined, "a deleted agent's sessions are unreachable");
    assert.ok(store.get(kept.id), "sessions on surviving tools are untouched");
  });

  it("bounds the turn history it retains", () => {
    const store = new McpSessionStore({ maxTurns: 2 });
    const session = store.create("mikro_query");
    for (const n of ["one", "two", "three"]) {
      store.record(session, { prompt: n, answer: `${n}!` });
    }
    assert.deepEqual(
      session.turns.map((t) => t.prompt),
      ["two", "three"],
      "the oldest turns drop out; the map cannot grow without bound"
    );
  });
});

/** The resume mechanism: conversation replay, not live REPL state. */
describe("buildResumeQuery", () => {
  it("passes the first turn of a session through untouched", () => {
    assert.equal(buildResumeQuery([], "what does agents.ts do?"), "what does agents.ts do?");
  });

  it("folds prior turns in ahead of the new prompt", () => {
    const out = buildResumeQuery(
      [{ prompt: "remember the codeword BANANA47", answer: "Noted: BANANA47." }],
      "what was the codeword?"
    );
    assert.match(out, /continuing conversation/);
    assert.match(out, /BANANA47/);
    assert.ok(out.trimEnd().endsWith("what was the codeword?"), "the new prompt comes last");
  });

  it("char-caps each replayed field so the preamble cannot run away", () => {
    const out = buildResumeQuery(
      [{ prompt: "p".repeat(10_000), answer: "a".repeat(10_000) }],
      "next"
    );
    assert.ok(out.length < 8_000, `preamble grew to ${out.length} chars`);
    assert.match(out, /…/);
  });
});

// ── The output contract ────────────────────────────────────────────────────

type OutputSchema = ReturnType<typeof toolOutputSchema>;
type ToolResult = ReturnType<typeof sessionResult>;

const SESSION_ID = "sess_0123456789abcdef";

/** JSON Schema type name → the `typeof` a conforming payload must report. */
const JSON_TYPEOF: Record<string, string> = {
  string: "string",
  number: "number",
  boolean: "boolean",
};

/** The `type` the schema declares for one property, or undefined. */
function declaredType(schema: OutputSchema, key: string): unknown {
  const prop = (schema?.properties ?? {})[key];
  return prop && typeof prop === "object" ? (prop as { type?: unknown }).type : undefined;
}

/**
 * Hold a result against the schema its own tool advertises.
 *
 * Written against `required` rather than against a literal field list, so a
 * field added to the declared contract and not to the payload fails here —
 * which is exactly the drift that made the answer invisible.
 */
function assertSatisfiesOutputSchema(result: ToolResult, label: string): void {
  const schema = toolOutputSchema();
  const required = Array.isArray(schema?.required) ? schema.required : [];
  assert.ok(required.length > 0, "the declared output contract must require something");

  const payload = result.structuredContent;
  assert.ok(payload, `${label}: outputSchema is declared, so structuredContent is mandatory`);
  for (const key of required) {
    const declared = String(declaredType(schema, key));
    const expected = JSON_TYPEOF[declared];
    assert.ok(expected, `the schema declares ${key} as ${declared}, which this check cannot verify`);
    assert.equal(
      typeof payload[key],
      expected,
      `${label}: structuredContent.${key} must be a ${expected}, got ${typeof payload[key]}`
    );
    if (expected === "string") {
      assert.ok(String(payload[key]).length > 0, `${label}: structuredContent.${key} is empty`);
    }
  }
}

function textOf(result: ToolResult): string {
  const block = result.content[0];
  assert.ok(block && block.type === "text", "the first content block must be text");
  return block.text;
}

/**
 * Declaring `outputSchema` cuts both ways: it makes `structuredContent` a
 * stated promise, and it also makes it a channel a conforming client may read
 * *instead of* the text block — the MCP SDK's own client rejects a non-error
 * result that omits it. So a payload narrower than the schema is not a cosmetic
 * mismatch: a schema naming only `session_id` describes a delegated run that
 * cost money and returned nothing the host model can read.
 */
describe("tool output contract", () => {
  it("promises the answer, not only the session id", () => {
    const schema = toolOutputSchema();
    const required = Array.isArray(schema?.required) ? [...schema.required].sort() : [];
    assert.deepEqual(
      required,
      ["answer", "session_id"],
      "the answer must be part of the stated contract, or a host may drop it"
    );
    assert.equal(declaredType(schema, "answer"), "string");
    assert.equal(declaredType(schema, "session_id"), "string");
  });

  it("declares that same contract on every advertised tool", () => {
    const agent = {
      name: "triage",
      toolName: "mikro_triage",
      dir: "/tmp/triage",
      summary: "Classifies inbound issues.",
      spec: {
        dir: "/tmp/triage",
        schemaVersion: 1,
        toolsApi: 1,
        shape: "single-step",
        tools: [],
        extras: {},
      },
    } as unknown as Microagent;

    const tools = buildToolList([agent]);
    assert.deepEqual(
      tools.map((t) => t.name),
      ["mikro_query", "mikro_triage"],
      "the generic tool plus one tool per agent"
    );
    for (const tool of tools) {
      assert.deepEqual(
        tool.outputSchema,
        toolOutputSchema(),
        `${tool.name} must advertise the same output contract as every other tool`
      );
    }
  });

  it("carries the answer in structuredContent on a successful call", () => {
    const text =
      "Two call sites: src/a.ts:10, src/b.ts:20.\n\n---\n" +
      `mikro · query · station/Brain-4B · 2 iterations · 900 in / 40 out · $0.00 · 3.1s · session ${SESSION_ID}`;
    const result = sessionResult(text, SESSION_ID);

    assert.equal(result.isError, false);
    assert.equal(
      result.structuredContent?.answer,
      text,
      "a host reading only structuredContent must still get the answer"
    );
    assert.equal(result.structuredContent?.session_id, SESSION_ID);
    assert.equal(
      result.structuredContent?.answer,
      textOf(result),
      "the structured answer and the text block must not drift"
    );
    assert.match(
      String(result.structuredContent?.answer),
      /mikro · /,
      "the cost footer rides along, so the offload stays visible on either channel"
    );
    assertSatisfiesOutputSchema(result, "success");
  });

  it("carries the failure message in structuredContent on a failed call", () => {
    const text = "mikro mikro_triage failed: connect ECONNREFUSED 127.0.0.1:8080";
    const result = sessionResult(text, SESSION_ID, true);

    assert.equal(result.isError, true);
    assert.equal(
      result.structuredContent?.answer,
      text,
      "a host reading only structuredContent must still learn why the call failed"
    );
    assert.equal(
      result.structuredContent?.session_id,
      SESSION_ID,
      "the session survives a failure so the caller can retry on it"
    );
    assert.equal(result.structuredContent?.answer, textOf(result));
    assertSatisfiesOutputSchema(result, "error");
  });

  it("omits structuredContent only where no session exists to report", () => {
    const result = textResult('mikro_query: "prompt" is required', true);
    assert.equal(
      result.structuredContent,
      undefined,
      "a pre-session failure has no session_id, and the schema requires one"
    );
    assert.equal(
      result.isError,
      true,
      "omitting structuredContent is legal only on an error result"
    );
  });
});

/**
 * `rlmLoop` only *throws* on unexpected failures. Its two designed ones — the
 * consecutive-empty-response abort and the wall-clock timeout — return normally
 * with their reason as the answer, so nothing downstream notices unless the
 * result is inspected, and the host model reads the abort reason as the
 * delegated agent's report.
 *
 * The constants come from `src/rlm.ts` on purpose: the discriminators are
 * values the loop produces, so if one is reworded the test moves with it rather
 * than quietly describing a shape nothing returns any more.
 */
describe("isFailedRun", () => {
  it("flags the failures rlmLoop returns instead of throwing", () => {
    // The empty-response abort is identified by budgetHit, not by its prose.
    assert.equal(
      isFailedRun({
        answer:
          "Error: aborted after 3 consecutive empty LLM responses. Context may exceed API token limits.",
        budgetHit: EMPTY_RESPONSES_BUDGET_HIT,
      }),
      true,
      "the empty-response abort must count as a failure"
    );
    // The timeout keeps whatever budgetHit it had (usually none), so it is
    // identified by its verbatim answer.
    assert.equal(
      isFailedRun({ answer: TIMEOUT_ANSWER, budgetHit: null }),
      true,
      "the wall-clock timeout must count as a failure"
    );
  });

  it("leaves a real answer alone, including a budget-truncated one", () => {
    // max-cost / max-tokens / max-depth force a *final answer* — shorter than
    // it would have been, but a report. Flagging it would teach the host to
    // discard good work.
    for (const budgetHit of ["max-cost", "max-tokens", "max-depth", null, undefined]) {
      assert.equal(
        isFailedRun({ answer: "The two call sites are src/a.ts:10 and src/b.ts:20.", budgetHit }),
        false,
        `budgetHit=${String(budgetHit)} is a shorter report, not a failure`
      );
    }
  });

  it("does not sniff the answer text — a report may open with `Error: `", () => {
    // Regression guard for the prefix heuristic this replaced. Quoting the
    // failing line out of a log is the whole job of the shipped `log-triage`
    // recipe, so `Error: …` is a normal first line of a *successful* run.
    // Flagging it returns a paid, correct delegation to the host as a tool
    // error, which it may discard or retry at double the cost.
    for (const answer of [
      "Error: ECONNREFUSED appears 42 times, all from worker-3 (logs/worker-3.log:118).",
      "Error: RLM query timed out — this string appears inside the log at build.log:9, not as an abort.",
      "Errors: the handler swallows three of them (src/x.ts:44).",
      "No errors found in the module.",
    ]) {
      assert.equal(
        isFailedRun({ answer, budgetHit: null }),
        false,
        `${answer.slice(0, 40)}… is an answer`
      );
    }
  });
});
