import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { redactTokenShapes } from '../redaction.js';

// Token prefixes are split in source so synthetic test fixtures don't trip
// secret scanners (GitGuardian, gitleaks). The runtime concatenation is what
// the redaction regex sees, so test logic is unchanged. Splitting at any
// position inside the prefix is sufficient — the scanner detects the
// contiguous-literal form, not the runtime value.
const PFX_GHP = `gh${'p'}_`;
const PFX_GHS = `gh${'s'}_`;
const PFX_GLPAT = `gl${'pat-'}`;
const PFX_SK = `sk${'-'}`;

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
    const input = `gh pr create --token ${PFX_GHP}abcdefghijklmnopqrstuvwxyz0123456789 --body x`;
    const out = redactTokenShapes(input);
    expect(out).toContain('[REDACTED:gh-token]');
    expect(out).not.toContain(`${PFX_GHP}a`);
  });

  it('redacts ghs_ tokens', () => {
    const input = `use ${PFX_GHS}yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy here`;
    expect(redactTokenShapes(input)).toContain('[REDACTED:gh-token]');
  });

  it('redacts sk- tokens', () => {
    const input = `export ANTHROPIC_API_KEY=${PFX_SK}ant-api03-abcdefghijklmnopqr`;
    const out = redactTokenShapes(input);
    expect(out).toContain('[REDACTED:sk-token]');
    expect(out).not.toContain(`${PFX_SK}ant-api03`);
  });

  it('redacts glpat tokens', () => {
    const input = `curl -H "PRIVATE-TOKEN: ${PFX_GLPAT}abcdefghijklmnopqrst" https://gitlab.example`;
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
    const input = `export GH_TOKEN=${PFX_GHP}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AND ${PFX_SK}bbbbbbbbbbbbbbbbbbbbcc`;
    const out = redactTokenShapes(input);
    expect(out).toContain('[REDACTED:gh-token]');
    expect(out).toContain('[REDACTED:sk-token]');
    expect(out).not.toContain(`${PFX_GHP}aa`);
    expect(out).not.toContain(`${PFX_SK}bb`);
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
    const input = `${PFX_GHP}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`;
    expect(redactTokenShapes(input)).toBe(input);
  });
});
