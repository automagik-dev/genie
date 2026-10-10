import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";
import { isGoogleProvider } from "../src/gemini.js";

/** Helper: create .mikro/ dir with mikro.yaml content */
async function makeConfig(dir: string, yamlContent: string): Promise<void> {
  const mikroDir = join(dir, ".mikro");
  await mkdir(mikroDir, { recursive: true });
  await writeFile(join(mikroDir, "mikro.yaml"), yamlContent);
}

describe("Structured output config", () => {
  let dir: string;

  it("detects structured output mode for Google provider", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-structured-"));
    await makeConfig(dir, `model:
  provider: google
  model: gemini-3.1-flash-lite-preview
output:
  schema:
    type: object
    properties:
      answer:
        type: string
`);
    const cfg = await loadConfig(dir);
    assert.ok(cfg.output.schema);
    assert.ok(isGoogleProvider(cfg.model.provider));
    await rm(dir, { recursive: true });
  });

  it("structured output falls back on non-Google", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-structured-"));
    await makeConfig(dir, `model:
  provider: anthropic
  model: claude-sonnet-4-5
output:
  schema:
    type: object
    properties:
      answer:
        type: string
`);
    const cfg = await loadConfig(dir);
    assert.ok(cfg.output.schema);
    assert.ok(!isGoogleProvider(cfg.model.provider));
    await rm(dir, { recursive: true });
  });

  it("schema with complex nested structure", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-structured-"));
    await makeConfig(dir, `output:
  schema:
    type: object
    properties:
      summary:
        type: string
      findings:
        type: array
        items:
          type: object
          properties:
            title:
              type: string
            severity:
              type: string
              enum: [low, medium, high, critical]
    required:
      - summary
      - findings
`);
    const cfg = await loadConfig(dir);
    assert.ok(cfg.output.schema);
    const schema = cfg.output.schema as any;
    assert.equal(schema.type, "object");
    assert.ok(schema.properties.findings);
    assert.equal(schema.properties.findings.type, "array");
    await rm(dir, { recursive: true });
  });
});
