/**
 * genie desktop — open the Automagik desktop app with Genie preloaded.
 *
 *   genie desktop [--path <file>] [--tag <tag>] [--dry-run]
 *
 * Mirrors Omni's `omni desktop`: the build for this machine comes from the GitHub releases of
 * automagik-dev/automagik (tags `v<version>`; a release without a build for this machine is
 * skipped), is checked against the release's SHA256SUMS, is kept in the same cache
 * `omni desktop` uses ($OMNI_HOME/desktop/app, else ~/.omni/desktop/app: one app, one
 * download), and is opened with `--preload=genie`, so the app's welcome lists Genie first and
 * starts with it chosen. `--path` opens a build you already have instead.
 *
 * Linux x64 (and WSL, through WSLg) gets the AppImage, unpacked once into the cache and run
 * from there, so it needs no FUSE. macOS gets the dmg, opened so you can drag the app to
 * Applications; once it is there, the app itself is opened with the preload. Windows itself
 * is not supported: run this inside WSL.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { z } from 'zod';

const RELEASES_URL = 'https://api.github.com/repos/automagik-dev/automagik/releases?per_page=50';
const TAG_PREFIX = 'v';
const SUMS_ASSET = 'SHA256SUMS';
/** What the app is opened for: its welcome lists Genie first and starts with it chosen. */
export const PRELOAD_ARG = '--preload=genie';
/** Where macOS keeps the app once dragged out of the dmg (the build's product name is Omni). */
const MAC_APP = '/Applications/Omni.app';

export type DesktopTarget =
  | { supported: true; os: 'linux' | 'mac'; asset: RegExp; label: string }
  | { supported: false; reason: string };
type Supported = Extract<DesktopTarget, { supported: true }>;

/** Which build fits this machine. `procVersion` is /proc/version, which names Microsoft under WSL. */
export function desktopTarget(platform: NodeJS.Platform, arch: string, procVersion = ''): DesktopTarget {
  if (platform === 'linux') {
    if (arch !== 'x64') return { supported: false, reason: `There is no Linux ${arch} build yet; only x64.` };
    const label = /microsoft/i.test(procVersion) ? 'Linux (WSL)' : 'Linux';
    return { supported: true, os: 'linux', asset: /-linux-x86_64\.AppImage$/, label };
  }
  if (platform === 'darwin') {
    if (arch !== 'arm64' && arch !== 'x64') return { supported: false, reason: `There is no macOS ${arch} build.` };
    return { supported: true, os: 'mac', asset: new RegExp(`-mac-${arch}\\.dmg$`), label: `macOS ${arch}` };
  }
  if (platform === 'win32')
    return { supported: false, reason: 'Windows itself is not supported. Run `genie desktop` inside WSL.' };
  return { supported: false, reason: `There is no desktop build for ${platform}.` };
}

const ReleaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string().url(), size: z.number() })),
});
export type DesktopRelease = z.infer<typeof ReleaseSchema>;

/**
 * The release to use: the one tagged `tag`; else the newest published release that carries a
 * build for this machine (GitHub lists newest first). A release with only plugins is skipped.
 */
export function pickRelease(releases: DesktopRelease[], asset: RegExp, tag?: string): DesktopRelease | undefined {
  const published = releases.filter((release) => !release.draft && release.tag_name.startsWith(TAG_PREFIX));
  if (tag) return published.find((release) => release.tag_name === tag);
  return published.find((release) => release.assets.some((candidate) => asset.test(candidate.name)));
}

/** `sha256sum` output: "<hex>  <name>" per line. */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match?.[1] && match[2]) sums.set(match[2].trim(), match[1].toLowerCase());
  }
  return sums;
}

const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The cache `omni desktop` uses too: $OMNI_HOME/desktop/app, else ~/.omni/desktop/app. */
export function appCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const omni = env.OMNI_HOME?.trim() ? resolve(env.OMNI_HOME.trim()) : join(homedir(), '.omni');
  return join(omni, 'desktop', 'app');
}

/** Where an AppImage is unpacked to run: mounting it needs libfuse2, which Ubuntu 24.04+ and WSL lack. */
export function extractionDir(file: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(appCacheDir(env), 'extracted', basename(file).replace(/\.AppImage$/, ''));
}

/**
 * How to open a build, with the preload: the extracted AppImage's AppRun on Linux. On macOS a
 * dmg cannot take arguments, so the app installed in Applications is opened with them when it
 * is there, else the dmg is opened for the drag.
 */
export function launchPlan(
  file: string,
  target: Supported,
  extracted: string,
  macApp: string | null,
): { command: string; args: string[] } {
  if (target.os === 'mac')
    return macApp
      ? { command: 'open', args: ['-a', macApp, '--args', PRELOAD_ARG] }
      : { command: 'open', args: [file] };
  return { command: join(extracted, 'squashfs-root', 'AppRun'), args: [PRELOAD_ARG] };
}

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

const say = (line: string) => process.stdout.write(`${line}\n`);

/** Unpack an AppImage once; the unpack is reused only for the exact file it came from. */
function ensureExtracted(file: string, dir: string): void {
  const marker = join(dir, '.complete');
  const digest = sha256Of(readFileSync(file));
  if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === digest) return;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  chmodSync(file, 0o755);
  say('Unpacking the app (once per build)…');
  const result = spawnSync(file, ['--appimage-extract'], { cwd: dir, stdio: 'ignore' });
  if (result.status !== 0 || !existsSync(join(dir, 'squashfs-root', 'AppRun'))) {
    throw new Error(`Could not unpack ${file} (exit ${result.status ?? result.signal}).`);
  }
  writeFileSync(marker, `${digest}\n`);
}

async function fetchOk(url: string, accept?: string): Promise<Response> {
  const response = await fetch(url, { headers: { 'user-agent': 'genie-cli', ...(accept ? { accept } : {}) } });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${url}`);
  return response;
}

/** Download the build for `target` from `release` into the cache, checked against SHA256SUMS; reuse a checked copy. */
async function fetchBuild(release: DesktopRelease, target: Supported): Promise<string> {
  const asset = release.assets.find((candidate) => target.asset.test(candidate.name));
  if (!asset) throw new Error(`${release.tag_name} has no ${target.label} build.`);
  const sumsAsset = release.assets.find((candidate) => candidate.name === SUMS_ASSET);
  if (!sumsAsset) throw new Error(`${release.tag_name} has no ${SUMS_ASSET}; refusing an unchecked download.`);
  const expected = parseSums(await (await fetchOk(sumsAsset.browser_download_url)).text()).get(asset.name);
  if (!expected) throw new Error(`${SUMS_ASSET} in ${release.tag_name} does not list ${asset.name}.`);

  const dir = join(appCacheDir(), release.tag_name);
  const file = join(dir, asset.name);
  if (existsSync(file) && sha256Of(readFileSync(file)) === expected) return file;
  mkdirSync(dir, { recursive: true });
  say(`Downloading ${asset.name} (${Math.round(asset.size / 1_000_000)} MB)…`);
  const bytes = new Uint8Array(await (await fetchOk(asset.browser_download_url)).arrayBuffer());
  const actual = sha256Of(bytes);
  if (actual !== expected) throw new Error(`Checksum mismatch for ${asset.name}: expected ${expected}, got ${actual}.`);
  writeFileSync(`${file}.partial`, bytes);
  renameSync(`${file}.partial`, file);
  return file;
}

function planFor(file: string, target: Supported): { command: string; args: string[] } {
  return launchPlan(file, target, extractionDir(file), target.os === 'mac' && existsSync(MAC_APP) ? MAC_APP : null);
}

function open(file: string, target: Supported): void {
  if (target.os === 'linux') ensureExtracted(file, extractionDir(file));
  const plan = planFor(file, target);
  spawn(plan.command, plan.args, { detached: true, stdio: 'ignore' }).unref();
  if (target.os === 'mac' && plan.args[0] !== '-a') {
    say(`Opened ${file}: drag Omni to Applications, then run \`genie desktop\` again to open it with Genie.`);
  } else {
    say(`Opened ${file} with Genie preloaded`);
  }
}

type DesktopOptions = { path?: string; tag?: string; dryRun?: boolean };

async function buildFromReleases(target: Supported, options: DesktopOptions): Promise<string | null> {
  const releases = z
    .array(ReleaseSchema)
    .parse(await (await fetchOk(RELEASES_URL, 'application/vnd.github+json')).json());
  const release = pickRelease(releases, target.asset, options.tag);
  if (!release) {
    fail(options.tag ? `There is no release ${options.tag}.` : `There is no desktop release for ${target.label} yet.`);
  }
  if (options.dryRun) {
    const asset = release.assets.find((candidate) => target.asset.test(candidate.name));
    say(
      `Would download ${asset?.name ?? `(no ${target.label} build)`} from ${release.tag_name} and open it with ${PRELOAD_ARG}`,
    );
    return null;
  }
  return fetchBuild(release, target);
}

async function handleDesktop(options: DesktopOptions): Promise<void> {
  const procVersion = existsSync('/proc/version') ? readFileSync('/proc/version', 'utf8') : '';
  const target = desktopTarget(process.platform, process.arch, procVersion);
  if (!target.supported) fail(target.reason);
  try {
    const file = options.path ? resolve(options.path) : await buildFromReleases(target, options);
    if (file === null) return;
    if (!existsSync(file)) fail(`No file at ${file}`);
    if (options.dryRun) {
      const plan = planFor(file, target);
      say(`Would open ${file} (${target.label}): ${[plan.command, ...plan.args].join(' ')}`);
      return;
    }
    open(file, target);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

export function registerDesktopCommand(program: Command): void {
  program
    .command('desktop')
    .description('Open the Automagik desktop app with Genie preloaded (downloads the build for this machine)')
    .option('--path <file>', 'Open this AppImage or dmg instead of downloading one')
    .option('--tag <tag>', `Release to take it from (default: the newest ${TAG_PREFIX}* with a build for this machine)`)
    .option('--dry-run', 'Say what would be downloaded and opened, and stop')
    .action((options: DesktopOptions) => handleDesktop(options));
}
