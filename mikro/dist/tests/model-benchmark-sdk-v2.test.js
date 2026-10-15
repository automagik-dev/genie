import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
const SCRIPT = fileURLToPath(new URL("../../scripts/benchmark-models-sdk-v2.mjs", import.meta.url));
function run(...args) {
    return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}
describe("Prime SDK model benchmark v2", () => {
    it("freezes one in-process runtime and the four exact models across sixty cases", () => {
        const result = run("manifest");
        assert.equal(result.status, 0, result.stderr);
        const manifest = JSON.parse(result.stdout);
        assert.equal(manifest.version, "mikro-prime-sdk-model-benchmark-v2");
        assert.match(manifest.runtime, /PrimeSdkBackend/);
        assert.match(manifest.wire, /OpenRouter and direct DeepSeek OpenAI chat completions/);
        assert.equal(manifest.routePolicy, "GLM via pinned OpenRouter FP8; DeepSeek via its official direct API");
        assert.equal(manifest.routesEnforced, true);
        assert.equal(manifest.commonUpstream, false);
        assert.equal(manifest.modelOnlyLeaderboardEligible, false);
        assert.deepEqual(manifest.routes["z-ai/glm-5.3"], { provider: "GMICloud", slug: "gmicloud", tag: "gmicloud/fp8", quantization: "fp8" });
        assert.deepEqual(manifest.routes["z-ai/glm-5.3-flash"], manifest.routes["z-ai/glm-5.3"]);
        assert.deepEqual(manifest.routes["deepseek/deepseek-v4-flash-0731"], {
            provider: "DeepSeek",
            tag: "deepseek-direct",
            wireProvider: "deepseek",
            wireModel: "deepseek-v4-flash",
            quantization: "provider-managed",
        });
        assert.deepEqual(manifest.routes["deepseek/deepseek-v4-pro-0813"], {
            provider: "DeepSeek",
            tag: "deepseek-direct",
            wireProvider: "deepseek",
            wireModel: "deepseek-v4-pro",
            quantization: "provider-managed",
        });
        assert.equal(manifest.upstreamObservable, true);
        assert.deepEqual(manifest.models.map((model) => model.id), [
            "z-ai/glm-5.3",
            "z-ai/glm-5.3-flash",
            "deepseek/deepseek-v4-flash-0731",
            "deepseek/deepseek-v4-pro-0813",
        ]);
        assert.deepEqual(manifest.models.map((model) => model.builtIn), [true, false, true, true]);
        assert.equal(manifest.cases.length, 60);
        assert.equal(new Set(manifest.cases.map((task) => task.id)).size, 60);
        assert.equal(manifest.fullCalls, 240);
        assert.equal(manifest.probeCalls, 4);
        assert.equal(manifest.fullProviderCalls, 480);
        assert.equal(manifest.probeProviderCalls, 8);
        assert.equal(manifest.maxIterations, 2);
        assert.equal(manifest.rootOutputTokens, 8192);
        assert.equal(manifest.providerModelMaxTokens, 17408);
        assert.equal(manifest.retries, 0);
        assert.equal(manifest.reasoning, "low");
        assert.equal(manifest.temperature, 0);
        assert.equal(manifest.inferenceSeed, null);
        assert.match(manifest.fixtureSeedPolicy, /deterministic task generation/);
        assert.equal(manifest.responseFormat, null);
        assert.equal(manifest.structuredOutputChannel, "Prime emit_done tool with output.schema validation");
        assert.equal(manifest.toolChoice, "omitted for all models; compliance with the sole emit_done tool is measured as reliability");
        assert.equal(manifest.rawAnswersPersisted, false);
        assert.equal(manifest.billingAuthority, "OpenRouter key usage delta per GLM calls; DeepSeek USD balance delta per direct calls");
        assert.equal(manifest.primeVersion, "0.8.1");
        assert.match(manifest.harnessSha256, /^[a-f0-9]{64}$/);
        assert.match(manifest.fixtureHarnessSha256, /^[a-f0-9]{64}$/);
        assert.match(manifest.primeSdkAdapterSha256, /^[a-f0-9]{64}$/);
    });
    it("is deterministic across process executions", () => {
        const first = run("manifest");
        const second = run("manifest");
        assert.equal(first.status, 0, first.stderr);
        assert.equal(second.status, 0, second.stderr);
        assert.equal(first.stdout, second.stdout);
    });
    it("pins OpenRouter GLM routes and configures official direct DeepSeek model IDs", () => {
        const result = run("models-config");
        assert.equal(result.status, 0, result.stderr);
        const config = JSON.parse(result.stdout);
        const provider = config.providers.openrouter;
        const routes = Object.fromEntries([
            ...provider.models.map((entry) => [entry.id, entry.compat.openRouterRouting]),
            ...Object.entries(provider.modelOverrides).map(([id, entry]) => [id, entry.compat.openRouterRouting]),
        ]);
        assert.equal(Object.keys(routes).length, 2);
        for (const id of ["z-ai/glm-5.3", "z-ai/glm-5.3-flash"]) {
            assert.deepEqual(routes[id], {
                only: ["gmicloud"],
                order: ["gmicloud"],
                allow_fallbacks: false,
                require_parameters: true,
                quantizations: ["fp8"],
            });
        }
        assert.deepEqual(Object.keys(config.providers.deepseek.modelOverrides).sort(), ["deepseek-v4-flash", "deepseek-v4-pro"]);
        assert.equal(config.providers.deepseek.modelOverrides["deepseek-v4-flash"].compat.supportsToolChoice, false);
        assert.equal(config.providers.deepseek.modelOverrides["deepseek-v4-pro"].compat.supportsToolChoice, false);
    });
    it("uses provider-native payload contracts without leaking aggregator routing to DeepSeek", () => {
        const result = run("payload-contracts");
        assert.equal(result.status, 0, result.stderr);
        const proofs = JSON.parse(result.stdout);
        for (const id of ["deepseek/deepseek-v4-flash-0731", "deepseek/deepseek-v4-pro-0813"]) {
            assert.equal(proofs[id].contractPass, true);
            assert.equal(proofs[id].provider, null);
            assert.equal(proofs[id].toolChoice, null);
            assert.equal(proofs[id].reasoning, null);
            assert.deepEqual(proofs[id].thinking, { type: "enabled" });
            assert.equal(proofs[id].reasoningEffort, "low");
        }
        for (const id of ["z-ai/glm-5.3", "z-ai/glm-5.3-flash"]) {
            assert.equal(proofs[id].contractPass, true);
            assert.equal(proofs[id].toolChoice, null);
            assert.deepEqual(proofs[id].reasoning, { effort: "low" });
            assert.equal(proofs[id].thinking, null);
            assert.equal(proofs[id].reasoningEffort, null);
        }
    });
    it("fails billing closed while a positive DeepSeek cost has no observed balance delta", () => {
        const result = run("billing-contract");
        assert.equal(result.status, 0, result.stderr);
        const billing = JSON.parse(result.stdout);
        assert.equal(billing.status, "unsettled");
        assert.equal(billing.deepseek.status, "unsettled");
        assert.equal(billing.deepseek.estimatedCostUsd, 0.005);
        assert.equal(billing.deepseek.spendDeltaUsd, 0);
    });
    it("rejects stale manifest authorization before credential projection", () => {
        const result = run("run", "--mode", "probe", "--output", "/tmp/unused-sdk-model-benchmark.json", "--manifest-sha", "stale", "--authorized-calls", "4", "--authorized-usd", "1");
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /manifest digest mismatch/);
    });
    it("rejects an unknown model before credential projection", () => {
        const result = run("run", "--mode", "probe", "--models", "not-a-model", "--output", "/tmp/unused-sdk-model-benchmark.json", "--manifest-sha", "not-reached", "--authorized-calls", "1", "--authorized-usd", "1");
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /unknown model\(s\): not-a-model/);
    });
});
//# sourceMappingURL=model-benchmark-sdk-v2.test.js.map