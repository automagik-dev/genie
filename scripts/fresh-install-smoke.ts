#!/usr/bin/env bun

/**
 * Exercise the exact Codex source-plugin layout without relying on symlink
 * dereference, a globally installed Genie CLI, or Claude-only skill variables.
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSkillMetadata } from './skills-lint.ts';
import { SHIPPED_SKILL_NAMES, assertPluginSkillsInSync } from './sync-plugin-skills.ts';

export function repositoryRootFromModuleUrl(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..');
}

const REPO_ROOT = repositoryRootFromModuleUrl(import.meta.url);

export const CODEX_ROLE_PROFILE_FILES = [
  'genie-engineer-complex.toml',
  'genie-engineer-standard.toml',
  'genie-engineer-trivial.toml',
  'genie-final-gate.toml',
  'genie-fixer.toml',
  'genie-reviewer.toml',
  'genie-scout.toml',
] as const;

export const CLAUDE_ROLE_AGENT_FILES = [
  'engineer-complex.md',
  'engineer-standard.md',
  'engineer-trivial.md',
  'final-gate.md',
  'fixer.md',
  'reviewer.md',
  'scout.md',
] as const;

const CODEX_ROLE_PROFILE_CONTRACTS = {
  'genie-engineer-complex.toml': {
    name: 'genie_engineer_complex',
    effort: 'xhigh',
    sandboxMode: 'workspace-write',
  },
  'genie-engineer-standard.toml': {
    name: 'genie_engineer_standard',
    effort: 'high',
    sandboxMode: 'workspace-write',
  },
  'genie-engineer-trivial.toml': {
    name: 'genie_engineer_trivial',
    effort: 'low',
    sandboxMode: 'workspace-write',
  },
  'genie-final-gate.toml': { name: 'genie_final_gate', effort: 'high', sandboxMode: 'read-only' },
  'genie-fixer.toml': { name: 'genie_fixer', effort: 'medium', sandboxMode: 'workspace-write' },
  'genie-reviewer.toml': { name: 'genie_reviewer', effort: 'xhigh', sandboxMode: null },
  'genie-scout.toml': { name: 'genie_scout', effort: 'low', sandboxMode: 'read-only' },
} as const satisfies Record<
  (typeof CODEX_ROLE_PROFILE_FILES)[number],
  { name: string; effort: string; sandboxMode: 'workspace-write' | 'read-only' | null }
>;

const CLAUDE_ROLE_AGENT_CONTRACTS = {
  'engineer-complex.md': { name: 'engineer-complex', model: 'opus', effort: 'xhigh' },
  'engineer-standard.md': { name: 'engineer-standard', model: 'opus', effort: 'high' },
  'engineer-trivial.md': { name: 'engineer-trivial', model: 'opus', effort: 'low' },
  'final-gate.md': { name: 'final-gate', model: 'fable', effort: 'high' },
  'fixer.md': { name: 'fixer', model: 'opus', effort: 'medium' },
  'reviewer.md': { name: 'reviewer', model: 'opus', effort: 'xhigh' },
  'scout.md': { name: 'scout', model: 'haiku', effort: 'low' },
} as const satisfies Record<(typeof CLAUDE_ROLE_AGENT_FILES)[number], { name: string; model: string; effort: string }>;

class SmokeFailure extends Error {}

function fail(message: string): never {
  throw new SmokeFailure(message);
}

interface SmokeArgs {
  skillsDir: string;
  pluginRoot?: string;
  expectProductInventory: boolean;
}

function parseArgs(argv: string[]): SmokeArgs {
  let skillsDir = join(REPO_ROOT, 'skills');
  let pluginRoot: string | undefined = join(REPO_ROOT, 'plugins', 'genie');
  let customSkills = false;
  let customPlugin = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--skills-dir') {
      const next = argv[i + 1];
      if (!next) fail('--skills-dir requires a path argument');
      skillsDir = resolve(next);
      customSkills = true;
      i++;
      continue;
    }
    if (argv[i] === '--plugin-root') {
      const next = argv[i + 1];
      if (!next) fail('--plugin-root requires a path argument');
      pluginRoot = resolve(next);
      customPlugin = true;
      i++;
      continue;
    }
    fail(`unknown argument: ${argv[i]}`);
  }
  if (customSkills && !customPlugin) pluginRoot = undefined;
  return { skillsDir, pluginRoot, expectProductInventory: !customSkills && !customPlugin };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactPhysicalFiles(root: string, relativeDir: string, expected: readonly string[]): string {
  const directory = join(root, relativeDir);
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) fail(`role directory not found: ${directory}`);
  if (lstatSync(directory).isSymbolicLink()) fail(`role directory must be physical: ${directory}`);
  const entries = readdirSync(directory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (names.join('\n') !== [...expected].sort().join('\n')) {
    fail(`${relativeDir} role inventory differs (expected ${expected.join(', ')}, got ${names.join(', ')})`);
  }
  for (const entry of entries) {
    const file = join(directory, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink() || lstatSync(file).isSymbolicLink()) {
      fail(`role profile must be a physical file: ${file}`);
    }
  }
  return directory;
}

function checkCodexRoleProfiles(pluginRoot: string): void {
  const directory = exactPhysicalFiles(pluginRoot, 'codex-agents', CODEX_ROLE_PROFILE_FILES);
  for (const fileName of CODEX_ROLE_PROFILE_FILES) {
    const file = join(directory, fileName);
    let parsed: unknown;
    try {
      parsed = Bun.TOML.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      fail(`${fileName} is not parseable TOML: ${error instanceof Error ? error.message : String(error)}`);
    }
    const contract = CODEX_ROLE_PROFILE_CONTRACTS[fileName];
    const accessMatches =
      contract.sandboxMode === null
        ? parsed !== undefined &&
          isRecord(parsed) &&
          parsed.approval_policy === 'never' &&
          parsed.default_permissions === ':read-only' &&
          parsed.sandbox_mode === undefined
        : parsed !== undefined && isRecord(parsed) && parsed.sandbox_mode === contract.sandboxMode;
    if (
      !isRecord(parsed) ||
      parsed.name !== contract.name ||
      parsed.model_reasoning_effort !== contract.effort ||
      !accessMatches ||
      typeof parsed.description !== 'string' ||
      parsed.description.trim() === '' ||
      typeof parsed.developer_instructions !== 'string' ||
      parsed.developer_instructions.trim() === ''
    ) {
      fail(`${fileName} must match the canonical ${contract.name} role contract`);
    }
  }
}

function checkClaudeRoleAgents(pluginRoot: string): void {
  const directory = exactPhysicalFiles(pluginRoot, 'agents', CLAUDE_ROLE_AGENT_FILES);
  for (const fileName of CLAUDE_ROLE_AGENT_FILES) {
    const file = join(directory, fileName);
    const raw = readFileSync(file, 'utf8');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
    if (!frontmatter) fail(`${fileName} must start with closed YAML frontmatter`);
    let parsed: unknown;
    try {
      parsed = Bun.YAML.parse(frontmatter[1]);
    } catch (error) {
      fail(`${fileName} is not parseable YAML: ${error instanceof Error ? error.message : String(error)}`);
    }
    const contract = CLAUDE_ROLE_AGENT_CONTRACTS[fileName];
    if (
      !isRecord(parsed) ||
      parsed.name !== contract.name ||
      typeof parsed.description !== 'string' ||
      parsed.description.trim() === '' ||
      parsed.model !== contract.model ||
      parsed.effort !== contract.effort ||
      raw.slice(frontmatter[0].length).trim() === ''
    ) {
      fail(`${fileName} must match the canonical ${contract.name} role contract`);
    }
  }
}

function checkRoleInventories(pluginRoot: string): void {
  checkCodexRoleProfiles(pluginRoot);
  checkClaudeRoleAgents(pluginRoot);
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

function checkSkillStarterPrompts(skillsDir: string, names: string[]): void {
  for (const name of names) {
    const metadata = readFileSync(join(skillsDir, name, 'agents', 'openai.yaml'), 'utf8');
    if (!metadata.includes(`$genie:${name}`)) {
      fail(`${name}/agents/openai.yaml must name the owner-qualified $genie:${name} selector`);
    }
    const qualifiesBareSelector =
      metadata.includes('separately installed personal copy') ||
      metadata.includes('intentionally selecting its user-tier copy');
    if (metadata.includes(`$${name}`) && !qualifiesBareSelector) {
      fail(`${name}/agents/openai.yaml uses an ambiguous bare selector without a user-tier qualifier`);
    }
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

function resolvePluginSkills(pluginRoot: string): { skillsDir: string; manifest: Record<string, unknown> } {
  const manifestPath = join(pluginRoot, '.codex-plugin', 'plugin.json');
  if (!existsSync(manifestPath)) fail(`Codex plugin manifest missing: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  if (typeof manifest.skills !== 'string' || !manifest.skills.startsWith('./')) {
    fail('Codex plugin manifest skills path must start with ./');
  }
  const declared = resolve(pluginRoot, manifest.skills);
  if (!isWithin(resolve(pluginRoot), declared))
    fail(`Codex plugin skills path escapes plugin root: ${manifest.skills}`);
  if (!existsSync(declared)) fail(`Codex plugin skills path is missing: ${manifest.skills}`);
  if (lstatSync(declared).isSymbolicLink()) fail(`Codex plugin skills path must be physical: ${manifest.skills}`);
  const realPluginRoot = realpathSync(pluginRoot);
  const realSkills = realpathSync(declared);
  if (!isWithin(realPluginRoot, realSkills))
    fail(`Codex plugin skills path resolves outside plugin root: ${manifest.skills}`);
  return { skillsDir: declared, manifest };
}

function checkStarterPrompts(manifest: Record<string, unknown>, names: string[]): void {
  const interfaceMetadata = manifest.interface as { defaultPrompt?: unknown } | undefined;
  const prompts = interfaceMetadata?.defaultPrompt;
  if (!Array.isArray(prompts) || !prompts.every((prompt) => typeof prompt === 'string')) {
    fail('Codex plugin interface.defaultPrompt must be an array of strings');
  }
  for (const required of ['wish', 'work', 'review']) {
    if (!names.includes(required) || !prompts.some((prompt) => prompt.includes(`$genie:${required}`))) {
      fail(`Codex plugin starter prompts must name $genie:${required}`);
    }
  }
}

function checkPluginMcpLayout(pluginRoot: string, manifest: Record<string, unknown>): void {
  if (manifest.mcpServers !== './.mcp.json') {
    fail('Codex plugin manifest mcpServers must point to ./.mcp.json');
  }
  const configPath = join(pluginRoot, '.mcp.json');
  if (!existsSync(configPath)) fail(`Codex plugin MCP config missing: ${configPath}`);
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  if ('mcpServers' in config) fail('Codex plugin .mcp.json must not use unsupported camelCase mcpServers');
  const wrapped = config.mcp_servers;
  const serverMap =
    typeof wrapped === 'object' && wrapped !== null && !Array.isArray(wrapped)
      ? (wrapped as Record<string, unknown>)
      : config;
  const rawEntry = serverMap.genie;
  const entry =
    typeof rawEntry === 'object' && rawEntry !== null && !Array.isArray(rawEntry)
      ? (rawEntry as { command?: unknown; args?: unknown; cwd?: unknown })
      : undefined;
  if (
    entry?.command !== 'node' ||
    !Array.isArray(entry.args) ||
    entry.args.length !== 1 ||
    entry.args[0] !== './scripts/mcp-launcher.cjs' ||
    entry.cwd !== '.'
  ) {
    fail('Codex plugin MCP entry must run node ./scripts/mcp-launcher.cjs with cwd "."');
  }
  const launcher = resolve(pluginRoot, entry.args[0]);
  if (!isWithin(resolve(pluginRoot), launcher)) fail('Codex MCP launcher escapes the plugin root');
  if (!existsSync(launcher) || !lstatSync(launcher).isFile() || lstatSync(launcher).isSymbolicLink()) {
    fail(`Codex MCP launcher must be a physical plugin-local file: ${launcher}`);
  }
  if (!isWithin(realpathSync(pluginRoot), realpathSync(launcher))) {
    fail('Codex MCP launcher resolves outside the plugin root');
  }
}

function checkPluginLayout(pluginRoot: string, canonicalSkills: string, expectedNames: string[]): void {
  const { skillsDir, manifest } = resolvePluginSkills(pluginRoot);
  const actual = listSkillNames(skillsDir);
  if (actual.join('\n') !== [...expectedNames].sort().join('\n')) {
    fail(`plugin skill inventory differs (expected ${expectedNames.length}, got ${actual.length})`);
  }
  assertPluginSkillsInSync({
    canonicalDir: canonicalSkills,
    pluginSkillsDir: skillsDir,
    expectedSkillNames: expectedNames,
  });
  checkStarterPrompts(manifest, expectedNames);
  checkPluginMcpLayout(pluginRoot, manifest);
  checkRoleInventories(pluginRoot);
}

/** Copy the plugin exactly as a source marketplace does, without dereferencing links. */
function checkSourceCopy(pluginRoot: string, canonicalSkills: string, expectedNames: string[]): void {
  const workRoot = mkdtempSync(join(tmpdir(), 'genie-source-plugin-'));
  try {
    const copiedRoot = join(workRoot, 'genie');
    cpSync(pluginRoot, copiedRoot, { recursive: true, dereference: false, verbatimSymlinks: true });
    checkPluginLayout(copiedRoot, canonicalSkills, expectedNames);
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

/** Mirror Codex's versioned cache nesting and verify relative MCP paths there too. */
function checkCacheCopy(pluginRoot: string, canonicalSkills: string, expectedNames: string[]): void {
  const workRoot = mkdtempSync(join(tmpdir(), 'genie-cache-plugin-'));
  try {
    const cachedRoot = join(workRoot, 'cache', 'automagik', 'genie', 'fixture-version');
    mkdirSync(join(workRoot, 'cache', 'automagik', 'genie'), { recursive: true });
    cpSync(pluginRoot, cachedRoot, { recursive: true, dereference: false, verbatimSymlinks: true });
    checkPluginLayout(cachedRoot, canonicalSkills, expectedNames);
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
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
    if (args.expectProductInventory && names.join('\n') !== [...SHIPPED_SKILL_NAMES].sort().join('\n')) {
      fail(`expected ${SHIPPED_SKILL_NAMES.length} shipped skills, got ${names.length}`);
    }
    checkMetadata(args.skillsDir, names);
    checkSkillStarterPrompts(args.skillsDir, names);
    const refs = checkBundledReferences(args.skillsDir, names);
    runWishScaffoldSmoke(args.skillsDir);
    if (args.pluginRoot) {
      checkPluginLayout(args.pluginRoot, args.skillsDir, names);
      checkSourceCopy(args.pluginRoot, args.skillsDir, names);
      checkCacheCopy(args.pluginRoot, args.skillsDir, names);
    }
    const roleSummary = args.pluginRoot ? ', 7 Codex + 7 Claude role profiles' : '';
    console.log(
      `fresh-install-smoke: OK (${names.length} valid skills, ${refs} bundled references${roleSummary}, source/package parity, Claude variables unset)`,
    );
  } catch (error) {
    if (!(error instanceof SmokeFailure)) throw error;
    console.error(`fresh-install-smoke: FAIL — ${error.message}`);
    process.exit(1);
  }
}

if (import.meta.main) main();
