import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildGeminiOnPayload } from "../src/gemini.js";
import type { GeminiConfig } from "../src/config.js";

const BASE_CONFIG: GeminiConfig = {
  thinkingLevel: null,
  googleSearch: false,
  urlContext: false,
  codeExecution: false,
  mediaResolution: null,
  computerUse: false,
  mapsGrounding: false,
  fileSearch: false,
};

describe("buildGeminiOnPayload", () => {
  it("returns undefined for non-Google provider", () => {
    const hook = buildGeminiOnPayload(
      { ...BASE_CONFIG, googleSearch: true },
      "anthropic"
    );
    assert.equal(hook, undefined);
  });

  it("returns undefined when no modifications needed", () => {
    const hook = buildGeminiOnPayload(BASE_CONFIG, "google");
    assert.equal(hook, undefined);
  });

  it("injects googleSearch tool", () => {
    const hook = buildGeminiOnPayload(
      { ...BASE_CONFIG, googleSearch: true },
      "google"
    );
    assert.ok(hook);
    const payload = { config: {} };
    const result = hook(payload) as any;
    assert.ok(result.config.tools);
    assert.ok(result.config.tools.some((t: any) => t.googleSearch));
  });

  it("injects urlContext tool", () => {
    const hook = buildGeminiOnPayload(
      { ...BASE_CONFIG, urlContext: true },
      "google"
    );
    assert.ok(hook);
    const payload = { config: {} };
    const result = hook(payload) as any;
    assert.ok(result.config.tools.some((t: any) => t.urlContext));
  });

  it("injects codeExecution tool", () => {
    const hook = buildGeminiOnPayload(
      { ...BASE_CONFIG, codeExecution: true },
      "google"
    );
    assert.ok(hook);
    const payload = { config: {} };
    const result = hook(payload) as any;
    assert.ok(result.config.tools.some((t: any) => t.codeExecution));
  });

  it("injects all three tools simultaneously", () => {
    const hook = buildGeminiOnPayload(
      { ...BASE_CONFIG, googleSearch: true, urlContext: true, codeExecution: true },
      "google"
    );
    assert.ok(hook);
    const payload = { config: {} };
    const result = hook(payload) as any;
    assert.equal(result.config.tools.length, 3);
  });

  it("injects media resolution", () => {
    const hook = buildGeminiOnPayload(
      {
        ...BASE_CONFIG,
        mediaResolution: { images: "high", pdfs: "medium", video: "low" },
      },
      "google"
    );
    assert.ok(hook);
    const payload = { config: {} };
    const result = hook(payload) as any;
    assert.equal(result.config.mediaResolution.imageResolution, "high");
    assert.equal(result.config.mediaResolution.pdfResolution, "medium");
    assert.equal(result.config.mediaResolution.videoResolution, "low");
  });

  it("injects structured output schema", () => {
    const schema = {
      type: "object",
      properties: { answer: { type: "string" } },
    };
    const hook = buildGeminiOnPayload(BASE_CONFIG, "google", schema);
    assert.ok(hook);
    const payload = { config: {} };
    const result = hook(payload) as any;
    assert.equal(result.config.responseMimeType, "application/json");
    assert.deepEqual(result.config.responseSchema, schema);
  });

  it("preserves existing tools in payload", () => {
    const hook = buildGeminiOnPayload(
      { ...BASE_CONFIG, googleSearch: true },
      "google"
    );
    assert.ok(hook);
    const payload = {
      config: {
        tools: [{ functionDeclarations: [{ name: "test" }] }],
      },
    };
    const result = hook(payload) as any;
    assert.equal(result.config.tools.length, 2); // existing + googleSearch
  });

  it("works with google-vertex provider", () => {
    const hook = buildGeminiOnPayload(
      { ...BASE_CONFIG, googleSearch: true },
      "google-vertex"
    );
    assert.ok(hook);
  });
});
