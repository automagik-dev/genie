#!/usr/bin/env node
// Experiment-local orchestration only. Never imported by a production workflow/accounting consumer.
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, readdir, lstat, realpath, readlink, chmod, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { collectOffloads, projectReportResult, reconcileSessions } from './native-session-accounting.mjs';

const SELF = fileURLToPath(import.meta.url);
const MODEL = 'deepseek-flash';
const PROVIDER = 'deepseek-official';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const sumCounts = values => {
  if (!values.every(count)) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return count(total) ? total : null;
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
const pathField = (value, name) => { assert(typeof value === 'string' && isAbsolute(value), `${name} must be an absolute path`); return value; };
const idField = value => { assert(typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,95}$/.test(value), 'invalid frozen cell id'); return value; };
const sealField = (value, name) => assert(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), `${name} must be a SHA256`);

// Reproducible immutable tree seal: sorted relative path + kind + byte hash/link text.
// Symlink targets are included as link text; installation-root seals must also include
// the dependency store itself, not just a package full of links to an unsealed store.
export async function sealTree(root) {
  const records = [];
  async function visit(path, name) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) records.push({ path: name, kind: 'symlink', target: await readlink(path) });
    else if (info.isDirectory()) {
      records.push({ path: name, kind: 'directory' });
      const entries = await readdir(path);
      for (const entry of entries.sort()) await visit(join(path, entry), name ? `${name}/${entry}` : entry);
    } else if (info.isFile()) records.push({ path: name, kind: 'file', sha256: hash(await readFile(path)) });
    else throw new Error(`unsupported frozen artifact type: ${path}`);
  }
  await visit(root, '');
  return { sha256: hash(JSON.stringify(records)), records };
}

async function writeJson(path, value, exclusive = true, redact = text => text) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, redact(`${JSON.stringify(value, null, 2)}\n`), { mode: 0o600, flag: exclusive ? 'wx' : 'w' });
}

async function immutableTree(path) {
  const info = await lstat(path);
  assert(!info.isSymbolicLink(), `immutable loader snapshot cannot contain links: ${path}`);
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) await immutableTree(join(path, entry));
    await chmod(path, 0o500);
  } else { assert(info.isFile(), `non-file loader artifact: ${path}`); await chmod(path, 0o400); }
}

function validateLaunch(launch, name) {
  assert(object(launch), `${name}.launch is required`);
  assert(typeof launch.path === 'string' && launch.path.length > 0 && launch.path.split(':').every(isAbsolute), `${name}.launch.path requires frozen absolute PATH entries`);
  assert(object(launch.env), `${name}.launch.env must contain explicit nonsecret file/profile refs`);
  for (const [key, value] of Object.entries(launch.env)) {
    assert(/^[A-Z][A-Z0-9_]*(?:FILE|HOME|DIR|ROOT|PROFILE)$/.test(key), `non-reference launch environment name refused: ${key}`);
    assert(!/PASSWORD|SECRET|TOKEN|API_KEY$/.test(key), `credential environment value refused: ${key}`);
    pathField(value, `${name}.launch.env.${key}`);
    assert(!['HOME', 'DSH_HOME', 'GENIE_HOME', 'TMPDIR'].includes(key), `isolated root override refused: ${key}`);
  }
  pathField(launch.offloadReceiptRoot, `${name}.launch.offloadReceiptRoot`);
  assert(Array.isArray(launch.seals) && launch.seals.length > 0, `${name}.launch.seals must bind arm launchers/profiles/auth references (not key bytes)`);
  for (const seal of launch.seals) {
    pathField(seal.path, 'launch seal path');
    assert(['file', 'directory'].includes(seal.kind), 'launch seal kind must be file/directory');
    sealField(seal.sha256, 'launch seal');
  }
}

function validateGithubRepository(repository) {
  assert(object(repository), 'explicit frozen GitHub repository identity required');
  idField(repository.objectiveId);
  assert(typeof repository.fullName === 'string' && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository.fullName), 'GitHub fullName must be owner/repository');
  assert(repository.url === `https://github.com/${repository.fullName}.git` || repository.url === `git@github.com:${repository.fullName}.git`, 'GitHub origin URL must match exact frozen fullName, without embedded credentials');
  assert(count(repository.repositoryId) && repository.repositoryId > 0, 'actual GitHub repositoryId required');
  assert(repository.private === true && repository.nonProduction === true, 'only explicitly private nonproduction experiment repositories are authorized');
  assert(repository.base === 'dev', 'authorized experimental GitHub base must be dev');
  assert(typeof repository.expectedParentSha === 'string' && /^[a-f0-9]{40}$/.test(repository.expectedParentSha), 'exact experimental dev parent SHA required');
  assert(object(repository.evidence), 'frozen actual GitHub repository readback evidence required');
  pathField(repository.evidence.path, 'GitHub repository readback path');
  sealField(repository.evidence.sha256, 'GitHub repository readback SHA256');
}

function validateRemoteAuthorization(authorization) {
  assert(object(authorization), 'workflow.remoteAuthorization is required for the two owner-authorized experiment repositories');
  pathField(authorization.recordPath, 'remote authorization recordPath');
  sealField(authorization.sha256, 'remote authorization SHA256');
  assert(Array.isArray(authorization.repositories) && authorization.repositories.length === 2, 'exactly two authorized private GitHub experiment repositories required');
  assert(Array.isArray(authorization.protectedRepositories) && authorization.protectedRepositories.length > 0 && authorization.protectedRepositories.every(name => typeof name === 'string' && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(name)), 'explicit actual production repository denylist required');
  const objectives = new Set();
  const repositories = new Set();
  const repositoryIds = new Set();
  for (const repository of authorization.repositories) {
    validateGithubRepository(repository);
    const name = repository.fullName.toLowerCase();
    assert(!authorization.protectedRepositories.some(protectedName => protectedName.toLowerCase() === name), 'production GitHub repository is never an experiment target');
    assert(!objectives.has(repository.objectiveId) && !repositories.has(name) && !repositoryIds.has(repository.repositoryId), 'one distinct private experiment repository per frozen objective required');
    objectives.add(repository.objectiveId); repositories.add(name); repositoryIds.add(repository.repositoryId);
  }
}

function validateCell(cell, smoke = false) {
  assert(object(cell), 'workflow cell must be an object');
  idField(cell.id);
  pathField(cell.cwd, `${cell.id}.cwd`);
  pathField(cell.gitCommonDir, `${cell.id}.gitCommonDir`);
  pathField(cell.runRoot, `${cell.id}.runRoot`);
  assert(!inside(cell.cwd, cell.runRoot) && !inside(cell.runRoot, cell.cwd), 'run/state roots must be outside and independent of the source repository');
  assert(typeof cell.sourceCommit === 'string' && /^[a-f0-9]{40}$/.test(cell.sourceCommit), 'cell.sourceCommit must be a frozen git SHA');
  assert(count(cell.deadlineMs) && cell.deadlineMs > 0, 'cell.deadlineMs must be positive');
  assert(object(cell.args), 'cell.args must be frozen real saved-wish arguments');
  const keys = new Set(['objective', 'issue', 'context', 'slug', 'base', 'repairBudget', 'model', 'gateModel', 'publishModel', 'check', 'install', 'validation', 'timestamp', 'offload', 'offloadEngine']);
  assert(Object.keys(cell.args).every(key => keys.has(key)), 'saved wish has no supported extra job/no-publish controls');
  for (const field of ['objective', 'slug', 'base', 'timestamp', 'validation']) assert(typeof cell.args[field] === 'string' && cell.args[field].trim(), `explicit frozen args.${field} required`);
  for (const field of ['check', 'install']) assert(typeof cell.args[field] === 'string', `explicit frozen args.${field} required (empty is the supported absent command)`);
  for (const field of ['model', 'gateModel', 'publishModel']) assert(cell.args[field] === MODEL, `args.${field} must be ${MODEL}`);
  assert(typeof cell.args.offload === 'boolean', 'args.offload must be explicit boolean');
  assert(['rlm', 'pi'].includes(cell.args.offloadEngine), 'args.offloadEngine must be explicit rlm/pi');
  assert(count(cell.args.repairBudget) && cell.args.repairBudget <= 2, 'saved wish repairBudget must be an explicit bounded 0..2');
  assert(!/^(?:(?:refs\/heads\/|origin\/)?(?:main|master))$/i.test(cell.args.base), 'saved wish base cannot be protected');
  validateLaunch(cell.launch, cell.id);
  assert(Array.isArray(cell.offloadLedgerRoots) && cell.offloadLedgerRoots.every(isAbsolute), 'explicit offloadLedgerRoots required');
  assert(object(cell.remotePolicy), 'explicit frozen remotePolicy required');
  assert(!smoke || cell.remotePolicy.mode === 'isolated-local', 'unscored smoke must use isolated-local origin; owner authorized only eighteen scored GitHub PRs');
  if (cell.remotePolicy.mode === 'isolated-local') {
    assert(smoke, 'isolated-local remotePolicy is valid only for an intentionally declared unscored smoke');
    assert(Array.isArray(cell.remotePolicy.roots) && cell.remotePolicy.roots.length > 0 && cell.remotePolicy.roots.every(isAbsolute), 'smoke isolated-local remote roots required');
  } else {
    assert(cell.remotePolicy.mode === 'authorized-github', 'remotePolicy must be authorized-github for scored experiments');
    validateGithubRepository(cell.remotePolicy);
    assert(cell.args.base === 'dev' && cell.sourceCommit === cell.remotePolicy.expectedParentSha, 'GitHub job base/source must bind frozen dev parent');
    if (!smoke) assert(cell.objectiveId === cell.remotePolicy.objectiveId, 'GitHub objective/repository binding differs from frozen cell');
  }
  if (!smoke) {
    idField(cell.objectiveId);
    assert(['offload-rlm', 'offload-pi', 'offload-off'].includes(cell.variant), 'invalid scored variant');
    assert([1, 2, 3].includes(cell.repetition), 'scored repetition must be 1..3');
    assert(cell.args.offload === (cell.variant !== 'offload-off'), 'frozen treatment/args mismatch');
    if (cell.args.offload) assert(cell.args.offloadEngine === cell.variant.slice(8), 'frozen engine/variant mismatch');
  }
}

export function validateWorkflow(workflow) {
  assert(object(workflow) && workflow.schemaVersion === 1, 'manifest.workflow.schemaVersion must be 1');
  for (const field of ['runtime', 'loader', 'source', 'auth']) assert(object(workflow[field]), `manifest.workflow.${field} is required`);
  pathField(workflow.runtime.root, 'workflow.runtime.root');
  pathField(workflow.runtime.node, 'workflow.runtime.node');
  assert(workflow.runtime.version === '0.2.0-rc.1', 'freeze installed public DSH 0.2.0-rc.1');
  sealField(workflow.runtime.treeSha256, 'runtime.treeSha256');
  pathField(workflow.loader.root, 'workflow.loader.root');
  assert(typeof workflow.loader.version === 'string' && workflow.loader.version, 'actual loader version must be frozen');
  sealField(workflow.loader.treeSha256, 'loader.treeSha256');
  pathField(workflow.source.wishPath, 'workflow.source.wishPath');
  sealField(workflow.source.sha256, 'source.sha256');
  pathField(workflow.auth.controlKeyFile, 'workflow.auth.controlKeyFile');
  assert(Array.isArray(workflow.confounds) && workflow.confounds.length > 0, 'freeze explicit source/version/dependency/rate/runtime confounds');
  pathField(workflow.receiptPath, 'workflow.receiptPath');
  pathField(workflow.smokeReceiptPath, 'workflow.smokeReceiptPath');
  validateRemoteAuthorization(workflow.remoteAuthorization);
  validateCell(workflow.smoke, true);
  assert(Array.isArray(workflow.cells) && workflow.cells.length === 18, 'exactly eighteen frozen scored saved-workflow cells required');
  const ids = new Set([workflow.smoke.id]);
  const cwds = new Set([workflow.smoke.cwd]);
  const common = new Set([workflow.smoke.gitCommonDir]);
  const states = new Set([workflow.smoke.runRoot]);
  const receiptRoots = new Set([workflow.smoke.launch.offloadReceiptRoot]);
  const objectives = new Map();
  const pairs = new Set();
  for (const cell of workflow.cells) {
    validateCell(cell);
    assert(!ids.has(cell.id) && !cwds.has(cell.cwd) && !common.has(cell.gitCommonDir) && !states.has(cell.runRoot) && !receiptRoots.has(cell.launch.offloadReceiptRoot), 'cells must have independent identities/repositories/git common dirs/state/SDK receipt roots');
    ids.add(cell.id); cwds.add(cell.cwd); common.add(cell.gitCommonDir); states.add(cell.runRoot); receiptRoots.add(cell.launch.offloadReceiptRoot);
    const control = { ...cell.args };
    for (const key of ['slug', 'timestamp', 'offload', 'offloadEngine']) delete control[key];
    const frozen = JSON.stringify(Object.fromEntries(Object.entries(control).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
    assert(!objectives.has(cell.objectiveId) || objectives.get(cell.objectiveId) === frozen, 'matched objective controls differ across treatments');
    objectives.set(cell.objectiveId, frozen);
    const pair = `${cell.objectiveId}/${cell.variant}/${cell.repetition}`;
    assert(!pairs.has(pair), 'duplicate frozen objective/variant/repetition'); pairs.add(pair);
  }
  assert(objectives.size === 2 && pairs.size === 18, 'two real objectives × three treatments × three repetitions required');
  const githubBranches = new Set();
  for (const cell of [workflow.smoke, ...workflow.cells]) {
    if (cell.remotePolicy.mode !== 'authorized-github') continue;
    const repository = workflow.remoteAuthorization.repositories.find(candidate => candidate.objectiveId === cell.remotePolicy.objectiveId);
    const policyIdentity = Object.fromEntries(Object.entries(cell.remotePolicy).filter(([key]) => key !== 'mode'));
    assert(repository && isDeepStrictEqual(repository, policyIdentity), 'cell GitHub remote must exactly match one frozen owner-authorized repository');
    assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cell.args.slug) && cell.args.slug.length <= 48, 'GitHub experiment slug must already be canonical under saved wish slugify/48-character bound');
    const branch = `${cell.remotePolicy.fullName.toLowerCase()}/wish/${cell.args.slug}`;
    assert(!githubBranches.has(branch), 'experimental GitHub cells must not share/adopt another frozen run branch or PR');
    githubBranches.add(branch);
  }
  assert(workflow.remoteAuthorization.repositories.every(repository => objectives.has(repository.objectiveId)), 'authorization and scored objective identities differ');
  const allRoots = [...states];
  for (let a = 0; a < allRoots.length; a++) for (let b = a + 1; b < allRoots.length; b++) assert(!inside(allRoots[a], allRoots[b]) && !inside(allRoots[b], allRoots[a]), 'nested/shared native state roots refused');
  return workflow;
}

function scrubbedEnvironment(cell) {
  // Deliberately do not copy host environment. DSH's native subprocess service
  // performs its own additional sensitive-name scrub, and never sees our secret snapshot.
  const runtimeRoot = join(cell.cwd, '.g8-runtime');
  assert(!Object.hasOwn(cell.launch.env, 'XDG_CONFIG_HOME') && !Object.hasOwn(cell.launch.env, 'XDG_CACHE_HOME'), 'observer-derived XDG root overrides refused');
  return {
    HOME: join(runtimeRoot, 'home'), DSH_HOME: join(cell.runRoot, 'dsh'),
    GENIE_HOME: join(runtimeRoot, 'genie'), TMPDIR: join(runtimeRoot, 'tmp'),
    XDG_CONFIG_HOME: join(runtimeRoot, 'home', '.config'), XDG_CACHE_HOME: join(runtimeRoot, 'home', '.cache'),
    PATH: cell.launch.path, LANG: 'C.UTF-8', DSH_TELEMETRY_DISABLED: '1',
    MIKRO_EXPERIMENT_RECEIPT_DIR: cell.launch.offloadReceiptRoot,
    ...cell.launch.env,
  };
}

// Used by the actual run and isolated public-SDK/filesystem probes; never launches a model.
export async function prepareNativeEnvironment(cell) {
  validateLaunch(cell.launch, 'native environment');
  assert(await realpath(cell.cwd) === cell.cwd, 'native environment repository cwd must be canonical');
  const env = scrubbedEnvironment(cell);
  const runtimeRoot = join(cell.cwd, '.g8-runtime');
  for (const directory of [runtimeRoot, env.HOME, env.GENIE_HOME, env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME]) {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(directory);
    assert(info.isDirectory() && !info.isSymbolicLink(), `native runtime directory must not be a symlink: ${directory}`);
    assert(await realpath(directory) === directory && inside(runtimeRoot, directory), `native runtime directory escapes its canonical clone: ${directory}`);
    assert((info.mode & 0o077) === 0, `native runtime directory must be private: ${directory}`);
  }
  return env;
}

async function command(executable, args, { cwd, env, signal, logPath, forwardInterrupt = false }) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    const stdout = [];
    let killTimer;
    let interrupted = false;
    const interrupt = () => { interrupted = true; abort(); };
    const abort = () => { child.kill('SIGTERM'); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 6000); };
    signal?.addEventListener('abort', abort, { once: true });
    if (forwardInterrupt) { process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt); }
    if (signal?.aborted) abort();
    child.stdout.on('data', bytes => { chunks.push(bytes); stdout.push(bytes); });
    child.stderr.on('data', bytes => chunks.push(bytes));
    child.once('error', error => {
      clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
      reject(error);
    });
    child.once('close', async (code, terminationSignal) => {
      clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
      const bytes = Buffer.concat(chunks);
      try {
        if (logPath) await writeFile(logPath, bytes, { flag: 'wx', mode: 0o600 });
        resolvePromise({ code, signal: terminationSignal, interrupted, stdout: Buffer.concat(stdout).toString('utf8') });
      } catch (error) { reject(error); }
    });
  });
}

async function git(cell, ...args) {
  const result = await command('git', ['-C', cell.cwd, ...args], { cwd: cell.cwd, env: scrubbedEnvironment(cell) });
  assert(result.code === 0, `read-only git provenance failed: ${args[0]}`);
  return result.stdout.trim();
}

async function preflight(workflow, cell) {
  const runtime = await sealTree(workflow.runtime.root);
  assert(runtime.sha256 === workflow.runtime.treeSha256, 'runtime installation/dependency tree changed before outcomes');
  assert(cell.launch.seals.some(seal => seal.kind === 'file' && seal.path === workflow.runtime.node), 'native Node executable requires a frozen file seal');
  for (const link of runtime.records.filter(record => record.kind === 'symlink')) {
    const target = await realpath(join(workflow.runtime.root, link.path));
    assert(inside(workflow.runtime.root, target) || cell.launch.seals.some(seal => seal.kind === 'directory' && inside(seal.path, target)), 'runtime dependency link escapes the sealed installation/store graph');
  }
  const packageRoot = join(workflow.runtime.root, 'node_modules', '@deepseek-ai', 'dsh');
  const sdkPackage = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert(sdkPackage.version === workflow.runtime.version, 'runtime package version differs from frozen manifest');
  const loader = await sealTree(workflow.loader.root);
  assert(loader.sha256 === workflow.loader.treeSha256, 'installed loader tree changed before outcomes');
  const loaderPackage = JSON.parse(await readFile(join(workflow.loader.root, 'package.json'), 'utf8'));
  assert(loaderPackage.version === workflow.loader.version, 'installed loader version differs from frozen manifest');
  const source = await readFile(workflow.source.wishPath);
  assert(hash(source) === workflow.source.sha256, 'saved integration wish source changed before outcomes');
  for (const seal of cell.launch.seals) {
    // Only public launchers/profiles/configs are sealed. Secret file bytes must NEVER be seals.
    assert(seal.path !== workflow.auth.controlKeyFile, 'private key cannot be a byte-sealed artifact');
    const actual = seal.kind === 'file' ? hash(await readFile(seal.path)) : (await sealTree(seal.path)).sha256;
    assert(actual === seal.sha256, `frozen arm launch binding changed: ${seal.path}`);
  }
  assert(await realpath(cell.cwd) === cell.cwd && await realpath(cell.gitCommonDir) === cell.gitCommonDir, 'repository/common-directory paths must be canonical and independent');
  assert(await git(cell, 'rev-parse', 'HEAD') === cell.sourceCommit, 'source repository differs from frozen cell commit');
  assert(resolve(cell.cwd, await git(cell, 'rev-parse', '--git-common-dir')) === cell.gitCommonDir, 'actual git common dir differs from frozen cell');
  assert(await git(cell, 'status', '--porcelain') === '', 'saved workflow source repository must start clean');
  const remotes = (await git(cell, 'remote')).split('\n').filter(Boolean);
  assert(remotes.length === 1 && remotes[0] === 'origin', 'saved wish requires exactly the explicitly authorized origin; additional remotes are refused');
  const remoteFacts = [];
  for (const name of remotes) {
    for (const direction of ['fetch', 'push']) {
      const urls = (await git(cell, 'remote', 'get-url', ...(direction === 'push' ? ['--push'] : []), '--all', name)).split('\n');
      for (const url of urls) {
        if (cell.remotePolicy.mode === 'isolated-local') {
          assert(isAbsolute(url) && cell.remotePolicy.roots.some(root => inside(root, url)), 'smoke remote is outside frozen isolated-local roots');
          assert(await realpath(url) === url, 'smoke remote target must be canonical');
        } else assert(url === cell.remotePolicy.url, 'GitHub origin differs from exact authorized experiment repository');
        remoteFacts.push({ name, direction, url });
      }
    }
  }
  if (cell.remotePolicy.mode === 'authorized-github') {
    const authorization = workflow.remoteAuthorization;
    const authorizationBytes = await readFile(authorization.recordPath);
    assert(hash(authorizationBytes) === authorization.sha256, 'owner GitHub authorization record changed before dispatch');
    const record = JSON.parse(authorizationBytes.toString('utf8'));
    assert(record.schemaVersion === 1 && record.kind === 'native-workflow-forge-authorization' && record.authorized === true && record.authorizedBy === 'owner' && typeof record.approvalRef === 'string' && record.approvalRef.trim(), 'explicit owner GitHub authorization provenance missing');
    assert(record.repositoryCount === 2 && record.pullRequestLimit === 18, 'owner authorization must cover exactly two experiment repositories and eighteen experimental PRs');
    assert(isDeepStrictEqual(record.repositories, authorization.repositories) && isDeepStrictEqual(record.protectedRepositories, authorization.protectedRepositories), 'authorization record repository/production boundaries differ from frozen manifest');
    for (const repository of authorization.repositories) {
      const evidenceBytes = await readFile(repository.evidence.path);
      assert(hash(evidenceBytes) === repository.evidence.sha256, 'actual GitHub repository readback evidence changed');
      const evidence = JSON.parse(evidenceBytes.toString('utf8'));
      assert(evidence.id === repository.repositoryId && evidence.full_name === repository.fullName && evidence.private === true && (evidence.clone_url === repository.url || evidence.ssh_url === repository.url), 'GitHub readback does not establish exact authorized private repository identity');
    }
    const parent = cell.remotePolicy.expectedParentSha;
    assert(await git(cell, 'rev-parse', 'refs/remotes/origin/dev') === parent, 'local origin/dev differs from frozen experiment parent');
    const remoteHead = await git(cell, 'ls-remote', '--exit-code', 'origin', 'refs/heads/dev');
    assert(remoteHead === `${parent}\trefs/heads/dev`, 'actual authorized remote dev differs from frozen experiment parent');
    remoteFacts.push({ authorizationRecordPath: authorization.recordPath, authorizationSha256: authorization.sha256, objectiveId: cell.remotePolicy.objectiveId, fullName: cell.remotePolicy.fullName, repositoryId: cell.remotePolicy.repositoryId, private: true, expectedParentSha: parent, remoteHead });
  }
  // Catalog selection is independent of the Agent's repository cwd. The loader
  // reads a private byte-identical catalog while stage agents use the frozen parent
  // tree. Never overlay/replace/drop a workflow or a truth path in that source tree.
  return { packageRoot, runtime, loader, source, remoteFacts };
}

function observe(ctx, path, redact, blockers) {
  const events = [];
  const runs = new Map();
  const disposers = [];
  const started = performance.now();
  let writes = Promise.resolve();
  const capture = (type, info, payload) => {
    const event = { type, wallTime: new Date().toISOString(), monotonicMs: performance.now() - started, runId: info.id, meta: info.meta, payload };
    events.push(event);
    writes = writes.then(() => writeFile(path, redact(`${JSON.stringify(event)}\n`), { flag: 'a', mode: 0o600 })).catch(error => { blockers.push(`observer journal write failed: ${error.code ?? error.name}`); });
    let run = runs.get(info.id);
    if (!run) { run = { id: info.id, meta: info.meta, stages: new Map(), progress: [] }; runs.set(info.id, run); }
    if (type === 'workflow/start') {
      if (run.start) blockers.push('duplicate workflow/start');
      run.start = event;
    } else if (type === 'workflow/phase') run.progress.push({ type: 'workflow_phase', index: run.progress.length, title: payload });
    else if (type === 'workflow/agent-start') {
      if (run.stages.has(payload.seq)) blockers.push('duplicate workflow agent sequence');
      run.stages.set(payload.seq, { ...payload, startMs: event.monotonicMs, endMs: null, outcome: null });
      run.progress.push({ type: 'workflow_agent', index: run.progress.length, seq: payload.seq, childId: payload.childId, label: payload.label, phaseTitle: payload.phase ?? null });
    } else if (type === 'workflow/agent-end') {
      const stage = run.stages.get(payload.seq);
      if (!stage || stage.childId !== payload.childId || stage.endMs !== null) blockers.push('unpaired/conflicting workflow child end');
      else { stage.endMs = event.monotonicMs; stage.outcome = payload.outcome; }
    } else if (type === 'workflow/end') {
      if (run.end) blockers.push('duplicate workflow/end');
      run.end = event; run.result = payload;
    }
  };
  disposers.push(ctx.on('workflow/start', info => capture('workflow/start', info, null), { global: true }));
  for (const type of ['workflow/phase', 'workflow/log', 'workflow/agent-start', 'workflow/agent-end', 'workflow/end']) {
    disposers.push(ctx.on(type, (info, payload) => capture(type, info, payload), { global: true }));
  }
  // Public request waterfall: enforce every actual child route before transport.
  // This is a guard, NOT a substitute model choice or served-model evidence.
  disposers.push(ctx.on('agent/request', async (_payload, next) => {
    const request = await next();
    assert(request.provider === PROVIDER && request.model === MODEL, 'non-Flash native request refused before transport');
    return request;
  }, { global: true, prepend: true }));
  return { runs, events, async drain() { await writes; }, dispose() { for (const dispose of disposers.reverse()) dispose(); } };
}

async function privateControlKey(path) {
  const info = await lstat(path);
  assert(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0, 'control key reference must be an owner-only regular file');
  assert(typeof process.getuid !== 'function' || info.uid === process.getuid(), 'control key file must belong to the invoking operator');
  const value = (await readFile(path, 'utf8')).trim();
  assert(value.length > 0 && !/[\r\n]/.test(value), 'control key file must contain one nonempty private value');
  return value;
}

async function runCell(manifest, manifestSha256, cell, smoke) {
  const workflow = manifest.workflow;
  // The supervisor exclusively claimed runRoot; this process owns everything below it.
  const receiptPath = join(cell.runRoot, 'receipt.json');
  const raw = { schemaVersion: 1, kind: 'native-workflow-run', manifestSha256, id: cell.id, objectiveId: cell.objectiveId ?? null, variant: cell.variant ?? 'unscored-smoke', repetition: cell.repetition ?? null, scored: !smoke, runId: null, parentSessionId: null, outcome: null, complete: false, blockers: [], startedAt: new Date().toISOString(), frozenArgs: cell.args, confounds: workflow.confounds };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('frozen deadline exceeded')), cell.deadlineMs);
  const interrupt = () => abort.abort(new Error('operator cancelled'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  let boot;
  let handle;
  let observer;
  let deriveUsage;
  let measuredRun;
  let redact = text => text;
  try {
    const frozen = await preflight(workflow, cell);
    raw.provenance = { source: { path: workflow.source.wishPath, sha256: workflow.source.sha256 }, runtime: { root: workflow.runtime.root, version: workflow.runtime.version, treeSha256: frozen.runtime.sha256 }, loader: { root: workflow.loader.root, version: workflow.loader.version, treeSha256: frozen.loader.sha256 }, remoteFacts: frozen.remoteFacts, launchSeals: cell.launch.seals };
    await writeJson(join(cell.runRoot, 'prelaunch.json'), raw);
    for (const dir of ['dsh', 'empty-catalog', 'journals', 'sessions']) await mkdir(join(cell.runRoot, dir), { mode: 0o700 });
    const env = await prepareNativeEnvironment(cell);
    await mkdir(cell.launch.offloadReceiptRoot, { mode: 0o700, recursive: false });
    const snapshotRoot = join(cell.runRoot, 'loader-snapshot');
    await cp(workflow.loader.root, snapshotRoot, { recursive: true, dereference: false, errorOnExist: true, force: false });
    assert((await sealTree(snapshotRoot)).sha256 === workflow.loader.treeSha256, 'loader snapshot changed during copy');
    await immutableTree(snapshotRoot);
    const catalogRoot = join(cell.runRoot, 'catalog-host');
    const catalogDir = join(catalogRoot, '.claude', 'workflows');
    await mkdir(catalogDir, { recursive: true, mode: 0o700 });
    const catalogWish = join(catalogDir, 'wish.js');
    await writeFile(catalogWish, frozen.source, { mode: 0o400, flag: 'wx' });
    const require = createRequire(join(frozen.packageRoot, 'package.json'));
    const load = async specifier => await import(pathToFileURL(require.resolve(specifier)).href);
    const { initializeProfileFromDefault, runProfile } = await load('@deepseek-ai/dsh/profile-boot');
    const { createLaunchEnvironmentSnapshot } = await load('@deepseek-ai/dsh-launch-environment');
    const { installModelSelection } = await load('@deepseek-ai/dsh-agent');
    const { deriveTurnTokenUsage } = await load('@deepseek-ai/dsh-token-meter/client');
    deriveUsage = deriveTurnTokenUsage;
    // Process-layer roots are nonsecret; the credential is supplied only in the snapshot below.
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    process.chdir(cell.cwd);
    raw.stateRoots = { dshHome: env.DSH_HOME, profileRoot: join(env.DSH_HOME, 'profiles', `experiment-${cell.id}`), genieHome: env.GENIE_HOME, sessions: join(cell.runRoot, 'sessions'), journals: join(cell.runRoot, 'journals'), sdkReceipts: cell.launch.offloadReceiptRoot };
    const profile = `experiment-${cell.id}`;
    initializeProfileFromDefault(profile, 'headless', env.DSH_HOME);
    const install = await command(workflow.runtime.node, [join(frozen.packageRoot, 'lib', 'bin.js'), 'plugin', '--profile', profile, 'add', snapshotRoot], { cwd: cell.cwd, env, signal: abort.signal, logPath: join(cell.runRoot, 'plugin-install.log') });
    raw.pluginInstall = { code: install.code, signal: install.signal, logPath: join(cell.runRoot, 'plugin-install.log') };
    assert(install.code === 0, 'supported isolated plugin installation failed; retain install receipt');
    assert((await sealTree(snapshotRoot)).sha256 === workflow.loader.treeSha256, 'supported plugin installation mutated frozen loader snapshot');
    const patch = [
      { id: 'headless-runner', disabled: true },
      { id: 'headless-startup', disabled: true },
      { id: 'session-title-llm', disabled: true },
      { id: 'agent-default-model', config: { provider: PROVIDER, model: MODEL } },
      { id: 'tools', config: { mode: 'native' } },
      { id: 'session-persistence-jsonl', config: { root: join(cell.runRoot, 'sessions'), compression: 'none' } },
      { id: 'credentials', config: { path: join(env.DSH_HOME, '.credentials.yaml'), dshHome: env.DSH_HOME, watch: false } },
      { id: 'llm-deepseek', config: { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
      { id: 'genie-dsh-workflow-loader', config: { toolName: 'workflow_run', userRoot: join(cell.runRoot, 'empty-catalog'), journalDir: join(cell.runRoot, 'journals'), allowShadowing: false, maxResultChars: 20000 } },
      { id: 'workflow-ptc', config: { provider: 'spawn', maxConcurrentAgents: 1, maxTotalAgents: 32 } },
    ];
    const patchPath = join(cell.runRoot, 'observer.patch.yml');
    await writeFile(patchPath, `${JSON.stringify(patch, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
    raw.provenance.patchSha256 = hash(await readFile(patchPath));
    // Secret resolution is per invocation, after source/package freeze and isolated install.
    // Sandbox read confinement does NOT deny reading this file; no such privacy claim is made.
    const secret = await privateControlKey(workflow.auth.controlKeyFile);
    redact = text => text.split(secret).join('[REDACTED-CONTROL-CREDENTIAL]');
    const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: { ...env, DEEPSEEK_API_KEY: secret } }]);
    const signalListeners = new Map(['SIGTERM', 'SIGINT'].map(signal => [signal, new Set(process.listeners(signal))]));
    boot = await runProfile({ environment, profile, patchFiles: [patchPath], args: [] });
    // runProfile installs CLI signal handlers. This programmatic composition owns
    // cancellation, durable receipts, and shutdown ordering instead of tearing down
    // the observer immediately on the CLI's signal handler.
    for (const [signal, previous] of signalListeners) {
      for (const listener of process.listeners(signal)) if (!previous.has(listener)) process.removeListener(signal, listener);
    }
    observer = observe(boot.ctx, join(cell.runRoot, 'workflow-events.jsonl'), redact, raw.blockers);
    raw.parentSessionId = randomUUID();
    handle = await boot.ctx.agents.create({ sessionId: raw.parentSessionId, meta: { cwd: cell.cwd, delegationDepth: 0 }, agentOptions: { provider: PROVIDER, model: MODEL }, signal: abort.signal, setup(agentCtx) { installModelSelection(agentCtx, { current: { provider: PROVIDER, model: MODEL }, assembled: undefined }); } });
    await handle.agent.whenIdle();
    raw.dispatch = { toolCallId: randomUUID(), name: 'workflow_run', mode: 'native', modelRequested: false, parentTokenFabricated: false };
    await writeJson(join(cell.runRoot, 'dispatch.json'), { manifestSha256, id: cell.id, parentSessionId: raw.parentSessionId, ...raw.dispatch }, true, redact);
    try {
      raw.toolResult = await boot.ctx.tools.execute({ callId: raw.dispatch.toolCallId, name: 'workflow_run', arguments: { name: 'wish', cwd: catalogRoot, args: cell.args }, agent: handle.agent, signal: abort.signal });
    } catch (error) {
      raw.dispatchError = { name: error.name, code: error.code ?? null, message: redact(error.message ?? String(error)) };
    }
    if (raw.dispatchError || raw.toolResult?.isError !== false) raw.blockers.push('registered native workflow_run dispatch failed; genuine tool failure retained');
    await observer.drain();
    assert(observer.runs.size === 1, 'exactly one actual saved workflow must start per frozen invocation');
    const run = [...observer.runs.values()][0];
    measuredRun = run;
    raw.runId = run.id;
    raw.outcome = run.result?.stopReason ?? null;
    raw.acceptedAgentCount = run.result?.agentsStarted ?? null;
    raw.publishedAgentCount = run.stages.size;
    raw.lifecycle = observer.events;
    if (!run.start || !run.end) raw.blockers.push('workflow start/end not both observed');
    if (raw.acceptedAgentCount !== raw.publishedAgentCount) raw.blockers.push('accepted vs published child accounting differs');
    raw.durationMs = run.start && run.end ? run.end.monotonicMs - run.start.monotonicMs : null;
    const journals = [];
    for (const entry of await readdir(join(cell.runRoot, 'journals'))) {
      if (!entry.endsWith('.json')) continue;
      const path = join(cell.runRoot, 'journals', entry);
      const bytes = await readFile(path);
      const value = JSON.parse(bytes.toString('utf8'));
      if (value.runId === raw.runId) journals.push({ path, sha256: hash(bytes), value });
    }
    raw.loaderJournals = journals;
    if (raw.outcome === 'completed' && journals.length !== 1) raw.blockers.push('completed loader journal missing/ambiguous');
    raw.savedResult = journals.length === 1 ? journals[0].value.value : null;
    // Header lineage discovers nested genuine sessions as well as workflow published children.
    const snapshots = await boot.ctx.sessionPersistence.list();
    const owned = new Set([raw.parentSessionId, ...[...run.stages.values()].map(stage => stage.childId)]);
    let changed;
    do {
      changed = false;
      for (const snapshot of snapshots) if (owned.has(snapshot.header.parentSession) && !owned.has(snapshot.header.id)) { owned.add(snapshot.header.id); changed = true; }
    } while (changed);
    const reconciled = await reconcileSessions(boot.ctx, [...owned], deriveTurnTokenUsage);
    raw.sessions = reconciled.sessions;
    raw.blockers.push(...reconciled.blockers);
    for (const session of raw.sessions) raw.blockers.push(...session.blockers.map(reason => `${session.sessionId}: ${reason}`));
    const measured = new Map(raw.sessions.map(session => [session.sessionId, session]));
    raw.workflowProgress = run.progress.map(entry => {
      if (entry.type !== 'workflow_agent') return entry;
      const stage = run.stages.get(entry.seq);
      const bill = measured.get(stage.childId)?.accounting;
      const routes = bill?.servedRoutes ?? [];
      const model = routes.length === 1 ? routes[0].model : null;
      if (!bill || model === null || stage.endMs === null) raw.blockers.push(`stage ${stage.seq} missing accounting/served model/lifecycle`);
      const descendants = new Set([stage.childId]);
      let added;
      do {
        added = false;
        for (const session of raw.sessions) if (descendants.has(session.header?.parentSession) && !descendants.has(session.sessionId)) { descendants.add(session.sessionId); added = true; }
      } while (added);
      const attributed = [...descendants].map(id => measured.get(id)?.accounting);
      const tokens = sumCounts(attributed.map(accounting => accounting?.totals.totalTokens));
      const toolCalls = sumCounts(attributed.map(accounting => accounting?.toolCalls));
      if (tokens === null || toolCalls === null) raw.blockers.push(`stage ${stage.seq} descendant accounting unknown`);
      return { ...entry, state: stage.outcome, model, tokens, toolCalls, attributedSessionIds: [...descendants], durationMs: stage.endMs === null ? null : stage.endMs - stage.startMs };
    });
    const exactTotals = raw.sessions.map(session => session.accounting?.totals.totalTokens);
    raw.native = { totalTokens: sumCounts(exactTotals), totalToolCalls: sumCounts(raw.sessions.map(session => session.accounting?.toolCalls)), billSource: 'canonical persisted own-suffix turns/tool calls; each actual session counted once, no inherited prefix or fabricated parent dispatch call', sdkNominalCostUsd: null, gatewayInvoice: null, keeperAggregate: null };
    if (raw.native.totalTokens === null || raw.native.totalToolCalls === null) raw.blockers.push('native aggregate token/tool-call accounting unknown');
    const calls = raw.sessions.flatMap(session => (session.accounting?.modelToolCalls ?? []).map(call => ({ sessionId: session.sessionId, ...call })));
    raw.offload = await collectOffloads(cell.offloadLedgerRoots, cell.launch.offloadReceiptRoot, cell.launch.seals, cell.args.slug, cell.args.offload, cell.args.offloadEngine, calls);
    raw.blockers.push(...raw.offload.blockers);
    const projected = projectReportResult(raw.savedResult, raw.offload);
    raw.reportResult = projected.result;
    raw.reportOffloadProjection = projected.projection;
    raw.blockers.push(...projected.blockers);
    // Confirm the actual catalog source of the loader completion, not a requested path label.
    for (const journal of journals) {
      assert(hash(await readFile(journal.value.source)) === workflow.source.sha256, 'actual served saved-workflow source differs from frozen bytes');
    }
    assert((await sealTree(snapshotRoot)).sha256 === workflow.loader.treeSha256, 'executed loader snapshot changed');
    if (raw.outcome !== 'completed') raw.blockers.push(`workflow engine outcome ${raw.outcome ?? 'unknown'}; raw failure/cancellation retained`);
    if (smoke && !raw.workflowProgress.some(entry => entry.type === 'workflow_agent' && entry.model === MODEL)) raw.blockers.push('unscored smoke lacks actual served Flash child');
    raw.blockers = [...new Set(raw.blockers)];
    raw.complete = raw.blockers.length === 0 && count(raw.native.totalTokens) && count(raw.native.totalToolCalls) && Number.isFinite(raw.durationMs);
  } catch (error) {
    raw.blockers.push(redact(error.message ?? String(error)));
    raw.failure = { name: error.name, code: error.code ?? null };
    raw.complete = false;
  } finally {
    // Preserve failed/cancelled event receipts even when dispatch/provenance failed
    // before the main reconciliation. Flush before owned Agent disposal.
    if (observer) raw.lifecycle = observer.events;
    if (boot) {
      try { await boot.ctx.sessionPersistence.flush(); } catch (error) { raw.blockers.push(`final flush failed: ${error.code ?? error.name}`); raw.complete = false; }
    }
    await observer?.drain();
    observer?.dispose();
    try { await handle?.dispose(); } catch (error) { raw.blockers.push(`agent disposal failed: ${error.code ?? error.name}`); raw.complete = false; }
    if (boot && deriveUsage) {
      try {
        const ids = (await boot.ctx.sessionPersistence.list()).map(snapshot => snapshot.header.id);
        raw.finalReconciliation = await reconcileSessions(boot.ctx, ids, deriveUsage);
        const finalBlockers = [...raw.finalReconciliation.blockers, ...raw.finalReconciliation.sessions.flatMap(session => session.blockers)];
        if (finalBlockers.length) { raw.blockers.push(...finalBlockers); raw.complete = false; }
        const finalTotals = raw.finalReconciliation.sessions.map(session => session.accounting?.totals.totalTokens);
        const total = sumCounts(finalTotals);
        if (raw.native && total !== raw.native.totalTokens) { raw.blockers.push('teardown canonical native bill differs from measured cut'); raw.complete = false; }
        const toolCalls = sumCounts(raw.finalReconciliation.sessions.map(session => session.accounting?.toolCalls));
        if (raw.native && toolCalls !== raw.native.totalToolCalls) { raw.blockers.push('teardown canonical own-session tool-call aggregate differs from measured cut'); raw.complete = false; }
      } catch (error) { raw.blockers.push(`teardown reconciliation failed: ${error.code ?? error.name}`); raw.complete = false; }
    }
    clearTimeout(timer);
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    raw.finishedAt = new Date().toISOString();
    raw.cancelled = abort.signal.aborted;
    if (raw.cancelled) { raw.blockers.push('deadline/operator cancellation'); raw.complete = false; }
    raw.blockers = [...new Set(raw.blockers)];
    if (boot) {
      try { await boot.shutdown.shutdown(raw.complete ? 0 : 2); }
      catch (error) { raw.blockers.push(`profile shutdown failed: ${error.code ?? error.name}`); raw.complete = false; }
    }
    if (raw.complete && measuredRun) {
      raw.recordPath = join(cell.runRoot, raw.parentSessionId, 'workflows', `${raw.runId}.json`);
      await writeJson(raw.recordPath, {
        runId: raw.runId, workflowName: measuredRun.meta.name, durationMs: raw.durationMs,
        totalTokens: raw.native.totalTokens, totalToolCalls: raw.native.totalToolCalls, agentCount: raw.publishedAgentCount, workflowProgress: raw.workflowProgress,
        engineOutcome: raw.outcome, result: raw.reportResult, savedResultEvidence: raw.savedResult,
        reportOffloadProjection: raw.reportOffloadProjection, nativeAccounting: raw.native, offloadAccounting: raw.offload,
        acceptedAgentCount: raw.acceptedAgentCount, parentSessionId: raw.parentSessionId, manifestSha256,
      }, true, redact);
    }
    await writeJson(receiptPath, raw, true, redact);
  }
  return raw;
}

async function readReceipt(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function comparison(workflow, manifestSha256) {
  const smoke = await readReceipt(join(workflow.smoke.runRoot, 'receipt.json'));
  const cells = [];
  const blockers = [];
  for (const cell of workflow.cells) {
    const receiptPath = join(cell.runRoot, 'receipt.json');
    const receipt = await readReceipt(receiptPath);
    const matches = receipt?.manifestSha256 === manifestSha256 && receipt?.id === cell.id && receipt?.scored === true;
    cells.push({ id: cell.id, objectiveId: cell.objectiveId, variant: cell.variant, repetition: cell.repetition, receiptPath, runId: receipt?.runId ?? null, parentSessionId: receipt?.parentSessionId ?? null, outcome: receipt?.outcome ?? null, complete: matches && receipt.complete === true, blockers: receipt?.blockers ?? ['frozen cell unexecuted'] });
    if (!matches || receipt?.complete !== true) blockers.push(`${cell.id}: missing/incomplete provenance or accounting`);
  }
  const smokeComplete = smoke?.manifestSha256 === manifestSha256 && smoke?.scored === false && smoke?.complete === true;
  if (!smokeComplete) blockers.push('genuine unscored saved-workflow route/accounting smoke missing');
  const result = { schemaVersion: 1, kind: 'native-workflow-comparison', manifestSha256, smoke: { id: workflow.smoke.id, receiptPath: join(workflow.smoke.runRoot, 'receipt.json'), complete: smokeComplete }, expectedCells: 18, cells, complete: blockers.length === 0, blockers };
  await writeJson(workflow.receiptPath, result, false);
  return result;
}

function parseCli(argv) {
  const options = { mode: 'smoke', append: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--manifest' || arg === '--cell' || arg === '--internal-cell') { assert(argv[index + 1], `${arg} requires a value`); options[arg.slice(2)] = argv[++index]; }
    else if (arg === '--smoke') options.mode = 'smoke';
    else if (arg === '--scored') options.mode = 'scored';
    else if (arg === '--append') options.append = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  pathField(options.manifest, '--manifest');
  assert(!options.cell || options.mode === 'scored', '--cell selects only explicitly frozen scored cells');
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  const bytes = await readFile(options.manifest);
  const manifestSha256 = hash(bytes);
  const manifest = JSON.parse(bytes.toString('utf8'));
  const workflow = validateWorkflow(manifest.workflow);
  if (options['internal-cell']) {
    const cell = [workflow.smoke, ...workflow.cells].find(candidate => candidate.id === options['internal-cell']);
    assert(cell, 'internal cell not frozen');
    const receipt = await runCell(manifest, manifestSha256, cell, cell.id === workflow.smoke.id);
    return receipt.complete ? 0 : 2;
  }
  let chosen;
  if (options.mode === 'smoke') chosen = [workflow.smoke];
  else {
    const smoke = await readReceipt(join(workflow.smoke.runRoot, 'receipt.json'));
    assert(smoke?.complete === true && smoke?.manifestSha256 === manifestSha256 && smoke?.scored === false, 'run genuine unscored smoke successfully before scored cells; do not silently re-freeze manifest after outcomes');
    chosen = options.cell ? workflow.cells.filter(cell => cell.id === options.cell) : workflow.cells;
    assert(chosen.length > 0, 'selected cell not frozen');
  }
  let failed = false;
  for (const cell of chosen) {
    // Exclusive root claim forbids outcome-dependent retry/resampling, including crashed cells.
    await mkdir(cell.runRoot, { recursive: false, mode: 0o700 });
    const result = await command(workflow.runtime.node, [SELF, '--manifest', options.manifest, '--internal-cell', cell.id], { cwd: cell.cwd, env: { PATH: cell.launch.path, LANG: 'C.UTF-8' }, signal: AbortSignal.timeout(cell.deadlineMs + 20000), forwardInterrupt: true, logPath: join(cell.runRoot, 'driver-process.log') });
    if (result.code !== 0) failed = true;
    if (!await readReceipt(join(cell.runRoot, 'receipt.json'))) {
      await writeJson(join(cell.runRoot, 'receipt.json'), { schemaVersion: 1, kind: 'native-workflow-run', manifestSha256, id: cell.id, scored: cell.id !== workflow.smoke.id, runId: null, parentSessionId: null, outcome: null, complete: false, blockers: ['driver terminated before final canonical accounting; retain process/partial receipts'], processExit: { code: result.code, signal: result.signal } });
    }
    const receipt = await readReceipt(join(cell.runRoot, 'receipt.json'));
    if (cell.id === workflow.smoke.id) await writeJson(workflow.smokeReceiptPath, { schemaVersion: 1, kind: 'native-workflow-smoke', manifestSha256, id: cell.id, receiptPath: join(cell.runRoot, 'receipt.json'), complete: receipt.complete }, false);
    if (options.append && receipt.complete === true && result.code === 0 && !result.interrupted) {
      assert(options.mode === 'scored', 'unscored smoke must never append report ledger');
      assert(receipt.recordPath, 'fully measured report record missing');
      assert(object(workflow.report), '--append requires explicit workflow.report executable and isolated ledgerHome');
      pathField(workflow.report.executable, 'report executable'); pathField(workflow.report.ledgerHome, 'report ledgerHome');
      const env = { ...scrubbedEnvironment(cell), GENIE_HOME: workflow.report.ledgerHome };
      const report = await command(workflow.report.executable, ['wish', 'report', receipt.runId, '--record', receipt.recordPath, '--variant', cell.variant, '--append'], { cwd: cell.cwd, env, logPath: join(cell.runRoot, 'wish-report-append.log') });
      if (report.code !== 0) failed = true;
    }
    if (result.interrupted) { failed = true; break; }
  }
  const result = await comparison(workflow, manifestSha256);
  // Smoke proves only the smoke, never the 18-cell comparison. Scored completion requires all cells.
  return failed || (options.mode === 'scored' && !result.complete) ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    // Do not print request bodies, launch snapshots, or credentials on an unexpected failure.
    process.stderr.write(`Native workflow observer blocked: ${error.message}\n`);
    process.exitCode = 2;
  });
}
