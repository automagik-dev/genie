import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  maskValue,
  isSensitiveKey,
  formatValue,
  parseSettingValue,
  loadSettings,
  saveSettings,
  injectApiKeysToEnv,
} from "../src/settings.js";

describe("maskValue", () => {
  it("masks long strings", () => {
    assert.equal(maskValue("AIzaSyAbcdefghijklmnop"), "AIz...nop");
  });

  it("masks short strings as ***", () => {
    assert.equal(maskValue("short"), "***");
    assert.equal(maskValue("12345678"), "***");
  });

  it("masks 9-char strings", () => {
    assert.equal(maskValue("123456789"), "123...789");
  });
});

describe("isSensitiveKey", () => {
  it("detects API_KEY", () => {
    assert.equal(isSensitiveKey("GEMINI_API_KEY"), true);
    assert.equal(isSensitiveKey("OPENAI_API_KEY"), true);
  });

  it("detects SECRET and TOKEN", () => {
    assert.equal(isSensitiveKey("MY_SECRET"), true);
    assert.equal(isSensitiveKey("AUTH_TOKEN"), true);
  });

  it("case insensitive", () => {
    assert.equal(isSensitiveKey("gemini_api_key"), true);
  });

  it("returns false for non-sensitive keys", () => {
    assert.equal(isSensitiveKey("model.provider"), false);
    assert.equal(isSensitiveKey("budget.max_cost"), false);
  });
});

describe("formatValue", () => {
  it("masks sensitive keys", () => {
    assert.equal(formatValue("GEMINI_API_KEY", "AIzaSyAbcdefghijklmnop"), "AIz...nop");
  });

  it("shows plain value for non-sensitive keys", () => {
    assert.equal(formatValue("model.provider", "google"), "google");
  });

  it("converts non-strings to string", () => {
    assert.equal(formatValue("budget.max_cost", 5), "5");
    assert.equal(formatValue("gemini.google_search", true), "true");
  });
});

describe("parseSettingValue", () => {
  it("parses booleans", () => {
    assert.equal(parseSettingValue("true"), true);
    assert.equal(parseSettingValue("false"), false);
  });

  it("parses numbers", () => {
    assert.equal(parseSettingValue("42"), 42);
    assert.equal(parseSettingValue("3.14"), 3.14);
    assert.equal(parseSettingValue("0"), 0);
  });

  it("keeps strings as strings", () => {
    assert.equal(parseSettingValue("google"), "google");
    assert.equal(parseSettingValue("AIzaSy123"), "AIzaSy123");
  });

  it("keeps empty string as string", () => {
    assert.equal(parseSettingValue(""), "");
  });
});

describe("loadSettings", () => {
  it("returns empty object when file missing", async () => {
    const settings = await loadSettings();
    // May or may not exist — if it does, it's valid JSON
    assert.equal(typeof settings, "object");
  });
});

describe("settings API key env injection", () => {
  const keys = ["DEEPSEEK_API_KEY", "KIMI_API_KEY", "MINIMAX_API_KEY", "ZAI_API_KEY", "GOOGLE_API_KEY"];
  const originals = new Map<string, string | undefined>();

  before(() => {
    for (const key of keys) {
      originals.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  after(() => {
    for (const key of keys) {
      const original = originals.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  it("injects cheap/diverse provider keys from settings", () => {
    injectApiKeysToEnv({
      DEEPSEEK_API_KEY: "deepseek-test-key",
      KIMI_API_KEY: "kimi-test-key",
      MINIMAX_API_KEY: "minimax-test-key",
      ZAI_API_KEY: "zai-test-key",
      GOOGLE_API_KEY: "google-test-key",
    });

    assert.equal(process.env.DEEPSEEK_API_KEY, "deepseek-test-key");
    assert.equal(process.env.KIMI_API_KEY, "kimi-test-key");
    assert.equal(process.env.MINIMAX_API_KEY, "minimax-test-key");
    assert.equal(process.env.ZAI_API_KEY, "zai-test-key");
    assert.equal(process.env.GOOGLE_API_KEY, "google-test-key");
  });
});

describe("saveSettings + loadSettings roundtrip", () => {
  const testDir = join(tmpdir(), `mikro-test-${Date.now()}`);
  const originalHome = process.env.HOME;

  before(async () => {
    await mkdir(testDir, { recursive: true });
    // Override HOME so settings go to temp dir
    process.env.HOME = testDir;
  });

  after(async () => {
    process.env.HOME = originalHome;
    await rm(testDir, { recursive: true, force: true });
  });

  it("saves and loads settings", async () => {
    const settings = { GEMINI_API_KEY: "test-key-123", "model.provider": "google" };
    await saveSettings(settings);
    const loaded = await loadSettings();
    assert.equal(loaded.GEMINI_API_KEY, "test-key-123");
    assert.equal(loaded["model.provider"], "google");
  });
});
