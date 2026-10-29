#!/usr/bin/env bun
/**
 * Regenerate `src/lib/legacy-skills-catalog.ts` from git history.
 *
 * The catalog is how `genie update` and `genie doctor` recognise a skill
 * directory genie shipped BEFORE the install record existed: every skill name
 * that ever lived under a `skills/` directory on a shipped ref
 * ({@link historyRevisions}) or an explicitly proven Genie archive and is no
 * longer delivered, plus every frontmatter `description` any Genie skill shipped
 * under any name that NO currently shipped skill carries. "Currently shipped"
 * is the union of HEAD, exact origin/dev and exact origin/main read through git
 * ({@link currentSkills}), never the working tree: a skill live on a release
 * branch but absent from HEAD is not retired (#3141). A retired description
 * under a genie name proves a directory is genie's own pre-record install — a
 * third party does not copy genie's description verbatim, and a user's fork of a
 * CURRENT skill keeps a current description, which is deliberately absent here.
 *
 * Mikro's independently owned subtree is not Genie delivery history: ignore
 * its prefixed paths and its imported source ancestry. Validated non-squash
 * metadata cuts source edges; overlapping refs additionally need commit-bound
 * ownership proof from independently Genie-owned, non-Mikro history.
 *
 * Run from a FULL clone (the shipped and proven archive refs need their whole
 * history; a shallow checkout would silently produce an incomplete catalog,
 * which is why this is not part of `bun run check` — `bun run check` has no say
 * over checkout depth):
 *
 *   bun scripts/legacy-skills-catalog.ts --write
 *   bun scripts/legacy-skills-catalog.ts --check   # exits 1 when the file is stale
 *   bun scripts/legacy-skills-catalog.ts --check --ref-provenance SHA:root-proof.json
 *
 * An explicit proof blob has `{ version: 1, refs: [{ ref, commit, owner }] }`,
 * with owner `genie` or `source` and each commit equal to that ref's current
 * peeled tip. Unknown/stale refs and source-owned proof blobs refuse collection.
 * Proof roots opt exact Genie archives into retirement history without
 * prerecording their skills, even outside the default shipped ref set;
 * source entries cannot remove independently proven Genie ancestry.
 *
 * CI runs `--check` as its own step in the `unit` job, whose checkout sets
 * `fetch-depth: 0` for exactly this reason (#2942); on a shallow clone
 * `--check` REFUSES ({@link SHALLOW_REFUSAL}) rather than passing vacuously,
 * while `--write` stays allowed. The check is an additive union, so it proves
 * a SUPERSET, never an exact match — see {@link CATALOG_CHECK_GAP}, which
 * every verdict prints.
 *
 * The file records digests, not text: each name and description as
 * {@link legacySkillDigest}, the same function the reader matches with, so the
 * binary carries no retired skill's text. Union and subtraction happen on
 * digests; this clone's history keeps the text only to name a missing entry
 * in the `--check` verdict.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { legacySkillDigest } from '../src/lib/legacy-skill-digest.js';
import { catalogGenieCommits } from './git-history-ownership.js';

const ROOT = join(import.meta.dir, '..');
const OUTPUT = join(ROOT, 'src', 'lib', 'legacy-skills-catalog.ts');
const MARKER_DIRS = ['.genie-codex-fallback-retirement'];

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
}

function git(...args: string[]): string {
  return gitIn(ROOT, ...args);
}

/** The two branches a release is cut from. Other remote branches are unmerged work. */
const SHIPPED_REMOTE_BRANCHES = ['refs/remotes/origin/main', 'refs/remotes/origin/dev'];

/**
 * Default retirement history: HEAD, every tag, exact origin/main and origin/dev
 * when present, and refs/archive/*. Unmerged refs never implicitly grant it.
 *
 * Resolve the release branches exactly: Git appends `/*` to --remotes/--glob
 * patterns without a wildcard, and for-each-ref can include descendant refs.
 * Absent branches, tags and archive refs are safe and match nothing.
 * Commit-bound Genie proof may opt additional exact archive tips into collection.
 */
export function historyRevisions(root: string): string[] {
  return ['HEAD', '--tags', ...shippedRemoteBranches(root), '--glob=refs/archive/*'];
}

/** Exact origin/main and origin/dev when present; a descendant or lookalike ref never qualifies. */
function shippedRemoteBranches(root: string): string[] {
  return gitIn(root, 'for-each-ref', '--format=%(refname)', ...SHIPPED_REMOTE_BRANCHES)
    .split('\n')
    .filter((ref) => SHIPPED_REMOTE_BRANCHES.includes(ref));
}

function parseDescription(markdown: string): string | null {
  if (!markdown.startsWith('---\n')) return null;
  const end = markdown.indexOf('\n---', 4);
  if (end === -1) return null;
  for (const line of markdown.slice(4, end).split('\n')) {
    const match = /^description:\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = (match[1] as string).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * `{ name: Set<description> }` for shipped or explicitly proven Genie history.
 * All refs validate source-edge ownership; only eligible owned commits contribute.
 * Both CLI modes and callers use this one derivation.
 */
export function collectCatalog(root: string = ROOT, provenance?: string): Map<string, Set<string>> {
  const catalog = new Map<string, Set<string>>();
  const readGit = (...args: string[]) => gitIn(root, ...args);
  const eligible = catalogGenieCommits(readGit, ['--all'], historyRevisions(root), provenance);
  const commits = readGit('log', '--all', '--pretty=format:%H', '--', 'skills/*/SKILL.md', '*/skills/*/SKILL.md')
    .split('\n')
    .filter((line) => /^[0-9a-f]{40}$/.test(line));
  const seenBlobs = new Set<string>();
  for (const commit of commits) {
    if (!eligible.has(commit)) continue;
    const tree = readGit('ls-tree', '-r', commit).split('\n');
    for (const row of tree) {
      // Capture the full path before matching skills: integration commits carry
      // foreign files too, even after their source ancestry has been excluded.
      const entry = /^\d+ blob ([0-9a-f]{40})\t(.+)$/.exec(row);
      if (!entry) continue;
      const [, blob, path] = entry as unknown as [string, string, string];
      if (path.startsWith('mikro/')) continue;
      // Root and nested Genie skill directories have both historically shipped.
      const match = /^(?:.*\/)?skills\/([^/]+)\/SKILL\.md$/.exec(path);
      if (!match) continue;
      const name = match[1] as string;
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) continue;
      const key = `${blob} ${name}`;
      if (seenBlobs.has(key)) continue;
      seenBlobs.add(key);
      // A name is recorded only through a revision whose frontmatter carries a parseable
      // `description`. A name-only entry would be inert at best: ownership needs a retired name AND
      // a retired description, and `readSkillDescription` ignores a directory that has no
      // `description:` at all — so the 2026-02 `gog` skill (which used `summary:`) could never be
      // recognised on disk under any roster, while listing it would only widen the `unproven`
      // reporting surface that already misfires on third-party products sharing a name.
      const description = parseDescription(readGit('cat-file', 'blob', blob));
      if (description === null) continue;
      if (!catalog.has(name)) catalog.set(name, new Set());
      (catalog.get(name) as Set<string>).add(description);
    }
  }
  return catalog;
}

export interface CurrentSkills {
  /** Every `skills/<name>` directory a current tree carries. */
  names: Set<string>;
  /** Every parseable `skills/<name>/SKILL.md` description a current tree carries: a fork of a current skill keeps one. */
  descriptions: Set<string>;
}

/**
 * What ships right now: the union of HEAD, exact origin/dev and exact origin/main,
 * read through git (ls-tree / cat-file), never the working tree. A revision that
 * does not resolve (unborn HEAD, an absent release branch) contributes nothing.
 */
export function currentSkills(root: string = ROOT): CurrentSkills {
  const names = new Set<string>();
  const descriptions = new Set<string>();
  const seenBlobs = new Set<string>();
  for (const revision of ['HEAD', ...shippedRemoteBranches(root)]) {
    try {
      gitIn(root, 'rev-parse', '--verify', '--quiet', `${revision}^{tree}`);
    } catch {
      continue;
    }
    for (const row of gitIn(root, 'ls-tree', '-r', '-t', '-z', revision, '--', 'skills/').split('\0')) {
      const entry = /^\d+ (tree|blob) ([0-9a-f]+)\tskills\/([^/]+)(\/SKILL\.md)?$/.exec(row);
      if (!entry) continue;
      const [, type, object, name, skillFile] = entry as unknown as [string, string, string, string, string?];
      if (type === 'tree' && skillFile === undefined) names.add(name);
      if (type !== 'blob' || skillFile === undefined || seenBlobs.has(object)) continue;
      seenBlobs.add(object);
      const description = parseDescription(gitIn(root, 'cat-file', 'blob', object));
      if (description !== null) descriptions.add(description);
    }
  }
  return { names, descriptions };
}

/**
 * What the committed catalog already carries. The history walk sees only the
 * shipped and proven archive refs THIS clone holds, so proof from a tag or archive
 * another machine fetched would otherwise silently drop out on regeneration.
 * The catalog is additive: union what this clone can see with what is recorded,
 * and subtract only currently shipped names and descriptions.
 */
export async function recordedCatalog(): Promise<{ names: string[]; descriptions: string[] }> {
  try {
    const module = (await import(OUTPUT)) as {
      LEGACY_SKILL_NAME_DIGESTS?: readonly string[];
      LEGACY_SKILL_DESCRIPTION_DIGESTS?: readonly string[];
    };
    return {
      names: [...(module.LEGACY_SKILL_NAME_DIGESTS ?? [])],
      descriptions: [...(module.LEGACY_SKILL_DESCRIPTION_DIGESTS ?? [])],
    };
  } catch {
    // No catalog yet, or one this build cannot import: history alone is the source.
    return { names: [], descriptions: [] };
  }
}

export interface MergedCatalog {
  /** Digests of the retired names, sorted. */
  names: string[];
  /** Digests of the retired descriptions, sorted. */
  descriptions: string[];
  /** The text of each digest this clone's history yields, to name it in a verdict. */
  labels: Map<string, string>;
}

/**
 * The union-then-subtract the catalog is made of, as a pure function of its
 * four inputs: history ∪ what is already recorded, minus what the tree ships
 * today. `render` emits it and `--check` reports against it, so the file and
 * the verdict can never describe different sets. History and the current tree
 * come as text and are digested here; `recorded` is already digests.
 */
export function mergeCatalog(
  catalog: Map<string, Set<string>>,
  recorded: { names: string[]; descriptions: string[] },
  current: Set<string>,
  shipping: Set<string>,
): MergedCatalog {
  const labels = new Map<string, string>();
  const digested = (values: Iterable<string>): string[] =>
    [...values].map((value) => {
      const digest = legacySkillDigest(value);
      labels.set(digest, value);
      return digest;
    });
  const currentDigests = new Set([...current].map(legacySkillDigest));
  const shippingDigests = new Set([...shipping].map(legacySkillDigest));
  const names = [...new Set([...digested(catalog.keys()), ...recorded.names])]
    .filter((name) => !currentDigests.has(name))
    .sort();
  const historyDescriptions = digested([...catalog.values()].flatMap((set) => [...set]));
  const descriptions = [...new Set([...historyDescriptions, ...recorded.descriptions])]
    .filter((description) => !shippingDigests.has(description))
    .sort();
  return { names, descriptions, labels };
}

export function render(
  catalog: Map<string, Set<string>>,
  recorded: { names: string[]; descriptions: string[] },
  current: CurrentSkills = currentSkills(),
): string {
  const { names, descriptions } = mergeCatalog(catalog, recorded, current.names, current.descriptions);
  const lines: string[] = [
    '// GENERATED by `bun scripts/legacy-skills-catalog.ts --write` from git history. Do not edit by hand.',
    '//',
    '// Every skill name genie shipped under a `skills/` directory in shipped or',
    '// proven archive history and no longer delivers, plus every description it',
    '// carried under any name that no currently shipped skill carries, each as its',
    '// digest (`src/lib/legacy-skill-digest.ts`). A directory in an agent home under',
    "// a genie name whose description digest appears here is genie's own pre-record",
    '// install (see `src/lib/legacy-skills.ts`).',
    '',
    "/** Genie-owned marker directories left by deleted runtimes; genie's by name alone. */",
    `export const LEGACY_MARKER_DIRS: readonly string[] = ${JSON.stringify(MARKER_DIRS)};`,
    '',
    '/** The digest of every skill name genie once delivered and no longer does. */',
    'export const LEGACY_SKILL_NAME_DIGESTS: readonly string[] = [',
  ];
  for (const name of names) lines.push(`  ${JSON.stringify(name)},`);
  lines.push(
    '];',
    '',
    '/** The digest of every retired frontmatter `description` a genie skill ever shipped with, under any name. */',
    'export const LEGACY_SKILL_DESCRIPTION_DIGESTS: readonly string[] = [',
  );
  for (const description of descriptions) lines.push(`  ${JSON.stringify(description)},`);
  lines.push('];', '');
  return lines.join('\n');
}

/**
 * What `--check` can and cannot prove, printed on EVERY verdict — green ones
 * included, because a green line that reads like an exact match is exactly how
 * a hand-added entry or a shallow checkout goes unnoticed.
 */
export const CATALOG_CHECK_GAP =
  "legacy-skills-catalog: --check is an additive-union SUPERSET check: it proves the committed catalog carries everything THIS clone's shipped history yields (HEAD, every tag, exact origin/main, origin/dev and refs/archive/*, plus exact trusted Genie archive proof — never an ordinary unmerged branch), never that it carries nothing more. An entry added by hand, or one retired on a ref this clone never fetched, is invisible to it — which is why it must run on a FULL clone (`fetch-depth: 0`), never a shallow checkout.";

export interface CatalogCheckVerdict {
  /** True when the committed file differs from what a regeneration would write. */
  stale: boolean;
  /** Names this clone's history yields that the committed catalog does not carry (as text). */
  missingNames: string[];
  /** Descriptions this clone's history yields that the committed catalog does not carry (as text). */
  missingDescriptions: string[];
  /** The exact lines the CLI prints, gap sentence last. */
  lines: string[];
}

/**
 * The `--check` verdict as a pure function, so the gate's reasoning is testable
 * without walking git history or shelling out to biome.
 */
export function evaluateCatalogCheck(
  existing: string,
  expected: string,
  catalog: { merged: MergedCatalog; recorded: { names: string[]; descriptions: string[] } },
): CatalogCheckVerdict {
  const { merged, recorded } = catalog;
  const label = (digest: string) => merged.labels.get(digest) ?? digest;
  const missingNames = merged.names.filter((name) => !recorded.names.includes(name)).map(label);
  const missingDescriptions = merged.descriptions
    .filter((description) => !recorded.descriptions.includes(description))
    .map(label);
  const stale = existing !== expected;
  const lines: string[] = [];
  if (stale) {
    lines.push('legacy-skills-catalog: stale — run `bun scripts/legacy-skills-catalog.ts --write`');
    lines.push(
      missingNames.length + missingDescriptions.length === 0
        ? 'legacy-skills-catalog: the committed file carries every entry this history yields; it differs in formatting or ordering only'
        : `legacy-skills-catalog: this clone's history yields ${missingNames.length} name(s) and ${missingDescriptions.length} description(s) the committed catalog does not carry${missingNames.length > 0 ? ` (${missingNames.slice(0, 5).join(', ')}${missingNames.length > 5 ? ', …' : ''})` : ''}`,
    );
  } else {
    lines.push(
      `legacy-skills-catalog: current — ${merged.names.length} retired name(s), ${merged.descriptions.length} retired description(s)`,
    );
  }
  lines.push(CATALOG_CHECK_GAP);
  return { stale, missingNames, missingDescriptions, lines };
}

/** The catalog is committed in the repository's biome style, so the generator emits it that way. */
function formatted(source: string): string {
  return execFileSync('bunx', ['biome', 'format', '--stdin-file-path', relative(ROOT, OUTPUT)], {
    cwd: ROOT,
    encoding: 'utf8',
    input: source,
    maxBuffer: 1 << 26,
  });
}

/**
 * The one refusal `--check` owns. On a shallow clone the history walk sees
 * (almost) nothing, so the collected catalog is empty, the additive union
 * leaves the committed file unchanged, and the check passes having proven
 * NOTHING — the exact vacuous green the CI `fetch-depth: 0` exists to prevent.
 * `--write` stays allowed: a maintainer regenerating on a partial clone still
 * only ever adds, and the union protects the rest.
 */
export const SHALLOW_REFUSAL =
  'legacy-skills-catalog: refusing --check on a shallow clone — the walk over the shipped and proven archive refs cannot see the history this catalog is derived from, so the additive union would pass vacuously; re-run on a FULL clone (`fetch-depth: 0`). `--write` is still allowed.';

function isShallowClone(): boolean {
  try {
    return git('rev-parse', '--is-shallow-repository').trim() === 'true';
  } catch {
    // Not a git repo, or a git too old for the flag: the walk below answers.
    return false;
  }
}

// Only the CLI walks git history, shells out to biome and exits: importing this module
// (the tests inject a synthetic catalog into `render`) must do none of that.
if (import.meta.main) {
  const mode = process.argv[2];
  // Before ANY work: a shallow --check cannot prove what it claims.
  if (mode === '--check' && isShallowClone()) {
    process.stderr.write(`${SHALLOW_REFUSAL}\n`);
    process.exit(1);
  }
  const provenanceIndex = process.argv.indexOf('--ref-provenance', 2);
  const provenance = provenanceIndex === -1 ? undefined : process.argv[provenanceIndex + 1];
  if (
    provenanceIndex !== -1 &&
    (provenanceIndex !== process.argv.lastIndexOf('--ref-provenance') || !provenance || provenance.startsWith('--'))
  ) {
    throw new Error('--ref-provenance requires one exact commit-bound SHA:root-path selector');
  }
  const collected = collectCatalog(ROOT, provenance);
  const recorded = await recordedCatalog();
  const current = currentSkills(ROOT);
  const rendered = render(collected, recorded, current);

  if (mode === '--write') {
    writeFileSync(OUTPUT, formatted(rendered), 'utf8');
    process.stdout.write(`legacy-skills-catalog: wrote ${OUTPUT}\n`);
  } else if (mode === '--check') {
    let existing = '';
    try {
      existing = readFileSync(OUTPUT, 'utf8');
    } catch {
      // Missing counts as stale.
    }
    const verdict = evaluateCatalogCheck(existing, formatted(rendered), {
      merged: mergeCatalog(collected, recorded, current.names, current.descriptions),
      recorded,
    });
    const sink = verdict.stale ? process.stderr : process.stdout;
    for (const line of verdict.lines) sink.write(`${line}\n`);
    if (verdict.stale) process.exit(1);
  } else {
    process.stdout.write(rendered);
  }
}
