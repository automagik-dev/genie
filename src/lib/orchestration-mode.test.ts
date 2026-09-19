import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenieConfigSchema } from '../types/genie-config.js';
import {
  InvalidOrchestrationAuthorityError,
  LocalLifecycleDisabledError,
  ORCA_FORBIDDEN,
  ORCA_REFUSAL_MESSAGE,
  assertLocalLifecycleEnabled,
  isOrcaForbiddenInvocation,
  orcaOwnsLifecycle,
  resolveOrchestrationMode,
} from './orchestration-mode.js';

const originalGenieHome = process.env.GENIE_HOME;
const roots: string[] = [];

function fixture(config?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'genie-orchestration-mode-'));
  roots.push(root);
  process.env.GENIE_HOME = join(root, '.genie-home');
  if (config !== undefined) {
    mkdirSync(process.env.GENIE_HOME, { recursive: true });
    writeFileSync(join(process.env.GENIE_HOME, 'config.json'), JSON.stringify(config));
  }
  return root;
}

afterEach(() => {
  if (originalGenieHome === undefined) process.env.GENIE_HOME = undefined;
  else process.env.GENIE_HOME = originalGenieHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('orchestration authority mode', () => {
  test('the config schema accepts exactly standalone and orca', () => {
    expect(GenieConfigSchema.parse({}).orchestration.mode).toBe('standalone');
    expect(GenieConfigSchema.parse({ orchestration: { mode: 'orca' } }).orchestration.mode).toBe('orca');
    expect(() => GenieConfigSchema.parse({ orchestration: { mode: 'automatic' } })).toThrow();
  });

  test('absent and explicit standalone configurations resolve to standalone', () => {
    fixture();
    expect(resolveOrchestrationMode()).toBe('standalone');
    fixture({ orchestration: { mode: 'standalone' } });
    expect(resolveOrchestrationMode()).toBe('standalone');
  });

  test('Orca mode is explicit and returns the stable typed lifecycle refusal', () => {
    fixture({ orchestration: { mode: 'orca' }, runtime: { defaultAgent: 'invalid' } });
    expect(resolveOrchestrationMode()).toBe('orca');
    expect(() => assertLocalLifecycleEnabled()).toThrow(LocalLifecycleDisabledError);
    try {
      assertLocalLifecycleEnabled();
    } catch (error) {
      expect(error).toBeInstanceOf(LocalLifecycleDisabledError);
      expect((error as LocalLifecycleDisabledError).code).toBe('local_lifecycle_disabled_in_orca_mode');
    }
  });

  test('authority resolution ignores unrelated malformed config fields', () => {
    fixture({ orchestration: { mode: 'standalone' }, runtime: { defaultAgent: 'invalid' } });
    expect(resolveOrchestrationMode()).toBe('standalone');
  });

  for (const config of [
    { orchestration: { mode: 'automatic' }, runtime: { defaultAgent: 'invalid' } },
    { orchestration: {} },
    { orchestration: { mod: 'orca' } },
    { orchestration: { mode: 'orca', extra: true } },
  ]) {
    test(`malformed authority selection fails closed: ${JSON.stringify(config.orchestration)}`, () => {
      fixture(config);
      expect(() => resolveOrchestrationMode()).toThrow(InvalidOrchestrationAuthorityError);
      try {
        assertLocalLifecycleEnabled();
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidOrchestrationAuthorityError);
        expect((error as InvalidOrchestrationAuthorityError).code).toBe('invalid_orchestration_authority');
        expect((error as Error).message).toContain('orchestration.mode must be either "standalone" or "orca"');
      }
    });
  }
});

// ============================================================================
// The closed list Orca owns — a verb may not join or leave it silently
// ============================================================================

describe('ORCA_FORBIDDEN', () => {
  test('is exactly the three root verbs, by root verb only', () => {
    // Sorted so the pin is about MEMBERSHIP, not insertion order. Adding a
    // fourth verb, dropping one, or smuggling a leaf path (`task create`) in
    // fails here first, which is the point: the list is the contract.
    expect([...ORCA_FORBIDDEN].sort()).toEqual(['board', 'idea', 'task']);
    expect(ORCA_FORBIDDEN.size).toBe(3);
    for (const entry of ORCA_FORBIDDEN) expect(entry).not.toContain(' ');
  });

  test('`task sync` is the one carve-out; no other subverb is exempt', () => {
    expect(isOrcaForbiddenInvocation('task', 'sync')).toBe(false);
    for (const sub of ['create', 'list', 'status', 'export', 'import', 'done', undefined]) {
      expect(isOrcaForbiddenInvocation('task', sub)).toBe(true);
    }
    // The carve-out is `task sync` specifically, not the word `sync`.
    expect(isOrcaForbiddenInvocation('board', 'sync')).toBe(true);
    expect(isOrcaForbiddenInvocation('idea', 'sync')).toBe(true);
    // Verbs outside the list are never gated.
    for (const root of ['context', 'doctor', 'init', 'setup', 'config', 'mikro', 'update']) {
      expect(isOrcaForbiddenInvocation(root, undefined)).toBe(false);
    }
  });

  test('the one refusal literal names orca and the exact remedy', () => {
    expect(ORCA_REFUSAL_MESSAGE).toContain('orca');
    expect(ORCA_REFUSAL_MESSAGE).toContain('genie setup --orchestration-mode standalone');
  });
});

describe('orcaOwnsLifecycle', () => {
  test('is false for standalone and an absent config, true for orca', () => {
    fixture();
    expect(orcaOwnsLifecycle()).toBe(false);
    fixture({ orchestration: { mode: 'standalone' } });
    expect(orcaOwnsLifecycle()).toBe(false);
    fixture({ orchestration: { mode: 'orca' } });
    expect(orcaOwnsLifecycle()).toBe(true);
  });

  test('fails closed on an authority it cannot parse', () => {
    // An unreadable `orchestration.mode` proves nothing — least of all
    // standalone — so the CLI gate refuses rather than guessing.
    fixture({ orchestration: { mode: 'automatic' } });
    expect(orcaOwnsLifecycle()).toBe(true);
    fixture({ orchestration: {} });
    expect(orcaOwnsLifecycle()).toBe(true);
  });
});
