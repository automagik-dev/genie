import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SCRIPT = fileURLToPath(new URL("../../scripts/benchmark-prime-runtimes.mjs", import.meta.url));

function run(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

describe("prime runtime benchmark manifest", () => {
  it("freezes three runtimes, four models, six tasks, five repetitions, and twelve probes", () => {
    const result = run("manifest", "--json");
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(result.stdout);
    assert.deepEqual(manifest.runtimes, ["mikro", "prime", "prime-sdk"]);
    assert.deepEqual(manifest.models, [
      "z-ai/glm-5.3",
      "z-ai/glm-5.3-flash",
      "deepseek/deepseek-v4-flash-0731",
      "deepseek/deepseek-v4-pro-0813",
    ]);
    assert.equal(manifest.tasks.length, 6);
    assert.equal(manifest.repetitions, 5);
    assert.equal(manifest.scoredCalls, 360);
    assert.equal(manifest.probeCalls, 12);
    assert.equal(manifest.totalCalls, 372);
    assert.deepEqual(manifest.maxIterationsByRuntime, {
      mikro: 1,
      prime: 1,
      "prime-sdk": 2,
    });
    assert.equal(manifest.probeProviderCalls, 16);
    assert.equal(manifest.scoredProviderCalls, 480);
    assert.equal(manifest.totalProviderCalls, 496);
    assert.equal(manifest.retries, 0);
    assert.equal(manifest.maxInputTokens, 32768);
    assert.equal(manifest.maxOutputTokens, 1024);
    assert.deepEqual(manifest.effectiveReasoningByModel, {
      "z-ai/glm-5.3": "high",
      "z-ai/glm-5.3-flash": "high",
      "deepseek/deepseek-v4-flash-0731": "high",
      "deepseek/deepseek-v4-pro-0813": "high",
    });
    assert.deepEqual(manifest.providerOutputCapsByModel, {
      "z-ai/glm-5.3": 17408,
      "z-ai/glm-5.3-flash": 17408,
      "deepseek/deepseek-v4-flash-0731": 17408,
      "deepseek/deepseek-v4-pro-0813": 17408,
    });
    assert.deepEqual(manifest.routePolicy, {
      "z-ai/glm-5.3": "openrouter-default-fallback",
      "z-ai/glm-5.3-flash": "openrouter-default-fallback",
      "deepseek/deepseek-v4-flash-0731": "openrouter-default-fallback",
      "deepseek/deepseek-v4-pro-0813": "openrouter-default-fallback",
    });
    assert.match(manifest.harnessSha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.candidateSha256, /^[a-f0-9]{64}$/);
    assert.ok(manifest.candidateFiles.includes("dist/src/mcp/backends/prime-sdk.js"));
    assert.ok(manifest.candidateFiles.includes("dist/src/mcp/backends/legacy.js"));
    assert.deepEqual(Object.keys(manifest.outputLimitEnforcement).sort(), ["mikro", "prime", "prime-sdk"]);
  });

  it("uses one task prompt digest across every runtime arm", () => {
    const result = run("manifest", "--json");
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(result.stdout);
    for (const task of manifest.tasks) {
      assert.match(task.promptSha256, /^[a-f0-9]{64}$/);
      assert.equal(typeof task.expectedSha256, "string");
      assert.equal(task.expectedGrounded, true, `${task.id} expected values must appear in its prompt`);
    }
  });
});

describe("prime runtime benchmark deterministic scorer", () => {
  const expected = JSON.stringify({ owner: "ada", port: 4821, severity: "critical" });

  it("accepts the exact JSON value regardless of object key order", () => {
    const answer = JSON.stringify({ severity: "critical", owner: "ada", port: 4821 });
    const result = run("score", "--expected", expected, "--answer", answer, "--json");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { pass: true, reason: "exact" });
  });

  it("rejects an extra field instead of silently scoring a partial contract", () => {
    const answer = JSON.stringify({ owner: "ada", port: 4821, severity: "critical", extra: true });
    const result = run("score", "--expected", expected, "--answer", answer, "--json");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { pass: false, reason: "value-mismatch" });
  });

  it("parses a single JSON code fence but rejects prose around the answer", () => {
    const fenced = `\`\`\`json\n${expected}\n\`\`\``;
    assert.equal(JSON.parse(run("score", "--expected", expected, "--answer", fenced, "--json").stdout).pass, true);
    const prose = `Result: ${expected}`;
    assert.equal(JSON.parse(run("score", "--expected", expected, "--answer", prose, "--json").stdout).pass, false);
  });
});

describe("prime runtime benchmark subset selection", () => {
  it("rejects an unknown runtime before credentials or paid calls", () => {
    const result = run(
      "run",
      "--mode", "probe",
      "--runtimes", "prime,not-a-runtime",
      "--output", "/tmp/unused-prime-benchmark.json",
      "--manifest-sha", "not-reached",
      "--authorized-calls", "8",
      "--authorized-usd", "1"
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown runtime\(s\): not-a-runtime/);
  });
});
