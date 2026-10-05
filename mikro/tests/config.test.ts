import { describe, it } from "node:test";
import type { MikroConfig } from "../src/config.js";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyModelRef,
  applyTemperatureOverride,
  loadConfig,
  parseModelRef,
  parseTemperatureFlag,
  parseToolsMd,
} from "../src/config.js";

/** Helper: create .mikro/ dir with mikro.yaml content */
async function makeConfig(dir: string, yamlContent: string): Promise<void> {
  const mikroDir = join(dir, ".mikro");
  await mkdir(mikroDir, { recursive: true });
  await writeFile(join(mikroDir, "mikro.yaml"), yamlContent);
}

describe("YAML config loading", () => {
  let dir: string;

  it("loads valid .mikro/mikro.yaml with all fields", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    await makeConfig(dir, `model:
  provider: openai
  model: gpt-4
  sub-call-model: gpt-3.5-turbo
tools:
  greet: |
    def greet(name):
        return f"Hello {name}"
context:
  extensions: [.md, .txt]
  exclude: [node_modules, dist]
budget:
  max-cost: 1.5
  max-tokens: 50000
  max-depth: 3
tools-level: standard
`);
    const cfg = await loadConfig(dir);
    assert.equal(cfg.model.provider, "openai");
    assert.equal(cfg.model.model, "gpt-4");
    assert.equal(cfg.model.subCallModel, "gpt-3.5-turbo");
    assert.deepEqual(cfg.contextConfig.extensions, [".md", ".txt"]);
    assert.equal(cfg.budget.maxCost, 1.5);
    assert.equal(cfg.budget.maxTokens, 50000);
    assert.equal(cfg.budget.maxDepth, 3);
    assert.equal(cfg.toolsLevel, "standard");
    assert.equal(cfg.configSource, "yaml");
    await rm(dir, { recursive: true });
  });

  it("auto-loads SYSTEM.md and CRITERIA.md from .mikro/", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    await makeConfig(dir, "model:\n  provider: google\n");
    await writeFile(join(dir, ".mikro", "SYSTEM.md"), "You are a helper.");
    await writeFile(join(dir, ".mikro", "CRITERIA.md"), "Be concise.");
    const cfg = await loadConfig(dir);
    assert.equal(cfg.system, "You are a helper.");
    assert.equal(cfg.criteria, "Be concise.");
    assert.equal(cfg.configSource, "yaml");
    await rm(dir, { recursive: true });
  });

  it("auto-loads TOOLS.md from .mikro/", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    await makeConfig(dir, "model:\n  provider: google\n");
    await writeFile(join(dir, ".mikro", "TOOLS.md"), "## greet\n```python\ndef greet(name):\n    return f\"Hello {name}\"\n```\n");
    const cfg = await loadConfig(dir);
    assert.equal(cfg.tools.length, 1);
    assert.equal(cfg.tools[0].name, "greet");
    await rm(dir, { recursive: true });
  });

  /**
   * `VALIDATE.md` is loaded by convention, like SYSTEM/CRITERIA/TOOLS — no
   * mikro.yaml key turns it on. The three cases below are the whole contract:
   * a readable schema arrives parsed, and *both* failure modes (no file, bad
   * file) collapse to `null` without throwing. The malformed case is the one
   * that matters: a typo in a markdown file must not take the pack off the
   * air, and it must not be enforced as a half-read contract either.
   */
  describe("VALIDATE.md auto-load", () => {
    it("parses the schema when .mikro/VALIDATE.md is present", async () => {
      dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
      await makeConfig(dir, "model:\n  provider: google\n");
      await writeFile(
        join(dir, ".mikro", "VALIDATE.md"),
        '# Done payload\n\n```json\n{\n  "type": "object",\n  "required": ["summary"],\n  "properties": { "summary": { "type": "string" } }\n}\n```\n'
      );
      const cfg = await loadConfig(dir);
      assert.ok(cfg.validate, "VALIDATE.md should have been loaded");
      assert.equal(cfg.validate.schema.type, "object");
      assert.deepEqual(cfg.validate.schema.required, ["summary"]);
      // The raw block rides along so the retry hint can quote it verbatim.
      assert.match(cfg.validate.rawBlock, /"summary"/);
      await rm(dir, { recursive: true });
    });

    it("is null when the pack ships no VALIDATE.md", async () => {
      dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
      await makeConfig(dir, "model:\n  provider: google\n");
      const cfg = await loadConfig(dir);
      assert.equal(cfg.validate, null);
      await rm(dir, { recursive: true });
    });

    it("is null — not a throw — when the file is malformed", async () => {
      for (const body of [
        "# Broken\n\n```json\n{ not json at all,\n```\n", // fenced but unparseable
        "# Empty\n\nNo fenced block here at all.\n", // no block
        "```json\n\n```\n", // empty block
      ]) {
        dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
        await makeConfig(dir, "model:\n  provider: google\n");
        await writeFile(join(dir, ".mikro", "VALIDATE.md"), body);
        const cfg = await loadConfig(dir);
        assert.equal(cfg.validate, null, `expected null for ${JSON.stringify(body)}`);
        // The rest of the config must still have loaded normally.
        assert.equal(cfg.configSource, "yaml");
        await rm(dir, { recursive: true });
      }
    });

    it("leaves the defaults branch (no mikro.yaml) unchanged", async () => {
      // The defaults branch reads no files. A VALIDATE.md next to a
      // non-existent mikro.yaml is not a pack, and must not become one.
      dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
      await mkdir(join(dir, ".mikro"), { recursive: true });
      await writeFile(
        join(dir, ".mikro", "VALIDATE.md"),
        '```json\n{ "type": "object" }\n```\n'
      );
      const cfg = await loadConfig(dir);
      assert.equal(cfg.configSource, "defaults");
      assert.equal(cfg.validate, null);
      await rm(dir, { recursive: true });
    });
  });

  it("loads minimal .mikro/mikro.yaml with defaults", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    await makeConfig(dir, "model:\n  provider: anthropic\n");
    const cfg = await loadConfig(dir);
    assert.equal(cfg.model.provider, "anthropic");
    assert.equal(cfg.toolsLevel, "core");
    assert.equal(cfg.budget.maxCost, null);
    assert.equal(cfg.configSource, "yaml");
    await rm(dir, { recursive: true });
  });

  it("returns defaults when no .mikro/ exists", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    const cfg = await loadConfig(dir);
    assert.equal(cfg.model.provider, "google");
    assert.equal(cfg.configSource, "defaults");
    await rm(dir, { recursive: true });
  });

  it("ignores root mikro.yaml (only .mikro/ is checked)", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    await writeFile(join(dir, "mikro.yaml"), "model:\n  provider: openai\n");
    const cfg = await loadConfig(dir);
    // Root mikro.yaml should be ignored — defaults returned
    assert.equal(cfg.model.provider, "google");
    assert.equal(cfg.configSource, "defaults");
    await rm(dir, { recursive: true });
  });

  it("throws on invalid YAML", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    await makeConfig(dir, "model: [\ninvalid yaml");
    await assert.rejects(() => loadConfig(dir), /Invalid YAML/);
    await rm(dir, { recursive: true });
  });

  it("rejects invalid tools-level", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    await makeConfig(dir, "tools-level: mega\n");
    await assert.rejects(() => loadConfig(dir), /Invalid tools-level/);
    await rm(dir, { recursive: true });
  });

  it("ignores the removed rtk config section, including legacy always mode", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    for (const enabled of ["auto", "always", "never", "banana"]) {
      await makeConfig(dir, `rtk:\n  enabled: ${enabled}\n`);
      const cfg = await loadConfig(dir);
      assert.equal("rtk" in cfg, false);
      assert.equal(cfg.configSource, "yaml");
    }
    await rm(dir, { recursive: true });
  });

  it("does not include removed integration settings in defaults", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    const cfg = await loadConfig(dir);
    assert.equal("rtk" in cfg, false);
    assert.equal(cfg.configSource, "defaults");
    await rm(dir, { recursive: true });
  });

  it("defaults prompt.append-stop-protocol to true when mikro.yaml omits it", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    await makeConfig(dir, "model:\n  provider: anthropic\n");
    const cfg = await loadConfig(dir);
    assert.ok(cfg.prompt);
    assert.equal(cfg.prompt.appendStopProtocol, true);
    await rm(dir, { recursive: true });
  });

  it("accepts prompt.append-stop-protocol: false", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    await makeConfig(dir, "prompt:\n  append-stop-protocol: false\n");
    const cfg = await loadConfig(dir);
    assert.ok(cfg.prompt);
    assert.equal(cfg.prompt.appendStopProtocol, false);
    await rm(dir, { recursive: true });
  });

  /**
   * A bare `append-stop-protocol:` key parses as YAML null. Null-as-unset is
   * the deliberate convention here — the agent.yaml parser (`parsePrompt` in
   * `src/sdk/agent-spec.ts`) treats null the same way — so
   * it falls back to the default rather than erroring.
   */
  it("treats a null prompt.append-stop-protocol as unset (default true)", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    await makeConfig(dir, "prompt:\n  append-stop-protocol:\n");
    const cfg = await loadConfig(dir);
    assert.ok(cfg.prompt);
    assert.equal(cfg.prompt.appendStopProtocol, true);
    await rm(dir, { recursive: true });
  });

  it("rejects a non-boolean prompt.append-stop-protocol", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    await makeConfig(dir, "prompt:\n  append-stop-protocol: banana\n");
    await assert.rejects(
      () => loadConfig(dir),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(
          err.message,
          /Invalid prompt\.append-stop-protocol in mikro\.yaml: must be true or false, got "banana"\./
        );
        return true;
      }
    );
    await rm(dir, { recursive: true });
  });

  it("default config (no yaml) sets prompt.appendStopProtocol to true", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    const cfg = await loadConfig(dir);
    assert.ok(cfg.prompt);
    assert.equal(cfg.prompt.appendStopProtocol, true);
    assert.equal(cfg.configSource, "defaults");
    await rm(dir, { recursive: true });
  });

  /**
   * Top-level `temperature:` — deliberately NOT under `gemini:`, because
   * pi-ai maps `temperature` on every api family and `gemini.thinking-level`
   * is the standing evidence of what that nesting costs a reader.
   */
  describe("temperature", () => {
    it("defaults to null when mikro.yaml omits it", async () => {
      dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
      await makeConfig(dir, "model:\n  provider: anthropic\n");
      const cfg = await loadConfig(dir);
      assert.equal(cfg.temperature, null);
      await rm(dir, { recursive: true });
    });

    it("default config (no yaml) leaves temperature null", async () => {
      dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
      const cfg = await loadConfig(dir);
      assert.equal(cfg.temperature, null);
      assert.equal(cfg.configSource, "defaults");
      await rm(dir, { recursive: true });
    });

    it("reads a value from the top level, not from under gemini:", async () => {
      dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
      await makeConfig(dir, "temperature: 0.7\ngemini:\n  thinking-level: low\n");
      const cfg = await loadConfig(dir);
      assert.equal(cfg.temperature, 0.7);
      await rm(dir, { recursive: true });
    });

    /**
     * The value the whole feature exists for, and the one every truthiness bug
     * eats. `temperature: 0` is greedy decoding — a real, deliberate pin — and
     * must survive the loader as `0`, never collapse to the unset `null`.
     */
    it("keeps an exact zero rather than collapsing it to unset", async () => {
      dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
      await makeConfig(dir, "temperature: 0\n");
      const cfg = await loadConfig(dir);
      assert.equal(cfg.temperature, 0);
      assert.notEqual(cfg.temperature, null);
      await rm(dir, { recursive: true });
    });

    it("accepts both ends of the range", async () => {
      for (const value of [0, 1, 2]) {
        dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
        await makeConfig(dir, `temperature: ${value}\n`);
        const cfg = await loadConfig(dir);
        assert.equal(cfg.temperature, value);
        await rm(dir, { recursive: true });
      }
    });

    it("treats a null temperature as unset", async () => {
      dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
      await makeConfig(dir, "temperature:\n");
      const cfg = await loadConfig(dir);
      assert.equal(cfg.temperature, null);
      await rm(dir, { recursive: true });
    });

    it("rejects a temperature above the ceiling", async () => {
      dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
      await makeConfig(dir, "temperature: 2.5\n");
      await assert.rejects(
        () => loadConfig(dir),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(
            err.message,
            /Invalid temperature in mikro\.yaml: must be a number between 0 and 2, got 2\.5\./
          );
          return true;
        }
      );
      await rm(dir, { recursive: true });
    });

    it("rejects a negative temperature", async () => {
      dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
      await makeConfig(dir, "temperature: -1\n");
      await assert.rejects(() => loadConfig(dir), /Invalid temperature in mikro\.yaml/);
      await rm(dir, { recursive: true });
    });

    /**
     * The yaml surface never sees a numeric-prefix string as a number: YAML
     * parses `1oops` as the string `"1oops"`, and the check is `typeof value
     * === "number"`, so the `--temperature` trailing-junk trap cannot reach it.
     * Locked here so a future "be lenient, coerce strings" change has to fail
     * a test rather than quietly re-open it.
     */
    it("rejects a numeric-prefix string temperature", async () => {
      for (const raw of ["1oops", "0.5.3"]) {
        dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
        await makeConfig(dir, `temperature: ${raw}\n`);
        await assert.rejects(
          () => loadConfig(dir),
          /Invalid temperature in mikro\.yaml/,
          `expected "${raw}" to be rejected`
        );
        await rm(dir, { recursive: true });
      }
    });

    it("rejects a non-number temperature", async () => {
      dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
      await makeConfig(dir, "temperature: hot\n");
      await assert.rejects(
        () => loadConfig(dir),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /Invalid temperature in mikro\.yaml/);
          assert.match(err.message, /got "hot"\./);
          return true;
        }
      );
      await rm(dir, { recursive: true });
    });
  });
});

/**
 * `--temperature` arrives as a *string* (`parseArgs` types it that way), so the
 * flag surface owns a parse step the yaml surface does not. `NaN` is the trap:
 * `Number.parseFloat("hot")` is NaN, and NaN fails every `<`/`>` comparison, so
 * a range check alone would report it as "not out of range" and let it through.
 */
describe("parseTemperatureFlag", () => {
  it("returns null for an absent flag", () => {
    assert.equal(parseTemperatureFlag(undefined), null);
    assert.equal(parseTemperatureFlag(null), null);
  });

  it("rejects an empty or whitespace-only value rather than reading it as unset", () => {
    // `Number("")` and `Number("   ")` are both `0`, so without an explicit
    // reject `--temperature ""` would silently pin greedy decoding.
    for (const raw of ["", " ", "\t"]) {
      assert.throws(
        () => parseTemperatureFlag(raw),
        /--temperature must be a number/,
        `expected ${JSON.stringify(raw)} to be rejected`
      );
    }
  });

  it("rejects a numeric prefix followed by trailing junk", () => {
    // `Number.parseFloat` stops at the first character it cannot read, so these
    // would otherwise parse as 1 / 0.5 / 2 and run at a temperature nobody asked for.
    for (const raw of ["1oops", "0.5.3", "2deg", "0 7", "1,5"]) {
      assert.throws(
        () => parseTemperatureFlag(raw),
        /--temperature must be a number/,
        `expected "${raw}" to be rejected`
      );
    }
  });

  it("still accepts a value padded with surrounding whitespace", () => {
    assert.equal(parseTemperatureFlag(" 0.7 "), 0.7);
  });

  it("parses the string form of an exact zero", () => {
    assert.equal(parseTemperatureFlag("0"), 0);
    assert.equal(parseTemperatureFlag("0.0"), 0);
  });

  it("parses fractional and boundary values", () => {
    assert.equal(parseTemperatureFlag("0.7"), 0.7);
    assert.equal(parseTemperatureFlag("1"), 1);
    assert.equal(parseTemperatureFlag("2"), 2);
  });

  it("rejects a non-numeric value and quotes what it got", () => {
    assert.throws(
      () => parseTemperatureFlag("hot"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /--temperature must be a number between 0 and 2/);
        assert.match(err.message, /got "hot"/);
        return true;
      }
    );
  });

  it("rejects NaN and Infinity rather than passing the range check", () => {
    for (const raw of ["NaN", "Infinity", "-Infinity"]) {
      assert.throws(
        () => parseTemperatureFlag(raw),
        /--temperature must be a number/,
        `expected "${raw}" to be rejected`
      );
    }
  });

  it("rejects out-of-range values at both ends", () => {
    assert.throws(() => parseTemperatureFlag("-0.1"), /--temperature must be a number/);
    assert.throws(() => parseTemperatureFlag("2.1"), /--temperature must be a number/);
  });
});

/**
 * The apply step the CLI runs after parsing. Its whole job is the `!= null`
 * guard: `if (temperature)` would drop `--temperature 0`, which is the value
 * anyone pinning sampling drift reaches for first.
 */
describe("applyTemperatureOverride", () => {
  const loaded = (temperature: number | null): MikroConfig =>
    ({ temperature }) as unknown as MikroConfig;

  it("applies an exact zero over an unset config", () => {
    const config = loaded(null);
    applyTemperatureOverride(config, parseTemperatureFlag("0"));
    assert.equal(config.temperature, 0);
  });

  it("applies an exact zero over a non-zero mikro.yaml value", () => {
    const config = loaded(1.5);
    applyTemperatureOverride(config, parseTemperatureFlag("0"));
    assert.equal(config.temperature, 0);
  });

  it("outranks the yaml value for ordinary temperatures too", () => {
    const config = loaded(1.5);
    applyTemperatureOverride(config, 0.2);
    assert.equal(config.temperature, 0.2);
  });

  it("leaves the config alone when the flag is absent", () => {
    const config = loaded(1.5);
    applyTemperatureOverride(config, null);
    assert.equal(config.temperature, 1.5);
    applyTemperatureOverride(config, undefined);
    assert.equal(config.temperature, 1.5);
  });
});

describe("parseToolsMd", () => {
  it("extracts tools from markdown format", () => {
    const md = `## greet\n\`\`\`python\ndef greet(name):\n    return f"Hello {name}"\n\`\`\`\n\n## farewell\n\`\`\`python\ndef farewell():\n    return "Goodbye"\n\`\`\``;
    const tools = parseToolsMd(md);
    assert.equal(tools.length, 2);
    assert.equal(tools[0].name, "greet");
    assert.ok(tools[0].code.includes("def greet"));
    assert.equal(tools[1].name, "farewell");
  });
});

describe("parseModelRef", () => {
  it("splits on the first slash only", () => {
    assert.deepEqual(parseModelRef("khal/deepseek-v4-flash"), { provider: "khal", model: "deepseek-v4-flash" });
    assert.deepEqual(parseModelRef("openrouter/meta/llama-4"), { provider: "openrouter", model: "meta/llama-4" });
  });

  it("returns null when there is no usable provider prefix", () => {
    assert.equal(parseModelRef("deepseek-v4-flash"), null);
    assert.equal(parseModelRef("/leading"), null);
    assert.equal(parseModelRef("trailing/"), null);
    assert.equal(parseModelRef(""), null);
  });
});

/**
 * Every model switch re-pins the sub-call model. Keeping the previous
 * provider's `sub-call-model` is what made a bare `llm_query()` fail with
 * `Unknown model "<inherited>" for provider "<new>"`.
 */
describe("applyModelRef", () => {
  const base = { provider: "google", model: "gemini-3.1-flash-lite-preview", subCallModel: "gemini-3.1-flash-lite-preview" };

  it("switches provider, model and sub-call model together", () => {
    assert.deepEqual(applyModelRef(base, "khal/deepseek-v4-flash"), {
      provider: "khal",
      model: "deepseek-v4-flash",
      subCallModel: "deepseek-v4-flash",
    });
  });

  it("keeps the configured provider for a bare model id", () => {
    assert.deepEqual(applyModelRef(base, "gemini-3.1-pro"), {
      provider: "google",
      model: "gemini-3.1-pro",
      subCallModel: "gemini-3.1-pro",
    });
  });

  it("trims surrounding whitespace and ignores an empty reference", () => {
    assert.equal(applyModelRef(base, "  khal/deepseek-v4-flash  ").model, "deepseek-v4-flash");
    assert.deepEqual(applyModelRef(base, "   "), base);
  });

  it("returns a new object rather than mutating the input", () => {
    const input = { ...base };
    applyModelRef(input, "khal/deepseek-v4-flash");
    assert.deepEqual(input, base);
  });
});
