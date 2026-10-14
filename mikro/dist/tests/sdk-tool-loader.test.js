import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createToolRegistry, InvalidPluginError, loadPluginTools, MissingPluginError, } from "../src/sdk/index.js";
import { resolvePluginPath } from "../src/sdk/tool-loader.js";
async function writePlugin(dir, name, body, ext = ".mjs") {
    const toolsDir = join(dir, "tools");
    await mkdir(toolsDir, { recursive: true });
    const file = join(toolsDir, `${name}${ext}`);
    await writeFile(file, body, "utf8");
    return file;
}
async function writeSchema(dir, name, contents) {
    const path = join(dir, "tools", `${name}.schema.json`);
    await writeFile(path, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
    return path;
}
function specFor(dir, tools) {
    return {
        dir,
        schemaVersion: 1,
        toolsApi: 1,
        shape: "single-step",
        tools,
        extras: {},
    };
}
describe("loadPluginTools — TS plugin loader (G3a, .mjs/.js only)", () => {
    let root = "";
    before(async () => {
        root = await mkdtemp(join(tmpdir(), "plugin-loader-"));
    });
    after(async () => {
        if (root)
            await rm(root, { recursive: true, force: true });
    });
    it("loads a plugin's default export into the registry", async () => {
        const agentDir = join(root, "load-default");
        await writePlugin(agentDir, "greet", `export default async (args) => "hello " + args.name;\n`);
        const registry = createToolRegistry();
        const result = await loadPluginTools(specFor(agentDir, ["greet"]), registry);
        assert.deepEqual([...result.loaded], ["greet"]);
        assert.equal(result.missing.length, 0);
        const handler = registry.get("greet");
        assert.ok(handler);
        const out = await handler({ name: "sté" }, {
            tool: "greet",
            sessionId: "s",
            iteration: 1,
            signal: new AbortController().signal,
        });
        assert.equal(out, "hello sté");
        assert.equal(registry.describe("greet"), undefined);
    });
    it("attaches a validated sidecar schema to the registry", async () => {
        const agentDir = join(root, "schema");
        await writePlugin(agentDir, "echo", `export default async (args) => args;\n`);
        const schema = {
            description: "Echo the supplied text",
            parameters: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
            },
        };
        await writeSchema(agentDir, "echo", schema);
        const registry = createToolRegistry();
        await loadPluginTools(specFor(agentDir, ["echo"]), registry);
        assert.deepEqual(registry.describe("echo"), schema);
    });
    it("accepts empty schemas and nested parameter keys without a type", async () => {
        const agentDir = join(root, "valid-schema-shapes");
        await writePlugin(agentDir, "empty", `export default async () => null;\n`);
        await writePlugin(agentDir, "nested", `export default async () => null;\n`);
        await writeSchema(agentDir, "empty", {});
        const nested = { parameters: { properties: {}, required: [] } };
        await writeSchema(agentDir, "nested", nested);
        const registry = createToolRegistry();
        await loadPluginTools(specFor(agentDir, ["empty", "nested"]), registry);
        assert.deepEqual(registry.describe("empty"), {});
        assert.deepEqual(registry.describe("nested"), nested);
    });
    it("rejects malformed sidecar schemas with the path and reason", async () => {
        const cases = [
            ["invalid-json", "{", /not valid JSON/],
            ["non-object", [], /plain object/],
            ["unknown-key", { extra: true }, /unknown top-level key/],
            ["description", { description: 1 }, /description must be a string/],
            ["parameters", { parameters: [] }, /parameters must be a plain object/],
            ["parameter-type", { parameters: { type: "string" } }, /parameters\.type must be "object"/],
        ];
        for (const [name, schema, reason] of cases) {
            const agentDir = join(root, `invalid-schema-${name}`);
            await writePlugin(agentDir, name, `export default async () => null;\n`);
            const sidecarPath = await writeSchema(agentDir, name, schema);
            await assert.rejects(loadPluginTools(specFor(agentDir, [name]), createToolRegistry()), (err) => {
                assert.ok(err instanceof InvalidPluginError);
                assert.ok(err.message.includes(sidecarPath));
                assert.match(err.message, reason);
                return true;
            });
        }
    });
    it("exports resolution limited to .mjs and .js", async () => {
        const agentDir = join(root, "resolver");
        await mkdir(join(agentDir, "tools"), { recursive: true });
        await writeFile(join(agentDir, "tools", "python-only.py"), "pass\n", "utf8");
        assert.deepEqual(await resolvePluginPath(agentDir, "python-only"), {
            path: null,
            tried: [
                join(agentDir, "tools", "python-only.mjs"),
                join(agentDir, "tools", "python-only.js"),
            ],
        });
        const jsPath = await writePlugin(agentDir, "javascript", "export default () => null;\n", ".js");
        assert.deepEqual(await resolvePluginPath(agentDir, "javascript"), {
            path: jsPath,
            tried: [
                join(agentDir, "tools", "javascript.mjs"),
                jsPath,
            ],
        });
    });
    it("skips tools already present in the registry (pre-registered wins)", async () => {
        const agentDir = join(root, "skip");
        await writePlugin(agentDir, "custom-tool", `export default async () => "file";\n`);
        const registry = createToolRegistry();
        registry.register("custom-tool", async () => "pre-registered");
        const result = await loadPluginTools(specFor(agentDir, ["custom-tool"]), registry);
        assert.deepEqual([...result.skipped], ["custom-tool"]);
        assert.deepEqual([...result.loaded], []);
        assert.equal(await registry.get("custom-tool")({}, {
            tool: "custom-tool",
            sessionId: "",
            iteration: 0,
            signal: new AbortController().signal,
        }), "pre-registered");
    });
    it("tracks missing plugins on the result when non-strict (default)", async () => {
        const agentDir = join(root, "missing");
        await mkdir(join(agentDir, "tools"), { recursive: true });
        const registry = createToolRegistry();
        const result = await loadPluginTools(specFor(agentDir, ["no_such_tool"]), registry);
        assert.deepEqual([...result.missing], ["no_such_tool"]);
        assert.equal(result.loaded.length, 0);
    });
    it("throws MissingPluginError in strict mode", async () => {
        const agentDir = join(root, "missing-strict");
        await mkdir(join(agentDir, "tools"), { recursive: true });
        const registry = createToolRegistry();
        await assert.rejects(loadPluginTools(specFor(agentDir, ["nope"]), registry, { strict: true }), (err) => {
            assert.ok(err instanceof MissingPluginError);
            assert.equal(err.toolName, "nope");
            return true;
        });
    });
    it("throws InvalidPluginError when the default export is not a function", async () => {
        const agentDir = join(root, "invalid");
        await writePlugin(agentDir, "bad", `export default "not a function";\n`);
        const registry = createToolRegistry();
        await assert.rejects(loadPluginTools(specFor(agentDir, ["bad"]), registry), (err) => {
            assert.ok(err instanceof InvalidPluginError);
            assert.equal(err.toolName, "bad");
            return true;
        });
    });
    it("prefers .mjs over .js when both are present", async () => {
        const agentDir = join(root, "ext-priority");
        await writePlugin(agentDir, "both", `export default async () => "mjs";\n`, ".mjs");
        // .js file with deliberately different output
        await writePlugin(agentDir, "both", `export default async () => "js";\n`, ".js");
        const registry = createToolRegistry();
        await loadPluginTools(specFor(agentDir, ["both"]), registry);
        const result = await registry.get("both")({}, {
            tool: "both",
            sessionId: "",
            iteration: 0,
            signal: new AbortController().signal,
        });
        assert.equal(result, "mjs");
    });
    it("falls back to .js when .mjs missing", async () => {
        const agentDir = join(root, "js-fallback");
        await writePlugin(agentDir, "fallback", `export default async () => "js-only";\n`, ".js");
        const registry = createToolRegistry();
        await loadPluginTools(specFor(agentDir, ["fallback"]), registry);
        const result = await registry.get("fallback")({}, {
            tool: "fallback",
            sessionId: "",
            iteration: 0,
            signal: new AbortController().signal,
        });
        assert.equal(result, "js-only");
    });
    it("loads multiple tools in declaration order + reports a breakdown", async () => {
        const agentDir = join(root, "multi");
        await writePlugin(agentDir, "a", `export default async () => "A";\n`);
        await writePlugin(agentDir, "b", `export default async () => "B";\n`);
        await writePlugin(agentDir, "c", `export default async () => "C";\n`);
        const registry = createToolRegistry();
        registry.register("b", async () => "pre-b"); // one pre-registered
        const result = await loadPluginTools(specFor(agentDir, ["a", "b", "c", "d"]), registry);
        assert.deepEqual([...result.loaded], ["a", "c"]);
        assert.deepEqual([...result.skipped], ["b"]);
        assert.deepEqual([...result.missing], ["d"]);
    });
});
//# sourceMappingURL=sdk-tool-loader.test.js.map