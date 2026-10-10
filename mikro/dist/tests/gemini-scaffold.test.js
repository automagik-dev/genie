import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffold } from "../src/scaffold.js";
describe("Scaffold creates .mikro/ directory", () => {
    let dir;
    it("mikro init creates .mikro/ with 4 files", async () => {
        dir = await mkdtemp(join(tmpdir(), "mikro-scaffold-"));
        const created = await scaffold(dir);
        assert.ok(created.includes("mikro.yaml"));
        assert.ok(created.includes("SYSTEM.md"));
        assert.ok(created.includes("CRITERIA.md"));
        assert.ok(created.includes("TOOLS.md"));
        const content = await readFile(join(dir, ".mikro", "mikro.yaml"), "utf-8");
        assert.ok(content.includes("gemini:"), "Should contain gemini section");
        assert.ok(content.includes("thinking-level"), "Should mention thinking-level");
        assert.ok(content.includes("google-search"), "Should mention google-search");
        assert.ok(content.includes("url-context"), "Should mention url-context");
        assert.ok(content.includes("code-execution"), "Should mention code-execution");
        assert.ok(content.includes("media-resolution"), "Should mention media-resolution");
        assert.ok(content.includes("output:"), "Should contain output section");
        assert.ok(content.includes("schema"), "Should mention schema");
        await rm(dir, { recursive: true });
    });
    it("scaffold default model is Gemini 3", async () => {
        dir = await mkdtemp(join(tmpdir(), "mikro-scaffold-"));
        await scaffold(dir);
        const content = await readFile(join(dir, ".mikro", "mikro.yaml"), "utf-8");
        assert.ok(content.includes("provider: google"), "Default provider should be google");
        assert.ok(content.includes("gemini-3.1-flash-lite-preview"), "Default model should be gemini-3.1-flash-lite-preview");
        await rm(dir, { recursive: true });
    });
    it("init with existing .mikro/ does not overwrite files", async () => {
        dir = await mkdtemp(join(tmpdir(), "mikro-scaffold-"));
        // First scaffold
        await scaffold(dir);
        // Write custom content
        await writeFile(join(dir, ".mikro", "SYSTEM.md"), "Custom system prompt");
        // Second scaffold — should not overwrite
        const created = await scaffold(dir);
        assert.equal(created.length, 0, "Should not create any files");
        const system = await readFile(join(dir, ".mikro", "SYSTEM.md"), "utf-8");
        assert.equal(system, "Custom system prompt", "Should not overwrite existing file");
        await rm(dir, { recursive: true });
    });
    it("--template nonexistent prints error", async () => {
        dir = await mkdtemp(join(tmpdir(), "mikro-scaffold-"));
        await assert.rejects(() => scaffold(dir, "nonexistent"), /template "nonexistent" not found.*Available: default, code/);
        await rm(dir, { recursive: true });
    });
    it("code template creates .mikro/ with code-tuned files", async () => {
        dir = await mkdtemp(join(tmpdir(), "mikro-scaffold-"));
        const created = await scaffold(dir, "code");
        assert.ok(created.includes("mikro.yaml"));
        assert.ok(created.includes("SYSTEM.md"));
        assert.ok(created.includes("CRITERIA.md"));
        assert.ok(created.includes("TOOLS.md"), "Should copy TOOLS.md from default");
        const yaml = await readFile(join(dir, ".mikro", "mikro.yaml"), "utf-8");
        assert.ok(yaml.includes("tools-level: standard"), "Code template should use standard tools");
        const system = await readFile(join(dir, ".mikro", "SYSTEM.md"), "utf-8");
        assert.ok(system.includes("Architecture analysis"), "Should have code-specific instructions");
        assert.ok(system.includes("Tracing call chains"), "Should have call chain tracing");
        assert.ok(system.includes("Import and dependency analysis"), "Should have import analysis");
        assert.ok(system.includes("file path and line number"), "Should reference file paths");
        await rm(dir, { recursive: true });
    });
});
//# sourceMappingURL=gemini-scaffold.test.js.map