/**
 * Tests for shared frontmatter parser + Zod validation.
 *
 * Covers: valid input, missing fields, invalid enum values,
 * unknown fields, malformed YAML, and edge cases.
 *
 * Run with: bun test src/lib/frontmatter.test.ts
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { AgentFrontmatterSchema, parseFrontmatter } from './frontmatter.js';

// Capture console.warn calls for assertion
const warnMock = mock(() => {});
const originalWarn = console.warn;

function captureWarnings() {
  warnMock.mockReset();
  console.warn = warnMock;
}

afterEach(() => {
  console.warn = originalWarn;
});

// ============================================================================
// Valid input
// ============================================================================

describe('parseFrontmatter — valid input', () => {
  test('parses all known fields', () => {
    const content = `---
name: vegapunk/atlas
description: A research agent
model: opus
color: blue
promptMode: system
provider: claude
---

# Agent identity below...
`;
    const result = parseFrontmatter(content);
    expect(result.name).toBe('vegapunk/atlas');
    expect(result.description).toBe('A research agent');
    expect(result.model).toBe('opus');
    expect(result.color).toBe('blue');
    expect(result.promptMode).toBe('system');
    expect(result.provider).toBe('claude');
  });

  test('parses codex provider', () => {
    const content = `---
provider: codex
---
`;
    const result = parseFrontmatter(content);
    expect(result.provider).toBe('codex');
  });

  test('parses append promptMode', () => {
    const content = `---
promptMode: append
---
`;
    const result = parseFrontmatter(content);
    expect(result.promptMode).toBe('append');
  });

  test('handles model: inherit as a valid string', () => {
    const content = `---
model: inherit
---
`;
    const result = parseFrontmatter(content);
    expect(result.model).toBe('inherit');
  });

  test('handles model: sonnet', () => {
    const content = `---
model: sonnet
---
`;
    const result = parseFrontmatter(content);
    expect(result.model).toBe('sonnet');
  });
});

// ============================================================================
// Missing fields
// ============================================================================

describe('parseFrontmatter — missing fields', () => {
  test('returns empty object for no frontmatter', () => {
    const content = '# Just a heading\nSome content';
    const result = parseFrontmatter(content);
    expect(result).toEqual({});
  });

  test('returns empty object for empty frontmatter', () => {
    const content = `---
---
# Content`;
    // yaml.load of empty string returns undefined
    const result = parseFrontmatter(content);
    expect(result).toEqual({});
  });

  test('returns partial when only some fields present', () => {
    const content = `---
name: test-agent
model: haiku
---
`;
    const result = parseFrontmatter(content);
    expect(result.name).toBe('test-agent');
    expect(result.model).toBe('haiku');
    expect(result.description).toBeUndefined();
    expect(result.color).toBeUndefined();
    expect(result.promptMode).toBeUndefined();
    expect(result.provider).toBeUndefined();
  });
});

// ============================================================================
// Invalid values
// ============================================================================

describe('parseFrontmatter — invalid values', () => {
  test('invalid promptMode falls back to undefined with warning', () => {
    captureWarnings();
    const content = `---
name: test
promptMode: invalid
---
`;
    const result = parseFrontmatter(content);
    expect(result.name).toBe('test');
    expect(result.promptMode).toBeUndefined();
    expect(warnMock).toHaveBeenCalled();
    const warnMsg = warnMock.mock.calls.flat().join(' ');
    expect(warnMsg).toContain('promptMode');
  });

  test('invalid provider falls back to undefined with warning', () => {
    captureWarnings();
    const content = `---
name: test
provider: openai
---
`;
    const result = parseFrontmatter(content);
    expect(result.name).toBe('test');
    expect(result.provider).toBeUndefined();
    expect(warnMock).toHaveBeenCalled();
    const warnMsg = warnMock.mock.calls.flat().join(' ');
    expect(warnMsg).toContain('provider');
  });

  test('invalid model: opuss still passes (model is free-form string)', () => {
    captureWarnings();
    const content = `---
model: opuss
---
`;
    const result = parseFrontmatter(content);
    // model is a free-form string, not an enum — typos pass through
    // The consuming code (spawn resolution) handles unknown models
    expect(result.model).toBe('opuss');
  });

  test('multiple invalid fields produce multiple warnings', () => {
    captureWarnings();
    const content = `---
promptMode: bad
provider: bad
---
`;
    const result = parseFrontmatter(content);
    expect(result.promptMode).toBeUndefined();
    expect(result.provider).toBeUndefined();
    expect(warnMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================================
// Unknown fields
// ============================================================================

describe('parseFrontmatter — unknown fields', () => {
  test('unknown field produces warning and is ignored', () => {
    captureWarnings();
    const content = `---
name: test
foo: bar
---
`;
    const result = parseFrontmatter(content);
    expect(result.name).toBe('test');
    expect((result as Record<string, unknown>).foo).toBeUndefined();
    expect(warnMock).toHaveBeenCalled();
    const warnMsg = warnMock.mock.calls.flat().join(' ');
    expect(warnMsg).toContain('foo');
  });

  test('multiple unknown fields produce multiple warnings', () => {
    captureWarnings();
    const content = `---
name: test
foo: bar
baz: qux
---
`;
    const result = parseFrontmatter(content);
    expect(result.name).toBe('test');
    const allWarns = warnMock.mock.calls.flat().join(' ');
    expect(allWarns).toContain('foo');
    expect(allWarns).toContain('baz');
  });
});

// ============================================================================
// Malformed YAML
// ============================================================================

describe('parseFrontmatter — malformed YAML', () => {
  test('invalid YAML returns empty object', () => {
    const content = `---
: invalid: yaml: [
---
`;
    const result = parseFrontmatter(content);
    expect(result).toEqual({});
  });

  test('non-object YAML returns empty object', () => {
    const content = `---
just a string
---
`;
    const result = parseFrontmatter(content);
    expect(result).toEqual({});
  });

  test('content without closing --- returns empty', () => {
    const content = `---
name: test
no closing delimiter`;
    const result = parseFrontmatter(content);
    expect(result).toEqual({});
  });
});

// ============================================================================
// Zod schema direct tests
// ============================================================================

describe('AgentFrontmatterSchema', () => {
  test('accepts empty object', () => {
    const result = AgentFrontmatterSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test('accepts full valid object', () => {
    const result = AgentFrontmatterSchema.safeParse({
      name: 'test',
      description: 'A test agent',
      model: 'opus',
      color: 'red',
      promptMode: 'system',
      provider: 'codex',
    });
    expect(result.success).toBe(true);
  });

  test('rejects invalid promptMode', () => {
    const result = AgentFrontmatterSchema.safeParse({ promptMode: 'invalid' });
    expect(result.success).toBe(false);
  });

  test('rejects invalid provider', () => {
    const result = AgentFrontmatterSchema.safeParse({ provider: 'openai' });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// SDK frontmatter block
// ============================================================================

describe('parseFrontmatter — sdk block', () => {
  test('parses AGENTS.md with sdk: block into sdk field', () => {
    const content = `---
name: senior-engineer
description: "Senior engineer with full tool access"
model: opus
provider: claude-sdk
promptMode: system
color: green
sdk:
  permissionMode: acceptEdits
  tools:
    - Read
    - Glob
    - Grep
    - Bash
  allowedTools:
    - Read
    - Glob
  effort: high
  maxBudgetUsd: 10.00
  maxTurns: 100
  enableFileCheckpointing: true
  persistSession: true
  mcpServers:
    github:
      command: npx
      args:
        - "-y"
        - "@modelcontextprotocol/server-github"
  agents:
    researcher:
      description: "Quick codebase research"
      tools:
        - Read
        - Glob
        - Grep
      model: haiku
      effort: low
  systemPrompt: "You are a senior engineer at Namastex."
---

# Senior Engineer Identity
`;
    const result = parseFrontmatter(content);
    expect(result.name).toBe('senior-engineer');
    expect(result.provider).toBe('claude-sdk');
    expect(result.sdk).toBeDefined();
    expect(result.sdk!.permissionMode).toBe('acceptEdits');
    expect(result.sdk!.tools).toEqual(['Read', 'Glob', 'Grep', 'Bash']);
    expect(result.sdk!.maxBudgetUsd).toBe(10.0);
    expect(result.sdk!.maxTurns).toBe(100);
    expect(result.sdk!.enableFileCheckpointing).toBe(true);
    expect(result.sdk!.mcpServers).toBeDefined();
    expect(result.sdk!.mcpServers as Record<string, unknown>).toHaveProperty('github');
    expect(result.sdk!.agents).toBeDefined();
    expect(result.sdk!.systemPrompt).toBe('You are a senior engineer at Namastex.');
  });

  test('provider: claude-sdk parses without warning', () => {
    captureWarnings();
    const content = `---
provider: claude-sdk
---
`;
    const result = parseFrontmatter(content);
    expect(result.provider).toBe('claude-sdk');
    // No warnings should be emitted for valid provider
    const providerWarns = warnMock.mock.calls.flat().filter((msg: string) => String(msg).includes('provider'));
    expect(providerWarns.length).toBe(0);
  });

  test('unknown fields inside sdk: block are preserved (not dropped)', () => {
    const content = `---
name: test-agent
sdk:
  customField: "custom-value"
  nestedCustom:
    deep: true
  futureOption: 42
---
`;
    const result = parseFrontmatter(content);
    expect(result.sdk).toBeDefined();
    expect(result.sdk!.customField).toBe('custom-value');
    expect(result.sdk!.nestedCustom).toEqual({ deep: true });
    expect(result.sdk!.futureOption).toBe(42);
  });

  test('sdk: block does not trigger unknown field warning', () => {
    captureWarnings();
    const content = `---
name: test
sdk:
  effort: high
---
`;
    const result = parseFrontmatter(content);
    expect(result.sdk).toBeDefined();
    // sdk is a known key — should not warn
    const sdkWarns = warnMock.mock.calls.flat().filter((msg: string) => String(msg).includes('"sdk"'));
    expect(sdkWarns.length).toBe(0);
  });

  test('missing sdk: block results in undefined sdk field', () => {
    const content = `---
name: test-agent
model: opus
---
`;
    const result = parseFrontmatter(content);
    expect(result.sdk).toBeUndefined();
  });
});

// ============================================================================
// Permissions, disallowedTools, omniScopes, hooks frontmatter
// ============================================================================

describe('parseFrontmatter — permissions and sandbox fields', () => {
  test('parses permissions with allow and deny lists', () => {
    const content = `---
name: sandboxed-agent
permissions:
  allow:
    - Read
    - Grep
    - "Bash(omni say *)"
    - "Bash(git *)"
  deny:
    - Write
    - Edit
---
`;
    const result = parseFrontmatter(content);
    expect(result.permissions).toBeDefined();
    expect(result.permissions!.allow).toEqual(['Read', 'Grep', 'Bash(omni say *)', 'Bash(git *)']);
    expect(result.permissions!.deny).toEqual(['Write', 'Edit']);
  });

  test('parses disallowedTools array', () => {
    const content = `---
name: restricted
disallowedTools:
  - Agent
  - NotebookEdit
---
`;
    const result = parseFrontmatter(content);
    expect(result.disallowedTools).toEqual(['Agent', 'NotebookEdit']);
  });

  test('parses omniScopes array', () => {
    const content = `---
name: omni-agent
omniScopes:
  - say
  - react
  - history
---
`;
    const result = parseFrontmatter(content);
    expect(result.omniScopes).toEqual(['say', 'react', 'history']);
  });

  test('parses hooks as permissive record', () => {
    const content = `---
name: hooked
hooks:
  PreToolUse:
    - matcher: "*"
      hooks:
        - type: command
          command: echo test
---
`;
    const result = parseFrontmatter(content);
    expect(result.hooks).toBeDefined();
    expect(result.hooks!.PreToolUse).toBeDefined();
  });

  test('missing sandbox fields result in undefined', () => {
    const content = `---
name: basic
---
`;
    const result = parseFrontmatter(content);
    expect(result.permissions).toBeUndefined();
    expect(result.disallowedTools).toBeUndefined();
    expect(result.omniScopes).toBeUndefined();
    expect(result.hooks).toBeUndefined();
  });

  test('permissions with only allow (no deny) is valid', () => {
    const content = `---
permissions:
  allow:
    - Read
    - Glob
---
`;
    const result = parseFrontmatter(content);
    expect(result.permissions).toBeDefined();
    expect(result.permissions!.allow).toEqual(['Read', 'Glob']);
    expect(result.permissions!.deny).toBeUndefined();
  });

  test('all sandbox fields together parse correctly', () => {
    const content = `---
name: full-sandbox
provider: claude-sdk
permissionMode: dontAsk
disallowedTools:
  - Agent
permissions:
  allow:
    - Read
    - "Bash(omni *)"
omniScopes:
  - say
hooks:
  PreToolUse:
    - matcher: Bash
---
`;
    const result = parseFrontmatter(content);
    expect(result.name).toBe('full-sandbox');
    expect(result.provider).toBe('claude-sdk');
    expect(result.disallowedTools).toEqual(['Agent']);
    expect(result.permissions!.allow).toEqual(['Read', 'Bash(omni *)']);
    expect(result.omniScopes).toEqual(['say']);
    expect(result.hooks).toBeDefined();
  });
});
