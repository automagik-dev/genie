import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MikroConfig } from "../src/config.js";
import type { UsageStats } from "../src/llm.js";
import { rlmLoop, type RLMOptions } from "../src/rlm.js";
import { LegacyMikroBackend } from "../src/mcp/backends/legacy.js";

const config = {
  model: { provider: "deepseek", model: "deepseek-v4-flash", subCallModel: "deepseek-v4-flash" },
  budget: { maxCost: null, maxTokens: null, maxDepth: null },
  gemini: { thinkingLevel: "low" },
  output: { schema: null },
  tools: [],
} as unknown as MikroConfig;

describe("benchmark output-token cap", () => {
  it("forwards an explicit root output cap through the legacy backend", async () => {
    let captured: Partial<RLMOptions> | undefined;
    const loop: typeof rlmLoop = async (_query, _context, _config, options = {}) => {
      captured = options;
      options.emitter?.close();
      return {
        answer: "{}",
        references: [],
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalCost: 0,
          llmCalls: 1,
        } as UsageStats,
        iterations: 1,
        model: "deepseek/deepseek-v4-flash",
        budgetHit: null,
      };
    };

    const backend = new LegacyMikroBackend({ loop });
    await backend.run(undefined, {
      query: "return JSON",
      context: null,
      config,
      cwd: process.cwd(),
      maxIterations: 1,
      maxOutputTokens: 1024,
      maxRetries: 0,
    }, () => {});

    assert.equal(captured?.maxOutputTokens, 1024);
    assert.equal(captured?.maxRetries, 0);
  });
});
