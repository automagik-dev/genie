import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { uuidv7 } from "../src/uuid.js";
describe("uuidv7 — sortable ancestry ids", () => {
    it("produces a valid v7 UUID string", () => {
        const id = uuidv7();
        assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "matches UUIDv7 shape with version 7 + RFC variant nibbles");
    });
    it("is unique across a burst", () => {
        const ids = new Set(Array.from({ length: 1000 }, () => uuidv7()));
        assert.equal(ids.size, 1000);
    });
    it("is time-ordered: ids minted later sort lexicographically >= earlier", async () => {
        const first = uuidv7();
        await new Promise((r) => setTimeout(r, 3));
        const second = uuidv7();
        assert.ok(second > first, `${second} should sort after ${first}`);
    });
});
//# sourceMappingURL=uuid.test.js.map