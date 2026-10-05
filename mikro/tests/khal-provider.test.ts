import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  KHAL_BASE_URL,
  KHAL_MISSING_KEY_ERROR,
  KHAL_PROVIDER_ID,
  ensureKhalModels,
  fetchKhalModels,
  khalApiKey,
  khalApiKeySource,
  khalProvider,
  parseModelInfo,
  parseModelList,
  perMillionDollars,
  registerKhalProvider,
  resetKhalModelsCache,
} from "../src/khal-provider.js";

/**
 * Offline structural checks — no live gateway required. The keyed end-to-end
 * run (footer shows nonzero cost) is the wish's manual acceptance step.
 *
 * The fixture below is a trimmed capture of the real `/model/info` response
 * from `llm.khal.ai` (2026-07-26), including the two things that broke the
 * first design: LiteLLM quotes prices **per token** where pi-ai's `Model.cost`
 * is **per million**, and one alias fronts several deployments.
 */
const MODEL_INFO_FIXTURE = {
  data: [
    {
      model_name: "khal/deepseek-v4-flash",
      model_info: {
        mode: "chat",
        max_input_tokens: 1048576,
        max_output_tokens: 1048576,
        input_cost_per_token: 1e-7,
        output_cost_per_token: 2e-7,
        cache_read_input_token_cost: 2e-8,
        cache_creation_input_token_cost: null,
        supports_vision: false,
        supports_reasoning: true,
      },
    },
    {
      // Second deployment of the same alias — must fold, not duplicate.
      model_name: "khal/deepseek-v4-flash",
      model_info: {
        mode: "chat",
        max_input_tokens: 1048576,
        max_output_tokens: 1048576,
        input_cost_per_token: 1e-7,
        output_cost_per_token: 2e-7,
        cache_read_input_token_cost: 2e-8,
        supports_vision: false,
        supports_reasoning: true,
      },
    },
    {
      model_name: "khal/claude-sonnet",
      model_info: {
        mode: "chat",
        max_input_tokens: 200000,
        max_output_tokens: 64000,
        input_cost_per_token: 3e-6,
        output_cost_per_token: 1.5e-5,
        cache_read_input_token_cost: 3e-7,
        cache_creation_input_token_cost: 3.75e-6,
        supports_vision: true,
        supports_reasoning: true,
      },
    },
    {
      // Cheapest deployment listed first; the folded price must be the max, so
      // the answer does not depend on `/model/info` ordering.
      model_name: "khal/kimi-k2.6",
      model_info: {
        mode: "chat",
        max_input_tokens: 262144,
        max_output_tokens: 262144,
        input_cost_per_token: 7.5e-7,
        output_cost_per_token: 3.5e-6,
        cache_read_input_token_cost: 1.5e-7,
        supports_vision: true,
        supports_reasoning: true,
      },
    },
    {
      model_name: "khal/kimi-k2.6",
      model_info: {
        mode: "chat",
        max_input_tokens: 262144,
        max_output_tokens: 262144,
        input_cost_per_token: 1.2e-6,
        output_cost_per_token: 4.5e-6,
        cache_read_input_token_cost: 2e-7,
        supports_vision: true,
        supports_reasoning: true,
      },
    },
    {
      model_name: "khal/text-embed",
      model_info: { mode: "embedding", input_cost_per_token: 1e-8 },
    },
  ],
};

const MODEL_LIST_FIXTURE = {
  data: [
    {
      id: "khal/deepseek-v4-flash",
      object: "model",
      max_input_tokens: 1048576,
      max_output_tokens: 1048576,
    },
    { id: "khal/claude-haiku", object: "model" },
  ],
};

function findModel<T extends { id: string }>(catalog: readonly T[], id: string): T {
  const model = catalog.find((m) => m.id === id);
  assert.ok(model, `catalog should contain ${id}`);
  return model;
}

describe("khal cost mapping (LiteLLM $/token → pi-ai $/Mtok)", () => {
  it("multiplies per-token prices by 1e6 — flash 1e-7/token is $0.10/Mtok", () => {
    const catalog = parseModelInfo(MODEL_INFO_FIXTURE);
    const flash = findModel(catalog, "deepseek-v4-flash");
    // The whole point of the conversion: pi-ai divides model.cost by 1e6 at
    // usage time, so without the ×1e6 every khal run reports $0.0000.
    assert.equal(flash.cost.input, 0.1);
    assert.equal(flash.cost.output, 0.2);
    assert.equal(flash.cost.cacheRead, 0.02);
    assert.equal(flash.cost.cacheWrite, 0);
  });

  it("converts a full priced row including cache writes", () => {
    const sonnet = findModel(parseModelInfo(MODEL_INFO_FIXTURE), "claude-sonnet");
    assert.deepEqual(sonnet.cost, {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
  });

  it("rounds away IEEE-754 noise (1e-7 * 1e6 is 0.09999999999999999)", () => {
    assert.equal(perMillionDollars(1e-7), 0.1);
    assert.equal(perMillionDollars(1.8e-7), 0.18);
    assert.equal(perMillionDollars(7.4e-7), 0.74);
  });

  it("treats missing/invalid prices as 0 rather than NaN", () => {
    for (const bad of [undefined, null, "3e-6", Number.NaN, -1, 0]) {
      assert.equal(perMillionDollars(bad), 0);
    }
  });
});

describe("khal /model/info parsing", () => {
  it("strips the gateway's redundant `khal/` alias prefix from the id", () => {
    const ids = parseModelInfo(MODEL_INFO_FIXTURE).map((m) => m.id);
    assert.ok(ids.includes("deepseek-v4-flash"));
    assert.ok(!ids.includes("khal/deepseek-v4-flash"));
  });

  it("keeps the wire alias in `name` so the transport can restore it", () => {
    const flash = findModel(parseModelInfo(MODEL_INFO_FIXTURE), "deepseek-v4-flash");
    // A bare `deepseek-v4-flash` is a 400 at the gateway — the request body
    // must carry the alias verbatim.
    assert.equal(flash.name, "khal/deepseek-v4-flash");
  });

  it("folds several deployments of one alias, taking the max price", () => {
    const catalog = parseModelInfo(MODEL_INFO_FIXTURE);
    assert.equal(catalog.filter((m) => m.id === "kimi-k2.6").length, 1);
    const kimi = findModel(catalog, "kimi-k2.6");
    assert.equal(kimi.cost.input, 1.2);
    assert.equal(kimi.cost.output, 4.5);
    assert.equal(kimi.cost.cacheRead, 0.2);
  });

  it("drops non-chat modes", () => {
    const ids = parseModelInfo(MODEL_INFO_FIXTURE).map((m) => m.id);
    assert.ok(!ids.includes("text-embed"));
  });

  it("carries limits, modalities and the gateway base URL", () => {
    const catalog = parseModelInfo(MODEL_INFO_FIXTURE);
    const sonnet = findModel(catalog, "claude-sonnet");
    assert.equal(sonnet.provider, KHAL_PROVIDER_ID);
    assert.equal(sonnet.baseUrl, KHAL_BASE_URL);
    assert.equal(sonnet.contextWindow, 200000);
    assert.equal(sonnet.maxTokens, 64000);
    assert.deepEqual(sonnet.input, ["text", "image"]);
    assert.equal(sonnet.reasoning, true);
    const flash = findModel(catalog, "deepseek-v4-flash");
    assert.deepEqual(flash.input, ["text"]);
    // Never advertise more output than the context window.
    assert.ok(flash.maxTokens <= flash.contextWindow);
  });

  it("pins the compat overrides a heterogeneous LiteLLM gateway needs", () => {
    const flash = findModel(parseModelInfo(MODEL_INFO_FIXTURE), "deepseek-v4-flash");
    assert.equal(flash.compat?.supportsDeveloperRole, false);
    assert.equal(flash.compat?.supportsStore, false);
    assert.equal(flash.compat?.maxTokensField, "max_tokens");
  });

  it("survives a drifted payload instead of throwing", () => {
    assert.deepEqual(parseModelInfo(undefined), []);
    assert.deepEqual(parseModelInfo({}), []);
    assert.deepEqual(parseModelInfo({ data: "nope" }), []);
    const partial = parseModelInfo({ data: [{ model_name: "khal/mystery" }] });
    assert.equal(partial.length, 1);
    assert.equal(partial[0]?.cost.input, 0);
    assert.ok(partial[0]?.contextWindow > 0);
  });
});

describe("khal /v1/models fallback", () => {
  it("resolves models with cost 0 when pricing is unavailable", () => {
    const catalog = parseModelList(MODEL_LIST_FIXTURE);
    assert.equal(catalog.length, 2);
    const flash = findModel(catalog, "deepseek-v4-flash");
    assert.equal(flash.name, "khal/deepseek-v4-flash");
    assert.deepEqual(flash.cost, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});

/**
 * Network-shaped behaviour. `globalThis.fetch` is stubbed so these stay
 * offline; the key is set/unset per test because it is read lazily.
 */
describe("khal catalog fetch", () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.KHAL_API_KEY;
  const realAltKey = process.env.MIKRO_KHAL_API_KEY;
  let stderr: string;
  let restoreStderr: (() => void) | null = null;

  beforeEach(() => {
    resetKhalModelsCache();
    process.env.KHAL_API_KEY = "sk-test";
    delete process.env.MIKRO_KHAL_API_KEY;
    stderr = "";
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stderr.write;
    restoreStderr = () => {
      process.stderr.write = original;
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    restoreStderr?.();
    restoreStderr = null;
    if (realKey === undefined) delete process.env.KHAL_API_KEY;
    else process.env.KHAL_API_KEY = realKey;
    if (realAltKey === undefined) delete process.env.MIKRO_KHAL_API_KEY;
    else process.env.MIKRO_KHAL_API_KEY = realAltKey;
    resetKhalModelsCache();
  });

  function stubFetch(
    handler: (url: string) => { ok: boolean; status?: number; body?: unknown },
  ) {
    const seen: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      seen.push(url);
      const res = handler(url);
      return {
        ok: res.ok,
        status: res.status ?? (res.ok ? 200 : 503),
        json: async () => res.body,
      } as Response;
    }) as typeof fetch;
    return seen;
  }

  it("prices from /model/info when it answers", async () => {
    const seen = stubFetch(() => ({ ok: true, body: MODEL_INFO_FIXTURE }));
    const catalog = await fetchKhalModels();
    assert.equal(findModel(catalog, "deepseek-v4-flash").cost.input, 0.1);
    assert.equal(seen.length, 1);
    assert.ok(seen[0]?.endsWith("/model/info"));
    assert.equal(stderr, "");
  });

  it("degrades to /v1/models with cost 0 and one stderr warning on outage", async () => {
    const seen = stubFetch((url) =>
      url.endsWith("/model/info")
        ? { ok: false }
        : { ok: true, body: MODEL_LIST_FIXTURE },
    );
    const catalog = await fetchKhalModels();
    // Resolution is never blocked by the pricing endpoint being down.
    assert.equal(findModel(catalog, "deepseek-v4-flash").cost.input, 0);
    assert.deepEqual(seen.map((u) => u.replace(KHAL_BASE_URL, "")), [
      "/model/info",
      "/models",
    ]);
    assert.match(stderr, /khal \/model\/info unavailable/);
    assert.equal(stderr.trim().split("\n").length, 1);

    // ...and only one warning per process, however many models resolve.
    await fetchKhalModels();
    assert.equal(stderr.trim().split("\n").length, 1);
  });

  it("reports both endpoints when neither answers, never claiming a fallback", async () => {
    stubFetch(() => ({ ok: false }));
    assert.deepEqual(await fetchKhalModels(), []);
    // The old warning said "models resolve from /v1/models with cost 0" before
    // /v1/models had been tried — false whenever the fallback also failed.
    assert.doesNotMatch(stderr, /models resolve from/);
    assert.match(
      stderr,
      /khal catalog refresh failed \(\/model\/info: HTTP 503; \/models: HTTP 503\)/,
    );
    assert.equal(stderr.trim().split("\n").length, 1);
  });

  it("does not claim a fallback that answered with an empty payload", async () => {
    stubFetch((url) =>
      url.endsWith("/model/info") ? { ok: false } : { ok: true, body: { data: [] } },
    );
    assert.deepEqual(await fetchKhalModels(), []);
    assert.doesNotMatch(stderr, /models resolve from/);
    assert.match(stderr, /\/models: empty payload/);
  });

  it("fails naming the credential when the gateway rejects the key", async () => {
    const seen = stubFetch(() => ({ ok: false, status: 401 }));
    await assert.rejects(fetchKhalModels(), (err: Error) => {
      assert.match(err.message, /^khal gateway rejected KHAL_API_KEY \(HTTP 401\)/);
      return true;
    });
    // No fallback attempt: /models answers the same 401. Treating a rejected
    // key as an outage is exactly what produced the misleading "unknown model".
    assert.deepEqual(seen.map((u) => u.replace(KHAL_BASE_URL, "")), ["/model/info"]);
    assert.equal(stderr, "", "a rejected key is not a pricing warning");
  });

  it("names MIKRO_KHAL_API_KEY when the fallback env var supplied the key", async () => {
    delete process.env.KHAL_API_KEY;
    process.env.MIKRO_KHAL_API_KEY = "sk-fallback";
    stubFetch(() => ({ ok: false, status: 403 }));
    await assert.rejects(
      fetchKhalModels(),
      /khal gateway rejected MIKRO_KHAL_API_KEY \(HTTP 403\)/,
    );
  });

  it("treats a rejected key on the fallback endpoint as auth, not outage", async () => {
    stubFetch((url) =>
      url.endsWith("/model/info") ? { ok: false, status: 404 } : { ok: false, status: 401 },
    );
    await assert.rejects(fetchKhalModels(), /khal gateway rejected KHAL_API_KEY \(HTTP 401\)/);
  });

  it("does not touch the network without a key", async () => {
    delete process.env.KHAL_API_KEY;
    const seen = stubFetch(() => ({ ok: true, body: MODEL_INFO_FIXTURE }));
    assert.deepEqual(await fetchKhalModels(), []);
    assert.deepEqual(seen, []);
  });
});

describe("ensureKhalModels — no-key guard", () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.KHAL_API_KEY;
  const realAltKey = process.env.MIKRO_KHAL_API_KEY;

  beforeEach(() => {
    resetKhalModelsCache();
    delete process.env.KHAL_API_KEY;
    delete process.env.MIKRO_KHAL_API_KEY;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.KHAL_API_KEY;
    else process.env.KHAL_API_KEY = realKey;
    if (realAltKey === undefined) delete process.env.MIKRO_KHAL_API_KEY;
    else process.env.MIKRO_KHAL_API_KEY = realAltKey;
    resetKhalModelsCache();
  });

  it("throws the exact message naming KHAL_API_KEY", async () => {
    const models = builtinModels();
    registerKhalProvider(models);
    await assert.rejects(
      () => ensureKhalModels(models),
      (err: Error) => {
        assert.equal(err.message, KHAL_MISSING_KEY_ERROR);
        assert.equal(err.message, "khal provider requires KHAL_API_KEY");
        return true;
      },
    );
  });

  it("throws before any network call — the guard precedes resolution", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error("unreachable");
    }) as typeof fetch;
    const models = builtinModels();
    registerKhalProvider(models);
    await assert.rejects(() => ensureKhalModels(models), /khal provider requires KHAL_API_KEY/);
    assert.equal(called, false, "no key must mean no request");
  });

  it("accepts the MIKRO_KHAL_API_KEY fallback, and reports which var it used", () => {
    assert.equal(khalApiKey(), undefined);
    assert.equal(khalApiKeySource(), undefined);
    process.env.MIKRO_KHAL_API_KEY = "sk-fallback";
    assert.equal(khalApiKey(), "sk-fallback");
    // Failure messages name this, so an operator is not sent to the wrong var.
    assert.equal(khalApiKeySource(), "MIKRO_KHAL_API_KEY");
    process.env.KHAL_API_KEY = "sk-primary";
    assert.equal(khalApiKey(), "sk-primary");
    assert.equal(khalApiKeySource(), "KHAL_API_KEY");
  });

  it("ignores a blank key", () => {
    process.env.KHAL_API_KEY = "   ";
    assert.equal(khalApiKey(), undefined);
  });
});

/**
 * The failure the no-key guard does *not* cover, and the likelier one once the
 * key has been rotated: the key is present and the gateway rejects it. Both
 * endpoints answer 401, so the pre-fix code degraded to an empty catalog and
 * the run died as `Unknown model "deepseek-v4-flash" for provider "khal"` —
 * the exact surface wish decision 2 exists to prevent.
 */
describe("ensureKhalModels — rejected key and dead gateway", () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.KHAL_API_KEY;
  const realAltKey = process.env.MIKRO_KHAL_API_KEY;
  let restoreStderr: (() => void) | null = null;

  beforeEach(() => {
    resetKhalModelsCache();
    process.env.KHAL_API_KEY = "sk-totally-invalid-key";
    delete process.env.MIKRO_KHAL_API_KEY;
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    restoreStderr = () => {
      process.stderr.write = original;
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    restoreStderr?.();
    restoreStderr = null;
    if (realKey === undefined) delete process.env.KHAL_API_KEY;
    else process.env.KHAL_API_KEY = realKey;
    if (realAltKey === undefined) delete process.env.MIKRO_KHAL_API_KEY;
    else process.env.MIKRO_KHAL_API_KEY = realAltKey;
    resetKhalModelsCache();
  });

  function stubStatus(status: number, onCall?: () => void) {
    globalThis.fetch = (async () => {
      onCall?.();
      return { ok: false, status, json: async () => ({}) } as Response;
    }) as typeof fetch;
  }

  it("rejects naming the credential, not as an unknown model", async () => {
    stubStatus(401);
    const models = builtinModels();
    registerKhalProvider(models);
    await assert.rejects(
      () => ensureKhalModels(models),
      (err: Error) => {
        assert.match(err.message, /^khal gateway rejected KHAL_API_KEY \(HTTP 401\)/);
        assert.doesNotMatch(err.message, /[Uu]nknown model/);
        return true;
      },
    );
    // And resolution never got the chance to invent a different story.
    assert.equal(models.getModel(KHAL_PROVIDER_ID, "deepseek-v4-flash"), undefined);
  });

  it("does not memoize the rejection — a fixed key works without a restart", async () => {
    let calls = 0;
    stubStatus(401, () => {
      calls += 1;
    });
    const models = builtinModels();
    registerKhalProvider(models);
    await assert.rejects(() => ensureKhalModels(models), /khal gateway rejected/);

    globalThis.fetch = (async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => MODEL_INFO_FIXTURE } as Response;
    }) as typeof fetch;
    await ensureKhalModels(models);
    assert.equal(calls, 2, "the failed fetch must not be cached");
    assert.ok(models.getModel(KHAL_PROVIDER_ID, "deepseek-v4-flash"));
  });

  it("names both endpoints when the key is accepted but nothing resolves", async () => {
    stubStatus(503);
    const models = builtinModels();
    registerKhalProvider(models);
    await assert.rejects(
      () => ensureKhalModels(models),
      /khal catalog unavailable \(\/model\/info: HTTP 503; \/models: HTTP 503\) — no khal models to resolve/,
    );
  });
});

describe("ensureKhalModels — overlay + memoization", () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.KHAL_API_KEY;
  let restoreStderr: (() => void) | null = null;

  beforeEach(() => {
    resetKhalModelsCache();
    process.env.KHAL_API_KEY = "sk-test";
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    restoreStderr = () => {
      process.stderr.write = original;
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    restoreStderr?.();
    restoreStderr = null;
    if (realKey === undefined) delete process.env.KHAL_API_KEY;
    else process.env.KHAL_API_KEY = realKey;
    resetKhalModelsCache();
  });

  it("registers the fetched catalog so `khal/<id>` resolves", async () => {
    globalThis.fetch = (async () =>
      ({ ok: true, status: 200, json: async () => MODEL_INFO_FIXTURE }) as Response) as typeof fetch;
    const models = builtinModels();
    registerKhalProvider(models);
    // Nothing static: the provider serves nothing until the overlay lands.
    assert.equal(models.getModel(KHAL_PROVIDER_ID, "deepseek-v4-flash"), undefined);

    await ensureKhalModels(models);
    const flash = models.getModel(KHAL_PROVIDER_ID, "deepseek-v4-flash");
    assert.ok(flash, "khal/deepseek-v4-flash must resolve after the overlay");
    assert.equal(flash?.cost.input, 0.1);
  });

  it("fetches once for concurrent callers, and resets on the test seam", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => MODEL_INFO_FIXTURE } as Response;
    }) as typeof fetch;
    const models = builtinModels();
    registerKhalProvider(models);

    await Promise.all([ensureKhalModels(models), ensureKhalModels(models)]);
    assert.equal(calls, 1);
    await ensureKhalModels(models);
    assert.equal(calls, 1, "memoized after the first success");

    resetKhalModelsCache();
    await ensureKhalModels(models);
    assert.equal(calls, 2, "the reset seam must force a refetch");
  });

  it("serves every runtime that asks from the one memoized fetch", async () => {
    // src/llm.ts and src/sdk/rlm-driver.ts each own a Models runtime. The memo
    // holds the catalog, not the act of applying it — memoizing the side
    // effect leaves the second runtime empty, i.e. "unknown model".
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => MODEL_INFO_FIXTURE } as Response;
    }) as typeof fetch;
    const cli = builtinModels();
    const sdk = builtinModels();
    registerKhalProvider(cli);
    registerKhalProvider(sdk);

    await ensureKhalModels(cli);
    await ensureKhalModels(sdk);
    assert.equal(calls, 1, "one fetch, shared");
    assert.ok(cli.getModel(KHAL_PROVIDER_ID, "deepseek-v4-flash"));
    assert.ok(sdk.getModel(KHAL_PROVIDER_ID, "deepseek-v4-flash"));
  });

  it("leaves a previously applied catalog intact when a later fetch fails", async () => {
    globalThis.fetch = (async () =>
      ({ ok: true, status: 200, json: async () => MODEL_INFO_FIXTURE }) as Response) as typeof fetch;
    const models = builtinModels();
    registerKhalProvider(models);
    await ensureKhalModels(models);

    resetKhalModelsCache();
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    await ensureKhalModels(models);
    assert.ok(
      models.getModel(KHAL_PROVIDER_ID, "deepseek-v4-flash"),
      "an outage must not un-resolve models that already resolved",
    );
  });
});

describe("khalProvider — registration", () => {
  it("registers a first-class `khal` provider on a Models runtime", () => {
    const models = builtinModels();
    registerKhalProvider(models);
    const provider = models.getProvider(KHAL_PROVIDER_ID);
    assert.ok(provider, "khal provider should be registered");
    assert.equal(provider?.baseUrl, KHAL_BASE_URL);
    assert.deepEqual(provider?.getModels(), []);
  });

  it("targets the gateway's /v1 base URL", () => {
    assert.match(KHAL_BASE_URL, /\/v1$/);
  });

  it("resolves auth from KHAL_API_KEY, and reports unconfigured without it", async () => {
    const auth = khalProvider().auth.apiKey;
    assert.ok(auth);
    // pi-ai resolves env through `ctx.env`, not process.env directly.
    const ctx = (env: Record<string, string>) =>
      ({ env: async (name: string) => env[name] }) as never;

    assert.equal(await auth.resolve({ ctx: ctx({}), credential: undefined }), undefined);
    assert.deepEqual(
      await auth.resolve({ ctx: ctx({ KHAL_API_KEY: "sk-primary" }), credential: undefined }),
      { auth: { apiKey: "sk-primary" }, source: "KHAL_API_KEY" },
    );
    assert.deepEqual(
      await auth.resolve({
        ctx: ctx({ MIKRO_KHAL_API_KEY: "sk-fallback" }),
        credential: undefined,
      }),
      { auth: { apiKey: "sk-fallback" }, source: "MIKRO_KHAL_API_KEY" },
    );
  });

  it("serves a supplied catalog so gateway models resolve", () => {
    const models = builtinModels();
    models.setProvider(khalProvider(parseModelInfo(MODEL_INFO_FIXTURE)));
    assert.ok(models.getModel(KHAL_PROVIDER_ID, "claude-sonnet"));
    assert.ok(models.getModel(KHAL_PROVIDER_ID, "deepseek-v4-flash"));
  });

  it("sends the gateway alias on the wire, not the catalog id", async () => {
    // The catalog must be keyed by the bare id (every mikro path strips the
    // `khal/` prefix before lookup) but LiteLLM 400s on a bare model name, so
    // the transport has to put the alias back. Regression guard for both.
    const realFetch = globalThis.fetch;
    let sentModel: unknown;
    globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
      sentModel = JSON.parse(String(init?.body ?? "{}")).model;
      return new Response("nope", { status: 503 });
    }) as typeof fetch;
    try {
      const models = builtinModels();
      models.setProvider(khalProvider(parseModelInfo(MODEL_INFO_FIXTURE)));
      const model = models.getModel(KHAL_PROVIDER_ID, "deepseek-v4-flash");
      assert.ok(model);
      const stream = models
        .getProvider(KHAL_PROVIDER_ID)
        ?.streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, {
          apiKey: "sk-test",
        });
      assert.ok(stream);
      // Drain: the request fails (503), but the body was already captured.
      for await (const _event of stream) {
        // no-op
      }
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(sentModel, "khal/deepseek-v4-flash");
  });
});

/**
 * Station must be untouched by any of this — the two gateways share the seam,
 * not the state.
 */
describe("station is unaffected", () => {
  it("still resolves its baseline alongside a registered khal provider", async () => {
    const { registerStationProvider, STATION_PROVIDER_ID } = await import(
      "../src/station-provider.js"
    );
    const models = builtinModels();
    registerStationProvider(models);
    registerKhalProvider(models);
    assert.ok(models.getModel(STATION_PROVIDER_ID, "qwen3.6-moe-35b-a3b-FLM"));
    assert.ok(models.getProvider(KHAL_PROVIDER_ID));
  });
});
