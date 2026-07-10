#!/usr/bin/env bun
/**
 * fresh-install-smoke: a broken fresh install must never reach a release
 * unnoticed. Two guarantees, both exercised against the shipped skill tree:
 *
 *   (a) every `${CLAUDE_SKILL_DIR}/<path>` reference inside a SKILL.md
 *       resolves to a real file INSIDE that skill's own directory — a plugin
 *       install materializes each skill under its own CLAUDE_SKILL_DIR, so a
 *       reference that escapes the dir or points at a missing file is a
 *       ship-blocking breakage the moment the plugin is installed.
 *
 *   (b) the /wish scaffold step (template copy via the resolved
 *       CLAUDE_SKILL_DIR) succeeds in a fresh git repo with NO genie CLI on
 *       PATH, and the copied skeleton carries the structural checklist the
 *       parser and linter expect.
 *
 * Exits non-zero with a clear message on any violation. Temp dirs are removed
 * even when an assertion fails.
 *
 * Usage: bun run scripts/fresh-install-smoke.ts [--skills-dir <path>]
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

function fail(message: string): never {
  console.error(`fresh-install-smoke: FAIL — ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): { skillsDir: string } {
  let skillsDir = join(REPO_ROOT, 'skills');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--skills-dir') {
      const next = argv[i + 1];
      if (!next) fail('--skills-dir requires a path argument');
      skillsDir = resolve(next);
      i++;
    }
  }
  return { skillsDir };
}

function listSkillDirs(skillsDir: string): string[] {
  return readdirSync(skillsDir)
    .map((name) => join(skillsDir, name))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, 'SKILL.md')));
}

/**
 * (a) Resolve every `${CLAUDE_SKILL_DIR}/<path>` reference against the skill
 * that owns the SKILL.md. Returns the number of references verified.
 */
function checkSkillDirReferences(skillsDir: string): number {
  let refs = 0;
  for (const skillDir of listSkillDirs(skillsDir)) {
    const text = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    // Capture the path chars after the token, stopping at whitespace, quote,
    // backtick, or closing paren — the delimiters that surround it in prose or
    // a shell fence.
    const re = /\$\{CLAUDE_SKILL_DIR\}\/([^\s"'`)\\]+)/g;
    let m: RegExpExecArray | null = re.exec(text);
    while (m !== null) {
      refs++;
      const relPath = m[1].replace(/[.,;:)]+$/, '');
      const resolved = resolve(skillDir, relPath);
      const within = resolved === skillDir || resolved.startsWith(skillDir + sep);
      const label = `${skillDir}/SKILL.md: \${CLAUDE_SKILL_DIR}/${relPath}`;
      if (!within) fail(`${label} escapes the skill directory`);
      if (!existsSync(resolved) || !statSync(resolved).isFile()) {
        fail(`${label} does not resolve to a real file`);
      }
      m = re.exec(text);
    }
  }
  return refs;
}

/**
 * (b) Materialize the skill tree the way a plugin install lays it down, then
 * run the /wish scaffold step in a fresh git repo with a genie-free PATH.
 */
function runWishScaffoldSmoke(skillsDir: string): void {
  if (!existsSync(join(skillsDir, 'wish', 'SKILL.md'))) {
    fail(`no wish skill under ${skillsDir} — cannot exercise the scaffold step`);
  }

  const workRoot = mkdtempSync(join(tmpdir(), 'genie-fresh-install-'));
  try {
    // Copy the skills the way an installed plugin materializes them.
    const pluginSkills = join(workRoot, 'plugin', 'skills');
    mkdirSync(dirname(pluginSkills), { recursive: true });
    cpSync(skillsDir, pluginSkills, { recursive: true });

    // A fresh consumer repo with no genie state.
    const repo = join(workRoot, 'consumer-repo');
    mkdirSync(repo, { recursive: true });
    const git = Bun.spawnSync(['git', 'init', '-q'], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
    if (git.exitCode !== 0) fail(`git init failed: ${git.stderr.toString().trim()}`);

    // Execute the /wish scaffold verbatim, under a PATH that cannot see genie.
    const installedWishDir = join(pluginSkills, 'wish');
    const slug = 'smoke-wish';
    const script = [
      'set -e',
      'if command -v genie >/dev/null 2>&1; then echo "genie unexpectedly on PATH" >&2; exit 3; fi',
      `mkdir -p ".genie/wishes/${slug}"`,
      `cp "\${CLAUDE_SKILL_DIR}/templates/wish-template.md" ".genie/wishes/${slug}/WISH.md"`,
    ].join('\n');
    const scaffold = Bun.spawnSync(['bash', '-c', script], {
      cwd: repo,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', CLAUDE_SKILL_DIR: installedWishDir },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (scaffold.exitCode !== 0) {
      fail(`wish scaffold step failed (exit ${scaffold.exitCode}): ${scaffold.stderr.toString().trim()}`);
    }

    // Structural checklist presence in the copied skeleton.
    const wishPath = join(repo, '.genie', 'wishes', slug, 'WISH.md');
    if (!existsSync(wishPath)) fail('scaffold produced no WISH.md');
    const wish = readFileSync(wishPath, 'utf8');
    const required = [
      '## Summary',
      '## Scope',
      '### IN',
      '### OUT',
      '## Success Criteria',
      '## Execution Strategy',
      '## Execution Groups',
    ];
    const missing = required.filter((section) => !wish.includes(section));
    if (missing.length > 0) {
      fail(`scaffolded WISH.md missing structural section(s): ${missing.join(', ')}`);
    }
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

function main(): void {
  const { skillsDir } = parseArgs(process.argv.slice(2));
  if (!existsSync(skillsDir)) fail(`skills dir not found: ${skillsDir}`);
  const refs = checkSkillDirReferences(skillsDir);
  runWishScaffoldSmoke(skillsDir);
  const summary = `${refs} \${CLAUDE_SKILL_DIR} reference(s) resolved, wish scaffold works with no genie on PATH`;
  console.log(`fresh-install-smoke: OK (${summary})`);
}

main();
