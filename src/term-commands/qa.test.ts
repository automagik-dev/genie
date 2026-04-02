import { describe, expect, test } from 'bun:test';
import type { LogEvent } from '../lib/unified-log.js';
import { buildQaCheckLogFilter, evaluateExpectations } from './qa.js';

describe('qa command helpers', () => {
  test('buildQaCheckLogFilter does not cap with last=200 when since is provided', () => {
    expect(buildQaCheckLogFilter('2026-03-27T00:00:00.000Z')).toEqual({
      since: '2026-03-27T00:00:00.000Z',
    });
  });

  test('evaluateExpectations respects output source filtering', () => {
    const expectations = [
      {
        description: 'output contains FILTER_TEST',
        source: 'output',
        matchers: { text: '~FILTER_TEST' },
      },
    ];
    const events: LogEvent[] = [
      {
        timestamp: '2026-03-27T12:00:00.000Z',
        kind: 'message',
        agent: 'engineer',
        direction: 'in',
        peer: 'qa',
        text: 'FILTER_TEST',
        source: 'mailbox',
      },
    ];

    const reports = evaluateExpectations(expectations, events);

    expect(reports[0]?.result).toBe('fail');
  });

  test('evaluateExpectations still matches output against provider events', () => {
    const expectations = [
      {
        description: 'output contains FILTER_TEST',
        source: 'output',
        matchers: { text: '~FILTER_TEST' },
      },
    ];
    const events: LogEvent[] = [
      {
        timestamp: '2026-03-27T12:00:00.000Z',
        kind: 'tool_result',
        agent: 'engineer',
        text: 'FILTER_TEST',
        source: 'provider',
      },
    ];

    const reports = evaluateExpectations(expectations, events);

    expect(reports[0]?.result).toBe('pass');
  });
});
