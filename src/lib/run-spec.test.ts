import { describe, expect, test } from 'bun:test';
import {
  AGENT_STATE_TRANSITIONS,
  RUN_STATE_TRANSITIONS,
  type RunState,
  TERMINAL_STATES,
  isValidAgentTransition,
  isValidTransition,
  resolveRunSpec,
} from './run-spec.js';

describe('run-spec', () => {
  describe('resolveRunSpec', () => {
    test('fills defaults for minimal input', () => {
      const result = resolveRunSpec({ command: 'genie spawn reviewer' });
      expect(result.command).toBe('genie spawn reviewer');
      expect(result.provider).toBe('claude');
      expect(result.role).toBe('worker');
      expect(result.ref_policy).toBe('current');
      expect(result.approval_policy).toBe('auto');
      expect(result.concurrency_class).toBe('default');
      expect(result.lease_timeout_ms).toBe(300_000);
      expect(result.model).toBe('');
    });

    test('preserves explicit values', () => {
      const result = resolveRunSpec({
        command: 'genie spawn qa',
        provider: 'codex',
        role: 'qa',
        model: 'sonnet',
        ref_policy: 'default',
        approval_policy: 'manual',
        concurrency_class: 'reviews',
        lease_timeout_ms: 600_000,
        repo: '/tmp/my-repo',
      });
      expect(result.provider).toBe('codex');
      expect(result.role).toBe('qa');
      expect(result.model).toBe('sonnet');
      expect(result.ref_policy).toBe('default');
      expect(result.approval_policy).toBe('manual');
      expect(result.concurrency_class).toBe('reviews');
      expect(result.lease_timeout_ms).toBe(600_000);
      expect(result.repo).toBe('/tmp/my-repo');
    });

    test('trims command whitespace', () => {
      const result = resolveRunSpec({ command: '  genie spawn reviewer  ' });
      expect(result.command).toBe('genie spawn reviewer');
    });

    test('throws on empty command', () => {
      expect(() => resolveRunSpec({ command: '' })).toThrow('command is required');
    });

    test('throws on whitespace-only command', () => {
      expect(() => resolveRunSpec({ command: '   ' })).toThrow('command is required');
    });

    test('throws on lease_timeout_ms too low', () => {
      expect(() => resolveRunSpec({ command: 'test', lease_timeout_ms: 5000 })).toThrow('>= 10000ms');
    });

    test('throws on lease_timeout_ms too high', () => {
      expect(() => resolveRunSpec({ command: 'test', lease_timeout_ms: 7_200_000 })).toThrow('<= 3600000ms');
    });

    test('throws on invalid provider', () => {
      expect(() => resolveRunSpec({ command: 'test', provider: 'invalid' as any })).toThrow("'claude' or 'codex'");
    });

    test('throws on invalid ref_policy', () => {
      expect(() => resolveRunSpec({ command: 'test', ref_policy: 'bad' as any })).toThrow("'current' or 'default'");
    });

    test('throws on invalid approval_policy', () => {
      expect(() => resolveRunSpec({ command: 'test', approval_policy: 'bad' as any })).toThrow("'auto' or 'manual'");
    });
  });

  describe('isValidTransition', () => {
    test('spawning can transition to running', () => {
      expect(isValidTransition('spawning', 'running')).toBe(true);
    });

    test('spawning can transition to failed', () => {
      expect(isValidTransition('spawning', 'failed')).toBe(true);
    });

    test('running can transition to completed', () => {
      expect(isValidTransition('running', 'completed')).toBe(true);
    });

    test('running can transition to waiting_input', () => {
      expect(isValidTransition('running', 'waiting_input')).toBe(true);
    });

    test('completed cannot transition anywhere', () => {
      const states: RunState[] = ['spawning', 'running', 'waiting_input', 'completed', 'failed', 'cancelled'];
      for (const to of states) {
        expect(isValidTransition('completed', to)).toBe(false);
      }
    });

    test('failed is terminal', () => {
      expect(isValidTransition('failed', 'running')).toBe(false);
    });

    test('cancelled is terminal', () => {
      expect(isValidTransition('cancelled', 'running')).toBe(false);
    });

    test('spawning cannot jump to completed', () => {
      expect(isValidTransition('spawning', 'completed')).toBe(false);
    });
  });

  describe('TERMINAL_STATES', () => {
    test('includes completed, failed, cancelled', () => {
      expect(TERMINAL_STATES.has('completed')).toBe(true);
      expect(TERMINAL_STATES.has('failed')).toBe(true);
      expect(TERMINAL_STATES.has('cancelled')).toBe(true);
    });

    test('does not include active states', () => {
      expect(TERMINAL_STATES.has('spawning')).toBe(false);
      expect(TERMINAL_STATES.has('running')).toBe(false);
      expect(TERMINAL_STATES.has('waiting_input')).toBe(false);
    });
  });

  describe('RUN_STATE_TRANSITIONS', () => {
    test('all states have transition entries', () => {
      const states: RunState[] = ['spawning', 'running', 'waiting_input', 'completed', 'failed', 'cancelled'];
      for (const state of states) {
        expect(RUN_STATE_TRANSITIONS[state]).toBeDefined();
      }
    });
  });

  describe('agent state transitions', () => {
    test('AGENT_STATE_TRANSITIONS: failed -> spawning is valid', () => {
      expect(AGENT_STATE_TRANSITIONS.failed).toContain('spawning');
    });
    test('AGENT_STATE_TRANSITIONS: done is terminal (no transitions)', () => {
      expect(AGENT_STATE_TRANSITIONS.done).toHaveLength(0);
    });
    test('AGENT_STATE_TRANSITIONS: suspended -> spawning', () => {
      expect(AGENT_STATE_TRANSITIONS.suspended).toContain('spawning');
    });
    test('AGENT_STATE_TRANSITIONS: error -> spawning', () => {
      expect(AGENT_STATE_TRANSITIONS.error).toContain('spawning');
    });
    test('AGENT_STATE_TRANSITIONS: spawning -> working', () => {
      expect(AGENT_STATE_TRANSITIONS.spawning).toContain('working');
    });
    test('isValidAgentTransition: failed -> spawning', () => {
      expect(isValidAgentTransition('failed', 'spawning')).toBe(true);
    });
    test('isValidAgentTransition: failed -> working is invalid', () => {
      expect(isValidAgentTransition('failed', 'working')).toBe(false);
    });
    test('isValidAgentTransition: done -> spawning is invalid', () => {
      expect(isValidAgentTransition('done', 'spawning')).toBe(false);
    });
    test('isValidAgentTransition: suspended -> spawning', () => {
      expect(isValidAgentTransition('suspended', 'spawning')).toBe(true);
    });
    test('isValidAgentTransition: working -> done', () => {
      expect(isValidAgentTransition('working', 'done')).toBe(true);
    });
    test('isValidAgentTransition: working -> spawning is invalid', () => {
      expect(isValidAgentTransition('working', 'spawning')).toBe(false);
    });
  });
});
