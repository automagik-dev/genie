/**
 * Tests for frontmatter-writer — bidirectional YAML frontmatter sync.
 *
 * Covers:
 *   - Write frontmatter to existing AGENTS.md (YAML updated, markdown body preserved)
 *   - Write to file with no frontmatter (--- block created)
 *   - Preserve unknown YAML fields through write cycle
 *   - SDK config serialization: nested structures survive roundtrip
 *   - Empty/undefined SDK fields omitted from output
 *
 * Run with: bun test src/lib/frontmatter-writer.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializeSdkConfig, writeFrontmatter } from './frontmatter-writer.js';
import { parseFrontmatter } from './frontmatter.js';
import type { SdkDirectoryConfig } from './sdk-directory-types.js';

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `genie-fm-writer-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ============================================================================
// writeFrontmatter — update existing AGENTS.md
// ============================================================================

describe('writeFrontmatter — existing file with frontmatter', () => {
  test('updates YAML fields and preserves markdown body', () => {
    const filePath = join(testDir, 'AGENTS.md');
    writeFileSync(
      filePath,
      `---
name: my-agent
model: sonnet
---

# Agent Identity

Instructions here...
`,
    );

    writeFrontmatter(filePath, { model: 'opus', description: 'Updated agent' });

    const content = readFileSync(filePath, 'utf-8');
    // Should contain updated fields
    expect(content).toContain('model: opus');
    expect(content).toContain('description: Updated agent');
    // Should still contain original name
    expect(content).toContain('name: my-agent');
    // Should preserve markdown body
    expect(content).toContain('# Agent Identity');
    expect(content).toContain('Instructions here...');
  });

  test('preserves exact markdown body including blank lines', () => {
    const filePath = join(testDir, 'AGENTS.md');
    const body = '\n# Agent Identity\n\nParagraph one.\n\nParagraph two.\n';
    writeFileSync(filePath, `---\nname: test\n---\n${body}`);

    writeFrontmatter(filePath, { model: 'opus' });

    const content = readFileSync(filePath, 'utf-8');
    // The body after the closing --- should be preserved exactly
    const closingIdx = content.indexOf('---', content.indexOf('---') + 3);
    const afterFrontmatter = content.slice(closingIdx + 3);
    expect(afterFrontmatter).toBe(`\n${body}`);
  });
});

// ============================================================================
// writeFrontmatter — file with no frontmatter
// ============================================================================

describe('writeFrontmatter — file without frontmatter', () => {
  test('creates --- block at top and preserves content below', () => {
    const filePath = join(testDir, 'AGENTS.md');
    writeFileSync(filePath, '# Just a heading\n\nSome content\n');

    writeFrontmatter(filePath, { name: 'new-agent', model: 'sonnet' });

    const content = readFileSync(filePath, 'utf-8');
    // Should start with frontmatter
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('name: new-agent');
    expect(content).toContain('model: sonnet');
    // Should still have original content
    expect(content).toContain('# Just a heading');
    expect(content).toContain('Some content');
  });
});

// ============================================================================
// Preserve unknown YAML fields
// ============================================================================

describe('writeFrontmatter — unknown field preservation', () => {
  test('preserves unknown YAML fields through write cycle', () => {
    const filePath = join(testDir, 'AGENTS.md');
    writeFileSync(
      filePath,
      `---
name: my-agent
customField: preserved-value
anotherCustom: 42
---

# Content
`,
    );

    writeFrontmatter(filePath, { model: 'opus' });

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('customField: preserved-value');
    expect(content).toContain('anotherCustom: 42');
    expect(content).toContain('model: opus');
    expect(content).toContain('name: my-agent');
  });
});

// ============================================================================
// SDK config serialization
// ============================================================================

describe('serializeSdkConfig', () => {
  test('serializes nested structures (mcpServers, agents)', () => {
    const sdk: SdkDirectoryConfig = {
      maxTurns: 50,
      maxBudgetUsd: 10,
      effort: 'high',
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@mcp/github'],
        },
      },
      agents: {
        researcher: {
          description: 'Quick research',
          prompt: 'Research things',
          tools: ['Read', 'Glob'],
          model: 'haiku',
        },
      },
    };

    const serialized = serializeSdkConfig(sdk);
    expect(serialized.maxTurns).toBe(50);
    expect(serialized.maxBudgetUsd).toBe(10);
    expect(serialized.effort).toBe('high');
    expect(serialized.mcpServers).toBeDefined();
    const mcpServers = serialized.mcpServers as Record<string, unknown>;
    expect(mcpServers.github).toBeDefined();
    expect(serialized.agents).toBeDefined();
    const agents = serialized.agents as Record<string, unknown>;
    expect(agents.researcher).toBeDefined();
  });

  test('nested structures survive roundtrip through YAML', () => {
    const filePath = join(testDir, 'AGENTS.md');
    writeFileSync(filePath, '---\nname: test-agent\n---\n\n# Content\n');

    const sdk: SdkDirectoryConfig = {
      maxTurns: 50,
      effort: 'high',
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@mcp/github'],
        },
      },
      agents: {
        researcher: {
          description: 'Quick research',
          prompt: 'Research things',
          tools: ['Read', 'Glob'],
          model: 'haiku',
        },
      },
    };

    writeFrontmatter(filePath, { sdk: serializeSdkConfig(sdk) });

    const content = readFileSync(filePath, 'utf-8');
    const parsed = parseFrontmatter(content);
    expect(parsed.sdk).toBeDefined();
    const sdkParsed = parsed.sdk as Record<string, unknown>;
    expect(sdkParsed.maxTurns).toBe(50);
    expect(sdkParsed.effort).toBe('high');

    const mcpServers = sdkParsed.mcpServers as Record<string, Record<string, unknown>>;
    expect(mcpServers.github.command).toBe('npx');
    expect(mcpServers.github.args).toEqual(['-y', '@mcp/github']);

    const agents = sdkParsed.agents as Record<string, Record<string, unknown>>;
    expect(agents.researcher.description).toBe('Quick research');
    expect(agents.researcher.tools).toEqual(['Read', 'Glob']);
  });

  test('omits undefined and default-value fields', () => {
    const sdk: SdkDirectoryConfig = {
      maxTurns: 50,
      // These are undefined and should be omitted
      permissionMode: undefined,
      tools: undefined,
      allowedTools: undefined,
    };

    const serialized = serializeSdkConfig(sdk);
    expect(serialized.maxTurns).toBe(50);
    expect('permissionMode' in serialized).toBe(false);
    expect('tools' in serialized).toBe(false);
    expect('allowedTools' in serialized).toBe(false);
  });

  test('empty arrays and objects are omitted', () => {
    const sdk: SdkDirectoryConfig = {
      effort: 'low',
      allowedTools: [],
      disallowedTools: [],
      mcpServers: {},
      agents: {},
    };

    const serialized = serializeSdkConfig(sdk);
    expect(serialized.effort).toBe('low');
    expect('allowedTools' in serialized).toBe(false);
    expect('disallowedTools' in serialized).toBe(false);
    expect('mcpServers' in serialized).toBe(false);
    expect('agents' in serialized).toBe(false);
  });
});
