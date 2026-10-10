import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SCRIPT = fileURLToPath(new URL("../../scripts/benchmark-prime-runtimes.mjs", import.meta.url));

function run(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

describe("prime runtime benchmark manifest", () => {

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
