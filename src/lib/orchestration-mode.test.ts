import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenieConfigSchema } from '../types/genie-config.js';
import {
  InvalidOrchestrationAuthorityError,
  LocalLifecycleDisabledError,
  assertLocalLifecycleEnabled,
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
