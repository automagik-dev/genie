import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildOmniRegistry } from '../index.js';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const CLAUDE_MANIFEST = join(REPO_ROOT, 'plugins', 'genie', 'hooks', 'hooks.json');
const CODEX_MANIFEST = join(REPO_ROOT, 'plugins', 'genie', 'hooks', 'codex-hooks.json');

interface HookManifest {
  hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
}

/** The PreToolUse matcher of the group whose command runs the dispatch-runtime launcher. */
function dispatchMatcher(manifestPath: string): string {
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as HookManifest;
  const group = (parsed.hooks.PreToolUse ?? []).find((entry) =>
    entry.hooks.some((hook) => hook.command.includes('dispatch-runtime.cjs')),
  );
  if (group?.matcher === undefined) {
    throw new Error(`no dispatch-runtime PreToolUse matcher in ${manifestPath}`);
  }
  return group.matcher;
}

/** Claude Code / Codex hook matchers FULL-match against the tool name. */
function routes(matcher: string, tool: string): boolean {
  return new RegExp(`^(?:${matcher})$`).test(tool);
}

/** Extract the tool alternatives from a `^(a|b|c)$` matcher, failing loudly on any other shape. */
function alternationTools(source: string): string[] {
  const match = source.match(/^\^\(([^)]+)\)\$$/);
  if (match === null) throw new Error(`omni matcher is not a simple ^(a|b|...)$ alternation: ${source}`);
  return match[1].split('|');
}

describe('Omni approval matcher / hook manifest parity', () => {
  // The Omni approval gate only fires for a tool when the SHIPPED runtime manifest
  // routes that tool into dispatch (Claude Code / Codex matchers full-match). If a
  // tool gains an Omni preview + matcher entry but a manifest is not updated, the
  // gate silently never fires — this test makes that drift fail closed in CI.
  const omniHandler = buildOmniRegistry(true).find((handler) => handler.name === 'omni-approval');
  const omniTools = alternationTools((omniHandler?.matcher ?? /(?!)/).source);
  const claudeMatcher = dispatchMatcher(CLAUDE_MANIFEST);
  const codexMatcher = dispatchMatcher(CODEX_MANIFEST);

  test('the default Omni approval matcher is a recognizable tool alternation', () => {
    expect(omniHandler).toBeDefined();
    expect(omniTools).toContain('NotebookEdit');
    expect(omniTools).toContain('apply_patch');
  });

  test('every Omni-gated tool is routed by at least one shipped runtime manifest', () => {
    for (const tool of omniTools) {
      const covered = routes(claudeMatcher, tool) || routes(codexMatcher, tool);
      expect(covered, `Omni-gated tool "${tool}" is not routed by any shipped hook manifest`).toBe(true);
    }
  });

  test('each runtime manifest routes its own native editing tool (Claude NotebookEdit, Codex apply_patch)', () => {
    // Claude Code ships a NotebookEdit approval preview; Codex ships apply_patch.
    // Each runtime manifest must route its own native editing tool into dispatch,
    // and must NOT claim the other runtime's tool (it can never emit it).
    expect(routes(claudeMatcher, 'NotebookEdit')).toBe(true);
    expect(routes(codexMatcher, 'apply_patch')).toBe(true);
    expect(routes(codexMatcher, 'NotebookEdit')).toBe(false);
    expect(routes(claudeMatcher, 'apply_patch')).toBe(false);
  });
});
