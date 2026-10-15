/**
 * `mikro migrate` (src/migrate.ts) and the legacy read-fallbacks that keep an
 * unmigrated checkout working until it runs.
 *
 * Everything runs inside a temp HOME and temp project roots — the real home
 * directory is never touched.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, readdir, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPlan, formatPlan, rewriteRcLine, scanLegacy } from "../src/migrate.js";
import { hasConfig, loadConfig } from "../src/config.js";
import { agentRoots } from "../src/mcp/agents.js";
async function writeJson(path, value) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}
async function readJson(path) {
    return JSON.parse(await readFile(path, "utf-8"));
}
function kinds(plan) {
    return plan.actions.map((a) => a.kind);
}
describe("mikro migrate — scan and apply", () => {
    let home;
    let work;
    before(async () => {
        home = await mkdtemp(join(tmpdir(), "mikro-mig-home-"));
        work = await mkdtemp(join(tmpdir(), "mikro-mig-work-"));
        // ~/.rlmx with settings and a stale checkout; no ~/.mikro yet
        await mkdir(join(home, ".rlmx", "rlmx"), { recursive: true });
        await writeJson(join(home, ".rlmx", "settings.json"), { "model.provider": "google" });
        // dangling legacy symlink
        await mkdir(join(home, ".local", "bin"), { recursive: true });
        await symlink(join(home, ".rlmx", "rlmx", "dist", "src", "cli.js"), join(home, ".local", "bin", "rlmx"));
        // Claude Code registration
        await writeJson(join(home, ".claude", "settings.json"), {
            enabledPlugins: { "genie@automagik": true, "rlmx@rlmx": true },
            extraKnownMarketplaces: { rlmx: { source: { source: "directory", path: join(home, ".rlmx", "rlmx") } } },
        });
        await writeJson(join(home, ".claude", "plugins", "known_marketplaces.json"), {
            rlmx: { source: { source: "directory", path: join(home, ".rlmx", "rlmx") }, installLocation: join(home, ".rlmx", "rlmx") },
        });
        await writeJson(join(home, ".claude", "plugins", "installed_plugins.json"), {
            version: 2,
            plugins: { "rlmx@rlmx": [{ scope: "user", installPath: join(home, ".claude", "plugins", "cache", "rlmx", "rlmx", "0.1.0"), version: "0.1.0" }] },
        });
        // shell rc mention
        await writeFile(join(home, ".bashrc"), "# comment about ~/.rlmx\nexport PYTHONPATH=$HOME/.rlmx/venv/lib\nexport RLMX_AGENTS_DIR=/x\n");
        // project A: legacy config dir + mcp.json + agents
        const a = join(work, "a");
        await mkdir(join(a, ".rlmx", "agents", "t"), { recursive: true });
        await writeFile(join(a, ".rlmx", "rlmx.yaml"), "model:\n  provider: google\n  model: gemini-3.1-flash-lite-preview\n");
        await writeFile(join(a, ".rlmx", "agents", "t", "agent.yaml"), "schema_version: 1\nshape: single-step\n");
        await writeJson(join(a, ".mcp.json"), {
            mcpServers: {
                rlmx: { command: "rlmx", args: ["mcp", "--dir", a] },
                other: { command: "node", args: ["x.js"] },
            },
        });
        // project B: already migrated, plus a leftover legacy dir
        const b = join(work, "b");
        await mkdir(join(b, ".mikro"), { recursive: true });
        await mkdir(join(b, ".rlmx"), { recursive: true });
        await writeFile(join(b, ".mikro", "mikro.yaml"), "model:\n  provider: google\n  model: g\n");
        // noise that must be skipped
        await mkdir(join(work, "node_modules", "pkg", ".rlmx"), { recursive: true });
        await mkdir(join(work, ".git", ".rlmx"), { recursive: true });
    });
    after(async () => {
        await rm(home, { recursive: true, force: true });
        await rm(work, { recursive: true, force: true });
    });
    it("plans every artifact type and skips node_modules/.git", async () => {
        const plan = await scanLegacy({ roots: [work], home, env: { RLMX_AGENTS_DIR: "/x" } });
        const k = kinds(plan);
        assert.ok(k.includes("migrate-home"), "home");
        assert.ok(k.includes("rename-config-dir"), "project config dir");
        assert.ok(k.includes("rewrite-mcp-json"), ".mcp.json");
        assert.ok(k.includes("remove-legacy-symlink"), "symlink");
        assert.equal(k.filter((x) => x === "rewrite-claude-plugin").length, 3, "three Claude files");
        const reports = plan.actions.filter((a) => a.reportOnly).map((a) => a.detail);
        assert.ok(reports.some((d) => d.includes(".bashrc:2")), "rc PYTHONPATH line reported");
        assert.ok(reports.some((d) => d.includes(".bashrc:3")), "rc RLMX_ line reported");
        assert.ok(!reports.some((d) => d.includes(".bashrc:1")), "comment lines are not reported");
        assert.ok(reports.some((d) => d.startsWith("env RLMX_AGENTS_DIR")), "env var reported");
        assert.ok(reports.some((d) => d.includes("b/.rlmx") && d.includes("shadowed")), "shadowed legacy dir reported");
        assert.ok(!plan.actions.some((a) => a.path.includes("node_modules") || a.path.includes("/.git/")), "noise skipped");
        const text = formatPlan(plan, home);
        assert.match(text, /mikro migrate — scanned/);
        assert.match(text, /\[rename-config-dir\]/);
        assert.match(text, /\[note\]/);
    });
    it("dry-run writes nothing", async () => {
        await scanLegacy({ roots: [work], home, env: {} });
        assert.ok((await lstat(join(work, "a", ".rlmx"))).isDirectory());
        assert.ok((await lstat(join(home, ".rlmx"))).isDirectory());
    });
    it("apply renames, rewrites with backups, and is idempotent", async () => {
        const plan = await scanLegacy({ roots: [work], home, env: {} });
        const done = await applyPlan(plan);
        assert.ok(done.length >= 6);
        // home
        assert.ok((await lstat(join(home, ".mikro", "settings.json"))).isFile());
        assert.ok((await lstat(join(home, ".mikro", "mikro"))).isDirectory(), "checkout renamed rlmx → mikro");
        await assert.rejects(lstat(join(home, ".rlmx")));
        // symlink
        await assert.rejects(lstat(join(home, ".local", "bin", "rlmx")));
        // project A
        assert.ok((await lstat(join(work, "a", ".mikro", "mikro.yaml"))).isFile());
        assert.ok((await lstat(join(work, "a", ".mikro", "agents", "t", "agent.yaml"))).isFile());
        await assert.rejects(lstat(join(work, "a", ".rlmx")));
        const mcp = await readJson(join(work, "a", ".mcp.json"));
        const servers = mcp.mcpServers;
        assert.equal(servers.rlmx, undefined);
        assert.equal(servers.mikro.command, "mikro");
        assert.deepEqual(servers.mikro.args, ["mcp", "--dir", join(work, "a")]);
        assert.equal(servers.other.command, "node", "unrelated servers untouched");
        const backups = (await readdir(join(work, "a"))).filter((f) => f.startsWith(".mcp.json.rlmx-backup-"));
        assert.equal(backups.length, 1, "one backup written");
        // Claude registration
        const settings = await readJson(join(home, ".claude", "settings.json"));
        assert.deepEqual(settings.enabledPlugins, { "genie@automagik": true, "mikro@mikro": true });
        assert.deepEqual(settings.extraKnownMarketplaces, { mikro: { source: { source: "directory", path: join(home, ".mikro", "mikro") } } });
        const known = await readJson(join(home, ".claude", "plugins", "known_marketplaces.json"));
        assert.equal(known.rlmx, undefined);
        assert.equal(known.mikro.installLocation, join(home, ".mikro", "mikro"));
        const installed = await readJson(join(home, ".claude", "plugins", "installed_plugins.json"));
        const plugins = installed.plugins;
        assert.equal(plugins["rlmx@rlmx"], undefined);
        assert.equal(plugins["mikro@mikro"][0].installPath, join(home, ".claude", "plugins", "cache", "mikro", "mikro", "0.1.0"));
        // second pass: only advice remains (rc lines, shadowed dir in B)
        const again = await scanLegacy({ roots: [work], home, env: {} });
        assert.ok(again.actions.every((a) => a.reportOnly), `left: ${kinds(again).join(",")}`);
    });
});
describe("mikro migrate --rc", () => {
    it("rewrites only the legacy tokens on a line", () => {
        assert.equal(rewriteRcLine('export PYTHONPATH="$HOME/.rlmx/venv/lib:$PYTHONPATH"'), 'export PYTHONPATH="$HOME/.mikro/venv/lib:$PYTHONPATH"');
        assert.equal(rewriteRcLine("export RLMX_AGENTS_DIR=~/.rlmx/agents"), "export MIKRO_AGENTS_DIR=~/.mikro/agents");
        assert.equal(rewriteRcLine("alias r=/home/u/.rlmx/rlmx/dist/src/cli.js"), "alias r=/home/u/.mikro/rlmx/dist/src/cli.js");
        assert.equal(rewriteRcLine("echo rlmx-unrelated .rlmxish"), "echo rlmx-unrelated .rlmxish", "no false positives");
    });
    it("rewrites rc files in place with a backup when --rc is given, comments untouched", async () => {
        const home = await mkdtemp(join(tmpdir(), "mikro-rc-home-"));
        try {
            await writeFile(join(home, ".zshrc"), "# see ~/.rlmx\nexport RLMX_X=1\nexport P=$HOME/.rlmx/venv\nexport KEEP=1\n");
            const plan = await scanLegacy({ roots: [], home, env: {}, rewriteRc: true });
            const rcActions = plan.actions.filter((a) => a.kind === "rewrite-rc");
            assert.equal(rcActions.length, 1);
            assert.match(rcActions[0].detail, /2 lines/);
            await applyPlan(plan);
            assert.equal(await readFile(join(home, ".zshrc"), "utf-8"), "# see ~/.rlmx\nexport MIKRO_X=1\nexport P=$HOME/.mikro/venv\nexport KEEP=1\n");
            assert.equal((await readdir(home)).filter((f) => f.startsWith(".zshrc.rlmx-backup-")).length, 1);
            const again = await scanLegacy({ roots: [], home, env: {}, rewriteRc: true });
            assert.equal(again.actions.filter((a) => a.kind === "rewrite-rc").length, 0, "idempotent");
        }
        finally {
            await rm(home, { recursive: true, force: true });
        }
    });
});
describe("legacy read-fallbacks", () => {
    let dir;
    before(async () => {
        dir = await mkdtemp(join(tmpdir(), "mikro-legacy-cfg-"));
        await mkdir(join(dir, ".rlmx"), { recursive: true });
        await writeFile(join(dir, ".rlmx", "rlmx.yaml"), "model:\n  provider: openai\n  model: gpt-4\n");
        await writeFile(join(dir, ".rlmx", "SYSTEM.md"), "legacy system\n");
    });
    after(async () => {
        await rm(dir, { recursive: true, force: true });
    });
    it("loadConfig reads .rlmx/rlmx.yaml (and its SYSTEM.md) when .mikro is absent", async () => {
        assert.equal(await hasConfig(dir), true);
        const cfg = await loadConfig(dir);
        assert.equal(cfg.configSource, "yaml");
        assert.equal(cfg.model.provider, "openai");
        assert.equal(cfg.system, "legacy system");
    });
    it(".mikro wins over .rlmx once both exist", async () => {
        await mkdir(join(dir, ".mikro"), { recursive: true });
        await writeFile(join(dir, ".mikro", "mikro.yaml"), "model:\n  provider: google\n  model: g\n");
        const cfg = await loadConfig(dir);
        assert.equal(cfg.model.provider, "google");
        assert.equal(cfg.system, null, "SYSTEM.md is read from the dir that supplied the yaml");
    });
    it("agentRoots scans legacy roots below their mikro counterparts and honours RLMX_AGENTS_DIR", () => {
        const savedM = process.env.MIKRO_AGENTS_DIR;
        const savedR = process.env.RLMX_AGENTS_DIR;
        try {
            delete process.env.MIKRO_AGENTS_DIR;
            delete process.env.RLMX_AGENTS_DIR;
            const roots = agentRoots("/w");
            assert.ok(roots.indexOf("/w/.rlmx/agents") < roots.indexOf("/w/.mikro/agents"));
            assert.ok(roots.includes("/w/.agents"));
            process.env.RLMX_AGENTS_DIR = "/legacy:/two";
            assert.deepEqual(agentRoots("/w"), ["/legacy", "/two"]);
            process.env.MIKRO_AGENTS_DIR = "/new";
            assert.deepEqual(agentRoots("/w"), ["/new"], "MIKRO_AGENTS_DIR outranks the alias");
        }
        finally {
            if (savedM === undefined)
                delete process.env.MIKRO_AGENTS_DIR;
            else
                process.env.MIKRO_AGENTS_DIR = savedM;
            if (savedR === undefined)
                delete process.env.RLMX_AGENTS_DIR;
            else
                process.env.RLMX_AGENTS_DIR = savedR;
        }
    });
});
//# sourceMappingURL=migrate.test.js.map