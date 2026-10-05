import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeOpenRouterDeveloperRole, normalizeProviderModelId, formatModelRef } from "../src/llm.js";
describe("OpenRouter compatibility payload normalization", () => {
    it("converts developer role to system for OpenRouter chat-completions payloads", () => {
        const payload = {
            model: "deepseek/deepseek-v4-flash",
            messages: [
                { role: "developer", content: "system instructions" },
                { role: "user", content: "Return OK" },
            ],
        };
        const normalized = normalizeOpenRouterDeveloperRole(payload);
        assert.equal(normalized.messages[0].role, "system");
        assert.equal(normalized.messages[1].role, "user");
        assert.equal(payload.messages[0].role, "developer", "original payload should not be mutated");
    });
    it("leaves non-chat payloads untouched", () => {
        const payload = { model: "x" };
        assert.equal(normalizeOpenRouterDeveloperRole(payload), payload);
    });
});
describe("provider/model id normalization", () => {
    it("strips redundant native provider prefixes", () => {
        assert.equal(normalizeProviderModelId("deepseek", "deepseek/deepseek-v4-pro"), "deepseek-v4-pro");
        assert.equal(normalizeProviderModelId("zai", "zai/glm-5.1"), "glm-5.1");
    });
    it("preserves OpenRouter upstream provider prefixes", () => {
        assert.equal(normalizeProviderModelId("openrouter", "deepseek/deepseek-v4-pro"), "deepseek/deepseek-v4-pro");
        assert.equal(normalizeProviderModelId("openrouter", "z-ai/glm-4.6"), "z-ai/glm-4.6");
    });
    it("formats provider/model refs without duplicate native prefixes", () => {
        assert.equal(formatModelRef("deepseek", "deepseek/deepseek-v4-pro"), "deepseek/deepseek-v4-pro");
        assert.equal(formatModelRef("openrouter", "deepseek/deepseek-v4-pro"), "openrouter/deepseek/deepseek-v4-pro");
    });
});
//# sourceMappingURL=openrouter-compat.test.js.map