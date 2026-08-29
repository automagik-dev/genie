import { describe, expect, test } from 'bun:test';
import {
  MAX_ORCA_STDERR_BYTES,
  MAX_ORCA_STDOUT_BYTES,
  OrcaAdapterError,
  type OrcaOperation,
  type OrcaProcessExecutor,
  buildOrcaOrchestrationArgv,
  createOrcaOrchestrationAdapter,
  resolveOrcaExecutable,
} from './orca-orchestration-adapter.js';

const cases: ReadonlyArray<[string, OrcaOperation, readonly string[]]> = [
  ['run-create', { operation: 'run-create', objective: 'Ship it' }, ['--objective', 'Ship it']],
  ['run-list', { operation: 'run-list', limit: 10, cursor: 'cursor_1' }, ['--limit', '10', '--cursor', 'cursor_1']],
  ['run-show', { operation: 'run-show', id: 'run_1' }, ['--id', 'run_1']],
  ['run-current', { operation: 'run-current' }, []],
  ['run-use', { operation: 'run-use', id: 'run_1' }, ['--id', 'run_1']],
  [
    'task-create',
    { operation: 'task-create', spec: 'Implement', title: 'Adapter', deps: ['task_a'], parent: 'task_p' },
    ['--spec', 'Implement', '--task-title', 'Adapter', '--deps', '["task_a"]', '--parent', 'task_p'],
  ],
  [
    'task-list',
    { operation: 'task-list', status: 'ready', ready: true, brief: true },
    ['--status', 'ready', '--ready', '--brief'],
  ],
  [
    'task-update',
    { operation: 'task-update', id: 'task_a', status: 'completed', result: { summary: 'done', artifacts: ['a.md'] } },
    ['--id', 'task_a', '--status', 'completed', '--result', '{"summary":"done","artifacts":["a.md"]}'],
  ],
  [
    'worker-start',
    { operation: 'worker-start', task: 'task_a', agent: 'codex', model: 'gpt-5', effort: 'high', timeoutMs: 500 },
    [
      '--task',
      'task_a',
      '--worktree',
      'current',
      '--agent',
      'codex',
      '--model',
      'gpt-5',
      '--effort',
      'high',
      '--timeout-ms',
      '500',
    ],
  ],
  ['worker-show', { operation: 'worker-show', dispatch: 'dispatch_a' }, ['--dispatch', 'dispatch_a']],
  [
    'worker-read',
    { operation: 'worker-read', dispatch: 'dispatch_a', source: 'auto', cursor: 'c1', limit: 2 },
    ['--dispatch', 'dispatch_a', '--source', 'auto', '--cursor', 'c1', '--limit', '2'],
  ],
  ['worker-release', { operation: 'worker-release', dispatch: 'dispatch_a' }, ['--dispatch', 'dispatch_a']],
  [
    'send',
    {
      operation: 'send',
      subject: 'alive',
      body: 'working',
      type: 'heartbeat',
      priority: 'normal',
      threadId: 'thread_a',
      payload: { taskId: 'task_a', phase: '-nested-is-safe' },
    },
    [
      '--subject',
      'alive',
      '--body',
      'working',
      '--type',
      'heartbeat',
      '--priority',
      'normal',
      '--thread-id',
      'thread_a',
      '--payload',
      '{"taskId":"task_a","phase":"-nested-is-safe"}',
    ],
  ],
  [
    'check',
    {
      operation: 'check',
      ack: 'delivery_a',
      unread: true,
      types: ['worker_done', 'question'],
      wait: true,
      timeoutMs: 500,
    },
    ['--ack', 'delivery_a', '--unread', '--types', 'worker_done,question', '--wait', '--timeout-ms', '500'],
  ],
  ['reply', { operation: 'reply', id: 'message_a', body: 'yes' }, ['--id', 'message_a', '--body', 'yes']],
  [
    'ask',
    { operation: 'ask', question: 'Choose', options: ['one', 'two'], timeoutMs: 500 },
    ['--question', 'Choose', '--options', 'one,two', '--timeout-ms', '500'],
  ],
  [
    'gate-create',
    { operation: 'gate-create', task: 'task_a', question: 'Choose', options: ['a,b', 'c\nd'] },
    ['--task', 'task_a', '--question', 'Choose', '--options', '["a,b","c\\nd"]'],
  ],
  [
    'gate-list',
    { operation: 'gate-list', task: 'task_a', status: 'pending' },
    ['--task', 'task_a', '--status', 'pending'],
  ],
  [
    'gate-resolve',
    { operation: 'gate-resolve', id: 'gate_a', resolution: 'approved', task: 'task_a' },
    ['--id', 'gate_a', '--resolution', 'approved'],
  ],
];

describe('closed Orca orchestration argv grammar', () => {
  for (const [verb, input, flags] of cases) {
    test(verb, () => {
      expect(buildOrcaOrchestrationArgv(input)).toEqual(['orchestration', verb, ...flags, '--json']);
    });
  }

  test('rejects unknown operations and caller-controlled fields', () => {
    for (const input of [
      { operation: 'dispatch', task: 'task_a' },
      { operation: 'run-current', argv: ['--terminal', 'term_a'] },
      { operation: 'run-show', id: 'run_a', json: true },
      { operation: 'worker-start', task: 'task_a', agent: 'codex', worktree: 'other' },
      { operation: 'send', subject: 'x', to: 'term_a' },
    ]) {
      expect(() => buildOrcaOrchestrationArgv(input)).toThrow(OrcaAdapterError);
    }
  });

  test('rejects flag-shaped scalar values after domain validation', () => {
    for (const value of ['-', '--', '-x', '--json', '-1', '-é']) {
      expect(() => buildOrcaOrchestrationArgv({ operation: 'run-create', objective: value })).toThrow(OrcaAdapterError);
    }
    expect(buildOrcaOrchestrationArgv({ operation: 'run-create', objective: 'x-y' })[3]).toBe('x-y');
    expect(buildOrcaOrchestrationArgv({ operation: 'run-create', objective: '–dash' })[3]).toBe('–dash');
  });

  test('rejects invalid dependent, structured, and delimiter-sensitive values', () => {
    for (const input of [
      { operation: 'worker-start', task: 'task_a', agent: 'codex', effort: 'high' },
      { operation: 'check', wait: false, timeoutMs: 500 },
      { operation: 'check', unread: true, peek: true },
      { operation: 'check', types: ['question', 'question'] },
      { operation: 'ask', question: 'q', resume: 'message_a' },
      { operation: 'ask', resume: 'message_a', options: ['yes'] },
      { operation: 'ask', question: 'q', options: ['a,b'] },
      { operation: 'ask', question: 'q', options: ['a\rb'] },
      { operation: 'ask', question: 'q', options: ['a\nb'] },
      { operation: 'task-create', spec: 'x', deps: ['task_a', 'task_a'] },
      { operation: 'task-update', id: 'task_a', status: 'completed', result: { summary: 'x', extra: true } },
      { operation: 'send', subject: 'x', payload: {} },
      { operation: 'send', subject: 'x', payload: { taskId: 'task_a', extra: true } },
    ]) {
      expect(() => buildOrcaOrchestrationArgv(input)).toThrow(OrcaAdapterError);
    }
  });
});

describe('runtime and executor boundary', () => {
  test('resolves one deterministic executable without fallback', () => {
    expect(resolveOrcaExecutable({ platform: 'win32', env: {} })).toBe('orca.exe');
    expect(resolveOrcaExecutable({ platform: 'darwin', env: {} })).toBe('orca');
    expect(resolveOrcaExecutable({ platform: 'linux', env: {}, managedTerminal: false })).toBe('orca-ide');
    expect(resolveOrcaExecutable({ platform: 'linux', env: {}, managedTerminal: true })).toBe('orca');
    expect(resolveOrcaExecutable({ platform: 'linux', env: { ORCA_CLI_COMMAND: '/opt/orca/bin/orca' } })).toBe(
      '/opt/orca/bin/orca',
    );
    expect(() => resolveOrcaExecutable({ platform: 'linux', env: { ORCA_CLI_COMMAND: 'wrapper --flag' } })).toThrow(
      OrcaAdapterError,
    );
  });

  test('does not spawn on invalid input and owns all process controls', async () => {
    const requests: Parameters<OrcaProcessExecutor>[0][] = [];
    const adapter = createOrcaOrchestrationAdapter({
      executable: 'orca-test',
      env: { SAFE: 'yes' },
      executor: async (request) => {
        requests.push(request);
        return { exitCode: 0, stdout: '{"id":"request_a","ok":true,"result":{"runs":[]}}', stderr: '' };
      },
    });
    await expect(adapter.execute({ operation: 'run-show', id: '--json' })).rejects.toBeInstanceOf(OrcaAdapterError);
    expect(requests).toHaveLength(0);
    await adapter.execute({ operation: 'run-list' });
    expect(requests).toEqual([
      {
        executable: 'orca-test',
        argv: ['orchestration', 'run-list', '--json'],
        shell: false,
        timeoutMs: 30_000,
        maxStdoutBytes: MAX_ORCA_STDOUT_BYTES,
        maxStderrBytes: MAX_ORCA_STDERR_BYTES,
        env: { SAFE: 'yes' },
      },
    ]);
  });

  test('requires one strict success envelope', async () => {
    for (const stdout of ['', '{}', '{"id":"x","ok":true}', '{"id":"x","ok":true,"result":{},"extra":1}', '{}\n{}']) {
      const adapter = createOrcaOrchestrationAdapter({
        executable: 'orca-test',
        executor: async () => ({ exitCode: 0, stdout, stderr: '' }),
      });
      await expect(adapter.execute({ operation: 'run-list' })).rejects.toBeInstanceOf(OrcaAdapterError);
    }
  });

  test('classifies an acknowledgement timeout as unrecoverably ambiguous', async () => {
    const adapter = createOrcaOrchestrationAdapter({
      executable: 'orca-test',
      executor: async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }),
    });
    try {
      await adapter.execute({ operation: 'check', ack: 'delivery_a' });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(OrcaAdapterError);
      expect((error as OrcaAdapterError).code).toBe('ambiguous_after_possible_commit');
      expect((error as OrcaAdapterError).retrySafety).toBe('unrecoverably-ambiguous');
    }
  });
});
