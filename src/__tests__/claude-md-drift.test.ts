import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
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
  'context',
  'doctor',
  'idea',
  'init',
  'omni',
  'setup',
  'shortcuts',
  'task',
  'uninstall',
  'update',
];

describe('CLAUDE.md v5 drift guard', () => {
  const content = readFileSync(CLAUDE_MD, 'utf8');
  const shared = readFileSync(AGENTS_MD, 'utf8');

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
    for (const file of [content, shared]) {
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
