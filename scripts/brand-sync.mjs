#!/usr/bin/env node
// The brand's copy tool. Automagik's repository is the source of the brand: docs/brand/ (start at its
// README.md). Genie, Omni and Arca carry a byte copy of that folder, with the agents' skill
// (.claude/skills/automagik-brand/) and this file, so an agent working there finds the brand as it
// does here. The folder goes to docs/brand in a copy too, or to the folder --into names, for a
// repository whose docs/ is not its own. A copy also holds SOURCE.json beside the skill: the folder
// the brand is in (`into`), the Automagik commit it was made from and the sha256 of every copied
// file. Its place is fixed, so a later run and the skill find the folder from it with no flag. The
// copy is never edited: a change is made in Automagik's repository and copied again.
//
//   node scripts/brand-sync.mjs --write --from <an Automagik checkout, or a commit> [--into <folder>]
//   node scripts/brand-sync.mjs --check
//
// --write copies the files as committed at that commit, removes the files the source no longer has
// and records the copy. --check (for the other repository's CI) exits 1 naming each file that
// differs from the record, is missing, or is not recorded. Both then look at Automagik's dev branch.
// When the brand changed there after the copy's commit they name dev's commit to copy; when the
// copy was made from a commit that is not on dev they say that instead, and do not advise copying
// dev over it. Neither fails a check, and with no network they say so and go on.
//
// The copy holds real folders and files only. Neither mode reads or writes through a symbolic
// link: --write refuses, before it changes anything, when a file it would write or remove, the
// record, or a folder on the way to one is a link, and --check names the link as a problem.
//
// Plain Node 22.7 or later and git: no dependencies, no install.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Automagik's repository, as SOURCE.json names it; with `.git`, the remote the look at dev reads. */
export const SOURCE = 'https://github.com/automagik-si/automagik';
export const BRANCH = 'dev';
/** The brand's folder in Automagik's repository, and in a copy unless --into named another. */
export const BRAND = 'docs/brand';
/** The agents' skill: at this path in every repository, because that is where an agent looks. */
export const SKILL_FOLDER = '.claude/skills/automagik-brand';
/** The copy's record, beside the skill. It exists only in a copy, never in Automagik's repository. */
export const RECORD = `${SKILL_FOLDER}/SOURCE.json`;
/**
 * Where the record was before the folder could be chosen. A copy runs the tool it carries, so one
 * made by that tool has its record here: it is read as a copy in docs/brand, and the next --write
 * moves it.
 */
export const OLD_RECORD = `${BRAND}/SOURCE.json`;
/** Copied whole from the source. In a copy the first is the folder `into` names (`foldersOf`). */
export const FOLDERS = [BRAND, SKILL_FOLDER];
/** This file, copied alone, so the other repository's CI can run --check. */
export const TOOL = 'scripts/brand-sync.mjs';
export const WRITE = 'node scripts/brand-sync.mjs --write --from <an Automagik checkout, or a commit>';
const REQUIRED = [`${BRAND}/README.md`, `${SKILL_FOLDER}/SKILL.md`, TOOL];
const NOTE = 'A copy of the Automagik brand. Do not edit these files here: change them in the source and run scripts/brand-sync.mjs --write.';
// A network read gets this long before the look at dev is skipped.
const NETWORK_MS = 30_000;
const USAGE = `Usage:
  ${WRITE}
  node scripts/brand-sync.mjs --check

Options:
  --into <folder>  with --write: the brand's folder in the repository that carries the copy
                   (default: the folder the copy is in already, else ${BRAND})
  --to <folder>    the repository that carries the copy (default: the one you are in)
  --remote <url>   Automagik's repository, for a commit and for the look at dev
                   (default: ${SOURCE}.git)`;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const short = commit => commit.slice(0, 12);
// Why a git call failed, in one line: git's first `fatal:` line (the lines after it are advice), else its last line.
const reason = error => {
  const lines = String(error?.stderr || error?.message || error).split('\n').map(line => line.trim()).filter(Boolean);
  return lines.find(line => line.startsWith('fatal:')) ?? lines.pop() ?? 'no reason given';
};

// The only GIT_ variables a call inherits: how to reach a remote. Every other one is dropped, so
// nothing the caller's shell or a hook set (GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR,
// GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_INDEX_FILE, GIT_NAMESPACE, the
// GIT_CONFIG family, GIT_CEILING_DIRECTORIES, or one git adds later) can point a call, or a
// scratch repository's objects, config and shallow file, at another repository.
const TRANSPORT = /^GIT_(SSH|SSH_COMMAND|SSH_VARIANT|ASKPASS|SSL_[A-Z_]+|HTTP_[A-Z_]+|PROXY_COMMAND)$/;
const gitEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_') || TRANSPORT.test(name))),
  GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
});

/** Runs git: in `cwd`, or on the scratch repository `dir`, named outright and never discovered. */
function git(args, { cwd, dir, timeout, buffer = false } = {}) {
  return execFileSync('git', dir ? ['--git-dir', dir, ...args] : args, {
    cwd: dir ?? cwd, timeout, encoding: buffer ? 'buffer' : 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

function scratchRepo(remote) {
  const repo = mkdtempSync(join(tmpdir(), 'brand-sync-'));
  try {
    git(['init', '-q', '--bare', repo]);
    git(['remote', 'add', 'origin', remote], { dir: repo });
  } catch (error) {
    // Nothing is left behind when the scratch repository cannot be made.
    rmSync(repo, { recursive: true, force: true });
    throw error;
  }
  return repo;
}

/** What is at `path` itself, a link not followed; undefined when nothing is, or a file is on the way. */
const lstatOf = path => { try { return lstatSync(path, { throwIfNoEntry: false }); } catch { return undefined; } };
const isFolder = path => lstatOf(path)?.isDirectory() === true;

/** The copy's two folders: the brand, in the folder `into` names, and the skill. */
const foldersOf = into => [into, SKILL_FOLDER];
const plain = path => typeof path === 'string' && path !== '' && !path.includes('\\') && !path.split('/').some(part => part === '' || part === '.' || part === '..');
const within = (path, folder) => path === folder || path.startsWith(`${folder}/`);

/**
 * Why `into` cannot be the brand's folder in a copy, or undefined when it can. A folder inside
 * the repository, named from its root, that is not git's, not the skill's or one around it, and
 * not one around the tool: --write removes what it did not copy from the folders it owns.
 */
function refusedInto(into) {
  if (!plain(into) || into.startsWith('-')) return 'it must be a folder inside the repository, named from its root (for example brand, or docs/brand)';
  if (into.split('/').some(part => part.toLowerCase() === '.git')) return 'it is inside .git';
  if (within(into, SKILL_FOLDER) || within(SKILL_FOLDER, into)) return `it overlaps the skill's folder (${SKILL_FOLDER})`;
  if (within(TOOL, into)) return `it holds the tool (${TOOL})`;
  return undefined;
}

/** A source path as the copy holds it: the brand's files go under `into`, the rest keep their path. */
const placed = (path, into) => (path.startsWith(`${BRAND}/`) ? `${into}/${path.slice(BRAND.length + 1)}` : path);

/** Whether a recorded path is one the copy may hold: inside the copy's folders, or the tool. */
const inScope = (path, into) => path !== RECORD && plain(path)
  && (path === TOOL || foldersOf(into).some(folder => path.startsWith(`${folder}/`)));

/** Every file (and link) now under the copy's folders, as repository paths. `.DS_Store` is the Finder's. */
function present(root, into) {
  const found = [];
  const walk = folder => {
    for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
      const path = `${folder}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name !== '.DS_Store') found.push(path);
    }
  };
  for (const folder of foldersOf(into)) if (isFolder(join(root, folder))) walk(folder);
  return found.sort();
}

function pruneEmpty(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) if (entry.isDirectory()) pruneEmpty(join(folder, entry.name));
  if (!readdirSync(folder).length) rmdirSync(folder);
}

/**
 * The first part of `path` that is a symbolic link in `root`: a folder on the way, or the path
 * itself. Nothing is read through it. Undefined when every part that exists is real.
 */
function linkOn(root, path) {
  const parts = path.split('/');
  for (let at = 1; at <= parts.length; at += 1) {
    const part = parts.slice(0, at).join('/');
    const now = lstatOf(join(root, part));
    if (!now) return undefined;
    if (now.isSymbolicLink()) return part;
    if (!now.isDirectory()) return undefined;
  }
  return undefined;
}

const LINK = 'is a symbolic link: a copy holds real folders and files only';

/**
 * Before --write changes anything: no path it will write or remove, and no folder on the way to
 * one, may be a symbolic link (writing through one would write somewhere else), and a folder it
 * needs may not be a file it is not about to remove.
 */
function refuseUnsafe(root, writes, removes) {
  const going = new Set(removes);
  for (const path of [...writes, ...removes]) {
    const link = linkOn(root, path);
    if (link) throw new Error(`${link} ${LINK}. Nothing was changed: remove the link and run again.`);
    const parts = path.split('/');
    for (let at = 1; at < parts.length; at += 1) {
      const part = parts.slice(0, at).join('/');
      const now = lstatOf(join(root, part));
      if (!now) break;
      if (!now.isDirectory() && !going.has(part)) throw new Error(`${part} is a file here, where the copy needs a folder. Nothing was changed.`);
      if (!now.isDirectory()) break;
    }
  }
}

/**
 * Writes one file of the copy: into a new file beside it, then a rename over it. A rename replaces
 * what is at the path, a link included, and never writes through it. Before anything is made, a
 * folder included: the deepest folder that exists on the way must resolve inside the repository,
 * and no folder on the way may be a link, whatever the checks before found.
 */
export function replaceFile(root, path, bytes, mode = 0o644) {
  const inside = realpathSync(root);
  const target = join(inside, path);
  const folder = dirname(target);
  const way = path.split('/').slice(0, -1);
  let deepest = inside;
  for (let at = 1; at <= way.length && lstatOf(join(inside, ...way.slice(0, at))); at += 1) deepest = join(inside, ...way.slice(0, at));
  let real;
  try { real = realpathSync(deepest); } catch { real = undefined; }
  if (real !== inside && !real?.startsWith(`${inside}${sep}`)) throw new Error(`${path} resolves outside this repository (${dirname(path)} leads elsewhere): nothing was made or written`);
  const link = way.length ? linkOn(inside, way.join('/')) : undefined;
  if (link) throw new Error(`${link} ${LINK}: ${path} was not written`);
  mkdirSync(folder, { recursive: true });
  // A folder left where a file goes: its files were stale and are gone, so it is empty or it stays.
  if (isFolder(target)) pruneEmpty(target);
  const temp = join(folder, `.brand-sync-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode });
    chmodSync(temp, mode);
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw new Error(`could not write ${path}: ${reason(error)}`);
  }
}

/**
 * Opens the source: an Automagik checkout (its HEAD, as committed) or a commit, branch or tag
 * fetched from `remote`. `close()` removes what a fetch made.
 */
export function openSource(from, remote = `${SOURCE}.git`) {
  if (isFolder(from)) {
    let top;
    try { top = git(['rev-parse', '--show-toplevel'], { cwd: from }).trim(); } catch { throw new Error(`${from} is a folder, but not a git checkout`); }
    const commit = git(['rev-parse', 'HEAD'], { cwd: top }).trim();
    const dirty = git(['status', '--porcelain', '--', ...FOLDERS, TOOL], { cwd: top }).trim() !== '';
    return { where: { cwd: top }, top, commit, dirty, close() {} };
  }
  if (from.startsWith('-') || remote.startsWith('-')) throw new Error(`not a checkout or a commit: ${from}`);
  let repo;
  try {
    repo = scratchRepo(remote);
    git(['fetch', '-q', '--depth', '1', 'origin', from], { dir: repo, timeout: NETWORK_MS });
    const commit = git(['rev-parse', 'FETCH_HEAD^{commit}'], { dir: repo }).trim();
    return { where: { dir: repo }, commit, dirty: false, close: () => rmSync(repo, { recursive: true, force: true }) };
  } catch (error) {
    if (repo) rmSync(repo, { recursive: true, force: true });
    throw new Error(`could not read ${from} from ${remote}: give an Automagik checkout, a branch or a full commit id (${reason(error)})`);
  }
}

/** The files the source (what `openSource` returned) holds at its commit: `{ path, mode, oid }`, plain files only. */
export function sourceFiles({ where, commit }) {
  const listed = git(['ls-tree', '-r', '-z', commit, '--', ...FOLDERS, TOOL], where).split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t');
    const [mode, type, oid] = line.slice(0, tab).split(' ');
    return { path: line.slice(tab + 1), mode, type, oid };
  });
  const record = listed.find(file => file.path === RECORD || file.path === OLD_RECORD);
  if (record) throw new Error(`commit ${short(commit)} holds ${record.path}: it is a copy itself. Copy from Automagik's repository.`);
  for (const path of REQUIRED) {
    if (!listed.some(file => file.path === path)) throw new Error(`commit ${short(commit)} holds no ${path}: it is not Automagik's repository, or it is older than the brand's copy tool`);
  }
  for (const file of listed) {
    if (file.type !== 'blob' || (file.mode !== '100644' && file.mode !== '100755')) throw new Error(`${file.path} is not a plain file in the source (mode ${file.mode})`);
  }
  return listed;
}

/**
 * The copy's record as it is on disk, for --write: `{ into, files }`, or undefined when there is
 * none it can use (no record, one behind a link, one that is not a record). The record beside the
 * skill first; else the one in docs/brand, which a copy made before the folder could be chosen has.
 */
function recordBefore(root) {
  for (const at of [RECORD, OLD_RECORD]) {
    if (linkOn(root, at) || !lstatOf(join(root, at))?.isFile()) continue;
    let record;
    try { record = JSON.parse(readFileSync(join(root, at), 'utf8')); } catch { return undefined; }
    const into = at === OLD_RECORD ? BRAND : record?.into ?? BRAND;
    const files = record?.files;
    if (refusedInto(into) || files === null || typeof files !== 'object' || Array.isArray(files)) return undefined;
    return { at, into, files: Object.keys(files).filter(path => inScope(path, into)) };
  }
  return undefined;
}

/**
 * Copies the brand, the skill and this tool from `from` into the repository at `to`, removes the
 * files the source no longer has, and writes the record. The brand goes into the folder `into`
 * names: when it is not given, the folder the copy is in already, else docs/brand. Returns what it did.
 */
export function write({ to, from, remote, into: asked }) {
  if (!statSync(to, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${to} is not a folder`);
  const root = realpathSync(resolve(to));
  if (asked !== undefined && refusedInto(asked)) throw new Error(`--into ${asked}: ${refusedInto(asked)}. Nothing was changed.`);
  const source = openSource(from, remote);
  try {
    if (source.top && realpathSync(source.top) === root) throw new Error("this is the source: Automagik's own repository carries no copy. Run it in the repository that does (or pass --to).");
    const files = sourceFiles(source).map(file => ({ ...file, source: file.path }));
    // The skill's folder, the tool and the record first: the record is read, and never through a link.
    refuseUnsafe(root, [SKILL_FOLDER, TOOL, RECORD], []);
    const before = recordBefore(root);
    const into = asked ?? before?.into ?? BRAND;
    for (const file of files) file.path = placed(file.source, into);
    const kept = new Set(files.map(file => file.path));
    // The folders next: `present` walks them, and must not walk through a link.
    try {
      refuseUnsafe(root, [...foldersOf(into), TOOL, RECORD], []);
    } catch (error) {
      throw new Error(`${error.message}${asked === undefined ? ' Or put the brand in another folder: --into <folder>.' : ''}`);
    }
    const here = present(root, into);
    // A folder chosen for the first time is the copy's alone from then on: it may not hold other files now.
    if (into !== before?.into && into !== BRAND) {
      const others = here.filter(path => within(path, into) && !kept.has(path) && !before?.files.includes(path));
      if (others.length) throw new Error(`${into} holds files that are not a brand copy (${others[0]}${others.length > 1 ? ` and ${others.length - 1} more` : ''}). Nothing was changed: choose a folder of the copy's own with --into.`);
    }
    const removed = here.filter(path => path !== RECORD && !kept.has(path));
    // The folder the copy was in, when this run moves it: the files that copy recorded, and its record.
    const left = before && before.into !== into ? before.into : undefined;
    if (left || before?.at === OLD_RECORD) {
      const moved = [...(left ? before.files.filter(path => within(path, left)) : []), ...(before.at === OLD_RECORD ? [OLD_RECORD] : [])];
      for (const path of moved) if (!kept.has(path) && !removed.includes(path) && lstatOf(join(root, path)) && !isFolder(join(root, path))) removed.push(path);
    }
    refuseUnsafe(root, [...kept, RECORD], removed);
    for (const path of removed) rmSync(join(root, path));
    const hashes = {};
    for (const file of files) {
      const bytes = git(['cat-file', 'blob', file.oid], { ...source.where, buffer: true });
      replaceFile(root, file.path, bytes, file.mode === '100755' ? 0o755 : 0o644);
      hashes[file.path] = sha256(bytes);
    }
    for (const folder of [...foldersOf(into), ...(left ? [left] : [])]) if (isFolder(join(root, folder))) pruneEmpty(join(root, folder));
    replaceFile(root, RECORD, `${JSON.stringify({ note: NOTE, source: SOURCE, commit: source.commit, into, files: hashes }, null, 2)}\n`);
    return { commit: source.commit, files: files.length, removed, dirty: source.dirty, into, from: left };
  } finally {
    source.close();
  }
}

/**
 * Compares the copy at `to` with its record. Returns `{ commit, files, into, record, problems }`;
 * no problems is a pass. `record` is where the record was found, `into` the folder it names.
 */
export function check({ to }) {
  if (!statSync(to, { throwIfNoEntry: false })?.isDirectory()) return { problems: [`${to} is not a folder`] };
  const root = realpathSync(resolve(to));
  // Links first, and nothing is read through one: a linked record or folder can show any bytes.
  const fixed = new Set([RECORD, SKILL_FOLDER, TOOL].map(path => linkOn(root, path)).filter(Boolean));
  if (fixed.size) return { problems: [...fixed].sort().map(link => `${link} ${LINK}`) };
  // The record beside the skill; with none there, the one in docs/brand (a copy made before the
  // folder could be chosen). The second is looked for only then, so a repository whose docs/ is a
  // link, with its copy in another folder, is never asked about docs/.
  const at = !lstatOf(join(root, RECORD)) && !linkOn(root, BRAND) && lstatOf(join(root, OLD_RECORD)) ? OLD_RECORD : RECORD;
  if (at === OLD_RECORD && linkOn(root, OLD_RECORD)) return { problems: [`${OLD_RECORD} ${LINK}`] };
  let record;
  try {
    record = JSON.parse(readFileSync(join(root, at), 'utf8'));
  } catch (error) {
    if (existsSync(join(root, at))) return { problems: [`${at} is not JSON (${reason(error)})`] };
    return { problems: [`${RECORD} is missing: nothing here says which Automagik commit this copy is`] };
  }
  const files = record?.files;
  const recorded = files !== null && typeof files === 'object' && !Array.isArray(files) && Object.values(files).every(hash => typeof hash === 'string');
  if (!recorded || typeof record.commit !== 'string' || !/^[0-9a-f]{40}$/.test(record.commit)) return { problems: [`${at} does not record a commit and its files`] };
  const into = record.into ?? BRAND;
  if (refusedInto(into)) return { problems: [`${at} names ${JSON.stringify(into)} as the brand's folder: ${refusedInto(into)}`] };
  if (at === OLD_RECORD && into !== BRAND) return { problems: [`${at} names ${into} as the brand's folder, but a record in ${BRAND} is a copy in ${BRAND}`] };
  const links = new Set(foldersOf(into).map(path => linkOn(root, path)).filter(Boolean));
  if (links.size) return { problems: [...links].sort().map(link => `${link} ${LINK}`) };
  const problems = [];
  for (const path of Object.keys(files).sort()) {
    if (!inScope(path, into)) { problems.push(`${at} lists ${path}, which is outside the brand's folders`); continue; }
    const link = linkOn(root, path);
    if (link) { links.add(link); continue; }
    const now = lstatOf(join(root, path));
    if (!now) problems.push(`${path} is missing`);
    else if (!now.isFile()) problems.push(`${path} is not a plain file`);
    else if (sha256(readFileSync(join(root, path))) !== files[path]) problems.push(`${path} differs from ${at}`);
  }
  for (const path of REQUIRED) if (!Object.hasOwn(files, placed(path, into))) problems.push(`${at} does not list ${placed(path, into)}`);
  for (const path of present(root, into)) {
    if (path === at || Object.hasOwn(files, path)) continue;
    if (lstatOf(join(root, path))?.isSymbolicLink()) links.add(path);
    else problems.push(`${path} is not in ${at}: a stale or added file`);
  }
  for (const link of [...links].sort()) problems.push(`${link} ${LINK}`);
  return { commit: record.commit, files: Object.keys(files).length, into, record: at, problems };
}

/**
 * Looks at Automagik's dev: is the brand there still the one at `commit`? Never throws.
 * `current`: the same files. `behind`: they differ and `commit` is in dev's history, so dev is
 * ahead and a fresh copy brings it. `apart`: they differ and `commit` is not on dev (a copy made
 * from a branch), so copying dev would undo it. `offline`: the remote did not answer. `unknown`:
 * it answered, but the two could not be compared. `dev` is dev's commit.
 */
export function staleness({ commit, remote = `${SOURCE}.git`, branch = BRANCH }) {
  if (remote.startsWith('-')) return { state: 'offline', why: `not a remote: ${remote}` };
  let dev;
  try {
    dev = /^([0-9a-f]{40})\t/.exec(git(['ls-remote', remote, `refs/heads/${branch}`], { timeout: NETWORK_MS }))?.[1];
  } catch (error) {
    return { state: 'offline', why: reason(error) };
  }
  if (!dev) return { state: 'unknown', why: `${remote} has no ${branch} branch` };
  if (dev === commit) return { state: 'current', dev };
  let repo;
  try {
    repo = scratchRepo(remote);
    // The two commits and their trees are enough: no file's bytes are fetched.
    git(['fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', dev, commit], { dir: repo, timeout: NETWORK_MS });
    const brandAt = at => git(['ls-tree', '-r', at, '--', ...FOLDERS, TOOL], { dir: repo });
    if (brandAt(dev) === brandAt(commit)) return { state: 'current', dev };
  } catch (error) {
    return { state: 'unknown', dev, why: reason(error) };
  } finally {
    if (repo) rmSync(repo, { recursive: true, force: true });
  }
  // The brand differs. Which way: is this copy's commit in dev's history? Commits alone answer that.
  let history;
  try {
    history = scratchRepo(remote);
    git(['fetch', '-q', '--filter=tree:0', 'origin', dev], { dir: history, timeout: NETWORK_MS });
    const onDev = git(['rev-list', dev], { dir: history }).split('\n').includes(commit);
    return { state: onDev ? 'behind' : 'apart', dev };
  } catch (error) {
    return { state: 'unknown', dev, why: reason(error) };
  } finally {
    if (history) rmSync(history, { recursive: true, force: true });
  }
}

/** What to say about the look at dev: `{ line, warn }`, or nothing to say. */
export function stalenessLine(found, commit) {
  if (found.state === 'offline') return { line: `could not reach Automagik's repository (offline?), so the look at its ${BRANCH} was skipped: ${found.why}`, warn: false };
  if (found.state === 'unknown') return { line: `could not compare this copy (${short(commit)}) with Automagik's ${BRANCH}: ${found.why}`, warn: false };
  if (found.state === 'behind') {
    return { line: `the brand changed on Automagik's ${BRANCH} after this copy's commit (${short(commit)}): ${BRANCH} is at ${found.dev}. Copy it again: node scripts/brand-sync.mjs --write --from ${found.dev}`, warn: true };
  }
  if (found.state === 'apart') {
    return { line: `this copy's commit (${short(commit)}) is not on Automagik's ${BRANCH} (${found.dev}), and the brand differs between the two. It was copied from a branch: copy from ${BRANCH} once that branch is merged there, not before.`, warn: true };
  }
  return { line: `the brand on Automagik's ${BRANCH} (${short(found.dev)}) is the same as this copy's`, warn: false };
}

function parse(argv) {
  const options = { write: false, check: false, help: false };
  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at];
    if (flag === '--write' || flag === '--check' || flag === '--help') options[flag.slice(2)] = true;
    else if ((flag === '--from' || flag === '--to' || flag === '--remote' || flag === '--into') && argv[at + 1] !== undefined) options[flag.slice(2)] = argv[at += 1];
    else return null;
  }
  if (options.help) return options;
  if (options.write === options.check || (options.write && !options.from) || (options.check && (options.from || options.into !== undefined))) return null;
  return options;
}

function repositoryOf(folder) {
  try { return git(['rev-parse', '--show-toplevel'], { cwd: folder }).trim(); } catch { return folder; }
}

/** The command line. Returns the exit code: 0, 1 when a check finds a problem or a copy fails, 2 for a wrong call. */
export function main(argv, { out = console.log, err = console.error, cwd = process.cwd() } = {}) {
  const options = parse(argv);
  if (!options) { err(USAGE); return 2; }
  if (options.help) { out(USAGE); return 0; }
  const to = options.to ?? repositoryOf(cwd);
  const lookAtDev = commit => {
    const { line, warn } = stalenessLine(staleness({ commit, remote: options.remote }), commit);
    out(`brand-sync: ${warn && options.check ? 'warning: ' : ''}${line}`);
    if (warn && options.check && process.env.GITHUB_ACTIONS) out(`::warning title=The brand copy is behind Automagik::${line}`);
  };
  try {
    if (options.write) {
      const done = write({ to, from: options.from, remote: options.remote, into: options.into });
      out(`brand-sync: copied ${done.files} files from Automagik ${done.commit}, the brand into ${done.into}, and wrote ${RECORD}`);
      for (const path of done.removed) {
        if (path === OLD_RECORD) out(`brand-sync: removed ${path}: the record is ${RECORD} now`);
        else if (done.from && within(path, done.from)) out(`brand-sync: removed ${path}: the brand is in ${done.into} now`);
        else out(`brand-sync: removed ${path}: the source no longer has it`);
      }
      if (done.dirty) out('brand-sync: note: that checkout has brand changes that are not committed. They were not copied: the copy is the commit.');
      lookAtDev(done.commit);
      return 0;
    }
    const found = check({ to });
    if (found.problems.length) {
      for (const problem of found.problems) err(`brand-sync: ${problem}`);
      err(`brand-sync: the copy is never edited here. Change the files in Automagik's repository, then run: ${WRITE}`);
    } else {
      out(`brand-sync: ${found.files} files match ${found.record} (Automagik ${short(found.commit)}); the brand is in ${found.into}`);
    }
    if (found.commit) lookAtDev(found.commit);
    return found.problems.length ? 1 : 0;
  } catch (error) {
    err(`brand-sync: ${error.message}`);
    return 1;
  }
}

const invoked = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invoked) process.exitCode = main(process.argv.slice(2));
