import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Drift guard for the path-scoped rules half of the contributor contract (issue #2967).
 *
 * CLAUDE.md `## Gotchas` is now an always-on floor plus a rules index; the subsystem
 * deep-dives live in `.claude/rules/*.md`, each carried by `paths:` frontmatter globs.
 * The claude-md-drift guard checks the two contract files; this one checks the seam
 * between them, because a scoped rule that never loads is indistinguishable from a
 * rule that was deleted:
 *   - a rule file on disk that the index does not name is an orphan;
 *   - an index entry naming no file is a dangling pointer;
 *   - a `paths:` glob that matches no tracked file can never load;
 *   - index globs and frontmatter globs are one set, so neither half drifts.
 */

const ROOT = join(import.meta.dir, '..', '..');
const RULES_DIR = join(ROOT, '.claude', 'rules');
const CLAUDE_MD = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');

/** The rules index bullets inside CLAUDE.md `## Gotchas`: file → its backticked globs. */
function indexEntries(): Map<string, string[]> {
  const entries = new Map<string, string[]>();
  for (const match of CLAUDE_MD.matchAll(/^- `(\.claude\/rules\/[\w.-]+\.md)` \(paths: ([^)]+)\) — /gm)) {
    const file = match[1] as string;
    const globs = [...(match[2] as string).matchAll(/`([^`]+)`/g)].map((g) => g[1] as string);
    expect(entries.has(file), `CLAUDE.md indexes ${file} twice`).toBe(false);
    entries.set(file, globs);
  }
  return entries;
}

/** The `paths:` list of a rules file's YAML frontmatter (`---` … `---`, `  - glob` items). */
function frontmatterPaths(file: string): string[] {
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
  const end = lines.indexOf('---', 1);
  expect(end, `${file}: the frontmatter is not closed`).toBeGreaterThan(0);
  const items: string[] = [];
  let inPaths = false;
  for (const line of lines.slice(1, end)) {
    if (line.startsWith('paths:')) {
      inPaths = true;
      continue;
    }
    const item = /^ {2}- (.+)$/.exec(line);
    if (inPaths && item) items.push((item[1] as string).trim().replace(/^['"]|['"]$/g, ''));
    else if (line.trim()) inPaths = false;
  }
  return items;
}

/**
 * The glob shapes this repository writes — literal segments, `*` inside a segment,
 * and `**` crossing segments — matched the same way a `paths:` consumer reads them.
 */
function globToRegExp(glob: string): RegExp {
  let source = '';
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith('**', i)) {
      source += '.*';
      i += 2;
      continue;
    }
    const c = glob[i] as string;
    source += c === '*' ? '[^/]*' : /[a-zA-Z0-9_/-]/.test(c) ? c : `\\${c}`;
    i++;
  }
  return new RegExp(`^${source}$`);
}

function trackedFiles(): Set<string> {
  const proc = Bun.spawnSync(['git', 'ls-files'], { cwd: ROOT });
  expect(proc.exitCode).toBe(0);
  return new Set(proc.stdout.toString().split('\n').filter(Boolean));
}

describe('CLAUDE.md path-scoped rules drift guard', () => {
  test('the rules directory exists and is indexed', () => {
    expect(existsSync(RULES_DIR)).toBe(true);
    expect(indexEntries().size).toBeGreaterThan(0);
  });

  test('every rules file is named by exactly one index entry, and vice versa', () => {
    const indexed = indexEntries();
    const onDisk = readdirSync(RULES_DIR)
      .filter((name) => name.endsWith('.md'))
      .map((name) => `.claude/rules/${name}`)
      .sort();
    // An orphan rule file never loads for a reader who trusts the index; an index
    // entry with no file points at rules that exist nowhere.
    expect(indexed.has('.claude/rules/README.md')).toBe(false); // the index lives in CLAUDE.md
    expect([...indexed.keys()].sort()).toEqual(onDisk);
  });

  test('every rules file is tracked — an untracked rule never reaches any consumer', () => {
    const tracked = trackedFiles();
    for (const file of indexEntries().keys()) expect(tracked.has(file), `${file} is untracked`).toBe(true);
  });

  test('every paths glob matches at least one tracked file', () => {
    const tracked = [...trackedFiles()];
    for (const [file, globs] of indexEntries()) {
      expect(globs.length, `${file}: no paths globs`).toBeGreaterThan(0);
      for (const glob of globs) {
        const re = globToRegExp(glob);
        expect(
          tracked.some((path) => re.test(path)),
          `${file}: glob \`${glob}\` matches no tracked file`,
        ).toBe(true);
      }
    }
  });

  test('index globs and frontmatter globs are one set', () => {
    for (const [file, indexed] of indexEntries()) {
      expect([...indexed].sort()).toEqual([...frontmatterPaths(file)].sort());
    }
  });

  test('the moved families live in their rule file, not in the floor', () => {
    // Duplication drift: a gotcha pasted back into the floor re-bills every session
    // the split was made to stop. One anchor title per rules file is enough to
    // catch a wholesale copy; the verbatim move itself was reviewed, not derived.
    const anchors: Record<string, string> = {
      '.claude/rules/skills-installer.md': 'skills.sh is the one skills channel',
      '.claude/rules/workflows-channel.md': 'The workflows channel is the skills channel',
      '.claude/rules/dsh-skills-source.md': 'is also the DSH body',
      '.claude/rules/release-pipeline.md': 'verifies a public release with NO GitHub credential',
    };
    for (const [file, anchor] of Object.entries(anchors)) {
      expect(readFileSync(join(ROOT, file), 'utf8')).toContain(anchor);
      expect(CLAUDE_MD, `${anchor} is back in the CLAUDE.md floor`).not.toContain(anchor);
    }
  });

  test('the floor keeps the rules with no derivable glob and the ownership rules', () => {
    // Council condition 1 of #2967: the always-on floor carries every gotcha with
    // no derivable path glob and the ownership rules a grep-only session must
    // never miss. Pinned by anchor title, not by line, so editing prose above
    // them never fails this guard.
    for (const anchor of [
      'One `genie.db`, and a machine-scope path that must stay empty',
      'Wish state is persisted by the orchestrator, never the reviewer',
    ]) {
      expect(CLAUDE_MD).toContain(anchor);
    }
  });
});
