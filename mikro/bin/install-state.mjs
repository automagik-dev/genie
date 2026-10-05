/** Dependency-free coordinator for launcher, updater, and canonical installer.
 *
 * The kernel owns the mutex (an exclusive socket listen), not a removable
 * lock directory. A crashed owner cannot leave a stale mutex or race an unlink
 * against a successor. Linux uses its exact abstract-socket namespace;
 * other platforms use a non-ephemeral loopback port (collisions fail busy).
 * State and the parked tree live beside the checkout, beyond reset/clean.
 * Each worker owns a POSIX process group: recovery also waits for surviving
 * npm/build children after SIGKILL, never deciding staleness from elapsed time.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const self = fileURLToPath(import.meta.url);
export const NPM_CI_ARGS = ["ci", "--include=dev", "--no-audit", "--no-fund", "--fetch-timeout=120000", "--fetch-retries=3"];
const WAIT_MS = 120_000;

function canonicalRoot(root) {
  const full = resolve(root);
  if (existsSync(full)) return realpathSync(full);
  return join(realpathSync(dirname(full)), full.slice(dirname(full).length + 1));
}
function paths(root) {
  const state = `${root}.mikro-install`;
  return { state, owner: join(state, "owner.json"), pending: join(state, "pending.json"), parked: join(state, "node_modules.prev"), current: join(root, "node_modules") };
}
function json(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function save(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value) + "\n", { mode: 0o600 });
  renameSync(temporary, path);
}
function failure(message, exitCode = 1) {
  return Object.assign(new Error(message), { exitCode });
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw failure("invalid install owner record; refusing unsafe recovery");
  try { process.kill(process.platform === "win32" ? pid : -pid, 0); }
  catch (error) { return error.code !== "ESRCH"; }
  if (process.platform !== "linux") return true;
  // Linux kill(0) includes zombies. Orphaned npm zombies cannot write, and
  // minimal containers may not reap them promptly. Check the whole group,
  // including live children of a dead owner, rather than the owner PID alone.
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === pid && fields[0] !== "Z" && fields[0] !== "X") return true;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") return true;
    }
  }
  return false;
}
function run(root, command, args, env = {}, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root, stdio: capture ? "pipe" : "inherit", encoding: "utf8",
    shell: process.platform === "win32", env: { ...process.env, ...env },
  });
  if (result.status !== 0) throw failure(`${command} ${args.join(" ")} failed${result.stderr ? `: ${result.stderr.trim()}` : ""}`, result.status ?? 1);
  return result.stdout?.trim() ?? "";
}
const git = (root, args) => run(root, "git", args, {}, true);
export function installComplete(root) {
  return [".package-lock.json", "js-yaml/package.json", "@earendil-works/pi-ai/package.json"].every(path => existsSync(join(root, "node_modules", path)));
}

async function acquire(root) {
  // Exclusive bind has no stale-file reclamation / compare-and-unlink race.
  const hash = createHash("sha256").update(root).digest();
  // Abstract sockets have no filesystem inode and disappear on owner death.
  // They also cannot collide with unrelated ephemeral TCP connections.
  // macOS has no abstract namespace; use a conservative non-ephemeral port.
  const address = process.platform === "linux"
    ? { path: `\0mikro-install-${hash.toString("hex")}`, exclusive: true }
    : { host: "127.0.0.1", port: 1024 + hash.readUInt32BE(0) % 31744, exclusive: true };
  const configured = Number(process.env.MIKRO_INSTALL_WAIT_MS ?? WAIT_MS);
  const wait = Number.isFinite(configured) && configured >= 0 ? Math.min(configured, WAIT_MS) : WAIT_MS;
  const deadline = Date.now() + wait;
  let announced = false;
  while (true) {
    const server = createServer(socket => socket.destroy());
    const bound = await new Promise((resolveBound, reject) => {
      server.once("error", error => error.code === "EADDRINUSE" ? resolveBound(false) : reject(error));
      server.listen(address, () => resolveBound(true));
    });
    if (bound) {
      try {
        const owner = json(paths(root).owner);
        if (!owner || !alive(owner.pid)) return server;
      } catch (error) {
        await new Promise(resolveClose => server.close(resolveClose));
        throw error;
      }
      await new Promise(resolveClose => server.close(resolveClose));
    }
    if (Date.now() >= deadline) throw failure(`installation is busy for ${root}; timed out waiting for the live owner (retry later)`, 75);
    if (!announced) { console.error(`mikro: waiting for active installation under ${root}...`); announced = true; }
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  }
}

async function withOwnership(root, body) {
  const server = await acquire(root);
  const p = paths(root);
  const token = randomUUID();
  try {
    mkdirSync(p.state, { recursive: true, mode: 0o700 });
    save(p.owner, { pid: process.pid, token });
    return await body(token);
  } finally {
    // All synchronous subprocesses have settled before releasing ownership.
    // SIGKILL skips this: acquire checks the recorded process group next time.
    try {
      if (json(p.owner)?.token === token) rmSync(p.owner, { force: true });
    } finally {
      await new Promise(resolveClose => server.close(resolveClose));
    }
  }
}

function pending(root, phase) {
  save(paths(root).pending, { phase });
}
function repair(root, reinstall = false) {
  const p = paths(root);
  const legacyParked = join(root, "node_modules.prev");
  let state = json(p.pending);
  const needed = reinstall || state || !installComplete(root) || !existsSync(join(root, "dist/src/cli.js")) || existsSync(p.parked) || existsSync(legacyParked);
  if (!needed) return;

  // Validate the selected checkout under ownership before dependency mutation.
  run(root, process.execPath, [join(root, "scripts/check-npm-authority.mjs")]);
  if (existsSync(legacyParked) && !existsSync(p.parked)) renameSync(legacyParked, p.parked);
  if (existsSync(p.parked)) {
    if (!installComplete(root)) {
      rmSync(p.current, { recursive: true, force: true });
      renameSync(p.parked, p.current);
    } else {
      rmSync(p.parked, { recursive: true, force: true });
    }
    // A recovered old tree may not match the selected checkout's lock.
    if (!state) { pending(root, "install"); state = { phase: "install" }; }
  }
  if (reinstall || state?.phase === "install" || !installComplete(root)) {
    pending(root, "install");
    if (existsSync(p.current)) renameSync(p.current, p.parked);
    console.error("mikro: installing dependencies with npm ci...");
    try {
      run(root, "npm", NPM_CI_ARGS, { MIKRO_SKIP_PREPARE: "1" });
      if (!installComplete(root)) throw failure("npm ci returned without a complete dependency tree");
    } catch (error) {
      rmSync(p.current, { recursive: true, force: true });
      if (existsSync(p.parked)) renameSync(p.parked, p.current);
      console.error("mikro: npm ci failed; previous dependencies restored where available; retry to finish the selected checkout.");
      throw error;
    }
    pending(root, "build");
    rmSync(p.parked, { recursive: true, force: true });
  }
  // Persist BEFORE invoking the build: even committed dist may be stale or
  // partially overwritten when tsc fails. Unchanged SHA is not completion.
  pending(root, "build");
  console.error("mikro: building...");
  run(root, "npm", ["run", "build"]);
  if (!existsSync(join(root, "dist/src/cli.js"))) throw failure("build returned without dist/src/cli.js");
  rmSync(p.pending, { force: true });
}

function update(root, args) {
  try { git(root, ["rev-parse", "--is-inside-work-tree"]); }
  catch { throw failure("mikro update requires a git-installed checkout. Reinstall with scripts/install.sh."); }
  const force = args.includes("--force") || args.includes("-f");
  const before = git(root, ["rev-parse", "HEAD"]);
  const dirty = git(root, ["status", "--porcelain"]);
  // Partial build output is tracked: permit retry of our own pending work.
  // User changes still require --force; only generated dist is exempted.
  const pendingWork = json(paths(root).pending);
  const userDirty = pendingWork ? git(root, ["status", "--porcelain", "--", ".", ":(exclude)dist"]) : dirty;
  if (userDirty && !force) throw failure("Refusing to update with local changes. Commit/stash them or rerun with --force for managed installs.");
  console.log(`mikro update: ${root}\nbefore: ${before}`);
  try { git(root, ["fetch", "origin", "main", "--tags"]); }
  catch (error) { throw failure(`mikro update: could not fetch main (${error.message}). Re-run scripts/install.sh to repair the remote.`, error.exitCode); }
  const target = git(root, ["rev-parse", "FETCH_HEAD"]);
  console.log(`target: ${target}`);
  if (before === target && (!dirty || (pendingWork && !userDirty))) {
    repair(root);
    console.log("Already up to date.");
    return;
  }
  // Journal first: interruption immediately after reset must trigger repair.
  pending(root, "install");
  git(root, ["reset", "--hard", "FETCH_HEAD"]);
  git(root, ["clean", "-fd", "-e", "node_modules.prev/"]);
  repair(root);
  console.log(`after:  ${git(root, ["rev-parse", "HEAD"])}\nmikro v${json(join(root, "package.json")).version}`);
}

export async function runManaged(root, mode, args = []) {
  const child = spawn(process.execPath, [self, "--worker", mode, root, ...args], {
    stdio: "inherit", detached: process.platform !== "win32",
    env: { ...process.env, MIKRO_INSTALL_TOKEN: "" },
  });
  const forward = signal => {
    if (typeof child.pid !== "number") return;
    try { process.kill(process.platform === "win32" ? child.pid : -child.pid, signal); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const interrupt = () => forward("SIGINT");
  const terminate = () => forward("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    return await new Promise((resolveStatus, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolveStatus(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)));
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}

export async function launch(rawRoot, args) {
  const root = canonicalRoot(rawRoot);
  while (true) {
    const server = await acquire(root);
    const p = paths(root);
    let ready;
    let startup;
    try {
      ready = process.env.MIKRO_NO_SELF_HEAL === "1" || (installComplete(root) && existsSync(join(root, "dist/src/cli.js")) && !json(p.pending) && !existsSync(p.parked) && !existsSync(join(root, "node_modules.prev")));
      if (ready) {
        // Import in the original launcher process, under the mutex. Normal
        // CLI/MCP keeps its original stdio, signals, and process lifetime.
        process.argv = [process.execPath, join(root, "dist/src/cli.js"), ...args];
        const cli = await import(pathToFileURL(join(root, "dist/src/cli.js")).href);
        startup = cli.cliReady;
        if (!cli.installOperation) await startup;
      }
    } finally {
      await new Promise(resolveClose => server.close(resolveClose));
    }
    if (ready) { await startup; return 0; }
    const status = await runManaged(root, "repair");
    if (status !== 0) return status;
    // A competing updater may have acquired ownership in the gap; recheck.
  }
}

async function main(argv) {
  if (argv[0] !== "--worker" && !["finish", "verify"].includes(argv[0])) {
    process.exitCode = await runManaged(argv[1], argv[0], argv.slice(2));
    return;
  }
  const [mode, rawRoot, ...args] = argv[0] === "--worker" ? argv.slice(1) : argv;
  const root = canonicalRoot(rawRoot);
  if (mode === "finish" || mode === "verify") {
    const owner = json(paths(root).owner);
    if (!owner || owner.token !== process.env.MIKRO_INSTALL_TOKEN || !alive(owner.pid)) throw failure("installer does not own the installation lock");
    if (mode === "finish") repair(root, true);
    return;
  }
  await withOwnership(root, async token => {
    if (mode === "update") update(root, args);
    else if (mode === "installer") {
      pending(root, "install");
      run(dirname(root), "bash", [args[0], "--under-install-lock"], { MIKRO_INSTALL_TOKEN: token });
    } else if (mode === "repair") {
      repair(root);
    } else throw failure(`unknown installation operation: ${mode}`);
  });
}
function isDirectEntry() {
  if (!process.argv[1]) return false;
  try { return realpathSync(resolve(process.argv[1])) === realpathSync(self); }
  catch { return false; } // stdin/eval or an imported module has no file entry.
}
if (isDirectEntry()) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`mikro error: ${error.message}`);
    process.exitCode = error.exitCode ?? 1;
  });
}
