import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseContextLine } from "../src/storage.js";
function captureStderr(fn) {
    const originalWrite = process.stderr.write;
    let captured = "";
    process.stderr.write = ((chunk) => {
        captured += String(chunk);
        return true;
    });
    try {
        fn();
    }
    finally {
        process.stderr.write = originalWrite;
    }
    return captured;
}
describe("storage context line parsing", () => {
    it("does not warn for markdown/code lines that look like malformed JSON objects", () => {
        let parsed;
        const stderr = captureStderr(() => {
            parsed = parseContextLine("{ config, ... }: {...", { source: "docs/reference.md" });
        });
        assert.equal(stderr, "");
        assert.deepEqual(parsed, {
            timestamp: null,
            type: null,
            content: "{ config, ... }: {...",
        });
    });
    it("parses JSON object lines from jsonl sources", () => {
        const parsed = parseContextLine('{"timestamp":"2026-05-16T00:00:00Z","type":"event","message":"ok"}', { source: "events.jsonl" });
        assert.equal(parsed.timestamp, "2026-05-16T00:00:00Z");
        assert.equal(parsed.type, "event");
        assert.equal(parsed.content, '{"timestamp":"2026-05-16T00:00:00Z","type":"event","message":"ok"}');
    });
    it("parses JSON object lines from uppercase jsonl sources", () => {
        const parsed = parseContextLine('{"createdAt":"2026-05-16","kind":"event"}', {
            source: "EVENTS.JSONL",
        });
        assert.equal(parsed.timestamp, "2026-05-16");
        assert.equal(parsed.type, "event");
    });
    it("still warns for malformed JSON lines in jsonl sources", () => {
        let parsed;
        const stderr = captureStderr(() => {
            parsed = parseContextLine("{not valid json", { source: "events.jsonl" });
        });
        assert.match(stderr, /malformed JSONL line/);
        assert.deepEqual(parsed, {
            timestamp: null,
            type: null,
            content: "{not valid json",
        });
    });
});
//# sourceMappingURL=storage.test.js.map