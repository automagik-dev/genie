/**
 * Config-declared providers (src/custom-providers.ts).
 *
 * The bug these guard against: a microagent pinned to a provider pi-ai has
 * never heard of (`wafer/GLM-5.3-Flash`) was advertised by `mikro mcp` and
 * then died on its first call with `Unknown model … Try updating MODEL.md` —
 * a file that does not exist. Everything below is offline: the provider is
 * registered on a real pi-ai runtime and resolved, but nothing is called.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  buildCustomProvider,
  customProviderKeySource,
  describeProviderHint,
  ensureCustomProviders,
  mergeCustomProviders,
  parseCustomProviders,
  toPiModel,
  type CustomProviderConfig,
} from "../src/custom-providers.js";
import { loadConfig, applyModelRef } from "../src/config.js";
import { checkModelConfig, resolveModel } from "../src/llm.js";
import { validateAgentModels } from "../src/mcp/server.js";

const WAFER_YAML = `
providers:
  wafer:
    base-url: https://pass.wafer.ai/v1
    api-key-env: WAFER_API_KEY
    headers:
      Wafer-ZDR: required
    models:
      GLM-5.3-Flash:
        context-window: 128000
        max-tokens: 16000
        reasoning: true
        input: [text]
        cost: { input: 0.1, output: 0.4 }
`;

function wafer(): CustomProviderConfig {
  const raw = yaml.load(WAFER_YAML) as { providers: unknown };
  return parseCustomProviders(raw.providers, "mikro.yaml")[0];
}

describe("parseCustomProviders", () => {
  it("parses the kebab-case mikro.yaml shape", () => {
    const [p] = parseCustomProviders((yaml.load(WAFER_YAML) as { providers: unknown }).providers, "mikro.yaml");
    assert.equal(p.id, "wafer");
    assert.equal(p.api, "openai-completions");
    assert.equal(p.baseUrl, "https://pass.wafer.ai/v1");
    assert.deepEqual(p.apiKeyEnv, ["WAFER_API_KEY"]);
    assert.deepEqual(p.headers, { "Wafer-ZDR": "required" });
    assert.equal(p.models.length, 1);
    assert.equal(p.models[0].id, "GLM-5.3-Flash");
    assert.equal(p.models[0].contextWindow, 128000);
    assert.equal(p.models[0].maxTokens, 16000);
    assert.equal(p.models[0].reasoning, true);
    assert.deepEqual(p.models[0].cost, { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 });
  });

  it("accepts the camelCase settings.json shape and a list of models", () => {
    const [p] = parseCustomProviders(
      {
        deepseek: {
          baseUrl: "https://api.deepseek.com/v1/",
          apiKeyEnv: ["DEEPSEEK_API_KEY", "DS_KEY"],
          models: ["deepseek-chat", { id: "deepseek-reasoner", reasoning: true, maxTokens: 32000 }],
        },
      },
      "settings.json"
    );
    assert.equal(p.id, "deepseek");
    assert.equal(p.baseUrl, "https://api.deepseek.com/v1", "trailing slash trimmed");
    assert.deepEqual(p.apiKeyEnv, ["DEEPSEEK_API_KEY", "DS_KEY"]);
    assert.deepEqual(
      p.models.map((m) => [m.id, m.reasoning, m.maxTokens]),
      [
        ["deepseek-chat", false, 16384],
        ["deepseek-reasoner", true, 32000],
      ]
    );
  });

  it("returns an empty list when the block is absent", () => {
    assert.deepEqual(parseCustomProviders(undefined, "mikro.yaml"), []);
    assert.deepEqual(parseCustomProviders(null, "mikro.yaml"), []);
  });

  it("supports the anthropic-messages and openai-responses wire formats", () => {
    const list = parseCustomProviders(
      {
        a: { "base-url": "https://a.example/v1", api: "anthropic-messages", models: ["m"] },
        b: { "base-url": "https://b.example/v1", api: "openai-responses", models: ["m"] },
      },
      "mikro.yaml"
    );
    assert.deepEqual(list.map((p) => p.api), ["anthropic-messages", "openai-responses"]);
  });

  it("rejects a provider without base-url, naming the path", () => {
    assert.throws(
      () => parseCustomProviders({ wafer: { models: ["x"] } }, "mikro.yaml"),
      /Invalid providers\.wafer\.base-url in mikro\.yaml: is required/
    );
  });

  it("rejects an unsupported api", () => {
    assert.throws(
      () => parseCustomProviders({ w: { "base-url": "https://x", api: "grpc" } }, "mikro.yaml"),
      /providers\.w\.api.*not supported.*openai-completions, anthropic-messages, openai-responses/
    );
  });

  it("rejects a malformed base-url, a duplicate model, and a bad input list", () => {
    assert.throws(
      () => parseCustomProviders({ w: { "base-url": "not a url" } }, "mikro.yaml"),
      /providers\.w\.base-url.*not a valid URL/
    );
    assert.throws(
      () => parseCustomProviders({ w: { "base-url": "https://x", models: ["m", "m"] } }, "mikro.yaml"),
      /declared twice/
    );
    assert.throws(
      () => parseCustomProviders({ w: { "base-url": "https://x", models: { m: { input: ["audio"] } } } }, "mikro.yaml"),
      /providers\.w\.models\.m\.input.*\[text, image\]/
    );
  });

  it("rejects a provider id that cannot be a model-ref prefix", () => {
    assert.throws(
      () => parseCustomProviders({ "bad id/": { "base-url": "https://x" } }, "mikro.yaml"),
      /provider id must match/
    );
  });
});

describe("mergeCustomProviders", () => {
  it("lets a later declaration replace an earlier one by id", () => {
    const global = parseCustomProviders(
      { wafer: { "base-url": "https://old.example/v1", models: ["a"] }, other: { "base-url": "https://o/v1" } },
      "settings.json"
    );
    const local = parseCustomProviders({ wafer: { "base-url": "https://new.example/v1", models: ["b"] } }, "mikro.yaml");
    const merged = mergeCustomProviders(global, local);
    assert.deepEqual(merged.map((p) => p.id), ["wafer", "other"]);
    assert.equal(merged[0].baseUrl, "https://new.example/v1");
    assert.deepEqual(merged[0].models.map((m) => m.id), ["b"]);
  });
});

describe("pi-ai construction", () => {
  it("maps a declared model onto the pi-ai Model shape with merged headers", () => {
    const p = wafer();
    p.models[0].headers = { "X-Trace": "1" };
    const m = toPiModel(p, p.models[0]);
    assert.equal(m.provider, "wafer");
    assert.equal(m.api, "openai-completions");
    assert.equal(m.baseUrl, "https://pass.wafer.ai/v1");
    assert.deepEqual(m.headers, { "Wafer-ZDR": "required", "X-Trace": "1" });
    assert.equal(m.maxTokens, 16000);
    assert.equal(m.contextWindow, 128000);
  });

  it("clamps max-tokens to the context window", () => {
    const p = wafer();
    p.models[0].maxTokens = 999_999;
    assert.equal(toPiModel(p, p.models[0]).maxTokens, 128000);
  });

  it("builds a provider whose catalog is the declared models", () => {
    const provider = buildCustomProvider(wafer());
    assert.equal(provider.id, "wafer");
    assert.deepEqual(provider.getModels().map((m) => m.id), ["GLM-5.3-Flash"]);
  });
});

describe("ensureCustomProviders", () => {
  it("registers on a real pi-ai runtime so <id>/<model> resolves", () => {
    const models = builtinModels();
    assert.equal(models.getModel("wafer", "GLM-5.3-Flash"), undefined, "not built in");
    const changed = ensureCustomProviders(models, [wafer()]);
    assert.deepEqual(changed, ["wafer"]);
    const m = models.getModel("wafer", "GLM-5.3-Flash");
    assert.ok(m, "resolves after registration");
    assert.deepEqual(m.headers, { "Wafer-ZDR": "required" });
  });

  it("is idempotent, and re-registers only when the declaration changes", () => {
    const models = builtinModels();
    const first = wafer();
    ensureCustomProviders(models, [first]);
    assert.deepEqual(ensureCustomProviders(models, [first]), [], "unchanged → no-op");

    const edited = wafer();
    edited.models.push({ ...edited.models[0], id: "GLM-5.3" });
    assert.deepEqual(ensureCustomProviders(models, [edited]), ["wafer"]);
    assert.ok(models.getModel("wafer", "GLM-5.3"));
  });

  it("is a no-op for an empty or missing list", () => {
    const models = builtinModels();
    assert.deepEqual(ensureCustomProviders(models, undefined), []);
    assert.deepEqual(ensureCustomProviders(models, []), []);
  });
});

describe("key status and hints", () => {
  it("reports which env var supplies the key", () => {
    const p = wafer();
    const saved = process.env.WAFER_API_KEY;
    try {
      delete process.env.WAFER_API_KEY;
      assert.equal(customProviderKeySource(p), undefined);
      process.env.WAFER_API_KEY = "k";
      assert.equal(customProviderKeySource(p), "WAFER_API_KEY");
    } finally {
      if (saved === undefined) delete process.env.WAFER_API_KEY;
      else process.env.WAFER_API_KEY = saved;
    }
  });

  it("points an undeclared provider at config, not at MODEL.md", () => {
    const hint = describeProviderHint(undefined, "wafer");
    assert.match(hint, /not declared in config/);
    assert.match(hint, /providers: in \.mikro\/mikro\.yaml/);
    assert.doesNotMatch(hint, /MODEL\.md/);
  });

  it("says a known provider lacks the model, not that the provider is missing", () => {
    const problem = checkModelConfig({ provider: "openrouter", model: "~vendor/does-not-exist" });
    assert.ok(problem);
    assert.match(problem, /Provider "openrouter" is known but does not list that model/);
    assert.doesNotMatch(problem, /not a built-in/);
  });

  it("lists the declared models when the provider exists but the model does not", () => {
    assert.match(describeProviderHint([wafer()], "wafer"), /models: GLM-5\.3-Flash/);
  });
});

describe("resolveModel / checkModelConfig (src/llm.ts)", () => {
  it("resolves a config-declared pin and rejects an undeclared one with the new hint", () => {
    const providers = [wafer()];
    const m = resolveModel("wafer", "GLM-5.3-Flash", providers);
    assert.equal(m.id, "GLM-5.3-Flash");
    assert.equal(checkModelConfig({ provider: "wafer", model: "GLM-5.3-Flash", providers }), null);

    const problem = checkModelConfig({ provider: "nope", model: "x" });
    assert.ok(problem);
    assert.match(problem, /Unknown model "x" for provider "nope"/);
    assert.match(problem, /not declared in config/);
    assert.doesNotMatch(problem, /MODEL\.md/);
  });

  it("carries providers through applyModelRef so an agent's pin resolves", () => {
    const base = { provider: "google", model: "gemini-3.1-flash-lite-preview", providers: [wafer()] };
    const pinned = applyModelRef(base, "wafer/GLM-5.3-Flash");
    assert.equal(pinned.provider, "wafer");
    assert.equal(checkModelConfig(pinned), null);
  });

  it("treats the dynamic-catalog gateways as call-time checks", () => {
    assert.equal(checkModelConfig({ provider: "station", model: "anything" }), null);
    assert.equal(checkModelConfig({ provider: "khal", model: "anything" }), null);
  });
});

describe("loadConfig providers block", () => {
  let home: string;
  let dir: string;
  const originalHome = process.env.HOME;

  before(async () => {
    home = await mkdtemp(join(tmpdir(), "mikro-home-"));
    dir = await mkdtemp(join(tmpdir(), "mikro-prov-"));
    process.env.HOME = home;
    await mkdir(join(home, ".mikro"), { recursive: true });
    await writeFile(
      join(home, ".mikro", "settings.json"),
      JSON.stringify({
        providers: {
          deepseek: { baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY", models: ["deepseek-chat"] },
          wafer: { baseUrl: "https://global.example/v1", models: ["old"] },
        },
      })
    );
    await mkdir(join(dir, ".mikro"), { recursive: true });
    await writeFile(join(dir, ".mikro", "mikro.yaml"), `model:\n  provider: wafer\n  model: GLM-5.3-Flash\n${WAFER_YAML}`);
  });

  after(async () => {
    process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  });

  it("merges settings.json providers under mikro.yaml, yaml winning per id", async () => {
    const cfg = await loadConfig(dir);
    assert.deepEqual(cfg.providers.map((p) => p.id).sort(), ["deepseek", "wafer"]);
    const w = cfg.providers.find((p) => p.id === "wafer")!;
    assert.equal(w.baseUrl, "https://pass.wafer.ai/v1", "project yaml overrides the global entry");
    assert.ok(cfg.model.providers, "providers ride on the model config");
    assert.equal(checkModelConfig(cfg.model), null, "the configured model resolves");
  });

  it("serves global providers to a directory with no mikro.yaml", async () => {
    const bare = await mkdtemp(join(tmpdir(), "mikro-bare-"));
    try {
      const cfg = await loadConfig(bare);
      assert.equal(cfg.configSource, "defaults");
      assert.deepEqual(cfg.providers.map((p) => p.id).sort(), ["deepseek", "wafer"]);
      assert.equal(checkModelConfig(applyModelRef(cfg.model, "deepseek/deepseek-chat")), null);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("marks an MCP agent whose pin cannot resolve, and clears it once declared", async () => {
    const agent = (model: string) =>
      ({
        name: "wendy",
        toolName: "mikro_wendy",
        dir: join(dir, ".agents", "wendy"),
        summary: "Tilt check.",
        spec: { dir: join(dir, ".agents", "wendy"), schemaVersion: 1, toolsApi: 1, shape: "loop", model, tools: [], extras: {} },
      }) as unknown as Parameters<typeof validateAgentModels>[1][number];

    const [ok] = await validateAgentModels(dir, [agent("wafer/GLM-5.3-Flash")]);
    assert.equal(ok.unavailable, undefined);

    const [bad] = await validateAgentModels(dir, [agent("wafer/GLM-9")]);
    assert.ok(bad.unavailable);
    assert.match(bad.unavailable, /Unknown model "GLM-9" for provider "wafer"/);
    assert.match(bad.unavailable, /models: GLM-5\.3-Flash/);
    assert.match(
      bad.unavailable,
      /Fix the agent's model: pin or declare the provider in config, then retry\.$/
    );

    const [other] = await validateAgentModels(dir, [{ ...agent("x/y"), spec: { ...agent("x/y").spec, backend: "prime" } } as never]);
    assert.equal(other.unavailable, undefined, "non-pi-ai backends are not validated");
  });
});
