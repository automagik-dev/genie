/**
 * QA Spec Parser — Parses markdown test specs into structured QaSpec objects.
 *
 * Spec format:
 *   # Test: <name>
 *   ## Setup
 *   - spawn <agent> [options]
 *   - follow <agent|team>
 *   ## Actions
 *   1. send "<message>" to <agent>
 *   2. wait <N>s
 *   3. run <command>
 *   ## Expect
 *   - [ ] <expectation>
 */

import { readFile } from 'node:fs/promises';

// ============================================================================
// Types
// ============================================================================

type SetupStepKind = 'spawn' | 'follow';

export interface SetupStep {
  kind: SetupStepKind;
  /** Target agent or team name */
  target: string;
  /** Extra options (e.g., provider, team) */
  options: Record<string, string>;
}

type ActionStepKind = 'send' | 'wait' | 'run';

export interface ActionStep {
  kind: ActionStepKind;
  /** For send: the message body */
  message?: string;
  /** For send: destination agent */
  to?: string;
  /** For wait: seconds */
  seconds?: number;
  /** For run: shell command */
  command?: string;
}

export interface Expectation {
  /** Human-readable description from the markdown */
  description: string;
  /** Where to look: 'nats', 'inbox', 'log', 'output' */
  source: string;
  /** Field matchers (e.g., { kind: 'tool_call', text: '~echo hello' }) */
  matchers: Record<string, string>;
}

export interface QaSpec {
  /** Test name from the # heading */
  name: string;
  /** File path (for reporting) */
  file: string;
  /** Setup steps */
  setup: SetupStep[];
  /** Ordered actions to execute */
  actions: ActionStep[];
  /** Expectations to validate */
  expect: Expectation[];
}

// ============================================================================
// Parser
// ============================================================================

/** Parse a QA spec markdown file into a structured QaSpec. */
export async function parseQaSpec(filePath: string): Promise<QaSpec> {
  const content = await readFile(filePath, 'utf-8');
  return parseQaSpecContent(content, filePath);
}

type Section = 'none' | 'setup' | 'actions' | 'expect';

const SECTION_MAP: Record<string, Section> = {
  setup: 'setup',
  actions: 'actions',
  expect: 'expect',
};

/** Detect which section a ## heading belongs to. */
function detectSection(line: string): Section | null {
  for (const [keyword, section] of Object.entries(SECTION_MAP)) {
    if (new RegExp(`^##\\s+${keyword}`, 'i').test(line)) return section;
  }
  if (line.startsWith('## ')) return 'none';
  return null;
}

/** Parse QA spec content directly (for testing). */
function parseQaSpecContent(content: string, filePath = '<inline>'): QaSpec {
  const lines = content.split('\n');

  let name = '';
  let currentSection: Section = 'none';
  const setup: SetupStep[] = [];
  const actions: ActionStep[] = [];
  const expect: Expectation[] = [];

  const parsers: Record<Section, (line: string) => void> = {
    none: () => {},
    setup: (line) => {
      const step = parseSetupLine(line);
      if (step) setup.push(step);
    },
    actions: (line) => {
      const step = parseActionLine(line);
      if (step) actions.push(step);
    },
    expect: (line) => {
      const exp = parseExpectLine(line);
      if (exp) expect.push(exp);
    },
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('# ') && !trimmed.startsWith('## ')) {
      const match = trimmed.match(/^#\s+(?:Test:\s*)?(.+)$/);
      if (match) name = match[1].trim();
      continue;
    }

    const section = detectSection(trimmed);
    if (section !== null) {
      currentSection = section;
      continue;
    }

    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('<!--')) continue;

    parsers[currentSection](trimmed);
  }

  if (!name) name = filePath.replace(/.*\//, '').replace(/\.md$/, '');

  return { name, file: filePath, setup, actions, expect };
}

// ============================================================================
// Line Parsers
// ============================================================================

/** Parse a setup line like "- spawn engineer (provider: claude)" */
function parseSetupLine(line: string): SetupStep | null {
  const text = stripListPrefix(line);
  if (!text) return null;

  const spawnMatch = text.match(/^spawn\s+(\S+)(?:\s+\((.+)\))?$/i);
  if (spawnMatch) {
    return {
      kind: 'spawn',
      target: spawnMatch[1],
      options: spawnMatch[2] ? parseOptions(spawnMatch[2]) : {},
    };
  }

  const followMatch = text.match(/^(?:start\s+)?follow(?:\s+(?:on\s+)?(\S+))?(?:\s+\((.+)\))?$/i);
  if (followMatch) {
    return {
      kind: 'follow',
      target: followMatch[1] || 'team',
      options: followMatch[2] ? parseOptions(followMatch[2]) : {},
    };
  }

  return null;
}

/** Parse an action line like '1. send "echo hello" to engineer' */
function parseActionLine(line: string): ActionStep | null {
  const text = stripListPrefix(line);
  if (!text) return null;

  const sendMatch = text.match(/^send\s+"([^"]+)"\s+to\s+(\S+)/i);
  if (sendMatch) return { kind: 'send', message: sendMatch[1], to: sendMatch[2] };

  const waitMatch = text.match(/^wait\s+(?:for\s+.+?\s+)?\(?(?:max\s+)?(\d+)s\)?/i);
  if (waitMatch) return { kind: 'wait', seconds: Number.parseInt(waitMatch[1], 10) };

  const runMatch = text.match(/^run\s+(.+)$/i);
  if (runMatch) return { kind: 'run', command: runMatch[1] };

  return null;
}

/** Detect expectation source from keywords in the text. */
function detectSource(text: string): string {
  if (/\binbox\b/i.test(text)) return 'inbox';
  if (/\blog\b/i.test(text)) return 'log';
  if (/\boutput\b/i.test(text)) return 'output';
  return 'nats';
}

/** Extract key=value and key~=value matchers from text. */
function extractMatchers(text: string): Record<string, string> {
  const matchers: Record<string, string> = {};
  // Match key=value or key~=value pairs. Values are either quoted or unquoted (stop at next key= or end).
  const matcherRegex = /(\w+)\s*([~!]?=)\s*(?:"([^"]+)"|(\S+))/g;
  for (const match of text.matchAll(matcherRegex)) {
    const op = match[2] === '~=' ? '~' : '';
    const value = (match[3] ?? match[4]).trim();
    matchers[match[1]] = `${op}${value}`;
  }
  return matchers;
}

/** Parse an expect line like "- [ ] follow stream contains event kind=tool_call text~=echo" */
function parseExpectLine(line: string): Expectation | null {
  const text = line.replace(/^[-*]\s*\[[ x]\]\s*/i, '').trim();
  if (!text) return null;

  return {
    description: text,
    source: detectSource(text),
    matchers: extractMatchers(text),
  };
}

// ============================================================================
// Helpers
// ============================================================================

/** Strip markdown list prefixes: "- ", "* ", "1. ", etc. */
function stripListPrefix(line: string): string {
  return line
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .trim();
}

/** Parse "(key: value, key2: value2)" into Record. */
function parseOptions(text: string): Record<string, string> {
  const opts: Record<string, string> = {};
  for (const pair of text.split(',')) {
    const [key, ...rest] = pair.split(':');
    if (key && rest.length > 0) {
      opts[key.trim()] = rest.join(':').trim();
    }
  }
  return opts;
}
