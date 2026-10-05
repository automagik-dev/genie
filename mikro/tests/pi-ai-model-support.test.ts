import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

const models = builtinModels();

describe("pi-ai Opus 4.8 model support", () => {
  it("supports direct Anthropic Claude Opus 4.8 as the primary route", () => {
    const resolved = models.getModel("anthropic", "claude-opus-4-8");
    assert.ok(resolved, "anthropic/claude-opus-4-8 should resolve through pi-ai");
  });

  it("supports OpenRouter Opus 4.8 as fallback route only", () => {
    const resolved = models.getModel("openrouter", "anthropic/claude-opus-4.8");
    assert.ok(resolved, "openrouter/anthropic/claude-opus-4.8 should resolve through pi-ai");
  });
});
