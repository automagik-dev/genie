import { describe, expect, test } from 'bun:test';
import { type WizardContext, formatDefaults, formatNextSteps, formatWelcome } from '../lib/mini-wizard.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeContext(overrides?: Partial<WizardContext>): WizardContext {
  return {
    workspaceRoot: '/tmp/test-ws',
    workspaceName: 'test-project',
    config: { name: 'test-project', agents: { defaults: {} } },
    discovered: [],
    pending: [],
    canonicalAgentCount: 0,
    ...overrides,
  };
}

// ─── formatDefaults ─────────────────────────────────────────────────────────

describe('formatDefaults()', () => {
  test('shows built-in defaults when no workspace overrides', () => {
    const output = formatDefaults();

    expect(output).toContain('model: opus');
    expect(output).toContain('built-in');
    expect(output).toContain('permissionMode: auto');
  });

  test('shows workspace overrides', () => {
    const output = formatDefaults({ model: 'sonnet' });

    expect(output).toContain('model: sonnet');
    expect(output).toContain('permissionMode: auto');
  });
});

// ─── formatWelcome ──────────────────────────────────────────────────────────

describe('formatWelcome()', () => {
  test('shows workspace name and agent count', () => {
    const ctx = makeContext({ workspaceName: 'my-project', canonicalAgentCount: 3 });
    const output = formatWelcome(ctx);

    expect(output).toContain('Workspace: my-project');
    expect(output).toContain('Agents:    3 registered');
  });

  test('shows discovered agents count when present', () => {
    const ctx = makeContext({
      discovered: [{ name: 'auth', path: '/tmp/auth', relativePath: 'services/auth', isSubAgent: false }],
    });
    const output = formatWelcome(ctx);

    expect(output).toContain('Discovered: 1 external agent(s) found');
  });

  test('omits discovered line when none found', () => {
    const ctx = makeContext();
    const output = formatWelcome(ctx);

    expect(output).not.toContain('Discovered:');
  });

  test('shows effective defaults', () => {
    const ctx = makeContext();
    const output = formatWelcome(ctx);

    expect(output).toContain('Effective defaults:');
    expect(output).toContain('model: opus');
  });
});

// ─── formatNextSteps ────────────────────────────────────────────────────────

describe('formatNextSteps()', () => {
  test('shows scaffold prompt when no agents exist', () => {
    const ctx = makeContext({ canonicalAgentCount: 0 });
    const output = formatNextSteps(ctx);

    expect(output).toContain('genie init agent <name>');
    expect(output).toContain('Scaffold your first agent');
  });

  test('omits scaffold prompt when agents exist', () => {
    const ctx = makeContext({ canonicalAgentCount: 2 });
    const output = formatNextSteps(ctx);

    expect(output).not.toContain('genie init agent <name>');
  });

  test('always shows spawn, team, and wizard steps', () => {
    const ctx = makeContext({ canonicalAgentCount: 5 });
    const output = formatNextSteps(ctx);

    expect(output).toContain('genie spawn <agent>');
    expect(output).toContain('genie team create <name>');
    expect(output).toContain('/wizard');
  });
});
