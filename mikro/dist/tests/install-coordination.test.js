import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
const ROOT = process.env.MIKRO_INSTALL_TEST_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = 'import {existsSync} from "node:fs"; if (!existsSync(new URL("../../node_modules/.package-lock.json", import.meta.url))) throw Error("partial import"); console.log("CLI_READY");\n';
const NPM = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const area = process.env.FIXTURE_AREA;
const mode = process.argv[2] === 'ci' ? 'ci' : 'build';
const log = x => fs.appendFileSync(path.join(area, 'events'), x + '\\n');
const wait = path.join(area, mode + '-gate');
const live = path.join(area, 'writer');
if (fs.existsSync(live)) { log('COLLISION'); process.exit(90); }
fs.writeFileSync(live, String(process.pid));
log(mode + ':start');
fs.writeFileSync(path.join(area, mode + '-ready'), String(process.pid));
if (mode === 'ci') fs.mkdirSync('node_modules', {recursive:true});
while (fs.existsSync(wait)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
if (fs.existsSync(path.join(area, mode + '-fail'))) {
 if (mode === 'build') fs.writeFileSync('dist/src/cli.js', 'throw Error("partial build");');
 fs.unlinkSync(live); log(mode + ':fail'); process.exit(mode === 'ci' ? 23 : 42);
}
if (mode === 'ci') {
 for (const p of ['.package-lock.json','js-yaml/package.json','@earendil-works/pi-ai/package.json']) {
  fs.mkdirSync(path.dirname('node_modules/' + p), {recursive:true}); fs.writeFileSync('node_modules/' + p, '{}');
 }
 fs.writeFileSync('node_modules/sentinel', 'new');
} else { fs.mkdirSync('dist/src', {recursive:true}); fs.copyFileSync('fixture-cli.mjs', 'dist/src/cli.js'); }
fs.unlinkSync(live); log(mode + ':end');
`;
function command(cwd, cmd, args) {
    const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
}
function start(cwd, cmd, args, env) {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", c => { out += c; });
    child.stderr.on("data", c => { out += c; });
    const done = new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", code => resolve({ code, out }));
    });
    return { child, done, output: () => out };
}
async function until(predicate, message) {
    const deadline = Date.now() + 15_000;
    while (!await predicate()) {
        assert.ok(Date.now() < deadline, message);
        await delay(10);
    }
}
async function fixture(actualCli = false) {
    const area = await mkdtemp(join(tmpdir(), "mikro-install-test-"));
    const remote = join(area, "remote");
    const checkout = join(area, "checkout");
    const bins = join(area, "bin");
    await mkdir(join(remote, "dist/src"), { recursive: true });
    await mkdir(bins);
    await cp(join(ROOT, "bin"), join(remote, "bin"), { recursive: true });
    await mkdir(join(remote, "scripts"));
    await cp(join(ROOT, "scripts/install.sh"), join(remote, "scripts/install.sh"));
    await cp(join(ROOT, "scripts/check-npm-authority.mjs"), join(remote, "scripts/check-npm-authority.mjs"));
    await writeFile(join(remote, "package-lock.json"), JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0" } } }));
    await writeFile(join(remote, "package.json"), '{"name":"fixture","version":"1.0.0","type":"module"}');
    await writeFile(join(remote, ".gitignore"), "node_modules\n");
    await writeFile(join(remote, "fixture-cli.mjs"), CLI);
    await writeFile(join(remote, "dist/src/cli.js"), CLI);
    if (actualCli)
        await cp(join(ROOT, "dist/src"), join(remote, "dist/src"), { recursive: true });
    command(remote, "git", ["init", "-b", "main"]);
    command(remote, "git", ["config", "user.name", "Fixture"]);
    command(remote, "git", ["config", "user.email", "fixture@example.invalid"]);
    command(remote, "git", ["add", "."]);
    command(remote, "git", ["commit", "-m", "fixture"]);
    command(area, "git", ["clone", remote, checkout]);
    await writeFile(join(bins, "npm"), NPM);
    await chmod(join(bins, "npm"), 0o755);
    const env = { ...process.env, PATH: bins + ":" + process.env.PATH, FIXTURE_AREA: area, HOME: area, MIKRO_INSTALL_WAIT_MS: "10000", MIKRO_SKIP_PREPARE: "1", MIKRO_BIN_DIR: join(area, "links") };
    const processes = [];
    function launch(args = ["--version"], extra = {}) {
        const p = start(checkout, process.execPath, [join(checkout, "bin/mikro.mjs"), ...args], { ...env, ...extra });
        processes.push(p);
        return p;
    }
    async function complete() {
        for (const name of [".package-lock.json", "js-yaml/package.json", "@earendil-works/pi-ai/package.json", "sentinel"]) {
            const path = join(checkout, "node_modules", name);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, name === "sentinel" ? "old" : "{}");
        }
    }
    async function advance() { await writeFile(join(remote, "change"), "next"); command(remote, "git", ["add", "."]); command(remote, "git", ["commit", "-m", "next"]); }
    async function events() { return (await readFile(join(area, "events"), "utf8")).trim().split("\n"); }
    async function close() {
        // Unblock subprocesses even after a failed assertion.
        await rm(join(area, "ci-gate"), { force: true });
        await rm(join(area, "build-gate"), { force: true });
        for (const p of processes)
            if (p.child.exitCode === null && p.child.signalCode === null)
                p.child.kill("SIGTERM");
        await Promise.all(processes.map(p => p.done));
        await rm(area, { recursive: true, force: true });
    }
    return { area, remote, checkout, env, processes, launch, complete, advance, events, close };
}
it("updater and launcher serialize npm/build and recheck completion after waiting", { timeout: 30_000 }, async () => {
    const f = await fixture(true);
    try {
        await symlink(join(ROOT, "node_modules"), join(f.checkout, "node_modules"), "dir");
        await f.advance();
        await writeFile(join(f.area, "ci-gate"), "");
        const updater = f.launch(["update"]);
        await until(() => existsSync(join(f.area, "ci-ready")), "updater did not enter npm");
        const launcher = f.launch();
        await until(async () => launcher.output().includes("waiting for active installation") || (await f.events()).includes("COLLISION"), "launcher neither waited nor reached npm");
        assert.equal((await f.events()).includes("COLLISION"), false, "two production processes entered npm concurrently");
        assert.deepEqual(await f.events(), ["ci:start"]);
        await rm(join(f.area, "ci-gate"));
        assert.equal((await updater.done).code, 0, updater.output());
        assert.equal((await launcher.done).code, 0, launcher.output());
        assert.match(launcher.output(), /CLI_READY/);
        assert.deepEqual(await f.events(), ["ci:start", "ci:end", "build:start", "build:end"]);
        assert.equal(existsSync(f.checkout + ".mikro-install/pending.json"), false);
    }
    finally {
        await f.close();
    }
});
it("live-owner contention is bounded and canonical installer cannot reset its checkout", { timeout: 30_000 }, async () => {
    const f = await fixture();
    try {
        await writeFile(join(f.area, "ci-gate"), "");
        const owner = f.launch();
        await until(() => existsSync(join(f.area, "ci-ready")), "no npm owner");
        const contender = f.launch([], { MIKRO_INSTALL_WAIT_MS: "150" });
        assert.equal((await contender.done).code, 75, contender.output());
        const installer = start(f.checkout, "bash", [join(f.checkout, "scripts/install.sh")], { ...f.env, MIKRO_INSTALL_WAIT_MS: "150", MIKRO_INSTALL_DIR: f.checkout, MIKRO_REPO_URL: f.remote });
        f.processes.push(installer);
        assert.equal((await installer.done).code, 75, installer.output());
        assert.doesNotMatch(installer.output(), /Existing checkout found/);
        assert.deepEqual(await f.events(), ["ci:start"]);
        await rm(join(f.area, "ci-gate"));
        assert.equal((await owner.done).code, 0, owner.output());
    }
    finally {
        await f.close();
    }
});
it("failed npm restores the previous tree and retry repairs the unchanged SHA", { timeout: 30_000 }, async () => {
    const f = await fixture();
    try {
        await f.complete();
        await f.advance();
        await writeFile(join(f.area, "ci-fail"), "");
        const first = f.launch(["update"]);
        assert.equal((await first.done).code, 23, first.output());
        assert.equal(await readFile(join(f.checkout, "node_modules/sentinel"), "utf8"), "old");
        await rm(join(f.area, "ci-fail"));
        const retry = f.launch(["update"]);
        assert.equal((await retry.done).code, 0, retry.output());
        assert.equal(await readFile(join(f.checkout, "node_modules/sentinel"), "utf8"), "new");
        assert.deepEqual(await f.events(), ["ci:start", "ci:fail", "ci:start", "ci:end", "build:start", "build:end"]);
    }
    finally {
        await f.close();
    }
});
it("failed build retries at unchanged SHA without another npm writer or partial CLI import", { timeout: 30_000 }, async () => {
    const f = await fixture();
    try {
        await f.complete();
        await f.advance();
        await writeFile(join(f.area, "build-fail"), "");
        const first = f.launch(["update"]);
        assert.equal((await first.done).code, 42, first.output());
        const sha = command(f.checkout, "git", ["rev-parse", "HEAD"]);
        await rm(join(f.area, "build-fail"));
        const retry = f.launch(["update"]);
        assert.equal((await retry.done).code, 0, retry.output());
        assert.equal(command(f.checkout, "git", ["rev-parse", "HEAD"]), sha);
        const version = f.launch();
        assert.equal((await version.done).code, 0, version.output());
        assert.match(version.output(), /CLI_READY/);
        assert.deepEqual(await f.events(), ["ci:start", "ci:end", "build:start", "build:fail", "build:start", "build:end"]);
    }
    finally {
        await f.close();
    }
});
it("dead owner recovery waits for its surviving npm child before acquiring mutation ownership", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
    const f = await fixture();
    try {
        await f.complete();
        await f.advance();
        await writeFile(join(f.area, "ci-gate"), "");
        const first = f.launch(["update"]);
        await until(() => existsSync(join(f.area, "ci-ready")), "no npm owner");
        const owner = JSON.parse(await readFile(f.checkout + ".mikro-install/owner.json", "utf8"));
        process.kill(owner.pid, "SIGKILL");
        const blocked = f.launch([], { MIKRO_INSTALL_WAIT_MS: "150" });
        assert.equal((await blocked.done).code, 75, blocked.output());
        await rm(join(f.area, "ci-gate"));
        await until(async () => (await f.events()).includes("ci:end"), "orphan npm did not finish");
        await first.done;
        const recovered = f.launch();
        assert.equal((await recovered.done).code, 0, recovered.output());
        assert.match(recovered.output(), /CLI_READY/);
        assert.equal((await f.events()).includes("COLLISION"), false);
        assert.equal(existsSync(f.checkout + ".mikro-install/node_modules.prev"), false);
    }
    finally {
        await f.close();
    }
});
it("interrupted build is recovered by launch even when dist and dependencies exist", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
    const f = await fixture();
    try {
        await f.complete();
        await f.advance();
        await writeFile(join(f.area, "build-gate"), "");
        const first = f.launch(["update"]);
        await until(() => existsSync(join(f.area, "build-ready")), "no build owner");
        const owner = JSON.parse(await readFile(f.checkout + ".mikro-install/owner.json", "utf8"));
        process.kill(owner.pid, "SIGKILL");
        await rm(join(f.area, "build-gate"));
        await first.done;
        const recovered = f.launch();
        assert.equal((await recovered.done).code, 0, recovered.output());
        assert.deepEqual(await f.events(), ["ci:start", "ci:end", "build:start", "build:end", "build:start", "build:end"]);
        assert.match(recovered.output(), /CLI_READY/);
    }
    finally {
        await f.close();
    }
});
it("canonical installer uses the same transaction and leaves a runnable launcher", { timeout: 30_000 }, async () => {
    const f = await fixture();
    try {
        await f.complete();
        const installer = start(f.checkout, "bash", [join(f.checkout, "scripts/install.sh")], { ...f.env, MIKRO_INSTALL_DIR: f.checkout, MIKRO_REPO_URL: f.remote });
        f.processes.push(installer);
        assert.equal((await installer.done).code, 0, installer.output());
        const version = f.launch();
        assert.equal((await version.done).code, 0, version.output());
        assert.deepEqual(await f.events(), ["ci:start", "ci:end", "build:start", "build:end"]);
    }
    finally {
        await f.close();
    }
});
it("standalone pipe-to-bash bootstrap installs before a local companion module exists", { timeout: 30_000 }, async () => {
    const f = await fixture();
    try {
        const destination = join(f.area, "fresh-install");
        const child = spawn("bash", [], { cwd: f.area, env: { ...f.env, MIKRO_INSTALL_DIR: destination, MIKRO_REPO_URL: f.remote }, stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", c => { out += c; });
        child.stderr.on("data", c => { out += c; });
        const done = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
        child.stdin.end(await readFile(join(ROOT, "scripts/install.sh")));
        assert.equal(await done, 0, out);
        const version = start(destination, process.execPath, [join(destination, "bin/mikro.mjs"), "--version"], f.env);
        f.processes.push(version);
        assert.equal((await version.done).code, 0, version.output());
        assert.match(version.output(), /CLI_READY/);
        assert.deepEqual(await f.events(), ["ci:start", "ci:end", "build:start", "build:end"]);
    }
    finally {
        await f.close();
    }
});
it("normal launch retains the original PID and terminates on SIGTERM", { timeout: 30_000 }, async () => {
    const f = await fixture();
    try {
        await f.complete();
        await writeFile(join(f.checkout, "dist/src/cli.js"), 'console.log("PID=" + process.pid); setInterval(() => {}, 1000);\n');
        const launched = f.launch();
        await until(() => launched.output().includes("PID="), "CLI did not start");
        assert.match(launched.output(), new RegExp(`PID=${launched.child.pid}\\b`));
        launched.child.kill("SIGTERM");
        assert.equal((await launched.done).code, null);
    }
    finally {
        await f.close();
    }
});
it("committed direct CLI update delegates to the same transaction after source compilation", { timeout: 30_000 }, async () => {
    const f = await fixture(true);
    try {
        await symlink(join(ROOT, "node_modules"), join(f.checkout, "node_modules"), "dir");
        await f.advance();
        const direct = start(f.checkout, process.execPath, [join(f.checkout, "dist/src/cli.js"), "update"], f.env);
        f.processes.push(direct);
        assert.equal((await direct.done).code, 0, direct.output());
        assert.deepEqual(await f.events(), ["ci:start", "ci:end", "build:start", "build:end"]);
        const source = await readFile(join(ROOT, "src/cli.ts"), "utf8");
        assert.match(source, /await runManaged\(root, "update"/);
    }
    finally {
        await f.close();
    }
});
it("actual stdio MCP initializes, lists tools, and exits on EOF or SIGTERM", { timeout: 30_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), "mikro-mcp-launch-"));
    try {
        for (const shutdown of ["eof", "signal"]) {
            const child = spawn(process.execPath, [join(ROOT, "bin/mikro.mjs"), "mcp", "--dir", home], { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
            let out = "";
            let err = "";
            child.stdout.on("data", c => { out += c; });
            child.stderr.on("data", c => { err += c; });
            const done = new Promise((resolve, reject) => {
                child.on("error", reject);
                child.on("close", (code, signal) => resolve({ code, signal }));
            });
            try {
                child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } }) + "\n");
                await until(() => out.includes('"id":1'), `MCP initialize missing: ${err}`);
                child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
                child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
                await until(() => out.includes('"id":2'), "MCP tools/list missing");
                const responses = out.trim().split("\n").map(line => JSON.parse(line));
                assert.ok(responses.find(r => r.id === 2)?.result?.tools?.length > 0, out);
                if (shutdown === "eof")
                    child.stdin.end();
                else
                    child.kill("SIGTERM");
                const result = await done;
                if (shutdown === "eof")
                    assert.equal(result.code, 0, err);
                else
                    assert.equal(result.signal, "SIGTERM");
            }
            finally {
                child.kill("SIGKILL");
                await done;
            }
        }
    }
    finally {
        await rm(home, { recursive: true, force: true });
    }
});
it("launcher protects asynchronous CLI startup from an updater parking dependencies", { timeout: 30_000 }, async () => {
    const f = await fixture();
    try {
        await f.complete();
        const gate = join(f.area, "startup-gate");
        await writeFile(gate, "");
        await writeFile(join(f.checkout, "dist/src/cli.js"), `import {existsSync} from "node:fs"; import {setTimeout as delay} from "node:timers/promises";
console.log("IMPORT_READY"); export const cliReady = (async () => { while (existsSync(${JSON.stringify(gate)})) await delay(10); if (!existsSync(new URL("../../node_modules/.package-lock.json", import.meta.url))) throw Error("partial startup"); })();\n`);
        const launched = f.launch();
        try {
            await until(() => launched.output().includes("IMPORT_READY"), "CLI did not import");
            const updater = f.launch(["update", "--force"], { MIKRO_INSTALL_WAIT_MS: "150" });
            assert.equal((await updater.done).code, 75, updater.output());
            assert.equal(existsSync(join(f.area, "events")), false);
        }
        finally {
            await rm(gate, { force: true });
        }
        assert.equal((await launched.done).code, 0, launched.output());
    }
    finally {
        await f.close();
    }
});
it("Linux installation cannot collide with unrelated ephemeral TCP ports", { timeout: 30_000, skip: process.platform !== "linux" }, async () => {
    const f = await fixture();
    const server = createServer(socket => socket.destroy());
    try {
        await f.complete();
        const oldPort = 49152 + createHash("sha256").update(f.checkout).digest().readUInt16BE(0) % 16384;
        await new Promise((resolve, reject) => {
            server.once("error", (error) => error.code === "EADDRINUSE" ? resolve() : reject(error));
            server.listen(oldPort, "127.0.0.1", resolve);
        });
        const launched = f.launch([], { MIKRO_INSTALL_WAIT_MS: "150" });
        assert.equal((await launched.done).code, 0, launched.output());
        assert.match(launched.output(), /CLI_READY/);
    }
    finally {
        if (server.listening)
            await new Promise(resolve => server.close(() => resolve()));
        await f.close();
    }
});
it("legacy-only default-prefix install refuses before creating state or mutating data and symlinks", { timeout: 30_000 }, async () => {
    const f = await fixture();
    try {
        const legacy = join(f.area, ".rlmx");
        const oldBin = join(f.area, ".local/bin");
        const oldLauncher = join(legacy, "rlmx/bin/mikro.mjs");
        await mkdir(dirname(oldLauncher), { recursive: true });
        await mkdir(oldBin, { recursive: true });
        await mkdir(join(legacy, "rlmx/node_modules"));
        await writeFile(oldLauncher, "legacy launcher bytes");
        await writeFile(join(legacy, "settings.json"), '{"legacy":true}');
        await writeFile(join(legacy, "rlmx/node_modules/sentinel"), "legacy dependency bytes");
        await symlink(oldLauncher, join(oldBin, "rlmx"));
        const installer = start(f.area, "bash", [join(f.checkout, "scripts/install.sh")], {
            ...f.env, MIKRO_INSTALL_DIR: join(f.area, ".mikro/mikro"), MIKRO_BIN_DIR: oldBin, MIKRO_REPO_URL: f.remote,
        });
        f.processes.push(installer);
        assert.equal((await installer.done).code, 1, installer.output());
        assert.match(installer.output(), /automatic migration is deferred/);
        assert.match(installer.output(), /test ! -e "\$HOME\/\.mikro" && mv/);
        assert.equal(existsSync(join(f.area, ".mikro")), false);
        assert.equal(existsSync(join(f.area, "events")), false, "npm must not run");
        assert.equal(await readFile(oldLauncher, "utf8"), "legacy launcher bytes");
        assert.equal(await readFile(join(legacy, "settings.json"), "utf8"), '{"legacy":true}');
        assert.equal(await readFile(join(legacy, "rlmx/node_modules/sentinel"), "utf8"), "legacy dependency bytes");
        assert.equal(await readlink(join(oldBin, "rlmx")), oldLauncher);
    }
    finally {
        await f.close();
    }
});
it("directory-symlink helper entry verifies ownership and runs the real installer", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
    const f = await fixture();
    try {
        const alias = join(f.area, "checkout-alias");
        await symlink(f.checkout, alias, "dir");
        for (const [root, flags] of [[f.checkout, []], [alias, []], [alias, ["--preserve-symlinks-main"]]]) {
            const verify = spawnSync(process.execPath, [...flags, join(root, "bin/install-state.mjs"), "verify", root], { cwd: f.area, env: f.env, encoding: "utf8" });
            assert.equal(verify.status, 1, `${root}: verify must execute, never silently succeed: ${verify.stdout}${verify.stderr}`);
            assert.match(verify.stderr, /installer does not own the installation lock/);
        }
        const installer = start(f.area, "bash", [join(alias, "scripts/install.sh")], { ...f.env, MIKRO_INSTALL_DIR: alias, MIKRO_REPO_URL: f.remote });
        f.processes.push(installer);
        assert.equal((await installer.done).code, 0, installer.output());
        const launched = start(f.area, process.execPath, [join(alias, "bin/mikro.mjs"), "--version"], f.env);
        f.processes.push(launched);
        assert.equal((await launched.done).code, 0, launched.output());
        assert.match(launched.output(), /CLI_READY/);
        assert.deepEqual(await f.events(), ["ci:start", "ci:end", "build:start", "build:end"]);
    }
    finally {
        await f.close();
    }
});
it("helper imports stay inert for eval, stdin and nonexistent entry paths", () => {
    for (const entry of [undefined, "-", "/nonexistent-mikro-entry"]) {
        const code = `process.argv = ${JSON.stringify(entry === undefined ? [process.execPath] : [process.execPath, entry])}; await import(${JSON.stringify(new URL("../../bin/install-state.mjs", import.meta.url).href)}); console.log('IMPORTED');`;
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), "IMPORTED");
        assert.equal(result.stderr, "");
    }
});
it("real ACP lifetime does not block version or concurrent MCP startup", { timeout: 30_000 }, async () => {
    const f = await fixture(true);
    try {
        await symlink(join(ROOT, "node_modules"), join(f.checkout, "node_modules"), "dir");
        function protocol(command) {
            const child = spawn(process.execPath, [join(f.checkout, "bin/mikro.mjs"), command, "--dir", f.area], {
                cwd: f.area, env: { ...f.env, MIKRO_INSTALL_WAIT_MS: "3000" }, stdio: ["pipe", "pipe", "pipe"],
            });
            let out = "";
            let err = "";
            child.stdout.on("data", c => { out += c; });
            child.stderr.on("data", c => { err += c; });
            const done = new Promise((resolve, reject) => {
                child.on("error", reject);
                child.on("close", code => resolve({ code, out: out + err }));
            });
            f.processes.push({ child, done, output: () => out + err });
            const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
            async function response(id) {
                await until(() => out.includes(`"id":${id}`) || child.exitCode !== null, `${command} response ${id} missing: ${err}`);
                assert.equal(child.exitCode, null, `${command} exited before responding: ${err}`);
                const message = out.trim().split("\n").map(line => JSON.parse(line)).find(value => value.id === id);
                assert.ok(message?.result, `${command}: ${out}${err}`);
                return message.result;
            }
            return { child, done, send, response };
        }
        const acp = protocol("acp");
        acp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
        assert.equal(typeof (await acp.response(1)).protocolVersion, "number");
        const version = f.launch(["--version"], { MIKRO_INSTALL_WAIT_MS: "3000" });
        const versionResult = await version.done;
        assert.equal(versionResult.code, 0, versionResult.out);
        assert.match(versionResult.out, /mikro v1\.0\.0/);
        assert.equal(acp.child.exitCode, null, "ACP must remain alive while another command starts");
        const mcp = protocol("mcp");
        mcp.send({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "concurrent-fixture", version: "1" } } });
        assert.ok((await mcp.response(2)).capabilities);
        mcp.send({ jsonrpc: "2.0", method: "notifications/initialized" });
        mcp.send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
        assert.ok((await mcp.response(3)).tools.length > 0);
        assert.equal(acp.child.exitCode, null, "ACP must remain alive during MCP initialization");
        assert.equal(existsSync(join(f.area, "events")), false, "complete installs need no npm");
        mcp.child.stdin.end();
        assert.equal((await mcp.done).code, 0);
        acp.child.stdin.end();
        assert.equal((await acp.done).code, 0);
    }
    finally {
        await f.close();
    }
});
it("query waiting for stdin releases startup ownership and still propagates errors", { timeout: 30_000 }, async () => {
    const f = await fixture(true);
    try {
        await symlink(join(ROOT, "node_modules"), join(f.checkout, "node_modules"), "dir");
        const log = join(f.area, "query.jsonl");
        const child = spawn(process.execPath, [join(f.checkout, "bin/mikro.mjs"), "--log", log], {
            cwd: f.area, env: f.env, stdio: ["pipe", "pipe", "pipe"],
        });
        let out = "";
        child.stdout.on("data", c => { out += c; });
        child.stderr.on("data", c => { out += c; });
        const done = new Promise((resolve, reject) => {
            child.on("error", reject);
            child.on("close", code => resolve({ code, out }));
        });
        f.processes.push({ child, done, output: () => out });
        await until(async () => child.exitCode !== null || (existsSync(log) && (await readFile(log, "utf8")).includes('"event":"run_start"')), `query startup missing: ${out}`);
        assert.equal(child.exitCode, null, out);
        const version = f.launch(["--version"], { MIKRO_INSTALL_WAIT_MS: "3000" });
        const result = await version.done;
        assert.equal(result.code, 0, result.out);
        assert.equal(child.exitCode, null, "query remains waiting while version runs");
        assert.equal(existsSync(join(f.area, "events")), false);
        child.stdin.end();
        const failed = await done;
        assert.equal(failed.code, 1, failed.out);
        assert.match(failed.out, /no query provided/);
    }
    finally {
        await f.close();
    }
});
for (const mode of ["cache", "batch", "cost", "oolong"])
    it(`${mode} model work after preparation does not own the installation mutex`, { timeout: 30_000 }, async () => {
        const f = await fixture(true);
        try {
            await symlink(join(ROOT, "node_modules"), join(f.checkout, "node_modules"), "dir");
            const module = mode === "cache" ? "rlm" : mode === "batch" ? "batch" : "benchmark";
            const names = module === "rlm" ? ["rlmLoop"] : module === "batch" ? ["runBatch"] : ["runCostBenchmark", "runOolongBenchmark"];
            // Replace only the model-work dependency in the isolated checkout. Keep
            // all other exports and the entire real CLI/launcher unchanged; no paid
            // calls occur. The marker proves command preparation reached model work.
            await writeFile(join(f.checkout, `dist/src/${module}.js`), `export * from ${JSON.stringify(new URL(`../src/${module}.js`, import.meta.url).href)};\n` + names.map(name => `export async function ${name}() { console.log('MODEL_WORK_READY'); await new Promise(() => { setInterval(() => {}, 1000); }); }`).join("\n"));
            const input = join(f.area, "input.md");
            await writeFile(input, "A fixture question and context.\n");
            const args = mode === "cache" ? ["cache", "--context", input] : mode === "batch" ? ["batch", input] : ["benchmark", mode];
            const running = start(f.area, process.execPath, [join(f.checkout, "bin/mikro.mjs"), ...args], f.env);
            f.processes.push(running);
            await until(() => running.output().includes("MODEL_WORK_READY") || running.child.exitCode !== null, `${mode} did not reach model work`);
            assert.match(running.output(), /MODEL_WORK_READY/);
            assert.equal(running.child.exitCode, null);
            const version = f.launch(["--version"], { MIKRO_INSTALL_WAIT_MS: "3000" });
            const result = await version.done;
            assert.equal(result.code, 0, result.out);
            assert.equal(running.child.exitCode, null, "model work must remain active while version runs");
            assert.equal(existsSync(join(f.area, "events")), false);
        }
        finally {
            await f.close();
        }
    });
//# sourceMappingURL=install-coordination.test.js.map