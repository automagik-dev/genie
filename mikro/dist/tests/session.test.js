import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import { saveSession } from "../src/session.js";
function makeSessionData(overrides) {
    return {
        runId: "test-run-id-1234",
        query: "What is the meaning of life?",
        contextPath: "/tmp/context",
        model: "google/gemini-2.0-flash",
        answer: "The answer is 42.",
        usage: {
            inputTokens: 1000,
            outputTokens: 500,
            cachedTokens: 200,
            totalCost: 0.0015,
            iterations: 3,
            timeMs: 4500,
            model: "google/gemini-2.0-flash",
        },
        config: {
            model: { provider: "google", model: "gemini-2.0-flash" },
            toolsLevel: "core",
            budget: { maxCost: 1.0, maxTokens: 100000 },
        },
        logPath: null,
        ...overrides,
    };
}
describe("saveSession", () => {
    const testDir = join(tmpdir(), `mikro-session-test-${Date.now()}`);
    const originalHome = process.env.HOME;
    before(async () => {
        await mkdir(testDir, { recursive: true });
        process.env.HOME = testDir;
    });
    after(async () => {
        process.env.HOME = originalHome;
        await rm(testDir, { recursive: true, force: true });
    });
    it("creates session directory and returns its path", async () => {
        const data = makeSessionData();
        const sessionDir = await saveSession(data);
        assert.ok(sessionDir.includes(data.runId));
        const dirStat = await stat(sessionDir);
        assert.ok(dirStat.isDirectory());
    });
    it("writes all 5 expected files", async () => {
        const data = makeSessionData({ runId: "test-all-files" });
        const sessionDir = await saveSession(data);
        const files = ["meta.json", "usage.json", "answer.txt", "config.yaml", "trajectory.jsonl"];
        for (const file of files) {
            const fileStat = await stat(join(sessionDir, file));
            assert.ok(fileStat.isFile(), `Expected ${file} to exist`);
        }
    });
    it("meta.json has correct fields", async () => {
        const data = makeSessionData({ runId: "test-meta-fields" });
        const sessionDir = await saveSession(data);
        const raw = await readFile(join(sessionDir, "meta.json"), "utf-8");
        const meta = JSON.parse(raw);
        assert.equal(meta.runId, "test-meta-fields");
        assert.equal(meta.query, data.query);
        assert.equal(meta.contextPath, data.contextPath);
        assert.ok(typeof meta.timestamp === "string");
        assert.ok(meta.timestamp.includes("T")); // ISO string
        assert.ok(typeof meta.version === "string");
    });
    it("usage.json has correct token counts", async () => {
        const data = makeSessionData({ runId: "test-usage-fields" });
        const sessionDir = await saveSession(data);
        const raw = await readFile(join(sessionDir, "usage.json"), "utf-8");
        const usage = JSON.parse(raw);
        assert.equal(usage.inputTokens, 1000);
        assert.equal(usage.outputTokens, 500);
        assert.equal(usage.cachedTokens, 200);
        assert.equal(usage.totalCost, 0.0015);
        assert.equal(usage.iterations, 3);
        assert.equal(usage.timeMs, 4500);
        assert.equal(usage.model, "google/gemini-2.0-flash");
    });
    it("answer.txt contains the answer text", async () => {
        const data = makeSessionData({ runId: "test-answer-txt" });
        const sessionDir = await saveSession(data);
        const answer = await readFile(join(sessionDir, "answer.txt"), "utf-8");
        assert.equal(answer, "The answer is 42.");
    });
    it("config.yaml is valid YAML matching the config snapshot", async () => {
        const data = makeSessionData({ runId: "test-config-yaml" });
        const sessionDir = await saveSession(data);
        const raw = await readFile(join(sessionDir, "config.yaml"), "utf-8");
        const parsed = yaml.load(raw);
        assert.ok(typeof parsed === "object");
        assert.deepEqual(parsed, data.config);
    });
    it("copies trajectory when logPath is provided", async () => {
        const logDir = join(testDir, "logs");
        await mkdir(logDir, { recursive: true });
        const logPath = join(logDir, "test-run.jsonl");
        const logContent = '{"event":"run_start","run_id":"abc"}\n{"event":"run_end","run_id":"abc"}\n';
        await writeFile(logPath, logContent);
        const data = makeSessionData({ runId: "test-trajectory-copy", logPath });
        const sessionDir = await saveSession(data);
        const trajectory = await readFile(join(sessionDir, "trajectory.jsonl"), "utf-8");
        assert.equal(trajectory, logContent);
    });
    it("writes empty trajectory when logPath is null", async () => {
        const data = makeSessionData({ runId: "test-trajectory-null", logPath: null });
        const sessionDir = await saveSession(data);
        const trajectory = await readFile(join(sessionDir, "trajectory.jsonl"), "utf-8");
        assert.equal(trajectory, "");
    });
    it("writes empty trajectory when logPath points to non-existent file", async () => {
        const data = makeSessionData({
            runId: "test-trajectory-missing",
            logPath: "/tmp/does-not-exist-mikro-test.jsonl",
        });
        const sessionDir = await saveSession(data);
        const trajectory = await readFile(join(sessionDir, "trajectory.jsonl"), "utf-8");
        assert.equal(trajectory, "");
    });
    it("handles null contextPath in meta.json", async () => {
        const data = makeSessionData({ runId: "test-null-context", contextPath: null });
        const sessionDir = await saveSession(data);
        const raw = await readFile(join(sessionDir, "meta.json"), "utf-8");
        const meta = JSON.parse(raw);
        assert.equal(meta.contextPath, null);
    });
});
//# sourceMappingURL=session.test.js.map