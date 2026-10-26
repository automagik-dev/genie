#!/usr/bin/env bun
/**
 * Genie's plugin lane: genie-dsh releases reach the Automagik desktop app (and any market
 * that reads lanes) without a Genie CLI release or an Automagik one. The shape is Automagik's
 * (automagik-dev/automagik plugin-lane/README.md, schemaVersion 1): one signed manifest on
 * a rolling `plugin-lane` release of this repository, the tarball on its own immutable
 * `genie-dsh-v<version>` release.
 *
 *   https://github.com/automagik-dev/genie/releases/download/plugin-lane/lane.json
 *   https://github.com/automagik-dev/genie/releases/download/plugin-lane/lane.json.sig
 *
 * The signature is ed25519 over the exact bytes of lane.json, detached, base64; the public
 * keys are plugin-lane/keys.json, and the private key exists only as the PLUGIN_LANE_KEY
 * Actions secret. .github/workflows/plugin-lane.yml runs each step:
 *
 *   bun scripts/plugin-lane.ts pack <dir>                         npm pack genie-dsh into dir; print its entry
 *   bun scripts/plugin-lane.ts describe <tgz>                     the same entry for a tarball already released
 *   bun scripts/plugin-lane.ts manifest <packed.json> <commit> <issuedAt>   print lane.json
 *   bun scripts/plugin-lane.ts sign <lane.json>                    print its signature (PLUGIN_LANE_KEY, PEM)
 *   bun scripts/plugin-lane.ts verify <lane.json> <lane.json.sig>  check it against plugin-lane/keys.json
 */
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign as signBytes, verify as verifyBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const ROOT = join(import.meta.dir, '..');
export const PLUGIN_DIR = join(ROOT, 'plugins', 'genie-dsh');
export const SCHEMA_VERSION = 1;
export const PUBLISHER = 'genie';
export const KEY_ID = 'genie-2026-10';
export const REPOSITORY = 'https://github.com/automagik-dev/genie';
export const RELEASE_PREFIX = 'genie-dsh-v';

/** What `pack` writes: the tarball npm made, and what describes its bytes. */
export interface Packed {
  name: string;
  version: string;
  file: string;
  integrity: string;
  sha256: string;
  size: number;
  /** The plugin's own DSH range (package.json engines.dsh). */
  dsh: string;
  /** The lowest Bot team release the plugin runs on (its @automagik/bots-dsh peer range). */
  base: string;
}

export interface Lane {
  schemaVersion: number;
  publisher: typeof PUBLISHER;
  keyId: string;
  sequence: number;
  issuedAt: string;
  repository: string;
  version: string;
  commit: string;
  base: string;
  plugins: {
    name: string;
    version: string;
    url: string;
    integrity: string;
    sha256: string;
    size: number;
    engines: { dsh: string };
  }[];
}

/** A version's place in the lane's order, so a consumer refuses an older lane: M.m.p as M·10⁸ + m·10⁴ + p. */
export function sequenceOf(version: string): number {
  const match = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(version);
  if (!match) throw new Error(`not a release version: ${version}`);
  return Number(match[1]) * 100_000_000 + Number(match[2]) * 10_000 + Number(match[3]);
}

/** The floor of a `>=x.y.z` peer range: the Bot team release the plugin was built against. */
export function baseOf(peerRange: string | undefined): string {
  const match = /^>=\s*(\d+\.\d+\.\d+)/.exec(peerRange ?? '');
  if (!match?.[1]) throw new Error(`@automagik/bots-dsh peer range has no >= floor: ${peerRange}`);
  return match[1];
}

/** lane.json for one packed genie-dsh. */
export function manifest(packed: Packed, { commit, issuedAt }: { commit: string; issuedAt: string }): Lane {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`not a commit: ${commit}`);
  return {
    schemaVersion: SCHEMA_VERSION,
    publisher: PUBLISHER,
    keyId: KEY_ID,
    sequence: sequenceOf(packed.version),
    issuedAt,
    repository: REPOSITORY,
    version: packed.version,
    commit,
    base: packed.base,
    plugins: [
      {
        name: packed.name,
        version: packed.version,
        url: `${REPOSITORY}/releases/download/${RELEASE_PREFIX}${packed.version}/${packed.file}`,
        integrity: packed.integrity,
        sha256: packed.sha256,
        size: packed.size,
        engines: { dsh: packed.dsh },
      },
    ],
  };
}

export const signLane = (bytes: Buffer, privatePem: string) =>
  signBytes(null, bytes, createPrivateKey(privatePem)).toString('base64');

/** The lane, once its signature checks out against one of `keys` and its schema is known. */
export function verifyLane(bytes: Buffer, signature: string, keys: { keyId: string; publicKey: string }[]): Lane {
  const lane = JSON.parse(bytes.toString('utf8')) as Lane;
  const key = keys.find((entry) => entry.keyId === lane.keyId);
  if (!key) throw new Error(`lane: no key ${lane.keyId}`);
  if (!verifyBytes(null, bytes, createPublicKey(key.publicKey), Buffer.from(signature.trim(), 'base64'))) {
    throw new Error('lane: the signature does not match');
  }
  if (lane.schemaVersion !== SCHEMA_VERSION) throw new Error(`lane: schema ${lane.schemaVersion}`);
  if (lane.publisher !== PUBLISHER) throw new Error(`lane: publisher ${lane.publisher}`);
  return lane;
}

/** Describe a genie-dsh tarball from its own bytes, with the range fields the checkout declares. */
export function describe(file: string): Packed {
  const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'));
  if (!pkg.engines?.dsh) throw new Error('genie-dsh declares no engines.dsh');
  const bytes = readFileSync(file);
  const name = basename(file);
  const version = /^automagik-genie-dsh-(.+)\.tgz$/.exec(name)?.[1];
  if (version !== pkg.version) throw new Error(`${name} is not genie-dsh ${pkg.version}`);
  return {
    name: pkg.name,
    version,
    file: name,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    dsh: pkg.engines.dsh,
    base: baseOf(pkg.peerDependencies?.['@automagik/bots-dsh']),
  };
}

/** npm pack genie-dsh into `dir` and describe the tarball. */
export function pack(dir: string): Packed {
  const [entry] = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--pack-destination', dir], { cwd: PLUGIN_DIR, encoding: 'utf8' }),
  );
  const packed = describe(join(dir, entry.filename));
  if (packed.integrity !== entry.integrity) throw new Error('npm and this script disagree on the tarball integrity');
  return packed;
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const out = (text: string) => process.stdout.write(`${text}\n`);
  if (command === 'pack' && args.length === 1) out(JSON.stringify(pack(args[0] as string), null, 2));
  else if (command === 'describe' && args.length === 1) out(JSON.stringify(describe(args[0] as string), null, 2));
  else if (command === 'manifest' && args.length === 3) {
    const [file, commit, issuedAt] = args as [string, string, string];
    out(JSON.stringify(manifest(JSON.parse(readFileSync(file, 'utf8')), { commit, issuedAt }), null, 2));
  } else if (command === 'sign' && args.length === 1) {
    const key = process.env.PLUGIN_LANE_KEY;
    if (!key) throw new Error('PLUGIN_LANE_KEY is not set');
    out(signLane(readFileSync(args[0] as string), key));
  } else if (command === 'verify' && args.length === 2) {
    const keys = JSON.parse(readFileSync(join(ROOT, 'plugin-lane', 'keys.json'), 'utf8')).keys;
    const lane = verifyLane(readFileSync(args[0] as string), readFileSync(args[1] as string, 'utf8'), keys);
    out(`lane ${lane.version} (sequence ${lane.sequence}) is signed by ${lane.keyId}`);
  } else {
    process.stderr.write(
      'usage: bun scripts/plugin-lane.ts pack <dir> | describe <tgz> | manifest <packed.json> <commit> <issuedAt> | sign <lane.json> | verify <lane.json> <sig>\n',
    );
    process.exit(2);
  }
}
