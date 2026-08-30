import { describe, expect, test } from 'bun:test';
import { resolveWishBranch } from './resolve-wish-branch.js';

// Longest-first ordering is part of the contract (the caller provides it).
const KNOWN = ['genie-mcp', 'genie', 'hooks-v2'];

describe('resolveWishBranch — the one shared wish-branch resolver', () => {
  test('exact known slug is a top-level branch, never a hyphen split', () => {
    expect(resolveWishBranch(KNOWN, 'wish/genie-mcp')).toEqual({ wish: 'genie-mcp', group: null });
    expect(resolveWishBranch(KNOWN, 'wish/genie')).toEqual({ wish: 'genie', group: null });
  });

  test('longest known slug wins the prefix split; the group is taken from the tail', () => {
    expect(resolveWishBranch(KNOWN, 'wish/genie-mcp-hardening')).toEqual({ wish: 'genie-mcp', group: 'hardening' });
    expect(resolveWishBranch(KNOWN, 'wish/hooks-v2-session-context')).toEqual({
      wish: 'hooks-v2',
      group: 'session-context',
    });
  });

  test('an unknown wish falls to the last-dash heuristic', () => {
    expect(resolveWishBranch([], 'wish/brand-new-feature')).toEqual({ wish: 'brand-new', group: 'feature' });
    expect(resolveWishBranch([], 'wish/brand-new')).toEqual({ wish: 'brand', group: 'new' });
  });

  test('non-wish branches resolve to null', () => {
    expect(resolveWishBranch(KNOWN, 'dev')).toBeNull();
    expect(resolveWishBranch(KNOWN, '')).toBeNull();
    expect(resolveWishBranch(KNOWN, 'wish/')).toBeNull();
  });

  test('a prefix that consumes the whole rest leaves the trailing dash on the wish', () => {
    expect(resolveWishBranch(['genie'], 'wish/genie-')).toEqual({ wish: 'genie-', group: null });
  });
});
