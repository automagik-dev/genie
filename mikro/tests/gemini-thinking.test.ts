import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isValidThinkingLevel, isGoogleProvider, checkFutureFlags, type ThinkingLevel } from "../src/gemini.js";
import type { GeminiConfig } from "../src/config.js";

describe("Thinking level validation", () => {
  it("accepts valid thinking levels", () => {
    const levels: ThinkingLevel[] = ["minimal", "low", "medium", "high"];
    for (const level of levels) {
      assert.ok(isValidThinkingLevel(level), `${level} should be valid`);
    }
  });

  it("rejects invalid thinking levels", () => {
    const invalid = ["ultra", "max", "none", "0", ""];
    for (const level of invalid) {
      assert.ok(!isValidThinkingLevel(level), `${level} should be invalid`);
    }
  });
});

describe("Provider detection", () => {
  it("identifies Google providers", () => {
    assert.ok(isGoogleProvider("google"));
    assert.ok(isGoogleProvider("google-vertex"));
    assert.ok(isGoogleProvider("google-gemini-cli"));
    assert.ok(isGoogleProvider("google-antigravity"));
  });

  it("rejects non-Google providers", () => {
    assert.ok(!isGoogleProvider("anthropic"));
    assert.ok(!isGoogleProvider("openai"));
    assert.ok(!isGoogleProvider("amazon-bedrock"));
    assert.ok(!isGoogleProvider("groq"));
  });
});

describe("Future flags", () => {
  it("warns about enabled future flags", () => {
    const config: GeminiConfig = {
      thinkingLevel: null,
      googleSearch: false,
      urlContext: false,
      codeExecution: false,
      mediaResolution: null,
      computerUse: true,
      mapsGrounding: true,
      fileSearch: true,
    };
    const warnings = checkFutureFlags(config);
    assert.equal(warnings.length, 3);
    assert.ok(warnings[0].includes("computer-use"));
    assert.ok(warnings[1].includes("maps-grounding"));
    assert.ok(warnings[2].includes("file-search"));
  });

  it("returns no warnings when future flags are off", () => {
    const config: GeminiConfig = {
      thinkingLevel: "high",
      googleSearch: true,
      urlContext: true,
      codeExecution: true,
      mediaResolution: null,
      computerUse: false,
      mapsGrounding: false,
      fileSearch: false,
    };
    const warnings = checkFutureFlags(config);
    assert.equal(warnings.length, 0);
  });
});
