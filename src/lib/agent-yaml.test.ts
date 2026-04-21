/**
 * Agent YAML — Unit Tests
 *
 * Covers:
 *   - Round-trip: writeAgentYaml → parseAgentYaml returns the same config
 *     after stripping the derived fields (name, dir, registeredAt).
 *   - Strict schema: unknown top-level keys fail with the key named.
 *   - Scope guard: `skill` and `extraArgs` are rejected (out of scope for
 *     this wish — they live in the `agent_templates` PG row, not the file).
 *   - Nested: `permissions.bashAllowPatterns` parses; `permissions.bashAllow`
 *     (wrong name) throws an unknown-field error.
 *   - extractFrontmatterFromAgentsMd purity + byte-for-byte body fidelity
 *     (CRLF, trailing newlines, Unicode, "no frontmatter" case).
 *   - Concurrent writeAgentYaml calls on the same path yield exactly one
 *     winner — never a partial/spliced file.
 *   - Malformed YAML surfaces a clear error.
 *
 * Run with: bun test src/lib/agent-yaml.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentConfig,
  AgentConfigSchema,
  extractFrontmatterFromAgentsMd,
  parseAgentYaml,
  writeAgentYaml,
} from './agent-yaml.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'agent-yaml-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function tmpYaml(name = 'agent.yaml'): string {
  return join(tempDir, name);
}

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe('writeAgentYaml / parseAgentYaml round-trip', () => {
  test('round-trips a fully-populated config (minus derived fields)', async () => {
    const path = tmpYaml();
    const input: AgentConfig = {
      repo: '/home/user/repo',
      team: 'my-team',
      promptMode: 'append',
      model: 'sonnet',
      roles: ['engineer', 'reviewer'],
      omniAgentId: 'uuid-1234',
      description: 'My agent',
      color: 'blue',
      provider: 'claude-sdk',
      permissions: {
        preset: 'strict',
        allow: ['Read', 'Grep'],
        deny: ['Bash'],
        bashAllowPatterns: ['git status', 'ls *'],
      },
      disallowedTools: ['WebSearch'],
      omniScopes: ['say', 'react'],
      hooks: { PreToolUse: [{ matcher: 'Read' }] },
      sdk: {
        permissionMode: 'default',
        maxTurns: 50,
        allowedTools: ['Read', 'Write'],
        settingSources: ['user', 'project'],
      },
      bridgeTmuxSession: 'felipe',
    };

    await writeAgentYaml(path, input);
    const parsed = await parseAgentYaml(path);
    expect(parsed).toEqual(input);
  });

  test('round-trips bridgeTmuxSession alone and preserves slash-containing values', async () => {
    const path = tmpYaml();
    const input: AgentConfig = {
      promptMode: 'system',
      bridgeTmuxSession: 'whatsapp-scout-12',
    };
    await writeAgentYaml(path, input);
    const parsed = await parseAgentYaml(path);
    expect(parsed.bridgeTmuxSession).toBe('whatsapp-scout-12');

    // Slashes are allowed at the storage layer — sanitization happens at
    // resolution time in the executor, not here.
    const slashPath = tmpYaml('slash.yaml');
    await writeAgentYaml(slashPath, { bridgeTmuxSession: 'felipe/scout' });
    const parsedSlash = await parseAgentYaml(slashPath);
    expect(parsedSlash.bridgeTmuxSession).toBe('felipe/scout');
  });

  test('strips derived fields (name, dir, registeredAt) from on-disk YAML', async () => {
    const path = tmpYaml();
    const input: AgentConfig = {
      name: 'derived-name',
      dir: '/some/absolute/path',
      registeredAt: '2026-01-01T00:00:00Z',
      model: 'opus',
      promptMode: 'append',
    };

    await writeAgentYaml(path, input);
    const onDisk = await readFile(path, 'utf-8');

    // The raw YAML file must NOT contain any of the derived keys.
    expect(onDisk).not.toContain('name:');
    expect(onDisk).not.toContain('dir:');
    expect(onDisk).not.toContain('registeredAt:');

    // Non-derived fields must still round-trip.
    expect(onDisk).toContain('model: opus');
    expect(onDisk).toContain('promptMode: append');

    const parsed = await parseAgentYaml(path);
    expect(parsed.name).toBeUndefined();
    expect(parsed.dir).toBeUndefined();
    expect(parsed.registeredAt).toBeUndefined();
    expect(parsed.model).toBe('opus');
    expect(parsed.promptMode).toBe('append');
  });

  test('round-trips an empty config', async () => {
    const path = tmpYaml();
    await writeAgentYaml(path, {});
    const parsed = await parseAgentYaml(path);
    expect(parsed).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Strict schema / scope guard
// ---------------------------------------------------------------------------

describe('AgentConfigSchema strict mode', () => {
  test('rejects an unknown top-level key with the key named', () => {
    const result = AgentConfigSchema.safeParse({ model: 'sonnet', bogus: 42 });
    expect(result.success).toBe(false);
    if (result.success) return;
    const message = result.error.issues
      .map((i) => `${i.code}:${JSON.stringify((i as any).keys ?? i.message)}`)
      .join('|');
    expect(message).toContain('bogus');
  });

  test('rejects `skill` top-level key (scope guard for agent_templates DB field)', () => {
    const result = AgentConfigSchema.safeParse({ skill: 'whatever' });
    expect(result.success).toBe(false);
    if (result.success) return;
    const flat = JSON.stringify(result.error.issues);
    expect(flat).toContain('skill');
  });

  test('rejects `extraArgs` top-level key (scope guard for agent_templates DB field)', () => {
    const result = AgentConfigSchema.safeParse({ extraArgs: ['--foo'] });
    expect(result.success).toBe(false);
    if (result.success) return;
    const flat = JSON.stringify(result.error.issues);
    expect(flat).toContain('extraArgs');
  });

  test('parseAgentYaml surfaces the unknown-key error message when skill is present', async () => {
    const path = tmpYaml('scope-guard.yaml');
    await writeFile(path, 'skill: something\nmodel: sonnet\n', 'utf-8');
    await expect(parseAgentYaml(path)).rejects.toThrow(/skill/);
  });
});

// ---------------------------------------------------------------------------
// Nested fields
// ---------------------------------------------------------------------------

describe('permissions nested schema', () => {
  test('accepts permissions.bashAllowPatterns (correct name)', () => {
    const result = AgentConfigSchema.safeParse({
      permissions: {
        bashAllowPatterns: ['git status', 'ls'],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.permissions?.bashAllowPatterns).toEqual(['git status', 'ls']);
    }
  });

  test('rejects permissions.bashAllow (wrong field name)', () => {
    const result = AgentConfigSchema.safeParse({
      permissions: {
        bashAllow: ['git status'],
      },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const flat = JSON.stringify(result.error.issues);
    expect(flat).toContain('bashAllow');
    // And the error should be pinned to the nested `permissions` path.
    expect(flat).toContain('permissions');
  });

  test('rejects an unknown nested key even when sibling fields are valid', () => {
    const result = AgentConfigSchema.safeParse({
      permissions: {
        allow: ['Read'],
        unknown: true,
      },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const flat = JSON.stringify(result.error.issues);
    expect(flat).toContain('unknown');
  });
});

// ---------------------------------------------------------------------------
// extractFrontmatterFromAgentsMd — purity + byte-for-byte body fidelity
// ---------------------------------------------------------------------------

describe('extractFrontmatterFromAgentsMd', () => {
  test('returns full body when no frontmatter fence is present', () => {
    const content = '# Hello\n\nThis is the body.\n';
    const { frontmatter, body } = extractFrontmatterFromAgentsMd(content);
    expect(frontmatter).toBeNull();
    expect(body).toBe(content);
  });

  test('extracts basic frontmatter and returns body starting after the closing fence', () => {
    const content = '---\nname: test\nmodel: sonnet\n---\n# Body\n';
    const { frontmatter, body } = extractFrontmatterFromAgentsMd(content);
    expect(frontmatter).toBe('name: test\nmodel: sonnet');
    expect(body).toBe('# Body\n');
  });

  test('preserves CRLF line endings in the body byte-for-byte', () => {
    // Frontmatter itself uses LF (YAML convention); body preserves CRLF.
    const content = '---\nname: test\n---\n# Body\r\n\r\nLine two\r\n';
    const { frontmatter, body } = extractFrontmatterFromAgentsMd(content);
    expect(frontmatter).toBe('name: test');
    expect(body).toBe('# Body\r\n\r\nLine two\r\n');
  });

  test('preserves trailing newlines exactly', () => {
    const content = '---\nname: test\n---\nbody line\n\n\n';
    const { body } = extractFrontmatterFromAgentsMd(content);
    expect(body).toBe('body line\n\n\n');
  });

  test('preserves Unicode characters (emoji, Portuguese accents, CJK)', () => {
    const body = 'Olá, Genie! 🧞 こんにちは — café\n';
    const content = `---\nname: unicode\n---\n${body}`;
    const result = extractFrontmatterFromAgentsMd(content);
    expect(result.frontmatter).toBe('name: unicode');
    expect(result.body).toBe(body);
  });

  test('returns no-frontmatter when content does not start with `---\\n`', () => {
    // Leading space/newline/BOM must NOT match.
    const leadingSpace = ' ---\nname: test\n---\nbody';
    expect(extractFrontmatterFromAgentsMd(leadingSpace).frontmatter).toBeNull();
    expect(extractFrontmatterFromAgentsMd(leadingSpace).body).toBe(leadingSpace);

    const leadingNewline = '\n---\nname: test\n---\nbody';
    expect(extractFrontmatterFromAgentsMd(leadingNewline).frontmatter).toBeNull();
    expect(extractFrontmatterFromAgentsMd(leadingNewline).body).toBe(leadingNewline);
  });

  test('returns no-frontmatter when the closing fence is missing', () => {
    const content = '---\nname: test\nbody-but-no-fence';
    const { frontmatter, body } = extractFrontmatterFromAgentsMd(content);
    expect(frontmatter).toBeNull();
    expect(body).toBe(content);
  });

  test('is pure — calling twice returns equal results without side effects', () => {
    const content = '---\nname: pure\n---\nbody\n';
    const a = extractFrontmatterFromAgentsMd(content);
    const b = extractFrontmatterFromAgentsMd(content);
    expect(a).toEqual(b);
    // The input string must not be mutated.
    expect(content).toBe('---\nname: pure\n---\nbody\n');
  });

  test('handles empty frontmatter block', () => {
    const content = '---\n---\nbody\n';
    const { frontmatter, body } = extractFrontmatterFromAgentsMd(content);
    expect(frontmatter).toBe('');
    expect(body).toBe('body\n');
  });
});

// ---------------------------------------------------------------------------
// Concurrent writes
// ---------------------------------------------------------------------------

describe('concurrent writeAgentYaml', () => {
  test('two simultaneous writers produce exactly one winner — never a splice', async () => {
    const path = tmpYaml('concurrent.yaml');

    const a: AgentConfig = {
      model: 'opus',
      description: 'alpha '.repeat(200).trim(),
    };
    const b: AgentConfig = {
      model: 'sonnet',
      description: 'bravo '.repeat(200).trim(),
    };

    // Kick off both writes in parallel and await both. One will acquire the
    // lock first and persist; the other will block, acquire after, and overwrite.
    // Either way, the final file must parse cleanly and equal exactly one input.
    await Promise.all([writeAgentYaml(path, a), writeAgentYaml(path, b)]);

    const parsed = await parseAgentYaml(path);
    // The parsed result must be EXACTLY one of the two inputs.
    const matchA = parsed.model === a.model && parsed.description === a.description;
    const matchB = parsed.model === b.model && parsed.description === b.description;
    expect(matchA || matchB).toBe(true);
    expect(matchA && matchB).toBe(false); // mutually exclusive
  });

  test('many parallel writers all complete and yield a parseable file', async () => {
    const path = tmpYaml('many-concurrent.yaml');
    const configs: AgentConfig[] = Array.from({ length: 8 }, (_, i) => ({
      model: `model-${i}`,
      description: `writer ${i}`,
    }));

    await Promise.all(configs.map((cfg) => writeAgentYaml(path, cfg)));

    const parsed = await parseAgentYaml(path);
    // Result must match EXACTLY one of the configs.
    const hits = configs.filter((c) => c.model === parsed.model && c.description === parsed.description);
    expect(hits).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Malformed YAML
// ---------------------------------------------------------------------------

describe('parseAgentYaml error handling', () => {
  test('throws a clear error on malformed YAML', async () => {
    const path = tmpYaml('malformed.yaml');
    // Unclosed quote — js-yaml will throw.
    await writeFile(path, 'model: "unclosed\n', 'utf-8');
    await expect(parseAgentYaml(path)).rejects.toThrow(/Malformed YAML/);
  });

  test('throws when the file is missing', async () => {
    const path = tmpYaml('does-not-exist.yaml');
    await expect(parseAgentYaml(path)).rejects.toThrow(/Failed to read/);
  });

  test('throws when the top-level YAML is an array rather than a mapping', async () => {
    const path = tmpYaml('array.yaml');
    await writeFile(path, '- foo\n- bar\n', 'utf-8');
    await expect(parseAgentYaml(path)).rejects.toThrow(/must be a YAML mapping/);
  });

  test('treats an empty file as an empty config', async () => {
    const path = tmpYaml('empty.yaml');
    await writeFile(path, '', 'utf-8');
    const parsed = await parseAgentYaml(path);
    expect(parsed).toEqual({});
  });
});
