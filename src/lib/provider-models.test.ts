/**
 * Tests for provider-model compatibility validator.
 *
 * Council recommendation P0 (2026-04-28). Closes the council-deliberation
 * incident where `genie spawn --provider codex --model opus` killed
 * agents on startup.
 */

import { describe, expect, test } from 'bun:test';
import { CrossProviderModelError, validateProviderModel } from './provider-models.js';

describe('validateProviderModel', () => {
  describe('the bug that triggered the council', () => {
    test('REJECTS provider=codex + model=opus (the exact tonight failure)', () => {
      expect(() => validateProviderModel({ provider: 'codex', model: 'opus' })).toThrow(CrossProviderModelError);
    });

    test('error message names the requested model and provider', () => {
      let err: Error | null = null;
      try {
        validateProviderModel({ provider: 'codex', model: 'opus' });
      } catch (e) {
        err = e as Error;
      }
      expect(err).not.toBeNull();
      expect(err?.message).toContain('opus');
      expect(err?.message).toContain('codex');
      expect(err?.message.toLowerCase()).toContain('claude');
    });

    test('error message offers actionable remedies', () => {
      try {
        validateProviderModel({ provider: 'codex', model: 'opus' });
        expect(true).toBe(false); // unreachable
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain('Drop --model'); // remedy 1
        expect(msg).toMatch(/codex-family|codex/); // remedy 2 — example codex models
        expect(msg).toContain('Switch --provider'); // remedy 3
      }
    });
  });

  describe('cross-provider rejections (other directions)', () => {
    test('REJECTS provider=claude + model=gpt-5-codex', () => {
      expect(() => validateProviderModel({ provider: 'claude', model: 'gpt-5-codex' })).toThrow(
        CrossProviderModelError,
      );
    });

    test('REJECTS provider=claude + model=gpt-4o', () => {
      expect(() => validateProviderModel({ provider: 'claude', model: 'gpt-4o' })).toThrow(CrossProviderModelError);
    });

    test('REJECTS provider=claude + model=o3-mini', () => {
      expect(() => validateProviderModel({ provider: 'claude', model: 'o3-mini' })).toThrow(CrossProviderModelError);
    });

    test('REJECTS provider=codex + model=sonnet', () => {
      expect(() => validateProviderModel({ provider: 'codex', model: 'sonnet' })).toThrow(CrossProviderModelError);
    });

    test('REJECTS provider=codex + model=claude-opus-4-7', () => {
      expect(() => validateProviderModel({ provider: 'codex', model: 'claude-opus-4-7' })).toThrow(
        CrossProviderModelError,
      );
    });

    test('REJECTS provider=claude-sdk + model=gpt-5-codex (claude-sdk is claude family)', () => {
      expect(() => validateProviderModel({ provider: 'claude-sdk', model: 'gpt-5-codex' })).toThrow(
        CrossProviderModelError,
      );
    });
  });

  describe('happy paths (no rejection)', () => {
    test('claude + opus passes', () => {
      expect(() => validateProviderModel({ provider: 'claude', model: 'opus' })).not.toThrow();
    });

    test('claude + sonnet passes', () => {
      expect(() => validateProviderModel({ provider: 'claude', model: 'sonnet' })).not.toThrow();
    });

    test('claude + haiku passes', () => {
      expect(() => validateProviderModel({ provider: 'claude', model: 'haiku' })).not.toThrow();
    });

    test('claude + claude-opus-4-7 passes', () => {
      expect(() => validateProviderModel({ provider: 'claude', model: 'claude-opus-4-7' })).not.toThrow();
    });

    test('claude-sdk + opus passes (same family as claude)', () => {
      expect(() => validateProviderModel({ provider: 'claude-sdk', model: 'opus' })).not.toThrow();
    });

    test('codex + gpt-5-codex passes', () => {
      expect(() => validateProviderModel({ provider: 'codex', model: 'gpt-5-codex' })).not.toThrow();
    });

    test('codex + gpt-4o passes', () => {
      expect(() => validateProviderModel({ provider: 'codex', model: 'gpt-4o' })).not.toThrow();
    });

    test('codex + o3-mini passes', () => {
      expect(() => validateProviderModel({ provider: 'codex', model: 'o3-mini' })).not.toThrow();
    });
  });

  describe('pass-through cases (no validation possible)', () => {
    test('no provider + any model: pass', () => {
      expect(() => validateProviderModel({ provider: null, model: 'opus' })).not.toThrow();
      expect(() => validateProviderModel({ provider: undefined, model: 'gpt-5-codex' })).not.toThrow();
    });

    test('any provider + no model: pass (user opted into provider default)', () => {
      expect(() => validateProviderModel({ provider: 'claude', model: null })).not.toThrow();
      expect(() => validateProviderModel({ provider: 'codex', model: undefined })).not.toThrow();
    });

    test('unknown provider: pass (we do not gatekeep providers we do not know)', () => {
      expect(() => validateProviderModel({ provider: 'future-provider', model: 'opus' })).not.toThrow();
      expect(() => validateProviderModel({ provider: 'gemini', model: 'gpt-4o' })).not.toThrow();
    });

    test('unknown model name: pass (defer to underlying CLI to surface its own error)', () => {
      // A future model name we have not added to the patterns yet
      expect(() => validateProviderModel({ provider: 'claude', model: 'unknown-future-model-2030' })).not.toThrow();
      expect(() => validateProviderModel({ provider: 'codex', model: 'whatever-new-thing' })).not.toThrow();
    });
  });

  describe('case sensitivity', () => {
    test('OPUS (upper) on codex still rejected', () => {
      expect(() => validateProviderModel({ provider: 'codex', model: 'OPUS' })).toThrow(CrossProviderModelError);
    });

    test('CODEX provider name (upper) treated same as codex', () => {
      expect(() => validateProviderModel({ provider: 'CODEX', model: 'opus' })).toThrow(CrossProviderModelError);
    });
  });
});
