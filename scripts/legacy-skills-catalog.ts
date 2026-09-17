#!/usr/bin/env bun
/**
 * Regenerate `src/lib/legacy-skills-catalog.ts` from git history.
 *
 * The catalog is how `genie update` and `genie doctor` recognise a skill
 * directory genie shipped BEFORE the install record existed: every skill name
 * that ever lived under a `skills/` directory on any ref and is no longer
 * delivered, plus every frontmatter `description` any genie skill ever shipped
 * under any name that NO currently shipped skill carries. A retired description
 * under a genie name proves a directory is genie's own pre-record install — a
 * third party does not copy genie's description verbatim, and a user's fork of a
 * CURRENT skill keeps a current description, which is deliberately absent here.
 *
 * Run by hand from a full clone (`git log --all` needs the whole history; a
 * shallow CI checkout would silently produce an incomplete catalog, which is
 * why this is not part of `bun run check`):
 *
 *   bun scripts/legacy-skills-catalog.ts --write
 *   bun scripts/legacy-skills-catalog.ts --check   # exits 1 when the file is stale
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const OUTPUT = join(ROOT, 'src', 'lib', 'legacy-skills-catalog.ts');
const MARKER_DIRS = ['.genie-codex-fallback-retirement'];

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
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

function currentSkillNames(): Set<string> {
  return new Set(
    readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
}

/** `{ name: Set<description> }` for every skill dir on any ref that is no longer shipped. */
function collectCatalog(): Map<string, Set<string>> {
  const catalog = new Map<string, Set<string>>();
  const commits = git('log', '--all', '--pretty=format:%H', '--', 'skills/*/SKILL.md', '*/skills/*/SKILL.md')
    .split('\n')
    .filter((line) => /^[0-9a-f]{40}$/.test(line));
  const seenBlobs = new Set<string>();
  for (const commit of commits) {
    const tree = git('ls-tree', '-r', commit).split('\n');
    for (const row of tree) {
      // `(?:.*\/)?` — a root-level `skills/<name>/SKILL.md` has no leading
      // slash; anchoring on one silently skipped every skill genie ever shipped
      // from the repo root and kept only nested worktree copies.
      const match = /^\d+ blob ([0-9a-f]{40})\t(?:.*\/)?skills\/([^/]+)\/SKILL\.md$/.exec(row);
      if (!match) continue;
      const [, blob, name] = match as unknown as [string, string, string];
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
      const description = parseDescription(git('cat-file', 'blob', blob));
      if (description === null) continue;
      if (!catalog.has(name)) catalog.set(name, new Set());
      (catalog.get(name) as Set<string>).add(description);
    }
  }
  return catalog;
}

/** The descriptions the tree ships right now: a fork of a current skill carries one of these. */
function currentDescriptions(): Set<string> {
  const found = new Set<string>();
  for (const name of currentSkillNames()) {
    let markdown = '';
    try {
      markdown = readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');
    } catch {
      continue;
    }
    const description = parseDescription(markdown);
    if (description !== null) found.add(description);
  }
  return found;
}

/**
 * What the committed catalog already carries. `git log --all` sees only the refs THIS clone holds,
 * so a description that lives on a branch another machine fetched would silently drop out of the
 * catalog on the next regeneration — and the proof it backs would weaken with it. The catalog is
 * therefore additive: a run unions what it can see with what is already recorded, and only the
 * currently shipped names and descriptions are ever subtracted.
 */
async function recordedCatalog(): Promise<{ names: string[]; descriptions: string[] }> {
  try {
    const module = (await import(OUTPUT)) as {
      LEGACY_SKILL_NAMES?: readonly string[];
      LEGACY_SKILL_DESCRIPTIONS?: readonly string[];
    };
    return {
      names: [...(module.LEGACY_SKILL_NAMES ?? [])],
      descriptions: [...(module.LEGACY_SKILL_DESCRIPTIONS ?? [])],
    };
  } catch {
    // No catalog yet, or one this build cannot import: history alone is the source.
    return { names: [], descriptions: [] };
  }
}

function render(catalog: Map<string, Set<string>>, recorded: { names: string[]; descriptions: string[] }): string {
  const current = currentSkillNames();
  const shipping = currentDescriptions();
  const names = [...new Set([...catalog.keys(), ...recorded.names])].filter((name) => !current.has(name)).sort();
  const descriptions = [...new Set([...[...catalog.values()].flatMap((set) => [...set]), ...recorded.descriptions])]
    .filter((description) => !shipping.has(description))
    .sort();
  const lines: string[] = [
    '// GENERATED by `bun scripts/legacy-skills-catalog.ts --write` from git history. Do not edit by hand.',
    '//',
    '// Every skill name genie shipped under a `skills/` directory on any ref and no',
    '// longer delivers, plus every frontmatter `description` any genie skill ever',
    '// carried under any name that no currently shipped skill carries. A directory',
    '// in an agent home under a genie name whose description appears here is',
    "// genie's own pre-record install (see `src/lib/legacy-skills.ts`).",
    '',
    "/** Genie-owned marker directories left by deleted runtimes; genie's by name alone. */",
    `export const LEGACY_MARKER_DIRS: readonly string[] = ${JSON.stringify(MARKER_DIRS)};`,
    '',
    '/** Skill names genie once delivered and no longer does. */',
    `export const LEGACY_SKILL_NAMES: readonly string[] = ${JSON.stringify(names)};`,
    '',
    '/** Every retired frontmatter `description` a genie skill ever shipped with, under any name. */',
    'export const LEGACY_SKILL_DESCRIPTIONS: readonly string[] = [',
  ];
  for (const description of descriptions) lines.push(`  ${JSON.stringify(description)},`);
  lines.push('];', '');
  return lines.join('\n');
}

const mode = process.argv[2];
const rendered = render(collectCatalog(), await recordedCatalog());
/** The catalog is committed in the repository's biome style, so the generator emits it that way. */
function formatted(source: string): string {
  return execFileSync('bunx', ['biome', 'format', '--stdin-file-path', relative(ROOT, OUTPUT)], {
    cwd: ROOT,
    encoding: 'utf8',
    input: source,
    maxBuffer: 1 << 26,
  });
}

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
  if (existing !== formatted(rendered)) {
    process.stderr.write('legacy-skills-catalog: stale — run `bun scripts/legacy-skills-catalog.ts --write`\n');
    process.exit(1);
  }
  process.stdout.write('legacy-skills-catalog: current\n');
} else {
  process.stdout.write(rendered);
}
