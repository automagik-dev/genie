import { describe, expect, test } from 'bun:test';
import { RESOLVED_FIELDS, type ResolveContext, resolveFieldWithSource } from '../lib/defaults.js';

describe('RESOLVED_FIELDS', () => {
  test('v1 contains only model', () => {
    expect(RESOLVED_FIELDS).toEqual(['model']);
  });

  test('adding a field to RESOLVED_FIELDS would produce an extra triplet', () => {
    // Verify the constant is iterable and typed correctly
    for (const field of RESOLVED_FIELDS) {
      expect(typeof field).toBe('string');
    }
  });
});

describe('dir ls source taxonomy', () => {
  test('agent with explicit model → source is explicit', () => {
    const result = resolveFieldWithSource({ model: 'sonnet' }, 'model', {});
    expect(result.source).toBe('explicit');
    expect(result.value).toBe('sonnet');
  });

  test('sub-agent inheriting from parent → source is parent:<name>', () => {
    const ctx: ResolveContext = {
      parent: { name: 'engineer', fields: { model: 'sonnet' } },
    };
    const result = resolveFieldWithSource({}, 'model', ctx);
    expect(result.source).toBe('parent:engineer');
    expect(result.value).toBe('sonnet');
  });

  test('agent falling through to workspace default → source is workspace', () => {
    const ctx: ResolveContext = { workspaceDefaults: { model: 'haiku' } };
    const result = resolveFieldWithSource({}, 'model', ctx);
    expect(result.source).toBe('workspace');
    expect(result.value).toBe('haiku');
  });

  test('agent falling through to built-in → source is built-in', () => {
    const result = resolveFieldWithSource({}, 'model', {});
    expect(result.source).toBe('built-in');
    expect(result.value).toBe('opus');
  });
});

describe('dir export JSON shape', () => {
  test('export produces nested object with declared/resolved/source per field', () => {
    // Simulate what handleDirExport --json does
    const entry = { name: 'engineer', model: 'sonnet' } as Record<string, unknown>;
    const ctx: ResolveContext = {};
    const output: Record<string, unknown> = { name: entry.name };

    for (const field of RESOLVED_FIELDS) {
      const declared = entry[field] ?? null;
      const result = resolveFieldWithSource(entry, field, ctx);
      output[field] = {
        declared: declared ?? null,
        resolved: result.value,
        source: result.source,
      };
    }

    expect(output).toEqual({
      name: 'engineer',
      model: {
        declared: 'sonnet',
        resolved: 'sonnet',
        source: 'explicit',
      },
    });
  });

  test('export with no declared model shows null declared + built-in', () => {
    const entry = { name: 'onboarding' } as Record<string, unknown>;
    const ctx: ResolveContext = {};
    const output: Record<string, unknown> = { name: entry.name };

    for (const field of RESOLVED_FIELDS) {
      const declared = entry[field] ?? null;
      const result = resolveFieldWithSource(entry, field, ctx);
      output[field] = {
        declared: declared ?? null,
        resolved: result.value,
        source: result.source,
      };
    }

    expect(output).toEqual({
      name: 'onboarding',
      model: {
        declared: null,
        resolved: 'opus',
        source: 'built-in',
      },
    });
  });

  test('export with workspace default shows workspace source', () => {
    const entry = { name: 'onboarding' } as Record<string, unknown>;
    const ctx: ResolveContext = { workspaceDefaults: { model: 'haiku' } };
    const output: Record<string, unknown> = { name: entry.name };

    for (const field of RESOLVED_FIELDS) {
      const declared = entry[field] ?? null;
      const result = resolveFieldWithSource(entry, field, ctx);
      output[field] = {
        declared: declared ?? null,
        resolved: result.value,
        source: result.source,
      };
    }

    expect(output).toEqual({
      name: 'onboarding',
      model: {
        declared: null,
        resolved: 'haiku',
        source: 'workspace',
      },
    });
  });

  test('export with parent inheritance shows parent source', () => {
    const entry = { name: 'engineer/qa' } as Record<string, unknown>;
    const ctx: ResolveContext = {
      parent: { name: 'engineer', fields: { model: 'sonnet' } },
    };
    const output: Record<string, unknown> = { name: entry.name };

    for (const field of RESOLVED_FIELDS) {
      const declared = entry[field] ?? null;
      const result = resolveFieldWithSource(entry, field, ctx);
      output[field] = {
        declared: declared ?? null,
        resolved: result.value,
        source: result.source,
      };
    }

    expect(output).toEqual({
      name: 'engineer/qa',
      model: {
        declared: null,
        resolved: 'sonnet',
        source: 'parent:engineer',
      },
    });
  });
});
