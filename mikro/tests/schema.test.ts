import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MIKRO_CLI_SCHEMA } from "../src/schema.js";

describe("MIKRO_CLI_SCHEMA", () => {
  it("describes at least ten CLI flags including v0.4 flags", () => {
    assert.ok(Array.isArray(MIKRO_CLI_SCHEMA.flags));
    assert.ok(MIKRO_CLI_SCHEMA.flags.length >= 10);

    const flags = new Map(MIKRO_CLI_SCHEMA.flags.map((flag) => [flag.name, flag]));
    for (const name of ["--thinking", "--cache", "--batch-api", "--tools"]) {
      assert.ok(flags.has(name), `${name} missing from schema flags`);
      assert.equal(typeof flags.get(name)?.description, "string");
    }
  });

  // --model is how a parent pins a recursive child (buildRlmChildArgs emits
  // it), so it is part of the documented surface, not an internal flag.
  it("documents --model as a query flag", () => {
    const flag = MIKRO_CLI_SCHEMA.flags.find((f) => f.name === "--model");
    assert.ok(flag, "--model missing from schema flags");
    assert.equal(flag.type, "string");
    assert.ok(flag.appliesTo?.includes("query"));
    assert.ok(flag.description.length > 0);
  });

  it("describes the JSON output object as JSON Schema", () => {
    assert.equal(MIKRO_CLI_SCHEMA.output.type, "object");
    assert.ok(MIKRO_CLI_SCHEMA.output.properties.answer);
    assert.ok(MIKRO_CLI_SCHEMA.output.properties.references);
    assert.ok(MIKRO_CLI_SCHEMA.output.properties.usage);
    assert.ok(MIKRO_CLI_SCHEMA.output.required?.includes("answer"));
  });

  it("lists documented exit codes and meanings", () => {
    const exitCodes = new Map(MIKRO_CLI_SCHEMA.exitCodes.map((entry) => [entry.code, entry.meaning]));
    assert.equal(exitCodes.get(0), "success");
    assert.ok(exitCodes.get(1)?.includes("error"));
    assert.equal(exitCodes.has(2), false);
    assert.ok(exitCodes.get(130)?.includes("SIGINT"));
    assert.ok(exitCodes.get(143)?.includes("SIGTERM"));
  });
});
