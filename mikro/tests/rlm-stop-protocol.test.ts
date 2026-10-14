/**
 * The termination protocol must reach every FINAL-terminated run.
 *
 * The defect these tests pin: a pack's own `SYSTEM.md` *replaces* the
 * scaffolded template, and the ```repl``` / `FINAL()` contract lived only in
 * that template. An agent with a hand-written prompt was therefore never told
 * how to stop — it answered in prose, `detectFinal` never fired, and the run
 * burned to `max_iterations`. Both prompt builders now append the protocol
 * unless the prompt already teaches it or the config opts out.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSystemPrompt } from "../src/rlm.js";
import { buildCachedSystemPrompt } from "../src/cache.js";
import { STOP_PROTOCOL_SECTION } from "../src/stop-protocol.js";
import { applyAgent } from "../src/mcp/server.js";
import type { Microagent } from "../src/mcp/agents.js";
import type { MikroConfig } from "../src/config.js";

// ─── Helpers ─────────────────────────────────────────────

function makeConfig(overrides: Partial<MikroConfig> = {}): MikroConfig {
  return {
    system: null,
    tools: [],
    criteria: null,
    model: { provider: "google", model: "gemini-3.1-flash-lite-preview" },
    configDir: "/tmp",
    budget: { maxCost: null, maxTokens: null, maxDepth: null },
    contextConfig: { extensions: [".md"], exclude: ["node_modules"] },
    toolsLevel: "core",
    cache: { enabled: false, strategy: "full", retention: "long" },
    gemini: {
      thinkingLevel: null,
      googleSearch: false,
      urlContext: false,
      codeExecution: false,
      computerUse: false,
      mapsGrounding: false,
      fileSearch: false,
      mediaResolution: null,
    },
    output: { schema: null },
    storage: {
      enabled: "auto",
      mode: "persistent",
      dataDir: "~/.mikro/data",
      port: 0,
      chunkSize: null,
      chunkUtilization: 0.6,
      charsPerToken: 4,
    },
    prompt: { appendStopProtocol: true },
    validate: overrides.validate ?? null,
    providers: [],
    configSource: "yaml",
    ...overrides,
  };
}

/**
 * Read a shipped template. Tests run from `dist/tests/`, and `npm run build`
 * copies `src/templates` to `dist/src/templates`, so this resolves in both
 * trees relative to the compiled test file.
 */
function readTemplate(name: "default" | "code"): string {
  return readFileSync(
    fileURLToPath(new URL(`../src/templates/${name}/SYSTEM.md`, import.meta.url)),
    "utf-8"
  );
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/** A `Microagent` carrying only the spec fields `applyAgent` reads. */
function agentWith(spec: Record<string, unknown>): Microagent {
  return {
    name: "one-liner",
    toolName: "mikro_one-liner",
    dir: "/tmp/one-liner",
    summary: "one-liner",
    spec: {
      dir: "/tmp/one-liner",
      schemaVersion: 1,
      toolsApi: 1,
      shape: "recurse",
      tools: [],
      extras: {},
      ...spec,
    },
  } as unknown as Microagent;
}

// ─── The shared section's content ────────────────────────

describe("STOP_PROTOCOL_SECTION", () => {
  it("teaches the ```repl fence contract", () => {
    assert.ok(STOP_PROTOCOL_SECTION.includes("```repl"));
    assert.ok(STOP_PROTOCOL_SECTION.includes("repl` language identifier"));
  });

  it("teaches both FINAL forms and the FINAL_VAR ordering trap", () => {
    assert.ok(STOP_PROTOCOL_SECTION.includes("FINAL("));
    assert.ok(STOP_PROTOCOL_SECTION.includes("FINAL_VAR("));
    assert.ok(STOP_PROTOCOL_SECTION.includes("EXISTING variable"));
    assert.ok(STOP_PROTOCOL_SECTION.includes("SEPARATE"));
  });

  it("carries the iteration-0 note that mirrors the runtime safeguard", () => {
    assert.ok(STOP_PROTOCOL_SECTION.includes("iteration 0"));
  });

  /**
   * The section is appended to every custom prompt, so it stays a minimal
   * termination contract. `SHOW_VARS()` is a debugging convenience, not part
   * of stopping, and the template's mention of it must not leak in here.
   */
  it("never mentions SHOW_VARS — this is a stop contract, not a tour", () => {
    assert.ok(!STOP_PROTOCOL_SECTION.includes("SHOW_VARS"));
  });
});

// ─── The append itself, on both builders ─────────────────

describe("stop protocol append", () => {
  const ONE_LINER = "You are a terse code reviewer.";

  it("reaches a custom one-line SYSTEM.md on the REPL path", () => {
    const result = buildSystemPrompt(makeConfig({ system: ONE_LINER }), null);
    assert.ok(result.startsWith(ONE_LINER));
    assert.ok(result.includes(STOP_PROTOCOL_SECTION));
  });

  it("reaches a custom one-line SYSTEM.md on the --cache path", () => {
    const result = buildCachedSystemPrompt(makeConfig({ system: ONE_LINER }), null);
    assert.ok(result.startsWith(ONE_LINER));
    assert.ok(result.includes(STOP_PROTOCOL_SECTION));
  });

  it("still embeds context on the --cache path", () => {
    const result = buildCachedSystemPrompt(makeConfig({ system: ONE_LINER }), {
      type: "list",
      content: [{ path: "a.ts", content: "const x = 1;" }],
      metadata: "Context is a list of 1 items",
    });
    assert.ok(result.includes(STOP_PROTOCOL_SECTION));
    assert.ok(result.includes("## Context Files"));
    assert.ok(result.includes("const x = 1;"));
  });

  it("precedes the criteria section, which presumes FINAL exists", () => {
    for (const build of [buildSystemPrompt, buildCachedSystemPrompt]) {
      const result = build(
        makeConfig({ system: ONE_LINER, criteria: "Cite file paths." }),
        null
      );
      const protocolAt = result.indexOf(STOP_PROTOCOL_SECTION);
      const criteriaAt = result.indexOf("## Output Criteria");
      assert.notEqual(protocolAt, -1);
      assert.notEqual(criteriaAt, -1);
      assert.ok(protocolAt < criteriaAt);
    }
  });

  it("gives a zero-config run the bare protocol section", () => {
    // No SYSTEM.md and no `prompt:` block — the shape `defaultConfig` produces.
    const zeroConfig = makeConfig({ system: null, prompt: undefined });
    assert.equal(buildSystemPrompt(zeroConfig, null), STOP_PROTOCOL_SECTION);
    assert.equal(buildCachedSystemPrompt(zeroConfig, null), STOP_PROTOCOL_SECTION);
  });
});

// ─── Structured output mode never teaches FINAL ──────────

describe("stop protocol vs structured output", () => {
  const SYSTEM = "You are a terse code reviewer.";
  const SCHEMA = { type: "object", properties: { answer: { type: "string" } } };

  /**
   * With `output.schema` on a Google provider the run loop treats the
   * schema-constrained response itself as the final answer and never parses
   * `FINAL()` — instructing the model to wrap its answer in `FINAL(...)`
   * would fight the schema (wrapper inside string fields, or failed
   * structured generation).
   */
  it("skips the append in structured output mode, on both builders", () => {
    const config = makeConfig({ system: SYSTEM, output: { schema: SCHEMA } });
    assert.equal(buildSystemPrompt(config, null), SYSTEM);
    assert.equal(buildCachedSystemPrompt(config, null), SYSTEM);
  });

  it("still appends when a schema is set but the provider is not Google", () => {
    const config = makeConfig({
      system: SYSTEM,
      model: { provider: "anthropic", model: "claude-sonnet-4-5" },
      output: { schema: SCHEMA },
    });
    assert.ok(buildSystemPrompt(config, null).includes(STOP_PROTOCOL_SECTION));
  });
});

// ─── Dedupe: the shipped templates already teach it ──────

describe("stop protocol dedupe", () => {
  for (const name of ["default", "code"] as const) {
    it(`leaves the ${name} template byte-for-byte unchanged`, () => {
      const template = readTemplate(name);
      assert.ok(template.includes("FINAL("), "template should teach FINAL");
      const config = makeConfig({ system: template });
      // `buildSystemPrompt` substitutes the tools placeholder even with no
      // tools declared; that is pre-existing behaviour, not the append.
      assert.equal(
        buildSystemPrompt(config, null),
        template.replace("{custom_tools_section}", "")
      );
      assert.equal(buildCachedSystemPrompt(config, null), template);
    });

    it(`keeps exactly one copy of the protocol for the ${name} template`, () => {
      const template = readTemplate(name);
      const result = buildSystemPrompt(makeConfig({ system: template }), null);
      // Both phrases appear once in each template and once in the appended
      // section, so a double copy shows up as 2.
      assert.equal(countOccurrences(result, "COMMON MISTAKE"), 1);
      assert.equal(countOccurrences(result, "retrieves an EXISTING variable"), 1);
    });
  }

  it("changes nothing for any prompt that already mentions FINAL(", () => {
    const system = "Answer the question, then call FINAL(answer).";
    const config = makeConfig({ system });
    assert.equal(buildSystemPrompt(config, null), system);
    assert.equal(buildCachedSystemPrompt(config, null), system);
  });

  /**
   * The sentinel is matched against `config.system` — the pack's base text —
   * never against the prompt built so far, which contains the appended
   * section itself. Matching the latter would make the append self-cancelling
   * only on the second builder to run, a bug that hides until --cache is on.
   */
  it("does not treat a criteria mention of FINAL as the prompt teaching it", () => {
    const result = buildSystemPrompt(
      makeConfig({ system: "Be terse.", criteria: "Put the FINAL(answer) on one line." }),
      null
    );
    assert.ok(result.includes(STOP_PROTOCOL_SECTION));
  });
});

// ─── Opt-out ─────────────────────────────────────────────

describe("prompt.append-stop-protocol opt-out", () => {
  const SYSTEM = "You emit JSON and stop.";

  it("restores the previous output byte-for-byte when false globally", () => {
    const config = makeConfig({ system: SYSTEM, prompt: { appendStopProtocol: false } });
    assert.equal(buildSystemPrompt(config, null), SYSTEM);
    assert.equal(buildCachedSystemPrompt(config, null), SYSTEM);
  });

  it("keeps the criteria section intact when opted out", () => {
    const config = makeConfig({
      system: SYSTEM,
      criteria: "One line.",
      prompt: { appendStopProtocol: false },
    });
    const result = buildSystemPrompt(config, null);
    assert.ok(!result.includes(STOP_PROTOCOL_SECTION));
    assert.ok(result.includes("## Output Criteria"));
  });

  it("honours a per-agent false over an ambient true", () => {
    const ambient = makeConfig({ system: "ambient", prompt: { appendStopProtocol: true } });
    const next = applyAgent(
      ambient,
      agentWith({ prompt: { appendStopProtocol: false } })
    );
    assert.equal(next.prompt?.appendStopProtocol, false);
    assert.equal(buildSystemPrompt({ ...next, system: SYSTEM }, null), SYSTEM);
  });

  it("honours a per-agent true over an ambient false", () => {
    const ambient = makeConfig({ prompt: { appendStopProtocol: false } });
    const next = applyAgent(ambient, agentWith({ prompt: { appendStopProtocol: true } }));
    assert.equal(next.prompt?.appendStopProtocol, true);
    assert.ok(
      buildSystemPrompt({ ...next, system: SYSTEM }, null).includes(STOP_PROTOCOL_SECTION)
    );
  });

  it("leaves the ambient prompt config alone when the agent declares none", () => {
    const ambient = makeConfig({ prompt: { appendStopProtocol: true } });
    const next = applyAgent(ambient, agentWith({}));
    assert.equal(next.prompt?.appendStopProtocol, true);
  });

  /**
   * `applyAgent` shallow-copies, so `next.prompt` would alias the caller's
   * object — an in-place write would leak one agent's opt-out into every
   * later ambient run in the same server process.
   */
  it("does not mutate the ambient config in place", () => {
    const ambient = makeConfig({ prompt: { appendStopProtocol: true } });
    applyAgent(ambient, agentWith({ prompt: { appendStopProtocol: false } }));
    assert.equal(ambient.prompt?.appendStopProtocol, true);
  });
});
