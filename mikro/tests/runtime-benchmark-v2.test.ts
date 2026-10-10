import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SCRIPT = fileURLToPath(new URL("../../scripts/benchmark-runtimes-v2.mjs", import.meta.url));

function run(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

describe("runtime benchmark v2 manifest", () => {

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
