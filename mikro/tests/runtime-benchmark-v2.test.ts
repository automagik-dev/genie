import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SCRIPT = fileURLToPath(new URL("../../scripts/benchmark-runtimes-v2.mjs", import.meta.url));

function run(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

describe("runtime benchmark v2 manifest", () => {
  it("freezes the selected direct DeepSeek circuit and real runtime journeys", () => {
    const result = run("manifest");
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(result.stdout);
    assert.equal(manifest.version, "mikro-runtime-benchmark-v2");
    assert.deepEqual(manifest.runtimes, ["mikro", "prime-sdk"]);
    assert.equal(manifest.selectedCircuit.selectionId, "deepseek/deepseek-v4-pro-0813");
    assert.equal(manifest.selectedCircuit.provider, "deepseek");
    assert.equal(manifest.selectedCircuit.id, "deepseek-v4-pro");
    assert.equal(manifest.selectedCircuit.baseUrl, "https://api.deepseek.com");
    assert.equal(manifest.selectionEvidence.path, ".genie/evidence/prime-runtime-benchmark/model-benchmark-sdk-v2-selection-lock.json");
    assert.match(manifest.selectionEvidence.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(manifest.journeys.map((journey: { id: string }) => journey.id), [
      "inline-incident-decision",
      "multi-file-release-context",
      "json-authority-context",
    ]);
    assert.deepEqual(manifest.journeys.map((journey: { contextType: string | null }) => journey.contextType), [null, "list", "dict"]);
    assert.equal(manifest.repetitions, 3);
    assert.equal(manifest.probeCalls, 6);
    assert.equal(manifest.fullCalls, 18);
    assert.equal(manifest.providerCallsCeiling, 45);
    assert.equal(manifest.retries, 0);
    assert.equal(manifest.reasoning, "low");
    assert.deepEqual(manifest.maxIterationsByRuntime, { mikro: 2, "prime-sdk": 3 });
    assert.equal(manifest.rawAnswersPersisted, false);
    assert.equal(manifest.primeVersion, "0.8.1");
    assert.equal(manifest.excludedRuntime.prime.eligible, false);
    assert.deepEqual(manifest.excludedRuntime.prime.reasons, [
      "output.schema unsupported",
      "dict context unsupported",
      "budget.maxDepth unsupported",
    ]);
    assert.match(manifest.harnessSha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.primeSdkAdapterSha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.legacyAdapterSha256, /^[a-f0-9]{64}$/);
  });

  it("is deterministic across processes", () => {
    const first = run("manifest");
    const second = run("manifest");
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(first.stdout, second.stdout);
  });

  it("rejects stale authorization before credential lookup", () => {
    const result = run("run", "--mode", "probe", "--output", "/tmp/unused-runtime-v2.json", "--manifest-sha", "stale", "--authorized-calls", "6", "--authorized-usd", "1");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /manifest digest mismatch/);
    assert.doesNotMatch(result.stderr, /DEEPSEEK_API_KEY is missing/);
  });
});

describe("runtime benchmark v2 scorer", () => {
  const expected = JSON.stringify({ timeout: 75, mode: "strict" });

  it("accepts semantic equality and rejects extra fields", () => {
    const pass = run("score", "--expected", expected, "--answer", JSON.stringify({ mode: "strict", timeout: 75 }));
    assert.equal(pass.status, 0, pass.stderr);
    assert.deepEqual(JSON.parse(pass.stdout), { semanticPass: true, formatPass: true, reason: "exact" });

    const fail = run("score", "--expected", expected, "--answer", JSON.stringify({ mode: "strict", timeout: 75, extra: true }));
    assert.equal(fail.status, 0, fail.stderr);
    assert.deepEqual(JSON.parse(fail.stdout), { semanticPass: false, formatPass: true, reason: "value-mismatch" });
  });

  it("rejects prose and malformed JSON", () => {
    const result = run("score", "--expected", expected, "--answer", `Result: ${expected}`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { semanticPass: false, formatPass: false, reason: "invalid-json" });
  });
});
