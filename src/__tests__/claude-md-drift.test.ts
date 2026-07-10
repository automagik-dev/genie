import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Drift guard for the canonical AGENTS.md contract and Claude-specific overlay.
 *
 * CLAUDE.md must describe v5 reality, not the demolished v4 harness. This test
 * fails hard if any retired-v4 fossil string reappears (a stale edit or a bad
 * merge that resurrects the old surface). Add a token here whenever a v4
 * concept is removed for good.
 */

const CLAUDE_MD = join(import.meta.dir, '..', '..', 'CLAUDE.md');
const AGENTS_MD = join(import.meta.dir, '..', '..', 'AGENTS.md');

// Substrings that MUST NOT appear anywhere in CLAUDE.md. Each is a v4 fossil:
// a demolished subsystem, a deleted env var, or a retired command namespace.
const RETIRED_FOSSILS: ReadonlyArray<string> = [
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
];

// v5 command surface that MUST stay documented so the file can't drift back
// into describing a body that no longer ships.
const REQUIRED_V5_COMMANDS: ReadonlyArray<string> = [
  'board',
  'doctor',
  'hook',
  'init',
  'launch',
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
    expect(shared).toContain('plugins/genie/references/native-surfaces.md');
  });

  test('does not resurrect the dead Genie loopback relay', () => {
    expect(content).not.toContain('relay is load-bearing');
    expect(shared).toContain('Do not use telemetry presence as integration health');
  });

  for (const fossil of RETIRED_FOSSILS) {
    test(`does not contain retired v4 fossil: ${JSON.stringify(fossil)}`, () => {
      expect(content).not.toContain(fossil);
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
