import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SCRIPT = fileURLToPath(new URL("../../scripts/benchmark-models-v2.mjs", import.meta.url));

function run(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

describe("model benchmark v2 manifest", () => {
  it("freezes one Prime wire, one upstream route, four exact models, and sixty independent cases", () => {
    const result = run("manifest");
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(result.stdout);
    assert.equal(manifest.version, "mikro-model-benchmark-v2");
    assert.equal(manifest.runtime, "prime-agent-ai direct completeSimple");
    assert.equal(manifest.wire, "openai-completions");
    assert.deepEqual(manifest.route, {
      gateway: "openrouter",
      allowFallbacks: false,
    });
    assert.deepEqual(manifest.models.map((model: { id: string }) => model.id), [
      "z-ai/glm-5.3",
      "z-ai/glm-5.3-flash",
      "deepseek/deepseek-v4-flash-0731",
      "deepseek/deepseek-v4-pro-0813",
    ]);
    assert.deepEqual(manifest.models.map((model: { providerName: string; providerSlug: string; tag: string; quantization: string }) => ({
      providerName: model.providerName,
      providerSlug: model.providerSlug,
      tag: model.tag,
      quantization: model.quantization,
    })), [
      { providerName: "GMICloud", providerSlug: "gmicloud", tag: "gmicloud/fp8", quantization: "fp8" },
      { providerName: "DeepInfra", providerSlug: "deepinfra", tag: "deepinfra/fp8", quantization: "fp8" },
      { providerName: "OpenInference", providerSlug: "open-inference", tag: "open-inference/fp8", quantization: "fp8" },
      { providerName: "GMICloud", providerSlug: "gmicloud", tag: "gmicloud/fp8", quantization: "fp8" },
    ]);
    assert.equal(manifest.primeVersion, "0.8.1");
    assert.equal(manifest.primeAiVersion, "0.8.1");
    assert.equal(manifest.families.length, 6);
    assert.equal(new Set(manifest.families).size, 6);
    assert.equal(manifest.casesPerFamily, 10);
    assert.equal(manifest.cases.length, 60);
    assert.equal(new Set(manifest.cases.map((task: { id: string }) => task.id)).size, 60);
    assert.equal(new Set(manifest.cases.map((task: { promptSha256: string }) => task.promptSha256)).size, 60);
    assert.ok(manifest.cases.every((task: { promptSha256: string; expectedSha256: string }) =>
      /^[a-f0-9]{64}$/.test(task.promptSha256) && /^[a-f0-9]{64}$/.test(task.expectedSha256)));
    assert.equal(manifest.fullCalls, 240);
    assert.equal(manifest.probeCalls, 4);
    assert.equal(manifest.temperature, 0);
    assert.equal(manifest.reasoning, "low");
    assert.equal(manifest.retries, 0);
    assert.equal(manifest.rawAnswersPersisted, false);
    assert.match(manifest.billingAuthority, /OpenRouter \/api\/v1\/key usage delta/);
    assert.equal(manifest.scoring.judgeModel, null);
  });

  it("is deterministic across independent process executions", () => {
    const first = run("manifest");
    const second = run("manifest");
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(first.stdout, second.stdout);
  });
});

describe("model benchmark v2 scorer", () => {
  const expected = JSON.stringify({ path: ["A", "C"], total_cost: 7 });

  it("scores semantic correctness and strict format independently", () => {
    const strict = run("score", "--expected", expected, "--answer", expected);
    assert.equal(strict.status, 0, strict.stderr);
    assert.deepEqual(JSON.parse(strict.stdout), {
      semanticPass: true,
      formatPass: true,
      fieldAccuracy: 1,
      reason: "exact",
      parsedFormat: "strict",
    });

    const prose = run("score", "--expected", expected, "--answer", `Result: ${expected}`);
    assert.equal(prose.status, 0, prose.stderr);
    assert.deepEqual(JSON.parse(prose.stdout), {
      semanticPass: true,
      formatPass: false,
      fieldAccuracy: 1,
      reason: "exact",
      parsedFormat: "recovered",
    });
  });

  it("reports partial field accuracy without upgrading it to a pass", () => {
    const answer = JSON.stringify({ path: ["A", "B"], total_cost: 7 });
    const result = run("score", "--expected", expected, "--answer", answer);
    assert.equal(result.status, 0, result.stderr);
    const score = JSON.parse(result.stdout);
    assert.equal(score.semanticPass, false);
    assert.equal(score.formatPass, true);
    assert.equal(score.reason, "value-mismatch");
    assert.ok(score.fieldAccuracy > 0 && score.fieldAccuracy < 1);
  });
});

describe("model benchmark v2 safety gates", () => {
  it("rejects a stale manifest before credentials or paid calls", () => {
    const result = run(
      "run",
      "--mode", "probe",
      "--output", "/tmp/unused-model-benchmark-v2.json",
      "--manifest-sha", "stale",
      "--authorized-calls", "4",
      "--authorized-usd", "1"
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /manifest digest mismatch/);
  });
});
