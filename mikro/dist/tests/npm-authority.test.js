import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import ts from "typescript";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const wrapper = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts["deps:ci"];
const workflow = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
const ciCommand = workflow.match(/- name: Install dependencies\s+run: ([^\n]+)/)?.[1];
const expectedWrapper = "node scripts/check-npm-authority.mjs && npm ci";
const competing = ["bun.lock", "bun.lockb", "yarn.lock", "pnpm-lock.yaml", "pnpm-lock.yml", "npm-shrinkwrap.json"];
const CLI = 'console.log("AUTHORITY_CLI_READY");\n';
const SENTINEL = "dependency bytes must survive invalid authority\n";
const realNpm = spawnSync("which", ["npm"], { encoding: "utf8" }).stdout.trim();
// Run the complete source/committed CLI entry, including argument dispatch.
// Only static sibling imports are relocated to the real built modules: fixture
// dependencies must stay incomplete, and malformed fixture package.json must
// reach the guard instead of Node's unrelated package-config import failure.
// The .mjs entry keeps its own import.meta.url, so production target selection,
// shared ownership and repair still act on the isolated selected checkout.
function updaterEntry(file) {
    const text = readFileSync(join(ROOT, file), "utf8");
    assert.match(text, /case "update":\s+await runUpdate\(process.argv.slice\(3\)\)/);
    assert.match(text, /await runManaged\(root, "update"/);
    assert.match(text, /export const cliReady = new Promise/);
    assert.match(text, /void main\(\)\.then\(signalCliReady!?\)/);
    const js = file.endsWith(".ts") ? ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText : text;
    const relocations = [];
    const entry = js.replace(/from "(\.\/[^"\n]+)"/g, (original, relative) => {
        const replacement = `from "${pathToFileURL(resolve(ROOT, "dist/src", relative)).href}"`;
        relocations.push([original, replacement]);
        return replacement;
    });
    assert.ok(relocations.length > 0, `${file}: expected static sibling imports`);
    // Reversing the import relocation must recover the entire original module.
    assert.equal(relocations.reduce((body, [original, replacement]) => body.replace(replacement, original), entry), js);
    return entry;
}
const updaterEntries = { source: updaterEntry("src/cli.ts"), committed: updaterEntry("dist/src/cli.js") };
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value));
function edit(root, file, fn) {
    const path = join(root, file);
    const value = JSON.parse(readFileSync(path, "utf8"));
    fn(value);
    writeJson(path, value);
}
const invalid = [];
for (const file of ["package.json", "package-lock.json"]) {
    invalid.push({ name: `missing ${file}`, field: file, mutate: root => rmSync(join(root, file)) });
    invalid.push({ name: `malformed ${file}`, field: file, mutate: root => writeFileSync(join(root, file), "{invalid") });
    for (const value of [null, [], 7])
        invalid.push({ name: `${file} is ${JSON.stringify(value)}`, field: file, mutate: root => writeJson(join(root, file), value) });
}
invalid.push({ name: "lockfileVersion is not 3", field: "lockfileVersion", mutate: root => edit(root, "package-lock.json", l => { l.lockfileVersion = 2; }) });
invalid.push({ name: "missing root package", field: 'packages[""]', mutate: root => edit(root, "package-lock.json", l => { delete l.packages[""]; }) });
for (const value of [null, [], 7])
    invalid.push({ name: `root package is ${JSON.stringify(value)}`, field: 'packages[""]', mutate: root => edit(root, "package-lock.json", l => { l.packages[""] = value; }) });
for (const field of ["name", "version"]) {
    for (const atRoot of [false, true])
        invalid.push({ name: `${field} mismatch at ${atRoot ? "root package" : "lock top level"}`, field: atRoot ? `packages[""].${field}` : `package-lock.json.${field}`, mutate: root => edit(root, "package-lock.json", l => { (atRoot ? l.packages[""] : l)[field] = "different"; }) });
}
for (const field of ["dependencies", "devDependencies", "engines"])
    invalid.push({ name: `${field} mismatch`, field, mutate: root => edit(root, "package-lock.json", l => { l.packages[""][field] = { changed: "1" }; }) });
for (const file of competing)
    invalid.push({ name: `competing ${file}`, field: file, mutate: root => writeFileSync(join(root, file), "competing lock\n") });
const seams = ["local wrapper body adapter", "CI command body adapter", "canonical installer", "source updater entry adapter", "committed updater entry adapter", "launcher"];
function git(cwd, args) {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
}
function put(path, value = SENTINEL) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
function complete(root) {
    for (const path of [".package-lock.json", "js-yaml/package.json", "@earendil-works/pi-ai/package.json"])
        put(join(root, "node_modules", path), "{}");
}
function snapshot(path) {
    if (!existsSync(path))
        return null;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink())
        return { link: readlinkSync(path) };
    if (!stat.isDirectory())
        return { bytes: readFileSync(path).toString("base64"), mode: stat.mode };
    return Object.fromEntries(readdirSync(path).sort().map(name => [name, snapshot(join(path, name))]));
}
function fixture(mutate) {
    const area = mkdtempSync(join(tmpdir(), "mikro-authority-"));
    const remote = join(area, "remote"), root = join(area, "checkout"), bins = join(area, "bin");
    mkdirSync(remote);
    mkdirSync(bins);
    cpSync(join(ROOT, "bin"), join(remote, "bin"), { recursive: true });
    mkdirSync(join(remote, "scripts"));
    for (const file of ["install.sh", "check-npm-authority.mjs"])
        cpSync(join(ROOT, "scripts", file), join(remote, "scripts", file));
    const manifest = { name: "fixture", version: "1.0.0", type: "module", scripts: { "deps:ci": wrapper }, dependencies: { a: "1" }, devDependencies: { b: "2" }, engines: { node: ">=22.19.0" } };
    writeJson(join(remote, "package.json"), manifest);
    writeJson(join(remote, "package-lock.json"), { name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: { "": { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies, devDependencies: manifest.devDependencies, engines: manifest.engines } } });
    put(join(remote, "dist/src/cli.js"), CLI);
    put(join(remote, "dist/src/source-update.mjs"), updaterEntries.source);
    put(join(remote, "dist/src/committed-update.mjs"), updaterEntries.committed);
    put(join(remote, ".gitignore"), "node_modules/\n");
    git(remote, ["init", "-b", "main"]);
    git(remote, ["config", "user.name", "Fixture"]);
    git(remote, ["config", "user.email", "fixture@example.invalid"]);
    git(remote, ["add", "."]);
    git(remote, ["commit", "-m", "fixture base"]);
    const base = git(remote, ["rev-parse", "HEAD"]);
    mutate?.(remote);
    put(join(remote, "selected-candidate"), "candidate");
    git(remote, ["add", "-A"]);
    git(remote, ["commit", "-m", "fixture selected authority"]);
    const target = git(remote, ["rev-parse", "HEAD"]);
    git(area, ["clone", remote, root]);
    put(join(root, "node_modules/sentinel"));
    // A dependency-free npm tripwire. Builds are separately counted and never
    // disguised as installs. No registry access or package installation occurs.
    put(join(bins, "npm"), `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
fs.appendFileSync(process.env.NPM_EVENTS, JSON.stringify(process.argv.slice(2))+'\\n');
if (process.argv[2] === 'ci') {
 for (const p of ['.package-lock.json','js-yaml/package.json','@earendil-works/pi-ai/package.json']) {
  const file=path.join(process.cwd(),'node_modules',p);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'{}');
 }
} else if (process.argv[2] !== 'run' || process.argv[3] !== 'build') process.exit(81);
`);
    chmodSync(join(bins, "npm"), 0o755);
    const events = join(area, "npm-events");
    const env = { ...process.env, HOME: area, PATH: bins + ":" + process.env.PATH, NPM_EVENTS: events, MIKRO_INSTALL_DIR: root, MIKRO_BIN_DIR: join(area, "links"), MIKRO_REPO_URL: remote, MIKRO_FALLBACK_REPO_URL: remote, MIKRO_BRANCH: "main", MIKRO_SKIP_PREPARE: "1", MIKRO_INSTALL_TOKEN: "" };
    function run(seam, advance = true) {
        let cmd = process.execPath;
        let args;
        if (seam.includes("updater") && advance)
            git(root, ["reset", "--hard", base]);
        if (seam === "local wrapper body adapter" || seam === "CI command body adapter") {
            assert.equal(wrapper, expectedWrapper);
            if (seam === "CI command body adapter")
                assert.equal(ciCommand, "npm run deps:ci");
            cmd = "bash";
            args = ["-c", wrapper];
        }
        else if (seam === "canonical installer") {
            // Bootstrap from the real coherent implementation, validate the selected
            // fixture root; checking only the bootstrap checkout cannot pass this.
            cmd = "bash";
            args = [join(ROOT, "scripts/install.sh")];
        }
        else if (seam.includes("updater")) {
            // A legacy parked tree is untracked user state: explicitly request the
            // existing force-update path to reach recovery without weakening refusal.
            args = [join(root, `dist/src/${seam.startsWith("source") ? "source" : "committed"}-update.mjs`), "update", ...(existsSync(join(root, "node_modules.prev")) ? ["--force"] : [])];
        }
        else
            args = [join(root, "bin/mikro.mjs"), "--version"];
        const r = spawnSync(cmd, args, { cwd: root, env, encoding: "utf8", timeout: 20_000 });
        assert.ifError(r.error);
        if (seam.includes("updater") || seam === "canonical installer")
            assert.equal(git(root, ["rev-parse", "HEAD"]), target, `actual selection must reach candidate: ${r.stdout}${r.stderr}`);
        return { status: r.status, out: r.stdout + r.stderr };
    }
    function calls() { return existsSync(events) ? readFileSync(events, "utf8").trim().split("\n").map(line => JSON.parse(line)) : []; }
    function trees() { return [join(root, "node_modules"), join(root, "node_modules.prev"), root + ".mikro-install/node_modules.prev"].map(snapshot); }
    return { area, root, remote, env, run, calls, trees, close: () => rmSync(area, { recursive: true, force: true }) };
}
function rejected(result, field) {
    assert.equal(result.status, 1, result.out);
    assert.ok(result.out.includes(field), result.out);
    assert.match(result.out, /npm-only check failed/);
    assert.match(result.out, /npm run deps:ci/);
}
it("wrapper and actual CI installation command have the frozen identities", () => {
    assert.equal(wrapper, expectedWrapper);
    assert.equal(ciCommand, "npm run deps:ci");
    assert.doesNotMatch(workflow, /run: npm ci\b/);
});
for (const seam of seams)
    describe(seam, () => {
        for (const bad of invalid)
            it(bad.name, { timeout: 30_000 }, () => {
                const f = fixture(bad.mutate);
                try {
                    const before = f.trees();
                    rejected(f.run(seam), bad.field);
                    assert.deepEqual(f.trees(), before);
                    assert.deepEqual(f.calls(), []);
                }
                finally {
                    f.close();
                }
            });
        it("coherent control reaches exactly one npm installation", { timeout: 30_000 }, () => {
            const f = fixture();
            try {
                const r = f.run(seam);
                assert.equal(r.status, 0, r.out);
                assert.equal(f.calls().filter(a => a[0] === "ci").length, 1);
                assert.equal(f.calls().filter(a => a[0] === "run" && a[1] === "build").length, seam.includes("body adapter") && !seam.includes("updater") ? 0 : 1);
                if (seam === "launcher")
                    assert.match(r.out, /AUTHORITY_CLI_READY/);
            }
            finally {
                f.close();
            }
        });
    });
it("real npm run deps:ci dispatcher reaches exactly one fake child installation", () => {
    const f = fixture();
    try {
        const r = spawnSync(realNpm, ["run", "deps:ci"], { cwd: f.root, env: f.env, encoding: "utf8" });
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.deepEqual(f.calls(), [["ci"]]);
    }
    finally {
        f.close();
    }
});
for (const seam of seams.slice(2))
    for (const parked of ["legacy", "sibling"])
        for (const ready of [false, true])
            for (const valid of [false, true]) {
                it(`${seam}: ${valid ? "coherent" : "invalid"} ${parked} recovery, ${ready ? "complete" : "incomplete"} current`, { timeout: 30_000 }, () => {
                    const f = fixture(valid ? undefined : invalid.find(b => b.name === "dependencies mismatch").mutate);
                    try {
                        if (ready)
                            complete(f.root);
                        put(parked === "legacy" ? join(f.root, "node_modules.prev/sentinel") : f.root + ".mikro-install/node_modules.prev/sentinel", "parked bytes\n");
                        // Pending install makes coherent complete-current recovery reach npm too.
                        put(f.root + ".mikro-install/pending.json", '{"phase":"install"}');
                        const before = f.trees();
                        const r = f.run(seam);
                        if (valid) {
                            assert.equal(r.status, 0, r.out);
                            assert.equal(f.calls().filter(a => a[0] === "ci").length, 1);
                        }
                        else {
                            rejected(r, "dependencies");
                            assert.deepEqual(f.trees(), before);
                            assert.deepEqual(f.calls(), []);
                        }
                    }
                    finally {
                        f.close();
                    }
                });
            }
for (const valid of [false, true])
    it(`custom-prefix legacy migration: ${valid ? "both renames remain reachable" : "invalid selected root preserves both paths and trees"}`, () => {
        const f = fixture(valid ? undefined : invalid.find(b => b.name === "engines mismatch").mutate);
        try {
            put(join(f.area, ".rlmx/rlmx/node_modules/sentinel"), "legacy dependency bytes\n");
            put(join(f.area, ".rlmx/settings.json"), '{"legacy":true}');
            put(f.root + ".mikro-install/node_modules.prev/sentinel", "parked bytes\n");
            const before = [f.trees(), snapshot(join(f.area, ".rlmx")), snapshot(join(f.area, ".mikro"))];
            const r = f.run("canonical installer");
            if (!valid) {
                rejected(r, "engines");
                assert.deepEqual([f.trees(), snapshot(join(f.area, ".rlmx")), snapshot(join(f.area, ".mikro"))], before);
                assert.deepEqual(f.calls(), []);
            }
            else {
                assert.equal(r.status, 0, r.out);
                assert.equal(existsSync(join(f.area, ".rlmx")), false);
                assert.equal(existsSync(join(f.area, ".mikro/rlmx")), false);
                assert.equal(readFileSync(join(f.area, ".mikro/mikro/node_modules/sentinel"), "utf8"), "legacy dependency bytes\n");
                assert.equal(readFileSync(join(f.area, ".mikro/settings.json"), "utf8"), '{"legacy":true}');
                assert.equal(f.calls().filter(a => a[0] === "ci").length, 1);
            }
        }
        finally {
            f.close();
        }
    });
for (const control of ["absent versus empty", "nested key order", "excluded fields and nested locks"])
    it(`exact authority boundary: ${control}`, () => {
        const f = fixture(root => {
            if (control === "absent versus empty") {
                edit(root, "package.json", p => { delete p.dependencies; p.devDependencies = {}; delete p.engines; });
                edit(root, "package-lock.json", p => { p.packages[""].dependencies = {}; delete p.packages[""].devDependencies; delete p.packages[""].engines; });
            }
            else if (control === "nested key order") {
                edit(root, "package.json", p => { p.dependencies = { a: { x: "1", y: "2" }, b: "2" }; });
                edit(root, "package-lock.json", p => { p.packages[""].dependencies = { b: "2", a: { y: "2", x: "1" } }; });
            }
            else {
                edit(root, "package.json", p => { p.optionalDependencies = { excluded: "1" }; p.peerDependencies = { excluded: "2" }; });
                edit(root, "package-lock.json", p => { p.packages["node_modules/arbitrary"] = null; });
                for (const name of competing)
                    put(join(root, "nested", name));
                put(join(root, "nested/package.json"), "invalid consumer metadata");
            }
        });
        try {
            const r = f.run("local wrapper body adapter");
            assert.equal(r.status, 0, r.out);
            assert.deepEqual(f.calls(), [["ci"]]);
        }
        finally {
            f.close();
        }
    });
//# sourceMappingURL=npm-authority.test.js.map