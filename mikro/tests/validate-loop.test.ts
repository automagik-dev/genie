/**
 * VALIDATE.md enforcement on the FINAL channel (`rlmLoop`).
 *
 * The defect these tests pin: `src/sdk/validate.ts` shipped the schema check,
 * the retry policy and the hint text, and `runAgent()` wired them for the SDK
 * surface — but the core loop, which serves the CLI *and* the default MCP
 * backend, never validated anything. A pack's `VALIDATE.md` was inert there
 * and the first FINAL won, conforming or not.
 *
 * `rlmLoop` itself has no injection seam for the LLM or the Python REPL, so
 * the loop is not driven end to end here. What is tested instead is every
 * decision the loop delegates — the disclosure section both prompt builders
 * append, the normalization FINAL needs before `JSON.parse`, the
 * validate/retry/flag policy, and the history mutation a granted retry makes.
 * Site adoption (which `finalize()` calls route through the wrapper) cannot be
 * driven either, so it is pinned by a source-level tripwire at the bottom of
 * this file; the end-to-end propagation of the resulting flag is covered in
 * `tests/backend-contract.test.ts`.
 */

import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { buildCachedSystemPrompt } from "../src/cache.js";
import type { MikroConfig, ValidateConfig } from "../src/config.js";
import type { ChatMessage } from "../src/llm.js";
import {
  appendValidationRetryTurn,
  buildSystemPrompt,
  decideValidatedFinal,
  normalizeFinalPayload,
  validateFinalAnswer,
} from "../src/rlm.js";
import { STOP_PROTOCOL_SECTION } from "../src/stop-protocol.js";
import { MAX_VALIDATE_ATTEMPTS } from "../src/sdk/validate.js";

// ─── Fixtures ────────────────────────────────────────────

/** The upstream shape: a verdict enum the committee gate reads. */
const VERDICT: ValidateConfig = {
  schema: {
    type: "object",
    required: ["verdict"],
    properties: { verdict: { type: "string", enum: ["pass", "fail"] } },
  },
  rawBlock:
    '{ "type": "object", "required": ["verdict"], "properties": { "verdict": { "type": "string", "enum": ["pass", "fail"] } } }',
};

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
    validate: null,
    providers: [],
    configSource: "yaml",
    ...overrides,
  } as MikroConfig;
}

/** A gate with the defaults a mid-run retry-capable site would supply. */
function gate(overrides: Partial<Parameters<typeof decideValidatedFinal>[1]> = {}) {
  return {
    validate: VERDICT,
    attempt: 1,
    retryCapable: true,
    roomForRetry: true,
    ...overrides,
  };
}

const CONFORMING = '{"verdict": "pass"}';
const WRONG_SHAPE = '{"verdict": "maybe"}';

// ─── Schema disclosure ───────────────────────────────────

describe("schema disclosure — both prompt builders", () => {
  for (const [name, build] of [
    ["buildSystemPrompt", (c: MikroConfig) => buildSystemPrompt(c, null)],
    ["buildCachedSystemPrompt", (c: MikroConfig) => buildCachedSystemPrompt(c, null)],
  ] as const) {
    it(`${name} quotes the schema block verbatim`, () => {
      const prompt = build(makeConfig({ system: "Be terse.", validate: VERDICT }));
      assert.ok(prompt.includes("## Output Schema"));
      assert.ok(prompt.includes(VERDICT.rawBlock));
    });

    it(`${name} steers to compact single-line FINAL and json.dumps`, () => {
      const prompt = build(makeConfig({ system: "Be terse.", validate: VERDICT }));
      // FINAL_REGEX (src/parser.ts) is single-line, so a pretty-printed
      // payload is silently truncated — the model has to be told.
      assert.ok(prompt.includes("FINAL(<compact single-line JSON>)"));
      assert.ok(prompt.includes("json.dumps"));
      // FINAL_VAR of a bare Python dict returns a single-quoted str() repr.
      assert.ok(prompt.includes("bare Python dict"));
    });

    it(`${name} is byte-identical to today without a VALIDATE.md`, () => {
      const bare = makeConfig({ system: "Be terse.", criteria: "Cite paths." });
      assert.equal(
        build(bare),
        build({ ...bare, validate: null }),
      );
      assert.ok(!build(bare).includes("## Output Schema"));
    });

    it(`${name} appends the schema after the criteria block`, () => {
      const prompt = build(
        makeConfig({ system: "Be terse.", criteria: "Cite paths.", validate: VERDICT })
      );
      assert.ok(prompt.indexOf("## Output Criteria") < prompt.indexOf("## Output Schema"));
    });
  }

  /**
   * The cross-wish contract with `mikro-stop-protocol-append`. That wish's
   * dedupe sentinel is the literal `FINAL(`, and this section is full of
   * `FINAL(` examples — so the ORDERING is the operative guarantee: the
   * sentinel is evaluated on `config.system` alone, and it runs before this
   * section exists. A schema pack must get both sections, not one.
   */
  it("a schema pack's prompt carries BOTH the stop protocol and the schema", () => {
    for (const build of [
      (c: MikroConfig) => buildSystemPrompt(c, null),
      (c: MikroConfig) => buildCachedSystemPrompt(c, null),
    ]) {
      const prompt = build(makeConfig({ system: "You grade patches.", validate: VERDICT }));
      const protocolAt = prompt.indexOf(STOP_PROTOCOL_SECTION);
      const schemaAt = prompt.indexOf("## Output Schema");
      assert.notEqual(protocolAt, -1, "stop protocol section missing");
      assert.notEqual(schemaAt, -1, "output schema section missing");
      assert.ok(protocolAt < schemaAt, "the schema section must come last");
    }
  });

  /**
   * Structured-output mode (Google + `output.schema`) finalizes the
   * provider-constrained response and never parses FINAL(), so disclosing a
   * `FINAL(<compact JSON>)` instruction there would fight the schema — the
   * same contradiction the stop protocol skip fixes. Mirror it.
   */
  it("skips the disclosure in structured output mode, on both builders", () => {
    const structured = makeConfig({
      system: "You grade patches.",
      validate: VERDICT,
      output: { schema: { type: "object", properties: { answer: { type: "string" } } } },
    });
    for (const build of [
      (c: MikroConfig) => buildSystemPrompt(c, null),
      (c: MikroConfig) => buildCachedSystemPrompt(c, null),
    ]) {
      assert.ok(!build(structured).includes("## Output Schema"));
    }
  });

  it("keeps the cached builder's context block after the schema", () => {
    const prompt = buildCachedSystemPrompt(
      makeConfig({ system: "Be terse.", validate: VERDICT }),
      { type: "list", content: [{ path: "a.ts", content: "const x = 1;" }], metadata: "1 item" }
    );
    assert.ok(prompt.indexOf("## Output Schema") < prompt.indexOf("## Context Files"));
    assert.ok(prompt.includes("const x = 1;"));
  });
});

// ─── Normalization (Decision 5) ──────────────────────────

describe("FINAL payload normalization", () => {
  it("trims surrounding whitespace", () => {
    assert.equal(normalizeFinalPayload(`  ${CONFORMING}\n`), CONFORMING);
  });

  it("unwraps a json code fence", () => {
    assert.equal(normalizeFinalPayload(`\`\`\`json\n${CONFORMING}\n\`\`\``), CONFORMING);
  });

  it("unwraps a bare code fence", () => {
    assert.equal(normalizeFinalPayload(`\`\`\`\n${CONFORMING}\n\`\`\``), CONFORMING);
  });

  it("leaves an unfenced payload alone", () => {
    assert.equal(normalizeFinalPayload(CONFORMING), CONFORMING);
  });

  it("a fenced conforming payload validates rather than burning an attempt", () => {
    assert.equal(
      validateFinalAnswer(`\`\`\`json\n${CONFORMING}\n\`\`\``, VERDICT).ok,
      true
    );
  });

  it("reports unparsable text as an ordinary shape failure", () => {
    // The systematic case: FINAL_VAR of a Python dict, whose str() repr uses
    // single quotes and is not JSON.
    const result = validateFinalAnswer("{'verdict': 'pass'}", VERDICT);
    assert.equal(result.ok, false);
    assert.deepEqual([...result.errors], [
      "<root>: expected JSON matching the VALIDATE.md schema, got unparsable text",
    ]);
    assert.equal(result.schemaSource, VERDICT.rawBlock);
  });

  it("reports a shape miss with the field-level error", () => {
    const result = validateFinalAnswer(WRONG_SHAPE, VERDICT);
    assert.equal(result.ok, false);
    assert.match(result.errors[0] ?? "", /verdict: value not in enum/);
  });
});

// ─── The validate / retry / flag policy ──────────────────

describe("decideValidatedFinal", () => {
  it("a conforming FINAL finalizes untouched", () => {
    const decision = decideValidatedFinal(CONFORMING, gate());
    assert.equal(decision.kind, "finalize");
    assert.equal(decision.kind === "finalize" && decision.validationFailed, false);
  });

  it("a pack with no VALIDATE.md is never checked and never flagged", () => {
    const decision = decideValidatedFinal("not json at all", gate({ validate: null }));
    assert.equal(decision.kind, "finalize");
    assert.equal(decision.kind === "finalize" && decision.validationFailed, false);
  });

  it("the first failure buys one retry, carrying the FINAL-surface hint", () => {
    const decision = decideValidatedFinal(WRONG_SHAPE, gate({ attempt: 1 }));
    assert.equal(decision.kind, "retry");
    if (decision.kind !== "retry") return;
    assert.match(decision.hint, /^Your previous FINAL answer did not match VALIDATE\.md:/);
    assert.ok(!decision.hint.includes("emit_done"));
    assert.ok(decision.hint.includes("verdict: value not in enum"));
    assert.ok(decision.hint.includes(VERDICT.rawBlock));
    assert.ok(decision.hint.includes("FINAL(<compact single-line JSON>)"));
  });

  it("a corrected payload on the retry turn finalizes clean", () => {
    const decision = decideValidatedFinal(CONFORMING, gate({ attempt: 2 }));
    assert.equal(decision.kind, "finalize");
    assert.equal(decision.kind === "finalize" && decision.validationFailed, false);
  });

  it("the second failure is terminal: flagged, not retried", () => {
    const decision = decideValidatedFinal(WRONG_SHAPE, gate({ attempt: MAX_VALIDATE_ATTEMPTS }));
    assert.equal(decision.kind, "finalize");
    assert.equal(decision.kind === "finalize" && decision.validationFailed, true);
  });

  /**
   * The room check mirrors the loop's own top-of-loop tests. Without it a
   * "retry" granted on the last iteration, past the budget, or after the
   * wall-clock abort would not produce another model turn at all — it would
   * fall through to `forceFinalAnswer`, spending a real LLM call to answer a
   * question nobody re-asked.
   */
  it("never retries when there is no room for another iteration", () => {
    const decision = decideValidatedFinal(WRONG_SHAPE, gate({ roomForRetry: false }));
    assert.equal(decision.kind, "finalize");
    assert.equal(decision.kind === "finalize" && decision.validationFailed, true);
  });

  it("the forced-final site validates and flags but never retries", () => {
    const decision = decideValidatedFinal(
      WRONG_SHAPE,
      gate({ retryCapable: false, attempt: 1, roomForRetry: true })
    );
    assert.equal(decision.kind, "finalize");
    assert.equal(decision.kind === "finalize" && decision.validationFailed, true);
  });

  it("the forced-final site leaves a conforming answer unflagged", () => {
    const decision = decideValidatedFinal(CONFORMING, gate({ retryCapable: false }));
    assert.equal(decision.kind, "finalize");
    assert.equal(decision.kind === "finalize" && decision.validationFailed, false);
  });
});

// ─── The retry's user turn ───────────────────────────────

describe("appendValidationRetryTurn", () => {
  const HINT = "Your previous FINAL answer did not match VALIDATE.md:\n  - boom";

  it("pushes a hint turn after the assistant turn (the no-code FINAL case)", () => {
    // The dominant retry shape: the model answered with FINAL and wrote no
    // REPL code, so the loop suppressed its "you didn't write any REPL code"
    // nudge and the history ends on the assistant turn.
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "q" },
      { role: "assistant", content: "FINAL({})" },
    ];
    appendValidationRetryTurn(messages, HINT);
    assert.equal(messages.length, 4);
    assert.equal(messages[3].role, "user");
    assert.equal(messages[3].content, HINT);
  });

  it("merges into a trailing user turn instead of stacking two (the REPL case)", () => {
    // When code ran, `formatIterationResult` already claimed this turn's user
    // message; the hint rides on the end of it so the history stays strictly
    // alternating — a shape some providers reject outright.
    const messages: ChatMessage[] = [
      { role: "assistant", content: "```repl\nemit(x)\n```" },
      { role: "user", content: "Execution result: {}" },
    ];
    appendValidationRetryTurn(messages, HINT);
    assert.equal(messages.length, 2);
    assert.equal(messages[1].content, `Execution result: {}\n\n${HINT}`);
    assert.ok(messages[1].content.endsWith(HINT), "the hint must land last");
  });

  it("never produces two consecutive user turns", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
      { role: "user", content: "exec" },
    ];
    appendValidationRetryTurn(messages, HINT);
    for (let i = 1; i < messages.length; i++) {
      assert.ok(
        !(messages[i].role === "user" && messages[i - 1].role === "user"),
        `consecutive user turns at ${i}`
      );
    }
  });
});

// ─── Site adoption (source-level) ─────────────────────────

describe("rlm.ts finalize() site adoption", () => {
  // The wrapper contract: a candidate FINAL that can still be retried must
  // reach `finalize()` through `settle()`, which spends the validate attempt
  // and may grant a retry instead. Only two paths may call `finalize()`
  // directly — structured-output mode (schema-enforced by the provider) and
  // the forced-final path (flag-only, no budget left to retry) — plus the one
  // call inside `settle()` itself. This test is a tripwire: it fails when a
  // new `finalize()` call site appears without going through the wrapper.
  // Resolved from `dist/tests/` at run time, so `../../` is the repo root.
  const source = readFileSync(new URL("../../src/rlm.ts", import.meta.url), "utf8")
    // Strip comments so prose mentioning `finalize()` is not counted.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  it("has exactly three direct finalize() call expressions", () => {
    const calls = source.match(/(?<![\w$.])finalize\(/g) ?? [];
    assert.equal(
      calls.length,
      3,
      `expected 3 direct finalize() calls in src/rlm.ts (inside settle(), the ` +
        `structured-output site, and the forced-final path) but found ${calls.length}. ` +
        `A retry-capable final answer must route through settle() so VALIDATE.md is ` +
        `enforced and a retry can be granted; call finalize() directly only from a ` +
        `path that provably cannot retry, and update this count with the reason.`
    );
  });

  it("routes every retry-capable final through settle()", () => {
    // Argument positions only — the union type and the `mode === …` guard
    // inside the wrapper also spell the literal but finalize nothing.
    const retryCapable = source.match(/,\s*"retry-capable"\)/g) ?? [];
    const viaSettle = source.match(/settle\([^)]*,\s*"retry-capable"\)/g) ?? [];
    assert.equal(
      viaSettle.length,
      retryCapable.length,
      `every "retry-capable" finalization must be an argument to settle(); ` +
        `found ${retryCapable.length} retry-capable sites but only ${viaSettle.length} ` +
        `settle() calls in src/rlm.ts.`
    );
    assert.ok(viaSettle.length > 0, "expected at least one settle() call site");
  });
});
