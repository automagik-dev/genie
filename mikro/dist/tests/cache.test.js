import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, computeContentHash, buildSessionId, buildCachedSystemPrompt, validateContextSize, } from "../src/cache.js";
import { STOP_PROTOCOL_SECTION } from "../src/stop-protocol.js";
// ─── Test helpers ────────────────────────────────────────
function makeContext(items) {
    return {
        type: "list",
        content: items,
        metadata: `Context is a list of ${items.length} items`,
    };
}
function makeStringContext(text) {
    return {
        type: "string",
        content: text,
        metadata: `Context is a string with ${text.length} total characters`,
    };
}
function makeConfig(overrides = {}) {
    return {
        system: overrides.system ?? "You are a helper.",
        tools: overrides.tools ?? [],
        criteria: overrides.criteria ?? null,
        model: overrides.model ?? { provider: "google", model: "gemini-3.1-flash-lite-preview" },
        configDir: overrides.configDir ?? "/tmp",
        budget: overrides.budget ?? { maxCost: null, maxTokens: null, maxDepth: null },
        contextConfig: overrides.contextConfig ?? { extensions: [".md"], exclude: ["node_modules"] },
        toolsLevel: overrides.toolsLevel ?? "core",
        cache: overrides.cache ?? { enabled: true, strategy: "full", retention: "long" },
        configSource: overrides.configSource ?? "yaml",
        gemini: overrides.gemini ?? { thinkingLevel: null, googleSearch: false, urlContext: false, codeExecution: false, computerUse: false, mapsGrounding: false, fileSearch: false, mediaResolution: null },
        output: overrides.output ?? { schema: null },
        storage: overrides.storage ?? { enabled: "auto", mode: "persistent", dataDir: "~/.mikro/data", port: 0, chunkSize: null, chunkUtilization: 0.6, charsPerToken: 4 },
        providers: overrides.providers ?? [],
        validate: overrides.validate ?? null,
    };
}
// ─── estimateTokens ──────────────────────────────────────
describe("estimateTokens", () => {
    it("estimates based on character count with safety margin", () => {
        const ctx = makeContext([{ path: "a.ts", content: "x".repeat(400) }]);
        const tokens = estimateTokens(ctx);
        // chars = 400 (content) + 4 (path "a.ts") = 404
        // tokens = ceil(404 / 4 * 1.2) = ceil(121.2) = 122
        assert.equal(tokens, Math.ceil((404 / 4) * 1.2));
    });
    it("returns 0 for empty context", () => {
        const ctx = makeContext([]);
        assert.equal(estimateTokens(ctx), 0);
    });
    it("sums across multiple items", () => {
        const ctx = makeContext([
            { path: "a.ts", content: "hello" },
            { path: "b.ts", content: "world" },
        ]);
        const tokens = estimateTokens(ctx);
        // chars = (4 + 5) + (4 + 5) = 18
        // tokens = ceil(18 / 4 * 1.2) = ceil(5.4) = 6
        const expected = Math.ceil((18 / 4) * 1.2);
        assert.equal(tokens, expected);
    });
    it("handles string-type context", () => {
        const ctx = makeStringContext("x".repeat(100));
        const tokens = estimateTokens(ctx);
        assert.equal(tokens, Math.ceil((100 / 4) * 1.2));
    });
    it("includes path length in the estimate", () => {
        const shortPath = makeContext([{ path: "a", content: "x" }]);
        const longPath = makeContext([{ path: "very/long/path/to/file.ts", content: "x" }]);
        assert.ok(estimateTokens(longPath) > estimateTokens(shortPath));
    });
});
// ─── computeContentHash ─────────────────────────────────
describe("computeContentHash", () => {
    it("produces stable hash for same content", () => {
        const ctx = makeContext([{ path: "a.ts", content: "hello" }]);
        const hash1 = computeContentHash(ctx);
        const hash2 = computeContentHash(ctx);
        assert.equal(hash1, hash2);
    });
    it("produces different hash for different content", () => {
        const ctx1 = makeContext([{ path: "a.ts", content: "hello" }]);
        const ctx2 = makeContext([{ path: "a.ts", content: "world" }]);
        assert.notEqual(computeContentHash(ctx1), computeContentHash(ctx2));
    });
    it("produces different hash for different paths", () => {
        const ctx1 = makeContext([{ path: "a.ts", content: "same" }]);
        const ctx2 = makeContext([{ path: "b.ts", content: "same" }]);
        assert.notEqual(computeContentHash(ctx1), computeContentHash(ctx2));
    });
    it("is order-independent (sorted by path)", () => {
        const ctx1 = makeContext([
            { path: "b.ts", content: "B" },
            { path: "a.ts", content: "A" },
        ]);
        const ctx2 = makeContext([
            { path: "a.ts", content: "A" },
            { path: "b.ts", content: "B" },
        ]);
        assert.equal(computeContentHash(ctx1), computeContentHash(ctx2));
    });
    it("returns a 12-character hex string", () => {
        const ctx = makeContext([{ path: "test.ts", content: "data" }]);
        const hash = computeContentHash(ctx);
        assert.equal(hash.length, 12);
        assert.match(hash, /^[0-9a-f]{12}$/);
    });
    it("handles empty context", () => {
        const ctx = makeContext([]);
        const hash = computeContentHash(ctx);
        assert.equal(typeof hash, "string");
        assert.equal(hash.length, 12);
    });
    it("handles string-type context", () => {
        const ctx1 = makeStringContext("hello world");
        const ctx2 = makeStringContext("hello world");
        assert.equal(computeContentHash(ctx1), computeContentHash(ctx2));
    });
    it("string context differs from list context with same text", () => {
        const stringCtx = makeStringContext("hello");
        const listCtx = makeContext([{ path: "hello", content: "" }]);
        // These should produce different hashes since they go through different code paths
        // and the list context includes path + separator
        assert.notEqual(computeContentHash(stringCtx), computeContentHash(listCtx));
    });
});
// ─── buildSessionId ──────────────────────────────────────
describe("buildSessionId", () => {
    it("prepends prefix when provided", () => {
        const id = buildSessionId("proj", "abc123");
        assert.equal(id, "proj-abc123");
    });
    it("returns just hash without prefix", () => {
        const id = buildSessionId(undefined, "abc123");
        assert.equal(id, "abc123");
    });
    it("handles empty string prefix as truthy", () => {
        // Empty string is falsy in JS, so no prefix
        const id = buildSessionId("", "abc123");
        assert.equal(id, "abc123");
    });
    it("preserves full hash value", () => {
        const id = buildSessionId("my-project", "deadbeef1234");
        assert.equal(id, "my-project-deadbeef1234");
    });
});
// ─── buildCachedSystemPrompt ─────────────────────────────
describe("buildCachedSystemPrompt", () => {
    it("returns the system prompt plus the stop protocol when no context", () => {
        // The prompt no longer comes back bare: a custom SYSTEM.md replaces the
        // template, so the FINAL contract is appended by the runtime instead
        // (`src/stop-protocol.ts`; see tests/rlm-stop-protocol.test.ts). What this
        // test still pins is that no Context Files section appears.
        const config = makeConfig({ system: "You are a test bot." });
        const result = buildCachedSystemPrompt(config, null);
        assert.equal(result, `You are a test bot.\n\n${STOP_PROTOCOL_SECTION}`);
    });
    it("includes criteria in output", () => {
        const config = makeConfig({
            system: "Be helpful.",
            criteria: "Be concise.",
        });
        const result = buildCachedSystemPrompt(config, null);
        assert.ok(result.includes("Be helpful."));
        assert.ok(result.includes("Output Criteria"));
        assert.ok(result.includes("Be concise."));
    });
    it("embeds full file content from list context", () => {
        const config = makeConfig({ system: "You are a helper." });
        const ctx = makeContext([
            { path: "src/index.ts", content: 'console.log("hello");' },
            { path: "README.md", content: "# Project" },
        ]);
        const result = buildCachedSystemPrompt(config, ctx);
        assert.ok(result.includes("## Context Files"));
        assert.ok(result.includes("### src/index.ts"));
        assert.ok(result.includes('console.log("hello");'));
        assert.ok(result.includes("### README.md"));
        assert.ok(result.includes("# Project"));
    });
    it("wraps content in code fences", () => {
        const config = makeConfig({ system: "helper" });
        const ctx = makeContext([{ path: "file.ts", content: "const x = 1;" }]);
        const result = buildCachedSystemPrompt(config, ctx);
        assert.ok(result.includes("```\nconst x = 1;\n```"));
    });
    it("handles string-type context", () => {
        const config = makeConfig({ system: "helper" });
        const ctx = makeStringContext("raw text content");
        const result = buildCachedSystemPrompt(config, ctx);
        assert.ok(result.includes("## Context Files"));
        assert.ok(result.includes("raw text content"));
    });
    it("handles null system prompt", () => {
        const config = makeConfig({ system: null });
        const ctx = makeContext([{ path: "a.ts", content: "code" }]);
        const result = buildCachedSystemPrompt(config, ctx);
        assert.ok(result.includes("## Context Files"));
        assert.ok(result.includes("code"));
    });
    it("handles empty context list", () => {
        const config = makeConfig({ system: "hello" });
        const ctx = makeContext([]);
        const result = buildCachedSystemPrompt(config, ctx);
        assert.ok(result.includes("## Context Files"));
        // No file entries, but the header is still present
        assert.ok(!result.includes("###"));
    });
});
// ─── validateContextSize ─────────────────────────────────
describe("validateContextSize", () => {
    it("passes for small context", () => {
        const ctx = makeContext([{ path: "a.ts", content: "small" }]);
        const result = validateContextSize(ctx, "google");
        assert.equal(result.valid, true);
        assert.ok(result.estimatedTokens > 0);
        assert.equal(result.limit, 1000000);
    });
    it("reports correct limit for each provider", () => {
        const ctx = makeContext([{ path: "a.ts", content: "test" }]);
        const google = validateContextSize(ctx, "google");
        assert.equal(google.limit, 1000000);
        const anthropic = validateContextSize(ctx, "anthropic");
        assert.equal(anthropic.limit, 200000);
        const openai = validateContextSize(ctx, "openai");
        assert.equal(openai.limit, 128000);
        const bedrock = validateContextSize(ctx, "amazon-bedrock");
        assert.equal(bedrock.limit, 128000);
    });
    it("uses default 128k limit for unknown providers", () => {
        const ctx = makeContext([{ path: "a.ts", content: "test" }]);
        const result = validateContextSize(ctx, "unknown-provider");
        assert.equal(result.limit, 128000);
    });
    it("fails when context exceeds provider limit", () => {
        // For OpenAI limit of 128000 tokens, we need ~128000 * 4 / 1.2 = ~426667 chars of content
        // Create a context that exceeds this
        const bigContent = "x".repeat(600_000);
        const ctx = makeContext([{ path: "big.ts", content: bigContent }]);
        const result = validateContextSize(ctx, "openai");
        assert.equal(result.valid, false);
        assert.ok(result.message);
        assert.ok(result.message.includes("provider limit"));
    });
    it("includes estimated tokens in result", () => {
        const ctx = makeContext([{ path: "a.ts", content: "x".repeat(1000) }]);
        const result = validateContextSize(ctx, "google");
        assert.ok(result.estimatedTokens > 0);
        assert.equal(typeof result.estimatedTokens, "number");
    });
    it("valid result has no message", () => {
        const ctx = makeContext([{ path: "a.ts", content: "tiny" }]);
        const result = validateContextSize(ctx, "google");
        assert.equal(result.valid, true);
        assert.equal(result.message, undefined);
    });
});
//# sourceMappingURL=cache.test.js.map