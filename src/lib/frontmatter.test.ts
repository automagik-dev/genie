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
