import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resolveExecutorType } from '../executor-config.js';

describe('resolveExecutorType', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.GENIE_EXECUTOR;
    delete process.env.GENIE_EXECUTOR;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.GENIE_EXECUTOR = originalEnv;
    } else {
      delete process.env.GENIE_EXECUTOR;
    }
  });

  test('defaults to tmux when nothing is set', () => {
    expect(resolveExecutorType()).toBe('tmux');
  });

  test('override argument wins over everything', () => {
    process.env.GENIE_EXECUTOR = 'tmux';
    expect(resolveExecutorType('sdk')).toBe('sdk');
  });

  test('env var is used when no override', () => {
    process.env.GENIE_EXECUTOR = 'sdk';
    expect(resolveExecutorType()).toBe('sdk');
  });

  test('env var tmux is respected', () => {
    process.env.GENIE_EXECUTOR = 'tmux';
    expect(resolveExecutorType()).toBe('tmux');
  });

  test('override beats env var', () => {
    process.env.GENIE_EXECUTOR = 'sdk';
    expect(resolveExecutorType('tmux')).toBe('tmux');
  });

  test('invalid override falls through to env', () => {
    process.env.GENIE_EXECUTOR = 'sdk';
    expect(resolveExecutorType('bogus')).toBe('sdk');
  });

  test('invalid override and no env falls back to tmux', () => {
    expect(resolveExecutorType('invalid')).toBe('tmux');
  });

  test('invalid env falls back to tmux', () => {
    process.env.GENIE_EXECUTOR = 'docker';
    expect(resolveExecutorType()).toBe('tmux');
  });

  test('empty string override falls through', () => {
    process.env.GENIE_EXECUTOR = 'sdk';
    expect(resolveExecutorType('')).toBe('sdk');
  });

  test('undefined override falls through', () => {
    process.env.GENIE_EXECUTOR = 'sdk';
    expect(resolveExecutorType(undefined)).toBe('sdk');
  });
});
