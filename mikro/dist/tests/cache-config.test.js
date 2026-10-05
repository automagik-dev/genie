import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";
/** Helper: create .mikro/ dir with mikro.yaml content */
async function makeConfig(dir, yamlContent) {
    const mikroDir = join(dir, ".mikro");
    await mkdir(mikroDir, { recursive: true });
    await writeFile(join(mikroDir, "mikro.yaml"), yamlContent);
}
describe("YAML cache config parsing", () => {
    let dir;
    it("returns default cache config when no cache section exists", async () => {
        dir = await mkdtemp(join(tmpdir(), "mikro-cache-cfg-"));
        await makeConfig(dir, "model:\n  provider: google\n");
        const cfg = await loadConfig(dir);
        assert.equal(cfg.cache.enabled, false);
        assert.equal(cfg.cache.strategy, "full");
        assert.equal(cfg.cache.retention, "long");
        assert.equal(cfg.cache.sessionPrefix, undefined);
        assert.equal(cfg.cache.ttl, undefined);
        assert.equal(cfg.cache.expireTime, undefined);
        await rm(dir, { recursive: true });
    });
    it("parses full cache config with all fields", async () => {
        dir = await mkdtemp(join(tmpdir(), "mikro-cache-cfg-"));
        await makeConfig(dir, `model:
  provider: anthropic
cache:
  enabled: true
  strategy: full
  session-prefix: my-project
  retention: short
  ttl: 3600
  expire-time: "2026-12-31T23:59:59Z"
`);
        const cfg = await loadConfig(dir);
        assert.equal(cfg.cache.enabled, true);
        assert.equal(cfg.cache.strategy, "full");
        assert.equal(cfg.cache.sessionPrefix, "my-project");
        assert.equal(cfg.cache.retention, "short");
        assert.equal(cfg.cache.ttl, 3600);
        assert.equal(cfg.cache.expireTime, "2026-12-31T23:59:59Z");
        await rm(dir, { recursive: true });
    });
    it("parses cache enabled: true", async () => {
        dir = await mkdtemp(join(tmpdir(), "mikro-cache-cfg-"));
        await makeConfig(dir, `model:
  provider: google
cache:
  enabled: true
`);
        const cfg = await loadConfig(dir);
        assert.equal(cfg.cache.enabled, true);
        await rm(dir, { recursive: true });
    });
    it("parses cache enabled: false explicitly", async () => {
        dir = await mkdtemp(join(tmpdir(), "mikro-cache-cfg-"));
        await makeConfig(dir, `model:
  provider: google
cache:
  enabled: false
`);
        const cfg = await loadConfig(dir);
        assert.equal(cfg.cache.enabled, false);
        await rm(dir, { recursive: true });
    });
    it("parses retention: short", async () => {
        dir = await mkdtemp(join(tmpdir(), "mikro-cache-cfg-"));
        await makeConfig(dir, `cache:
  retention: short
`);
        const cfg = await loadConfig(dir);
        assert.equal(cfg.cache.retention, "short");
        await rm(dir, { recursive: true });
    });
    it("parses retention: long", async () => {
        dir = await mkdtemp(join(tmpdir(), "mikro-cache-cfg-"));
        await makeConfig(dir, `cache:
  retention: long
`);
        const cfg = await loadConfig(dir);
        assert.equal(cfg.cache.retention, "long");
        await rm(dir, { recursive: true });
    });
    it("rejects invalid retention value", async () => {
        dir = await mkdtemp(join(tmpdir(), "mikro-cache-cfg-"));
        await makeConfig(dir, `cache:
  retention: medium
`);
        await assert.rejects(() => loadConfig(dir), /Invalid cache\.retention/);
        await rm(dir, { recursive: true });
    });
    it("rejects invalid strategy value", async () => {
        dir = await mkdtemp(join(tmpdir(), "mikro-cache-cfg-"));
        await makeConfig(dir, `cache:
  strategy: partial
`);
        await assert.rejects(() => loadConfig(dir), /Invalid cache\.strategy/);
        await rm(dir, { recursive: true });
    });
    it("parses TTL as a number", async () => {
        dir = await mkdtemp(join(tmpdir(), "mikro-cache-cfg-"));
        await makeConfig(dir, `cache:
  ttl: 7200
`);
        const cfg = await loadConfig(dir);
        assert.equal(cfg.cache.ttl, 7200);
        assert.equal(typeof cfg.cache.ttl, "number");
        await rm(dir, { recursive: true });
    });
    it("parses expire-time as ISO 8601 string", async () => {
        dir = await mkdtemp(join(tmpdir(), "mikro-cache-cfg-"));
        await makeConfig(dir, `cache:
  expire-time: "2026-06-15T12:00:00Z"
`);
        const cfg = await loadConfig(dir);
        assert.equal(cfg.cache.expireTime, "2026-06-15T12:00:00Z");
        await rm(dir, { recursive: true });
    });
    it("omits optional fields when not provided", async () => {
        dir = await mkdtemp(join(tmpdir(), "mikro-cache-cfg-"));
        await makeConfig(dir, `cache:
  enabled: true
`);
        const cfg = await loadConfig(dir);
        assert.equal(cfg.cache.enabled, true);
        assert.equal(cfg.cache.sessionPrefix, undefined);
        assert.equal(cfg.cache.ttl, undefined);
        assert.equal(cfg.cache.expireTime, undefined);
        await rm(dir, { recursive: true });
    });
    it("defaults cache config when no config files exist", async () => {
        dir = await mkdtemp(join(tmpdir(), "mikro-cache-cfg-"));
        const cfg = await loadConfig(dir);
        assert.equal(cfg.cache.enabled, false);
        assert.equal(cfg.cache.strategy, "full");
        assert.equal(cfg.cache.retention, "long");
        assert.equal(cfg.configSource, "defaults");
        await rm(dir, { recursive: true });
    });
    it("cache config coexists with other config sections", async () => {
        dir = await mkdtemp(join(tmpdir(), "mikro-cache-cfg-"));
        await makeConfig(dir, `model:
  provider: anthropic
  model: claude-sonnet-4-20250514
budget:
  max-cost: 2.0
cache:
  enabled: true
  retention: short
  ttl: 1800
  session-prefix: review
`);
        const cfg = await loadConfig(dir);
        assert.equal(cfg.cache.enabled, true);
        assert.equal(cfg.cache.retention, "short");
        assert.equal(cfg.cache.ttl, 1800);
        assert.equal(cfg.cache.sessionPrefix, "review");
        assert.equal(cfg.model.provider, "anthropic");
        assert.equal(cfg.budget.maxCost, 2.0);
        await rm(dir, { recursive: true });
    });
});
//# sourceMappingURL=cache-config.test.js.map