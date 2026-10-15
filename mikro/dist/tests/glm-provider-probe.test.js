import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
const SCRIPT = fileURLToPath(new URL("../../scripts/probe-glm-provider.mjs", import.meta.url));
function run(...args) {
    return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}
describe("GLM provider stability probe", () => {
    it("freezes GMICloud FP8, both GLMs, and six no-retry cells", () => {
        const result = run("manifest");
        assert.equal(result.status, 0, result.stderr);
        const manifest = JSON.parse(result.stdout);
        assert.equal(manifest.version, "glm-provider-stability-probe-v1");
        assert.deepEqual(manifest.provider, { name: "GMICloud", slug: "gmicloud", tag: "gmicloud/fp8", quantization: "fp8" });
        assert.deepEqual(manifest.routing, {
            only: ["gmicloud"],
            order: ["gmicloud"],
            allow_fallbacks: false,
            require_parameters: true,
            quantizations: ["fp8"],
        });
        assert.deepEqual(manifest.models.map((model) => model.id), ["z-ai/glm-5.3", "z-ai/glm-5.3-flash"]);
        assert.equal(manifest.repeats, 3);
        assert.equal(manifest.cells, 6);
        assert.equal(manifest.retries, 0);
        assert.equal(manifest.reasoning, "high");
        assert.equal(manifest.temperature, 0);
        assert.equal(manifest.maxCompletionTokens, 4096);
        assert.equal(manifest.rawAnswersPersisted, false);
        assert.match(manifest.harnessSha256, /^[a-f0-9]{64}$/);
    });
    it("is deterministic across processes", () => {
        const first = run("manifest");
        const second = run("manifest");
        assert.equal(first.status, 0, first.stderr);
        assert.equal(second.status, 0, second.stderr);
        assert.equal(first.stdout, second.stdout);
    });
    it("rejects a stale digest before credential projection", () => {
        const result = run("run", "--output", "/tmp/unused-glm-provider-probe.json", "--manifest-sha", "stale", "--authorized-calls", "6", "--authorized-usd", "1");
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /manifest digest mismatch/);
    });
});
//# sourceMappingURL=glm-provider-probe.test.js.map