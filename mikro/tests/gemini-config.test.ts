import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";

/** Helper: create .mikro/ dir with mikro.yaml content */
async function makeConfig(dir: string, yamlContent: string): Promise<void> {
  const mikroDir = join(dir, ".mikro");
  await mkdir(mikroDir, { recursive: true });
  await writeFile(join(mikroDir, "mikro.yaml"), yamlContent);
}

describe("Gemini YAML config parsing", () => {
  let dir: string;

  it("parses full gemini section", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-gemini-"));
    await makeConfig(dir, `model:
  provider: google
  model: gemini-3.1-flash-lite-preview
gemini:
  thinking-level: medium
  google-search: true
  url-context: true
  code-execution: true
  media-resolution:
    images: high
    pdfs: medium
    video: low
  computer-use: false
  maps-grounding: false
  file-search: false
`);
    const cfg = await loadConfig(dir);
    assert.equal(cfg.gemini.thinkingLevel, "medium");
    assert.equal(cfg.gemini.googleSearch, true);
    assert.equal(cfg.gemini.urlContext, true);
    assert.equal(cfg.gemini.codeExecution, true);
    assert.deepEqual(cfg.gemini.mediaResolution, {
      images: "high",
      pdfs: "medium",
      video: "low",
    });
    assert.equal(cfg.gemini.computerUse, false);
    assert.equal(cfg.gemini.mapsGrounding, false);
    assert.equal(cfg.gemini.fileSearch, false);
    await rm(dir, { recursive: true });
  });

  it("uses defaults when gemini section is absent", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-gemini-"));
    await makeConfig(dir, "model:\n  provider: anthropic\n");
    const cfg = await loadConfig(dir);
    assert.equal(cfg.gemini.thinkingLevel, null);
    assert.equal(cfg.gemini.googleSearch, false);
    assert.equal(cfg.gemini.urlContext, false);
    assert.equal(cfg.gemini.codeExecution, false);
    assert.equal(cfg.gemini.mediaResolution, null);
    assert.equal(cfg.gemini.computerUse, false);
    await rm(dir, { recursive: true });
  });

  it("rejects invalid thinking-level", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-gemini-"));
    await makeConfig(dir, "gemini:\n  thinking-level: ultra\n");
    await assert.rejects(() => loadConfig(dir), /Invalid gemini\.thinking-level/);
    await rm(dir, { recursive: true });
  });

  it("rejects invalid media-resolution value", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-gemini-"));
    await makeConfig(dir, "gemini:\n  media-resolution:\n    images: ultra\n");
    await assert.rejects(
      () => loadConfig(dir),
      /Invalid gemini\.media-resolution\.images/
    );
    await rm(dir, { recursive: true });
  });

  it("parses partial gemini section with defaults", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-gemini-"));
    await makeConfig(dir, "gemini:\n  thinking-level: low\n");
    const cfg = await loadConfig(dir);
    assert.equal(cfg.gemini.thinkingLevel, "low");
    assert.equal(cfg.gemini.googleSearch, false);
    assert.equal(cfg.gemini.codeExecution, false);
    await rm(dir, { recursive: true });
  });

  it("graceful degradation: non-Google provider ignores gemini section", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-gemini-"));
    await makeConfig(dir, `model:
  provider: anthropic
  model: claude-sonnet-4-5
gemini:
  thinking-level: high
  google-search: true
`);
    const cfg = await loadConfig(dir);
    assert.equal(cfg.gemini.thinkingLevel, "high");
    assert.equal(cfg.gemini.googleSearch, true);
    assert.equal(cfg.model.provider, "anthropic");
    await rm(dir, { recursive: true });
  });
});

describe("Output schema parsing", () => {
  let dir: string;

  it("parses output.schema from YAML", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-gemini-"));
    await makeConfig(dir, `output:
  schema:
    type: object
    properties:
      answer:
        type: string
      confidence:
        type: number
    required:
      - answer
`);
    const cfg = await loadConfig(dir);
    assert.ok(cfg.output.schema);
    assert.equal((cfg.output.schema as any).type, "object");
    assert.ok((cfg.output.schema as any).properties.answer);
    await rm(dir, { recursive: true });
  });

  it("defaults output.schema to null", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-gemini-"));
    await makeConfig(dir, "model:\n  provider: google\n");
    const cfg = await loadConfig(dir);
    assert.equal(cfg.output.schema, null);
    await rm(dir, { recursive: true });
  });
});
