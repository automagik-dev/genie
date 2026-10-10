import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkPythonVersion, detectPackages, formatPackagePrompt, } from "../src/detect.js";
describe("checkPythonVersion", () => {
    it("returns valid for Python 3.10+", async () => {
        const result = await checkPythonVersion();
        assert.equal(result.valid, true);
    });
    it("returns a version string", async () => {
        const result = await checkPythonVersion();
        assert.match(result.version, /^\d+\.\d+\.\d+$/);
    });
    it("throws for missing python path", async () => {
        await assert.rejects(() => checkPythonVersion("/nonexistent/python99"), /Python not found/);
    });
});
describe("detectPackages", () => {
    it("returns object with boolean values", async () => {
        const pkgs = await detectPackages();
        assert.equal(typeof pkgs, "object");
        for (const val of Object.values(pkgs)) {
            assert.equal(typeof val, "boolean");
        }
    });
});
describe("formatPackagePrompt", () => {
    it("returns empty string when no packages available", () => {
        const result = formatPackagePrompt({ numpy: false, pandas: false });
        assert.equal(result, "");
    });
    it("lists available packages", () => {
        const result = formatPackagePrompt({ numpy: true, pandas: true, bs4: false });
        assert.ok(result.includes("numpy"));
        assert.ok(result.includes("pandas"));
        assert.ok(!result.includes("beautifulsoup4"));
    });
    it("uses display names for aliased packages", () => {
        const result = formatPackagePrompt({ bs4: true, sklearn: true });
        assert.ok(result.includes("beautifulsoup4"));
        assert.ok(result.includes("scikit-learn"));
    });
});
//# sourceMappingURL=detect.test.js.map