#!/usr/bin/env bun

/**
 * Exercise the shipped `skills/` tree exactly as a fresh install delivers it:
 * no symlink dereference, no globally installed Genie CLI, and no Claude-only
 * skill variables. Every check reads the physical skills tree and the bundled
 * resources each SKILL.md names, so a skill that only works out of a source
 * checkout — or out of a plugin payload that no longer ships — fails here.
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSkillMetadata } from './skills-lint.ts';

export function repositoryRootFromModuleUrl(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..');
}

const REPO_ROOT = repositoryRootFromModuleUrl(import.meta.url);

class SmokeFailure extends Error {}

function fail(message: string): never {
  throw new SmokeFailure(message);
}

interface SmokeArgs {
  skillsDir: string;
  expectProductInventory: boolean;
}

function parseArgs(argv: string[]): SmokeArgs {
  let skillsDir = join(REPO_ROOT, 'skills');
  let customSkills = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--skills-dir') {
      const next = argv[i + 1];
      if (!next) fail('--skills-dir requires a path argument');
      skillsDir = resolve(next);
      customSkills = true;
      i++;
      continue;
    }
    fail(`unknown argument: ${argv[i]}`);
  }
  return { skillsDir, expectProductInventory: !customSkills };
}

function listSkillNames(skillsDir: string): string[] {
  if (!existsSync(skillsDir) || !lstatSync(skillsDir).isDirectory()) fail(`skills dir not found: ${skillsDir}`);
  if (lstatSync(skillsDir).isSymbolicLink()) fail(`skills dir must be physical, not a symlink: ${skillsDir}`);
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
}

function checkMetadata(skillsDir: string, names: string[]): void {
  for (const name of names) {
    const validation = validateSkillMetadata(join(skillsDir, name));
    if (validation.violations.length > 0) {
      fail(`${name}: ${validation.violations.join('; ')}`);
    }
  }
}

/** Verify literal bundled resources resolve from the loaded skill package. */
function checkBundledReferences(skillsDir: string, names: string[]): number {
  let checked = 0;
  const resourcePattern = /\b((?:templates|references?|prompts|assets)\/[A-Za-z0-9._/-]+)/g;
  for (const name of names) {
    const skillDir = join(skillsDir, name);
    const text = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    for (const forbidden of ['plugins/genie/references/', '$GENIE_HOME/plugins/genie']) {
      if (text.includes(forbidden)) {
        fail(`${name}/SKILL.md depends on a source-checkout/global plugin path: ${forbidden}`);
      }
    }
    let match: RegExpExecArray | null = resourcePattern.exec(text);
    while (match !== null) {
      const resource = match[1].replace(/[.,;:)]+$/, '');
      const candidate = resolve(skillDir, resource);
      if (!isWithin(resolve(skillDir), candidate) || !existsSync(candidate)) {
        fail(`${name}/SKILL.md references missing bundled resource: ${resource}`);
      }
      checked++;
      match = resourcePattern.exec(text);
    }
  }
  return checked;
}

export function checkSkillStarterPrompts(skillsDir: string, names: string[]): void {
  for (const name of names) {
    const metadata = Bun.YAML.parse(readFileSync(join(skillsDir, name, 'agents', 'openai.yaml'), 'utf8')) as {
      interface?: { default_prompt?: unknown };
    };
    const prompt = metadata.interface?.default_prompt;
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      fail(`${name}/agents/openai.yaml must provide a non-empty starter prompt`);
    }
    if (/\$(?:[a-z0-9][a-z0-9-]*:)?[a-z0-9][a-z0-9-]*/i.test(prompt)) {
      fail(`${name}/agents/openai.yaml starter prompt must be selector-free across physical tiers`);
    }
  }
}

function checkDesignReviewEvidenceTool(skillsDir: string, names: string[]): void {
  if (!names.includes('brainstorm') || !names.includes('wish')) return;
  const brainstormTool = join(skillsDir, 'brainstorm', 'references', 'design-review-evidence.mjs');
  const wishTool = join(skillsDir, 'wish', 'references', 'design-review-evidence.mjs');
  const template = join(skillsDir, 'brainstorm', 'references', 'design-template.md');
  for (const file of [brainstormTool, wishTool, template]) {
    if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) {
      fail(`design-review contract resource must be a physical file: ${file}`);
    }
  }
  const root = mkdtempSync(join(tmpdir(), 'genie-design-review-smoke-'));
  try {
    const design = join(root, 'DESIGN.md');
    cpSync(template, design);
    const digest = Bun.spawnSync(['node', brainstormTool, 'digest', design], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (digest.exitCode !== 0) fail(`design-review digest failed: ${digest.stderr.toString().trim()}`);
    const reviewedSha256 = digest.stdout.toString().trim();
    if (!/^[a-f0-9]{64}$/.test(reviewedSha256)) {
      fail('design-review digest must be exactly 64 lowercase hex characters');
    }
    const stamp = Bun.spawnSync(
      [
        'node',
        brainstormTool,
        'stamp',
        design,
        '--verdict',
        'SHIP',
        '--reviewed-sha256',
        reviewedSha256,
        '--reviewer',
        'fresh-install-smoke',
        '--reviewed-at',
        '2026-07-11T00:00:00.000Z',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    if (stamp.exitCode !== 0) fail(`design-review stamp failed: ${stamp.stderr.toString().trim()}`);
    const verified = Bun.spawnSync(['node', wishTool, 'verify', design], { stdout: 'pipe', stderr: 'pipe' });
    if (verified.exitCode !== 0) fail(`design-review verification failed: ${verified.stderr.toString().trim()}`);

    writeFileSync(design, `${readFileSync(design, 'utf8')}\npost-review drift\n`);
    const stale = Bun.spawnSync(['node', wishTool, 'verify', design], { stdout: 'pipe', stderr: 'pipe' });
    if (stale.exitCode === 0 || !stale.stderr.toString().includes('design changed after review')) {
      fail('design-review verifier did not reject post-review content drift');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const WISH_SCAFFOLD_START = '<!-- wish-scaffold-command:start -->';
const WISH_SCAFFOLD_END = '<!-- wish-scaffold-command:end -->';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Parse the workflow that the wish skill actually documents. Keeping this
 * parser deliberately narrow makes prose, missing placeholders, or a second
 * competing scaffold command a smoke-test failure rather than an untested
 * instruction change.
 */
function documentedWishScaffoldCommand(instructions: string, wishDir: string, slug: string): string {
  const start = instructions.indexOf(WISH_SCAFFOLD_START);
  const end = instructions.indexOf(WISH_SCAFFOLD_END);
  if (start < 0 || end < 0 || end <= start) fail('wish skill has no bounded scaffold command');
  if (
    instructions.indexOf(WISH_SCAFFOLD_START, start + WISH_SCAFFOLD_START.length) >= 0 ||
    instructions.indexOf(WISH_SCAFFOLD_END, end + WISH_SCAFFOLD_END.length) >= 0
  ) {
    fail('wish skill must document exactly one scaffold command');
  }

  const block = instructions.slice(start + WISH_SCAFFOLD_START.length, end);
  const fence = /^[\t \r\n]*```(?:sh|bash)\r?\n([\s\S]*?)\r?\n[\t ]*```[\t \r\n]*$/.exec(block);
  if (!fence) fail('wish scaffold command must be one sh/bash fence between its markers');

  const commandLines = fence[1].split(/\r?\n/);
  const indents = commandLines.filter((line) => line.trim() !== '').map((line) => /^\s*/.exec(line)?.[0].length ?? 0);
  const commonIndent = indents.length > 0 ? Math.min(...indents) : 0;
  let command = commandLines.map((line) => line.slice(commonIndent)).join('\n');
  const substitute = (name: 'WISH_SKILL_DIR' | 'WISH_SLUG', value: string): void => {
    const assignment = new RegExp(`^${name}=.*$`, 'gm');
    const matches = command.match(assignment) ?? [];
    if (matches.length !== 1) fail(`wish scaffold command must assign ${name} exactly once`);
    command = command.replace(assignment, `${name}=${shellQuote(value)}`);
  };
  substitute('WISH_SKILL_DIR', wishDir);
  substitute('WISH_SLUG', slug);
  return command;
}

/** Execute the exact scaffold workflow documented by the shipped wish skill. */
function runWishScaffoldSmoke(skillsDir: string): void {
  const wishDir = join(skillsDir, 'wish');
  if (!existsSync(join(wishDir, 'SKILL.md'))) fail(`no wish skill under ${skillsDir}`);
  const instructions = readFileSync(join(wishDir, 'SKILL.md'), 'utf8');
  if (!instructions.includes('templates/wish-template.md')) fail('wish skill does not name its bundled template');

  const workRoot = mkdtempSync(join(tmpdir(), 'genie-fresh-install-'));
  try {
    const repo = join(workRoot, 'consumer-repo');
    mkdirSync(repo, { recursive: true });
    const git = Bun.spawnSync(['git', 'init', '-q'], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
    if (git.exitCode !== 0) fail(`git init failed: ${git.stderr.toString().trim()}`);

    const slug = 'smoke-wish';
    const destination = join(repo, '.genie', 'wishes', slug, 'WISH.md');
    const command = documentedWishScaffoldCommand(instructions, wishDir, slug);
    const scaffold = Bun.spawnSync(['sh', '-eu', '-c', command], {
      cwd: repo,
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: workRoot,
        CLAUDE_SKILL_DIR: undefined,
        CLAUDE_PLUGIN_ROOT: undefined,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (scaffold.exitCode !== 0) {
      fail(`documented wish scaffold failed without host variables: ${scaffold.stderr.toString().trim()}`);
    }
    if (!existsSync(destination)) fail('documented wish scaffold did not create WISH.md');

    const wish = readFileSync(destination, 'utf8');
    const required = [
      '## Summary',
      '## Scope',
      '### IN',
      '### OUT',
      '## Dependencies',
      '## Success Criteria',
      '## Execution Strategy',
      '## Execution Groups',
    ];
    const missing = required.filter((section) => !wish.includes(section));
    if (missing.length > 0) fail(`scaffolded WISH.md missing structural section(s): ${missing.join(', ')}`);
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

function main(): void {
  try {
    const args = parseArgs(process.argv.slice(2));
    const names = listSkillNames(args.skillsDir);
    if (args.expectProductInventory) {
      const shipped = listSkillNames(join(REPO_ROOT, 'skills'));
      if (names.join('\n') !== shipped.join('\n'))
        fail(`expected ${shipped.length} shipped skills, got ${names.length}`);
    }
    checkMetadata(args.skillsDir, names);
    checkSkillStarterPrompts(args.skillsDir, names);
    checkDesignReviewEvidenceTool(args.skillsDir, names);
    const refs = checkBundledReferences(args.skillsDir, names);
    runWishScaffoldSmoke(args.skillsDir);
    console.log(
      `fresh-install-smoke: OK (${names.length} valid skills, ${refs} bundled references, Claude variables unset)`,
    );
  } catch (error) {
    if (!(error instanceof SmokeFailure)) throw error;
    console.error(`fresh-install-smoke: FAIL — ${error.message}`);
    process.exit(1);
  }
}

if (import.meta.main) main();
