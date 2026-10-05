import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractCodeBlocks, detectFinal } from "../src/parser.js";
describe("extractCodeBlocks", () => {
    it("finds repl code blocks", () => {
        const text = "Some text\n```repl\nprint('hello')\n```\nMore text";
        const blocks = extractCodeBlocks(text);
        assert.equal(blocks.length, 1);
        assert.equal(blocks[0].code, "print('hello')");
    });
    it("finds multiple code blocks", () => {
        const text = "```repl\nx = 1\n```\ntext\n```repl\ny = 2\n```";
        const blocks = extractCodeBlocks(text);
        assert.equal(blocks.length, 2);
        assert.equal(blocks[0].code, "x = 1");
        assert.equal(blocks[1].code, "y = 2");
    });
    it("ignores non-repl code blocks", () => {
        const text = "```python\nprint('hello')\n```\n```repl\nprint('world')\n```";
        const blocks = extractCodeBlocks(text);
        assert.equal(blocks.length, 1);
        assert.equal(blocks[0].code, "print('world')");
    });
    it("returns empty for no code blocks", () => {
        const blocks = extractCodeBlocks("Just plain text, no code.");
        assert.equal(blocks.length, 0);
    });
});
describe("detectFinal", () => {
    it("detects FINAL(answer)", () => {
        const text = "Here is my conclusion:\nFINAL(The answer is 42)";
        const signal = detectFinal(text, []);
        assert.deepEqual(signal, { type: "final", value: "The answer is 42" });
    });
    it("detects FINAL_VAR(variable_name)", () => {
        const text = "I stored the result.\nFINAL_VAR(my_result)";
        const signal = detectFinal(text, []);
        assert.deepEqual(signal, { type: "final_var", value: "my_result" });
    });
    it("returns null when no final signal", () => {
        const text = "Still working on it, more iterations needed.";
        const signal = detectFinal(text, []);
        assert.equal(signal, null);
    });
    it("FINAL_VAR takes priority over FINAL", () => {
        const text = "FINAL_VAR(result)\nFINAL(Direct answer)";
        const signal = detectFinal(text, []);
        assert.equal(signal?.type, "final_var");
    });
    it("handles quoted variable names in FINAL_VAR", () => {
        const text = 'FINAL_VAR("my_var")';
        const signal = detectFinal(text, []);
        assert.equal(signal?.type, "final_var");
        assert.equal(signal?.value, "my_var");
    });
    it("ignores FINAL inside code blocks", () => {
        const text = "```repl\nFINAL('not this')\n```\nFINAL(This one counts)";
        const blocks = extractCodeBlocks(text);
        const signal = detectFinal(text, blocks);
        assert.equal(signal?.type, "final");
        assert.equal(signal?.value, "This one counts");
    });
});
//# sourceMappingURL=parser.test.js.map