import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  STATION_BASELINE_MODELS,
  STATION_BASE_URL,
  STATION_PROVIDER_ID,
  registerStationProvider,
  stationProvider,
} from "../src/station-provider.js";

// These are offline structural checks — no live gateway required. The live
// three-model completions (incl. the NPU gate) are validated by the wish's
// smoke run, not the unit suite.

describe("station provider", () => {
  it("registers a first-class `station` provider on a Models runtime", () => {
    const models = builtinModels();
    registerStationProvider(models);
    assert.ok(
      models.getProvider(STATION_PROVIDER_ID),
      "station provider should be registered",
    );
  });

  it("resolves all three baseline models via getModel(provider, id)", () => {
    const models = builtinModels();
    registerStationProvider(models);
    for (const id of [
      "qwen3.6-moe-35b-a3b-FLM",
      "Qwen3.6-35B-A3B-MTP-GGUF",
      "Qwen3.5-4B-MTP-GGUF",
    ]) {
      const m = models.getModel(STATION_PROVIDER_ID, id);
      assert.ok(m, `station/${id} should resolve`);
      assert.equal(m?.provider, STATION_PROVIDER_ID);
      assert.equal(m?.baseUrl, STATION_BASE_URL);
      assert.deepEqual(m?.input, ["text"]);
      assert.equal(m?.cost.input, 0);
      assert.equal(m?.cost.output, 0);
      assert.equal(m?.maxTokens, 8192);
    }
  });

  it("ACP smoke defaults to the curated NPU model", () => {
    const smoke = readFileSync(new URL("../../scripts/smoke-acp.mjs", import.meta.url), "utf8");
    assert.match(
      smoke,
      /const MODEL_ID = RECURSIVE \? "Qwen3\.6-35B-A3B-MTP-GGUF" : "qwen3\.6-moe-35b-a3b-FLM";/,
    );
    assert.doesNotMatch(smoke, /qwen3\.5-2b-FLM/);
  });

  it("base URL targets the gateway's /api/v1 (not /v1)", () => {
    assert.match(STATION_BASE_URL, /\/api\/v1$/);
  });

  it("applies qwen-chat-template thinking format to the GGUF Qwen MTP models", () => {
    const gguf = STATION_BASELINE_MODELS.filter((m) =>
      m.id.endsWith("-GGUF"),
    );
    assert.equal(gguf.length, 2, "expected two GGUF baseline models");
    for (const m of gguf) {
      assert.equal(m.reasoning, true, `${m.id} needs reasoning:true for the thinking branch`);
      assert.equal(
        m.compat?.thinkingFormat,
        "qwen-chat-template",
        `${m.id} must send chat_template_kwargs so streaming yields content`,
      );
      assert.equal(m.compat?.supportsDeveloperRole, false);
      assert.equal(m.compat?.supportsReasoningEffort, false);
    }
  });

  it("keeps the NPU FastFlowLM model minimal (no thinking format)", () => {
    const flm = STATION_BASELINE_MODELS.find(
      (m) => m.id === "qwen3.6-moe-35b-a3b-FLM",
    );
    assert.ok(flm);
    assert.equal(flm?.name, "Qwen3.6 35B A3B (NPU / FastFlowLM)");
    assert.equal(flm?.contextWindow, 32768);
    assert.equal(flm?.reasoning, false);
    assert.equal(flm?.compat?.thinkingFormat, undefined);
    assert.equal(flm?.compat?.supportsDeveloperRole, false);
    assert.equal(flm?.compat?.supportsReasoningEffort, false);
  });

  it("keyless auth resolves as configured (local server)", async () => {
    const provider = stationProvider();
    const resolved = await provider.auth.apiKey?.resolve({
      // The resolver ignores ctx/credential — it always reports configured.
      ctx: {} as never,
      credential: undefined,
    });
    assert.ok(resolved, "keyless auth must report configured");
    assert.ok(resolved?.auth.apiKey, "keyless auth must supply a placeholder key");
  });
});

/**
 * Dynamic-catalog regression — the gateway serves ids that are not in the
 * static baseline (e.g. `Brain-35B`). `fetchModels` is a pi-ai hook that only
 * runs on `Models.refresh()`, which nothing called, so those ids resolved as
 * "Unknown model" despite being live. `stationProvider(catalog)` is the seam
 * `ensureStationModels` re-registers through.
 */
describe("stationProvider — dynamic catalog", () => {
  it("defaults to the static baseline", () => {
    const ids = stationProvider().getModels().map((m) => m.id);
    assert.deepEqual(
      [...ids].sort(),
      [...STATION_BASELINE_MODELS.map((m) => m.id)].sort()
    );
  });

  it("serves a supplied catalog so gateway-only ids resolve", () => {
    const extra = {
      ...STATION_BASELINE_MODELS[0],
      id: "Brain-35B",
      name: "Brain-35B",
    };
    const models = builtinModels();
    models.setProvider(stationProvider([...STATION_BASELINE_MODELS, extra]));

    assert.ok(
      models.getModel(STATION_PROVIDER_ID, "Brain-35B"),
      "a gateway-only id must resolve once the overlay is registered"
    );
    // Re-registering must not drop the baseline.
    for (const baseline of STATION_BASELINE_MODELS) {
      assert.ok(
        models.getModel(STATION_PROVIDER_ID, baseline.id),
        `baseline model ${baseline.id} must survive the overlay`
      );
    }
  });

  it("does not resolve a gateway-only id without the overlay", () => {
    const models = builtinModels();
    registerStationProvider(models);
    assert.equal(
      models.getModel(STATION_PROVIDER_ID, "Brain-35B"),
      undefined,
      "baseline-only registration must not invent models"
    );
  });
});
