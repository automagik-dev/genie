/**
 * Tests for codex hook config TOML injection.
 *
 * Run with: bun test src/hooks/codex-inject.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CODEX_DISPATCHED_EVENTS, codexHooksInjected, injectCodexHooks } from './codex-inject.js';

describe('injectCodexHooks', () => {
  let tmp: string;
  let originalCodexHome: string | undefined;
  let originalGenieHome: string | undefined;
  let originalHookBin: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'codex-inject-'));
    originalCodexHome = process.env.CODEX_HOME;
    originalGenieHome = process.env.GENIE_HOME;
    originalHookBin = process.env.GENIE_HOOK_BIN;
    process.env.CODEX_HOME = tmp;
    // Pin GENIE_HOME so the compiled-binary candidate (~/.genie/bin/genie-hook)
    // doesn't resolve to a real binary produced by postinstall on the CI
    // runner; these tests assert the bun-fork fallback shape.
    process.env.GENIE_HOME = join(tmp, 'genie-home');
    process.env.GENIE_HOOK_BIN = join(tmp, 'genie-home', 'no-such-binary');
  });

  afterEach(() => {
    if (originalCodexHome === undefined) {
      process.env.CODEX_HOME = undefined as unknown as string;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
    if (originalGenieHome === undefined) delete process.env.GENIE_HOME;
    else process.env.GENIE_HOME = originalGenieHome;
    if (originalHookBin === undefined) delete process.env.GENIE_HOOK_BIN;
    else process.env.GENIE_HOOK_BIN = originalHookBin;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('writes a fresh config.toml when none exists', async () => {
    const modified = await injectCodexHooks();
    expect(modified).toBe(true);

    const written = readFileSync(join(tmp, 'config.toml'), 'utf-8');
    expect(written).toContain('# === GENIE HOOK BRIDGE BEGIN ===');
    expect(written).toContain('# === GENIE HOOK BRIDGE END ===');
    expect(written).toContain('feature_enabled = true');

    // Each dispatched event has a [[hooks.X]] section + nested .hooks entry
    for (const event of CODEX_DISPATCHED_EVENTS) {
      expect(written).toContain(`[[hooks.${event}]]`);
      expect(written).toContain(`[[hooks.${event}.hooks]]`);
    }
    expect(written).toContain('type = "command"');
    expect(written).toContain('hook dispatch');
  });

  test('preserves user-defined TOML content outside the genie block', async () => {
    const userConfig = `
model = "gpt-5.5"

[mcp_servers.foo]
command = "/usr/local/bin/foo-mcp"

[sandbox]
mode = "workspace-write"
`;
    writeFileSync(join(tmp, 'config.toml'), userConfig);

    await injectCodexHooks();
    const merged = readFileSync(join(tmp, 'config.toml'), 'utf-8');

    expect(merged).toContain('model = "gpt-5.5"');
    expect(merged).toContain('[mcp_servers.foo]');
    expect(merged).toContain('command = "/usr/local/bin/foo-mcp"');
    expect(merged).toContain('[sandbox]');
    expect(merged).toContain('# === GENIE HOOK BRIDGE BEGIN ===');
  });

  test('is idempotent on repeated invocations with no change', async () => {
    const first = await injectCodexHooks();
    expect(first).toBe(true);

    const beforeSecond = readFileSync(join(tmp, 'config.toml'), 'utf-8');
    const second = await injectCodexHooks();
    expect(second).toBe(false); // no change needed

    const afterSecond = readFileSync(join(tmp, 'config.toml'), 'utf-8');
    expect(afterSecond).toBe(beforeSecond);
  });

  test('replaces an old genie block when the dispatch command changes', async () => {
    // Seed a stale block manually with a different (fake) command path
    const stale = `
model = "gpt-5.5"

# === GENIE HOOK BRIDGE BEGIN ===
[hooks]
feature_enabled = true

[[hooks.UserPromptSubmit]]
matcher = "*"

[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "/old/path/to/genie hook dispatch"
timeout = 15
# === GENIE HOOK BRIDGE END ===
`;
    writeFileSync(join(tmp, 'config.toml'), stale);

    const modified = await injectCodexHooks();
    expect(modified).toBe(true);

    const written = readFileSync(join(tmp, 'config.toml'), 'utf-8');
    expect(written).toContain('model = "gpt-5.5"'); // user content preserved
    expect(written).not.toContain('/old/path/to/genie'); // stale command gone
    // Only ONE block should exist now (no duplicates)
    const beginCount = (written.match(/=== GENIE HOOK BRIDGE BEGIN ===/g) ?? []).length;
    expect(beginCount).toBe(1);
  });

  test('codexHooksInjected reports presence', async () => {
    expect(await codexHooksInjected()).toBe(false);
    await injectCodexHooks();
    expect(await codexHooksInjected()).toBe(true);
  });

  test('CODEX_DISPATCHED_EVENTS matches the handler-backed set (Fix D extension)', () => {
    // Mac-CPU Fix D extension (#1513 follow-up): codex-side narrow now
    // mirrors claude-side. SessionStart and PermissionRequest dropped
    // because no handlers exist for them — wiring them with matcher='*'
    // produced wasted bun cold-starts on every fire.
    // dog-fooder-da66 verdict 2026-04-29 surfaced the codex-side leak.
    const sorted = [...CODEX_DISPATCHED_EVENTS].sort();
    expect(sorted as string[]).toEqual(['PostToolUse', 'PreToolUse', 'Stop', 'UserPromptSubmit']);
  });

  test('PostToolUse is wired with SendMessage matcher (not "*")', async () => {
    await injectCodexHooks();
    const config = readFileSync(join(tmp, 'config.toml'), 'utf-8');
    const postSection = config.split('[[hooks.PostToolUse]]')[1] ?? '';
    expect(postSection).toMatch(/matcher\s*=\s*"SendMessage"/);
  });
});
