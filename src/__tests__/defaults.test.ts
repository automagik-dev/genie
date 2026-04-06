import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_DEFAULTS,
  type ResolveContext,
  computeEffectiveDefaults,
  normalizeValue,
  resolveField,
  resolveFieldWithSource,
} from '../lib/defaults.js';

// ============================================================================
// normalizeValue
// ============================================================================

describe('normalizeValue', () => {
  test('returns undefined for undefined', () => {
    expect(normalizeValue(undefined)).toBeUndefined();
  });

  test('returns undefined for null', () => {
    expect(normalizeValue(null)).toBeUndefined();
  });

  test('returns undefined for empty string', () => {
    expect(normalizeValue('')).toBeUndefined();
  });

  test('returns undefined for literal "inherit"', () => {
    expect(normalizeValue('inherit')).toBeUndefined();
  });

  test('passes through valid values', () => {
    expect(normalizeValue('opus')).toBe('opus');
    expect(normalizeValue('sonnet')).toBe('sonnet');
    expect(normalizeValue('blue')).toBe('blue');
  });
});

// ============================================================================
// BUILTIN_DEFAULTS
// ============================================================================

describe('BUILTIN_DEFAULTS', () => {
  test('model defaults to opus', () => {
    expect(BUILTIN_DEFAULTS.model).toBe('opus');
  });

  test('has all expected fields', () => {
    expect(BUILTIN_DEFAULTS).toHaveProperty('model');
    expect(BUILTIN_DEFAULTS).toHaveProperty('promptMode');
    expect(BUILTIN_DEFAULTS).toHaveProperty('color');
    expect(BUILTIN_DEFAULTS).toHaveProperty('effort');
    expect(BUILTIN_DEFAULTS).toHaveProperty('thinking');
    expect(BUILTIN_DEFAULTS).toHaveProperty('permissionMode');
  });
});

// ============================================================================
// resolveField — chain levels
// ============================================================================

describe('resolveField', () => {
  const emptyCtx: ResolveContext = {};

  test('step 1: agent frontmatter wins when declared', () => {
    const agent = { model: 'sonnet' };
    expect(resolveField(agent, 'model', emptyCtx)).toBe('sonnet');
  });

  test('step 2: parent agent value used for sub-agents', () => {
    const agent = {};
    const ctx: ResolveContext = {
      parent: { name: 'engineer', fields: { model: 'sonnet' } },
    };
    expect(resolveField(agent, 'model', ctx)).toBe('sonnet');
  });

  test('step 3: workspace defaults used when agent and parent absent', () => {
    const agent = {};
    const ctx: ResolveContext = { workspaceDefaults: { model: 'haiku' } };
    expect(resolveField(agent, 'model', ctx)).toBe('haiku');
  });

  test('step 4: built-in default as final fallback', () => {
    const agent = {};
    expect(resolveField(agent, 'model', emptyCtx)).toBe('opus');
  });

  test('explicit value beats workspace default', () => {
    const agent = { model: 'sonnet' };
    const ctx: ResolveContext = { workspaceDefaults: { model: 'haiku' } };
    expect(resolveField(agent, 'model', ctx)).toBe('sonnet');
  });

  test('explicit value beats parent', () => {
    const agent = { model: 'haiku' };
    const ctx: ResolveContext = {
      parent: { name: 'engineer', fields: { model: 'sonnet' } },
      workspaceDefaults: { model: 'opus' },
    };
    expect(resolveField(agent, 'model', ctx)).toBe('haiku');
  });

  test('parent beats workspace', () => {
    const agent = {};
    const ctx: ResolveContext = {
      parent: { name: 'engineer', fields: { model: 'sonnet' } },
      workspaceDefaults: { model: 'haiku' },
    };
    expect(resolveField(agent, 'model', ctx)).toBe('sonnet');
  });

  test('forgiving mode: "inherit" at agent level normalized to absent', () => {
    const agent = { model: 'inherit' };
    const ctx: ResolveContext = { workspaceDefaults: { model: 'sonnet' } };
    expect(resolveField(agent, 'model', ctx)).toBe('sonnet');
  });

  test('forgiving mode: null at agent level normalized to absent', () => {
    const agent = { model: null };
    expect(resolveField(agent, 'model', emptyCtx)).toBe('opus');
  });

  test('forgiving mode: empty string at agent level normalized to absent', () => {
    const agent = { model: '' };
    expect(resolveField(agent, 'model', emptyCtx)).toBe('opus');
  });

  test('forgiving mode: "inherit" at parent level normalized to absent', () => {
    const agent = {};
    const ctx: ResolveContext = {
      parent: { name: 'engineer', fields: { model: 'inherit' as any } },
      workspaceDefaults: { model: 'haiku' },
    };
    expect(resolveField(agent, 'model', ctx)).toBe('haiku');
  });

  test('top-level agent: 3-step chain (no parent)', () => {
    const agent = {};
    const ctx: ResolveContext = { workspaceDefaults: { model: 'sonnet' } };
    expect(resolveField(agent, 'model', ctx)).toBe('sonnet');
  });

  test('sub-agent: parent miss falls through to workspace', () => {
    const agent = {};
    const ctx: ResolveContext = {
      parent: { name: 'engineer', fields: {} },
      workspaceDefaults: { model: 'haiku' },
    };
    expect(resolveField(agent, 'model', ctx)).toBe('haiku');
  });

  test('sub-agent: parent and workspace miss falls to built-in', () => {
    const agent = {};
    const ctx: ResolveContext = {
      parent: { name: 'engineer', fields: {} },
      workspaceDefaults: {},
    };
    expect(resolveField(agent, 'model', ctx)).toBe('opus');
  });

  test('resolves non-model fields (color)', () => {
    const agent = {};
    const ctx: ResolveContext = { workspaceDefaults: { color: 'red' } };
    expect(resolveField(agent, 'color', ctx)).toBe('red');
  });

  test('resolves non-model fields (promptMode)', () => {
    const agent = { promptMode: 'system' };
    expect(resolveField(agent, 'promptMode', emptyCtx)).toBe('system');
  });
});

// ============================================================================
// resolveFieldWithSource — source annotation
// ============================================================================

describe('resolveFieldWithSource', () => {
  test('source: explicit when agent declares value', () => {
    const result = resolveFieldWithSource({ model: 'sonnet' }, 'model', {});
    expect(result).toEqual({ value: 'sonnet', source: 'explicit' });
  });

  test('source: parent:<name> when parent provides value', () => {
    const ctx: ResolveContext = {
      parent: { name: 'engineer', fields: { model: 'sonnet' } },
    };
    const result = resolveFieldWithSource({}, 'model', ctx);
    expect(result).toEqual({ value: 'sonnet', source: 'parent:engineer' });
  });

  test('source: workspace when workspace provides value', () => {
    const ctx: ResolveContext = { workspaceDefaults: { model: 'haiku' } };
    const result = resolveFieldWithSource({}, 'model', ctx);
    expect(result).toEqual({ value: 'haiku', source: 'workspace' });
  });

  test('source: built-in as final fallback', () => {
    const result = resolveFieldWithSource({}, 'model', {});
    expect(result).toEqual({ value: 'opus', source: 'built-in' });
  });
});

// ============================================================================
// computeEffectiveDefaults
// ============================================================================

describe('computeEffectiveDefaults', () => {
  test('returns built-in defaults when no workspace overrides', () => {
    const result = computeEffectiveDefaults();
    expect(result).toEqual(BUILTIN_DEFAULTS);
  });

  test('returns built-in defaults for undefined workspace', () => {
    const result = computeEffectiveDefaults(undefined);
    expect(result).toEqual(BUILTIN_DEFAULTS);
  });

  test('workspace overrides merge over built-in defaults', () => {
    const result = computeEffectiveDefaults({ model: 'sonnet' });
    expect(result.model).toBe('sonnet');
    expect(result.color).toBe('blue'); // unchanged
    expect(result.promptMode).toBe('append'); // unchanged
  });

  test('workspace overrides multiple fields', () => {
    const result = computeEffectiveDefaults({ model: 'haiku', color: 'red', effort: 'low' });
    expect(result.model).toBe('haiku');
    expect(result.color).toBe('red');
    expect(result.effort).toBe('low');
    expect(result.promptMode).toBe('append'); // unchanged
  });

  test('empty workspace defaults returns built-in defaults', () => {
    const result = computeEffectiveDefaults({});
    expect(result).toEqual(BUILTIN_DEFAULTS);
  });

  test('"inherit" in workspace defaults normalized to absent', () => {
    const result = computeEffectiveDefaults({ model: 'inherit' as any });
    expect(result.model).toBe('opus'); // falls through to built-in
  });

  test('does not mutate BUILTIN_DEFAULTS', () => {
    const before = { ...BUILTIN_DEFAULTS };
    computeEffectiveDefaults({ model: 'sonnet' });
    expect(BUILTIN_DEFAULTS).toEqual(before);
  });
});
