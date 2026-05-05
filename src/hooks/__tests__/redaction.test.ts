import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { redactTokenShapes } from '../redaction.js';

describe('redactTokenShapes', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.GENIE_HOOK_REDACTION;
    // biome-ignore lint/performance/noDelete: process.env requires delete — assignment sets the string "undefined"
    delete process.env.GENIE_HOOK_REDACTION;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      // biome-ignore lint/performance/noDelete: process.env requires delete — assignment sets the string "undefined"
      delete process.env.GENIE_HOOK_REDACTION;
    } else {
      process.env.GENIE_HOOK_REDACTION = originalEnv;
    }
  });

  it('redacts ghp_ tokens', () => {
    const input = 'gh pr create --token ghp_abcdefghijklmnopqrstuvwxyz0123456789 --body x';
    const out = redactTokenShapes(input);
    expect(out).toContain('[REDACTED:gh-token]');
    expect(out).not.toContain('ghp_a');
  });

  it('redacts ghs_ tokens', () => {
    const input = 'use ghs_yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy here';
    expect(redactTokenShapes(input)).toContain('[REDACTED:gh-token]');
  });

  it('redacts sk- tokens', () => {
    const input = 'export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqr';
    const out = redactTokenShapes(input);
    expect(out).toContain('[REDACTED:sk-token]');
    expect(out).not.toContain('sk-ant-api03');
  });

  it('redacts glpat tokens', () => {
    const input = 'curl -H "PRIVATE-TOKEN: glpat-abcdefghijklmnopqrst" https://gitlab.example';
    expect(redactTokenShapes(input)).toContain('[REDACTED:glpat]');
  });

  it('redacts 40+ hex strings (sha-shaped, secret-shaped)', () => {
    const input = 'reset to commit 1234567890abcdef1234567890abcdef12345678 now';
    const out = redactTokenShapes(input);
    expect(out).toContain('[REDACTED:hex]');
    expect(out).not.toContain('1234567890abcdef');
  });

  it('does not redact short hex (e.g. 7-char short SHA)', () => {
    const input = 'short sha 1a2b3c4 is fine';
    expect(redactTokenShapes(input)).toBe(input);
  });

  it('passes plain English commands unchanged', () => {
    const input = 'list all files in the current directory and show their size';
    expect(redactTokenShapes(input)).toBe(input);
  });

  it('handles multiple secrets in the same string', () => {
    const input = 'export GH_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AND sk-bbbbbbbbbbbbbbbbbbbbcc';
    const out = redactTokenShapes(input);
    expect(out).toContain('[REDACTED:gh-token]');
    expect(out).toContain('[REDACTED:sk-token]');
    expect(out).not.toContain('ghp_aa');
    expect(out).not.toContain('sk-bb');
  });

  it('returns null for null input', () => {
    expect(redactTokenShapes(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(redactTokenShapes(undefined)).toBeNull();
  });

  it('passes empty string unchanged', () => {
    expect(redactTokenShapes('')).toBe('');
  });

  it('honors GENIE_HOOK_REDACTION=off opt-out', () => {
    process.env.GENIE_HOOK_REDACTION = 'off';
    const input = 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    expect(redactTokenShapes(input)).toBe(input);
  });
});
