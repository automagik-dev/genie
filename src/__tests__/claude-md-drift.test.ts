import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Drift guard for the canonical AGENTS.md contract and Claude-specific overlay.
 *
 * Both files must describe current reality, not the demolished v4 harness and
 * not the plugin era the `skills-everywhere` wishes retired. This test fails
 * hard if any retired fossil string reappears in EITHER file (a stale edit or a
 * bad merge that resurrects the old surface). Add a token here whenever a
 * concept is removed for good.
 */

const CLAUDE_MD = join(import.meta.dir, '..', '..', 'CLAUDE.md');
const AGENTS_MD = join(import.meta.dir, '..', '..', 'AGENTS.md');

// Substrings that MUST NOT appear anywhere in CLAUDE.md or AGENTS.md. Each is a
// fossil: a demolished subsystem, a deleted env var, or a retired command
// namespace.
const RETIRED_FOSSILS: ReadonlyArray<string> = [
  // v4 harness
  'genie launch',
  'pgserve',
  'PostgreSQL',
  'GENIE_OTEL',
  'genie agent spawn',
  'genie team ',
  'genie exec ',
  '305KB',
  'tmux is required',
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  'workers.json',
  'GENIE_IDLE_TIMEOUT_MS',
  'buildTeamLeadCommand',
  'native-teams',
  'mailbox',
  // Plugin era, retired by `skills-everywhere-b` (RETIRED-9).
  'setup --codex',
  'agent-sync',
  'H3/H4/H6',
  '.curated',
  'LENS_ROOT',
  'CLAUDE_PLUGIN_ROOT',
  'genie@automagik',
  'council.js',
  'hook dispatch',
  // Plugin era, AGENTS.md-specific: the RETIRED-9 regex does not catch these.
  'native-surfaces.md',
  '.codex-plugin',
  'both marketplaces',
];

// v5 command surface that MUST stay documented so the file can't drift back
// into describing a body that no longer ships.
const REQUIRED_V5_COMMANDS: ReadonlyArray<string> = [
  'board',
  'config',
  'context',
  'doctor',
  'idea',
  'init',
  'setup',
  'shortcuts',
  'task',
  'uninstall',
  'update',
];

describe('CLAUDE.md v5 drift guard', () => {
  const content = readFileSync(CLAUDE_MD, 'utf8');
  const shared = readFileSync(AGENTS_MD, 'utf8');

  /**
   * The Claude overlay a session can actually load: CLAUDE.md always on, plus every
   * path-scoped `.claude/rules/*.md` (issue #2967) — the skills-channel narratives
   * moved there, so a claim may live in either half. Absent rules directory = the
   * overlay is CLAUDE.md alone.
   */
  const overlay = [
    content,
    ...readdirSync(join(import.meta.dir, '..', '..', '.claude', 'rules'))
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((name) => readFileSync(join(import.meta.dir, '..', '..', '.claude', 'rules', name), 'utf8')),
  ].join('\n');

  test('keeps AGENTS.md canonical and CLAUDE.md as an overlay', () => {
    expect(content).toContain('canonical shared repository contract in `AGENTS.md`');
    expect(shared).toContain('runtime-neutral contributor contract');
    expect(shared).toContain('delivered to every agent home by the skills channel');
  });

  test('does not resurrect the dead Genie loopback relay', () => {
    expect(content).not.toContain('relay is load-bearing');
    expect(shared).toContain('Do not use telemetry presence as integration health');
  });

  test('documents the one skills channel in both files', () => {
    for (const file of [overlay, shared]) {
      expect(file).toContain('npx skills add automagik-dev/genie');
      expect(file).toContain('skills-install.json');
    }
  });

  for (const fossil of RETIRED_FOSSILS) {
    test(`does not contain retired fossil: ${JSON.stringify(fossil)}`, () => {
      expect(content).not.toContain(fossil);
      expect(shared).not.toContain(fossil);
    });
  }

  for (const command of REQUIRED_V5_COMMANDS) {
    test(`documents v5 command: ${command}`, () => {
      expect(content).toContain(command);
    });
  }

  test('documents the v5 SQLite state store', () => {
    expect(content).toContain('genie.db');
    expect(content).toContain('bun:sqlite');
  });
});

/**
 * The second drift axis: CLAUDE.md's SUBCOMMAND blocks against the live
 * commander registry.
 *
 * The fossil guard above only forbids strings and the release-docs guard only
 * derives the TOP-LEVEL inventory, so `genie task move <id> --lane <x>`, a
 * `--worker` bolted onto `task heartbeat`, and a subcommand row naming four of
 * a command's five verbs all sat in the contributor contract with a green suite
 * (the 2026-09-15 dogfood run found them by hand). Every flag and verb CLAUDE.md
 * documents is now spawned and checked against `--help`.
 */
const ROOT = join(import.meta.dir, '..', '..');

function cliHelp(args: string[]): string {
  const proc = Bun.spawnSync([process.execPath, join(ROOT, 'src', 'genie.ts'), ...args, '--help'], { cwd: ROOT });
  expect(proc.exitCode).toBe(0);
  return proc.stdout.toString();
}

/** Registered subcommand names, `help` excluded. */
function subcommandNames(helpText: string): string[] {
  const block = helpText.split('Commands:')[1] ?? '';
  return [...block.matchAll(/^ {2}([a-z][a-z-]*)/gm)]
    .map((match) => match[1] as string)
    .filter((name) => name !== 'help')
    .sort();
}

/** Long options declared on the command itself (never the global block). */
function longOptions(helpText: string): string[] {
  const block = helpText.split('Options:')[1] ?? '';
  return [...block.matchAll(/--[a-z][a-z-]*/g)].map((match) => match[0]);
}

/** The `## CLI Commands` prose + table, up to the first `###` subsection. */
function commandTableSection(content: string): string {
  return content.split('## CLI Commands')[1]?.split('\n### ')[0] ?? '';
}

/** The backticked command name that opens each table row, sorted. */
function commandTableNames(content: string): string[] {
  return [...commandTableSection(content).matchAll(/^\| `([a-z][a-z-]*)/gm)].map((match) => match[1] as string).sort();
}

/** Count words the command-table sentence may use, keyed by the row count. */
const COUNT_WORDS: Readonly<Record<number, string>> = {
  12: 'Twelve',
  13: 'Thirteen',
  14: 'Fourteen',
  15: 'Fifteen',
  16: 'Sixteen',
  17: 'Seventeen',
  18: 'Eighteen',
  19: 'Nineteen',
  20: 'Twenty',
};

/** The lines of one ```bash block under a `### <heading>` section. */
function documentedLines(content: string, heading: string, verb: string): string[] {
  const section = content.split(`### ${heading}`)[1] ?? '';
  const block = section.split('```bash')[1]?.split('```')[0] ?? '';
  expect(block.length).toBeGreaterThan(0);
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`genie ${verb} `));
}

/** `genie task move <id> --to <lane>   # note` → `{ name: 'move', flags: ['--to'] }`. */
function documentedInvocation(line: string, verb: string): { name: string; flags: string[] } {
  const command = (line.split('#')[0] as string).trim();
  const name = command.slice(`genie ${verb} `.length).trim().split(/\s+/)[0] as string;
  return { name, flags: [...command.matchAll(/--[a-z][a-z-]*/g)].map((match) => match[0]) };
}

describe('CLAUDE.md subcommand drift guard', () => {
  const content = readFileSync(CLAUDE_MD, 'utf8');

  test('task move moves a card with --to, and --lane does not exist', () => {
    const options = longOptions(cliHelp(['task', 'move']));
    expect(options).toContain('--to');
    expect(options).not.toContain('--lane');
    const [documented] = documentedLines(content, 'Task subcommands', 'task').filter((line) =>
      line.startsWith('genie task move '),
    );
    expect(documented).toContain('--to <lane>');
    // The invocation itself, not the trailing comment that spells out the trap.
    expect(documentedInvocation(documented as string, 'task').flags).toEqual(['--to']);
  });

  test('task heartbeat is documented, and takes no --worker', () => {
    const options = longOptions(cliHelp(['task', 'heartbeat']));
    expect(options).not.toContain('--worker');
    const [documented] = documentedLines(content, 'Task subcommands', 'task').filter((line) =>
      line.startsWith('genie task heartbeat'),
    );
    expect(documented).toBeDefined();
    expect(documentedInvocation(documented as string, 'task').flags).toEqual([]);
  });

  test('every task verb and flag CLAUDE.md documents exists in the registry', () => {
    const verbs = subcommandNames(cliHelp(['task']));
    for (const line of documentedLines(content, 'Task subcommands', 'task')) {
      const { name, flags } = documentedInvocation(line, 'task');
      expect(verbs).toContain(name);
      const options = longOptions(cliHelp(['task', name]));
      for (const flag of flags) expect([name, ...options]).toContain(flag);
    }
  });

  /**
   * Dogfood 7 W5: `genie config` shipped, the `fix` skill built its repair
   * budget on `genie config get budgets.maxEscalationsPerGroup`, and the
   * contributor contract's own table still listed only the other fifteen
   * commands while claiming "Fifteen top-level commands". Nothing derived the
   * table from the registry, so any future command lands the same way. This
   * derives BOTH the inventory and the count word from `genie --help`.
   */
  test('the CLI command table names every registered top-level command', () => {
    const registered = subcommandNames(cliHelp([]));
    // `help` is registered too and carries its own row; every other row must
    // correspond to a real command, and every command to a row.
    expect(commandTableNames(content)).toEqual([...registered, 'help'].sort());
  });

  test('the CLI command table count word matches the number of rows', () => {
    const section = commandTableSection(content);
    const claimed = /^(\w+) top-level commands/m.exec(section)?.[1] as string;
    expect(claimed).toBeDefined();
    expect(COUNT_WORDS[commandTableNames(content).length]).toBe(claimed);
  });

  /**
   * The `config` row is load-bearing for a SHIPPED skill: `fix` resolves its
   * per-group repair budget from one dotted key. Pin the row to the key the
   * skill actually reads, and the key to one the CLI actually resolves.
   */
  test('the config row names the budget key the shipped fix skill reads', () => {
    const skill = readFileSync(join(ROOT, 'skills', 'fix', 'SKILL.md'), 'utf8');
    const key = /genie config get ([a-zA-Z.]+)/.exec(skill)?.[1] as string;
    expect(key).toBe('budgets.maxEscalationsPerGroup');
    const row = (content.split('\n').find((line) => line.startsWith('| `config` |')) as string) ?? '';
    expect(row).toContain(`\`${key}\``);
    // The key resolves: a typo in either document is a failing command line.
    const proc = Bun.spawnSync([process.execPath, join(ROOT, 'src', 'genie.ts'), 'config', 'get', key], { cwd: ROOT });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString().trim().length).toBeGreaterThan(0);
  });
});
