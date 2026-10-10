/**
 * `examples/agents/` is the single recipe tree: every `agent.yaml` microagent
 * this repository ships lives there and nowhere else. This file is the
 * mechanical half of that claim.
 *
 * Two things are checked, and they fail for different reasons:
 *
 *   1. **Every** directory under `examples/agents/` loads via `loadAgentSpec`.
 *      Enumerated from the filesystem rather than from a list, so a recipe
 *      added later is covered without editing this file, and a recipe that is
 *      committed broken fails here rather than in a user's session.
 *   2. The three **archived** recipes — `changelog`, `codebase-qa`,
 *      `log-triage`, copied out of `~/.mikro/agents/` on 2026-07-27 by wish
 *      `mikro-microagent-plugin` (B5) — load with the exact shape, model and
 *      budget they were archived with. These have no other gate: no smoke
 *      test, no parity arm, no scored suite covers them. Pinning the spec is
 *      the only regression floor they have, and an archive whose contents
 *      drift is not an archive.
 *
 * Deliberately **not** checked: whether any of these agents answers well. That
 * is a model result measured elsewhere (`docs/parity-explore.md`), and the
 * archived three were never measured at all — see `docs/worker-models.md`.
 */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadAgentSpec } from "../src/sdk/index.js";
// tests/ compiles to dist/tests/, so the repo root is two levels up.
const testDir = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(testDir, "..", "..", "examples", "agents");
/** The archived-recipe contract: what each was copied in carrying. */
const ARCHIVED = {
    changelog: { shape: "loop", maxIterations: 6 },
    "codebase-qa": { shape: "loop", maxIterations: 8 },
    "log-triage": { shape: "loop", maxIterations: 6 },
};
const STATION_MODEL = "station/Qwen3.6-35B-A3B-MTP-GGUF";
function recipeDirs() {
    return readdirSync(AGENTS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
}
describe("examples/agents — the recipe tree", () => {
    it("is not empty and holds the archived three", () => {
        const dirs = recipeDirs();
        assert.ok(dirs.length > 0, "examples/agents/ has no recipe directories");
        for (const name of Object.keys(ARCHIVED)) {
            assert.ok(dirs.includes(name), `archived recipe ${name}/ is missing from examples/agents/`);
        }
    });
    it("every recipe directory loads via loadAgentSpec", async () => {
        for (const name of recipeDirs()) {
            const spec = await loadAgentSpec(join(AGENTS_DIR, name));
            assert.equal(spec.dir, join(AGENTS_DIR, name), `${name}: spec.dir is not the directory it was loaded from`);
            assert.ok(spec.systemPath, `${name}: agent.yaml declares no system:`);
        }
    });
    it("archived recipes load with the shape, model and budget they were archived with", async () => {
        for (const [name, want] of Object.entries(ARCHIVED)) {
            const spec = await loadAgentSpec(join(AGENTS_DIR, name));
            assert.equal(spec.shape, want.shape, `${name}: shape drifted`);
            assert.equal(spec.model, STATION_MODEL, `${name}: model drifted`);
            assert.equal(spec.budget?.maxIterations, want.maxIterations, `${name}: budget.max_iterations drifted`);
            assert.equal(spec.systemPath, "SYSTEM.md", `${name}: system: drifted`);
            // `shape: loop` is load-bearing for all three: mikro externalizes
            // context into the REPL, so `single-step` answers before it has read
            // anything. Asserted by name so the failure says why.
            assert.notEqual(spec.shape, "single-step", `${name}: single-step answers before reading the input`);
        }
    });
});
//# sourceMappingURL=examples-agents-recipes.test.js.map