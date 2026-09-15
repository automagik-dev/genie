import { describe, expect, test } from 'bun:test';
import {
  ConfigError,
  MAX_SOCKET_DEADLINE_MS,
  MIN_DEADLINE_MS,
  MIN_OUTPUT_BUDGET_BYTES,
  SOCKET_MARGIN_MS,
  resolveBoardConfig,
  resolveManagerConfig,
  resolveSkillsConfig,
  resolveWorkflowsConfig,
  schemaOf,
  socketDeadlineOf,
} from './config';
import { DEADLINE_MS, MAX_OUTPUT } from './process';

describe('every row config key has a default', () => {
  test('an absent config block is exactly today behaviour', () => {
    expect(resolveManagerConfig()).toEqual({ deadlineMs: DEADLINE_MS, outputBudgetBytes: MAX_OUTPUT });
    expect(resolveManagerConfig({})).toEqual({ deadlineMs: DEADLINE_MS, outputBudgetBytes: MAX_OUTPUT });
    expect(resolveBoardConfig()).toEqual({ order: 10 });
    expect(resolveSkillsConfig()).toEqual({ order: 11, groupBy: 'category' });
    expect(resolveWorkflowsConfig()).toEqual({ order: 12 });
  });

  test('a partial config keeps the defaults of the keys it omits', () => {
    expect(resolveManagerConfig({ deadlineMs: 30_000 })).toEqual({
      deadlineMs: 30_000,
      outputBudgetBytes: MAX_OUTPUT,
    });
    expect(resolveSkillsConfig({ groupBy: 'name' })).toEqual({ order: 11, groupBy: 'name' });
  });
});

describe('the two manager refinements', () => {
  test('the derived socket deadline strictly outlives the handler budget and stays under the ceiling', () => {
    const config = resolveManagerConfig({ deadlineMs: MAX_SOCKET_DEADLINE_MS - SOCKET_MARGIN_MS });
    expect(socketDeadlineOf(config)).toBe(MAX_SOCKET_DEADLINE_MS);
    expect(socketDeadlineOf(config)).toBeGreaterThan(config.deadlineMs);
    // One millisecond more would arm a socket timer past the ceiling.
    expect(() => resolveManagerConfig({ deadlineMs: MAX_SOCKET_DEADLINE_MS - SOCKET_MARGIN_MS + 1 })).toThrow(
      ConfigError,
    );
    expect(() => resolveManagerConfig({ deadlineMs: MIN_DEADLINE_MS - 1 })).toThrow('deadlineMs');
  });

  test('outputBudgetBytes has a hard maximum and a floor', () => {
    expect(resolveManagerConfig({ outputBudgetBytes: MAX_OUTPUT }).outputBudgetBytes).toBe(MAX_OUTPUT);
    expect(() => resolveManagerConfig({ outputBudgetBytes: MAX_OUTPUT + 1 })).toThrow('outputBudgetBytes');
    expect(() => resolveManagerConfig({ outputBudgetBytes: MIN_OUTPUT_BUDGET_BYTES - 1 })).toThrow('outputBudgetBytes');
  });

  test('a non-integer, a non-object and an unknown enum value are all named, not coerced', () => {
    expect(() => resolveManagerConfig({ deadlineMs: 10_000.5 })).toThrow('deadlineMs');
    expect(() => resolveManagerConfig([])).toThrow('expected an object');
    expect(() => resolveSkillsConfig({ groupBy: 'colour' })).toThrow('category, name');
    // Every issue of one config is reported together.
    const failure = (() => {
      try {
        resolveManagerConfig({ deadlineMs: -1, outputBudgetBytes: -1 });
      } catch (error) {
        return error as ConfigError;
      }
    })();
    expect(failure?.issues.map((issue) => issue.path[0])).toEqual(['deadlineMs', 'outputBudgetBytes']);
  });
});

describe('the Standard Schema the DSH loader validates against mirrors the pure resolver', () => {
  test('a valid config returns the resolved value; an invalid one returns cordis issues', () => {
    const schema = schemaOf(resolveSkillsConfig);
    expect(schema['~standard'].validate({ order: 3 })).toEqual({ value: { order: 3, groupBy: 'category' } });
    const rejected = schema['~standard'].validate({ order: 'first' });
    expect('issues' in rejected && rejected.issues).toEqual([
      { message: 'expected an integer between 0 and 1000', path: ['order'] },
    ]);
    expect(schema['~standard'].version).toBe(1);
  });
});
