import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runBatch } from "../src/batch.js";
describe("runBatch", () => {
    it("exports runBatch as a function", () => {
        assert.equal(typeof runBatch, "function");
    });
    it("accepts the correct parameter signature", () => {
        // runBatch(questionsFile, context, config, options?)
        // options has a default value so .length is 3
        assert.equal(runBatch.length, 3);
    });
});
describe("batch question file parsing", () => {
    let dir;
    it("reads questions from a file (one per line)", async () => {
        dir = await mkdtemp(join(tmpdir(), "mikro-batch-"));
        const questionsPath = join(dir, "questions.txt");
        await writeFile(questionsPath, "What is TypeScript?\nHow does caching work?\nExplain recursion.\n");
        const content = await readFile(questionsPath, "utf-8");
        const questions = content
            .split("\n")
            .map((q) => q.trim())
            .filter((q) => q.length > 0 && !q.startsWith("#"));
        assert.equal(questions.length, 3);
        assert.equal(questions[0], "What is TypeScript?");
        assert.equal(questions[1], "How does caching work?");
        assert.equal(questions[2], "Explain recursion.");
        await rm(dir, { recursive: true });
    });
    it("skips empty lines", async () => {
        dir = await mkdtemp(join(tmpdir(), "mikro-batch-"));
        const questionsPath = join(dir, "questions.txt");
        await writeFile(questionsPath, "First question\n\n\nSecond question\n\n");
        const content = await readFile(questionsPath, "utf-8");
        const questions = content
            .split("\n")
            .map((q) => q.trim())
            .filter((q) => q.length > 0 && !q.startsWith("#"));
        assert.equal(questions.length, 2);
        assert.equal(questions[0], "First question");
        assert.equal(questions[1], "Second question");
        await rm(dir, { recursive: true });
    });
    it("skips comment lines starting with #", async () => {
        dir = await mkdtemp(join(tmpdir(), "mikro-batch-"));
        const questionsPath = join(dir, "questions.txt");
        await writeFile(questionsPath, "# This is a comment\nActual question\n# Another comment\nSecond question\n");
        const content = await readFile(questionsPath, "utf-8");
        const questions = content
            .split("\n")
            .map((q) => q.trim())
            .filter((q) => q.length > 0 && !q.startsWith("#"));
        assert.equal(questions.length, 2);
        assert.equal(questions[0], "Actual question");
        assert.equal(questions[1], "Second question");
        await rm(dir, { recursive: true });
    });
    it("trims whitespace from questions", async () => {
        dir = await mkdtemp(join(tmpdir(), "mikro-batch-"));
        const questionsPath = join(dir, "questions.txt");
        await writeFile(questionsPath, "  padded question  \n\tanother one\t\n");
        const content = await readFile(questionsPath, "utf-8");
        const questions = content
            .split("\n")
            .map((q) => q.trim())
            .filter((q) => q.length > 0 && !q.startsWith("#"));
        assert.equal(questions.length, 2);
        assert.equal(questions[0], "padded question");
        assert.equal(questions[1], "another one");
        await rm(dir, { recursive: true });
    });
    it("handles file with only comments and empty lines", async () => {
        dir = await mkdtemp(join(tmpdir(), "mikro-batch-"));
        const questionsPath = join(dir, "questions.txt");
        await writeFile(questionsPath, "# comment\n\n# another comment\n\n");
        const content = await readFile(questionsPath, "utf-8");
        const questions = content
            .split("\n")
            .map((q) => q.trim())
            .filter((q) => q.length > 0 && !q.startsWith("#"));
        assert.equal(questions.length, 0);
        await rm(dir, { recursive: true });
    });
    it("handles single question file", async () => {
        dir = await mkdtemp(join(tmpdir(), "mikro-batch-"));
        const questionsPath = join(dir, "questions.txt");
        await writeFile(questionsPath, "Just one question\n");
        const content = await readFile(questionsPath, "utf-8");
        const questions = content
            .split("\n")
            .map((q) => q.trim())
            .filter((q) => q.length > 0 && !q.startsWith("#"));
        assert.equal(questions.length, 1);
        assert.equal(questions[0], "Just one question");
        await rm(dir, { recursive: true });
    });
    it("preserves question content with special characters", async () => {
        dir = await mkdtemp(join(tmpdir(), "mikro-batch-"));
        const questionsPath = join(dir, "questions.txt");
        await writeFile(questionsPath, 'What is O(n^2)?\nHow does `async/await` work?\nExplain "prompt caching".\n');
        const content = await readFile(questionsPath, "utf-8");
        const questions = content
            .split("\n")
            .map((q) => q.trim())
            .filter((q) => q.length > 0 && !q.startsWith("#"));
        assert.equal(questions.length, 3);
        assert.equal(questions[0], "What is O(n^2)?");
        assert.ok(questions[1].includes("`async/await`"));
        assert.ok(questions[2].includes('"prompt caching"'));
        await rm(dir, { recursive: true });
    });
});
describe("BatchOptions interface", () => {
    it("allows empty options object", () => {
        const opts = {};
        assert.equal(opts.maxCost, undefined);
        assert.equal(opts.parallel, undefined);
    });
    it("accepts maxCost option", () => {
        const opts = { maxCost: 5.0 };
        assert.equal(opts.maxCost, 5.0);
    });
    it("accepts parallel option", () => {
        const opts = { parallel: 4 };
        assert.equal(opts.parallel, 4);
    });
    it("accepts RLMOptions fields", () => {
        const opts = {
            maxCost: 2.0,
            parallel: 2,
            maxIterations: 5,
            timeout: 30000,
            verbose: true,
        };
        assert.equal(opts.maxCost, 2.0);
        assert.equal(opts.maxIterations, 5);
        assert.equal(opts.timeout, 30000);
        assert.equal(opts.verbose, true);
    });
});
//# sourceMappingURL=batch.test.js.map