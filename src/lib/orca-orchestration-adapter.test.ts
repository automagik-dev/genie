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

  test('classifies every mutation timeout as ambiguous and does not retry', async () => {
    let calls = 0;
    const adapter = createOrcaOrchestrationAdapter({
      executable: 'orca-test',
      executor: async () => {
        calls += 1;
        return { exitCode: null, stdout: '', stderr: '', timedOut: true };
      },
    });
    try {
      await adapter.execute({ operation: 'send', subject: 'once' });
      throw new Error('expected failure');
    } catch (error) {
      expect((error as OrcaAdapterError).code).toBe('ambiguous_after_possible_commit');
      expect((error as OrcaAdapterError).retrySafety).toBe('unrecoverably-ambiguous');
    }
    expect(calls).toBe(1);
  });

  test('rejects verb-specific malformed and identifier-free mutation JSON without retry', async () => {
    for (const [stdout, code] of [
      ['not-json', 'malformed_json'],
      ['{"id":"request_a","ok":true,"result":{"released":true}}', 'missing_receipt'],
    ] as const) {
      let calls = 0;
      const adapter = createOrcaOrchestrationAdapter({
        executable: 'orca-test',
        executor: async () => {
          calls += 1;
          return { exitCode: 0, stdout, stderr: '' };
        },
      });
      try {
        await adapter.execute({ operation: 'worker-release', dispatch: 'dispatch_a' });
        throw new Error('expected failure');
      } catch (error) {
        expect(error).toBeInstanceOf(OrcaAdapterError);
        expect((error as OrcaAdapterError).code).toBe(code);
        expect((error as OrcaAdapterError).retrySafety).toBe('readback-required');
      }
      expect(calls).toBe(1);
    }
  });

  test('normalizes run-use identifiers, runtime metadata, timestamps, and run-current proof', async () => {
    const requests: string[][] = [];
    const instants = [new Date('2026-08-29T00:00:00.000Z'), new Date('2026-08-29T00:00:01.000Z')];
    const adapter = createOrcaOrchestrationAdapter({
      executable: 'orca-test',
      now: () => instants.shift() as Date,
      executor: async (request) => {
        requests.push([...request.argv]);
        const result =
          request.argv[1] === 'run-use'
            ? { runId: 'run_a', coordinatorTerminalHandle: 'term_a' }
            : { run: { id: 'run_a' }, coordinatorTerminalHandle: 'term_a' };
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            id: 'request_a',
            ok: true,
            result,
            _meta: { runtimeId: 'runtime_a', runtimeVersion: '1.2.3', invokingTerminal: 'term_a' },
          }),
          stderr: '',
        };
      },
    });
    const response = await adapter.execute({ operation: 'run-use', id: 'run_a' });
    expect(requests.map((argv) => argv[1])).toEqual(['run-use', 'run-current']);
    expect(response.receipt).toEqual({
      verb: 'run-use',
      ids: { runId: 'run_a' },
      runtimeId: 'runtime_a',
      runtimeVersion: '1.2.3',
      startedAt: '2026-08-29T00:00:00.000Z',
      completedAt: '2026-08-29T00:00:01.000Z',
      readbackVerb: 'run-current',
    });
  });

  test('verifies gate task context and worker release through their required public readbacks', async () => {
    const run = async (input: OrcaOperation, results: Record<string, object>) => {
      const verbs: string[] = [];
      const adapter = createOrcaOrchestrationAdapter({
        executable: 'orca-test',
        executor: async (request) => {
          const verb = request.argv[1] as string;
          verbs.push(verb);
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              id: `request_${verb}`,
              ok: true,
              result: results[verb],
              _meta: { runtimeId: 'runtime_a', runtimeVersion: '1.2.3' },
            }),
            stderr: '',
          };
        },
      });
      const response = await adapter.execute(input);
      return { verbs, response };
    };
    const gate = await run(
      { operation: 'gate-resolve', id: 'gate_a', resolution: 'yes', task: 'task_a' },
      {
        'gate-resolve': { gateId: 'gate_a', taskId: 'task_a' },
        'gate-list': {
          gates: [{ id: 'gate_a', taskId: 'task_a', question: 'Choose', status: 'resolved', resolution: 'yes' }],
        },
      },
    );
    expect(gate.verbs).toEqual(['gate-resolve', 'gate-list']);
    expect(gate.response.receipt?.ids).toEqual({ gateId: 'gate_a', taskId: 'task_a' });

    const worker = await run(
      { operation: 'worker-release', dispatch: 'dispatch_a' },
      {
        'worker-release': { dispatchId: 'dispatch_a' },
        'worker-show': {
          dispatch: { id: 'dispatch_a', taskId: 'task_a', terminalDisposition: 'released' },
        },
      },
    );
    expect(worker.verbs).toEqual(['worker-release', 'worker-show']);
    expect(worker.response.receipt?.readbackVerb).toBe('worker-show');
  });

  test('fails on readback disagreement and never retries either call', async () => {
    const verbs: string[] = [];
    const adapter = createOrcaOrchestrationAdapter({
      executable: 'orca-test',
      executor: async (request) => {
        const verb = request.argv[1] as string;
        verbs.push(verb);
        const result =
          verb === 'run-use'
            ? { runId: 'run_a', coordinatorTerminalHandle: 'term_a' }
            : { run: { id: 'run_other' }, coordinatorTerminalHandle: 'term_a' };
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            id: 'request_a',
            ok: true,
            result,
            _meta: { runtimeId: 'runtime_a', runtimeVersion: '1.2.3', invokingTerminal: 'term_a' },
          }),
          stderr: '',
        };
      },
    });
    try {
      await adapter.execute({ operation: 'run-use', id: 'run_a' });
      throw new Error('expected failure');
    } catch (error) {
      expect((error as OrcaAdapterError).code).toBe('readback_mismatch');
    }
    expect(verbs).toEqual(['run-use', 'run-current']);
  });

  test('returns receipt-only proofs for send/reply and supported check --ack', async () => {
    for (const input of [
      { operation: 'send', subject: 'hello' },
      { operation: 'reply', id: 'message_a', body: 'yes' },
      { operation: 'check', ack: 'delivery_a' },
    ] satisfies OrcaOperation[]) {
      let calls = 0;
      const adapter = createOrcaOrchestrationAdapter({
        executable: 'orca-test',
        executor: async (request) => {
          calls += 1;
          const result =
            request.argv[1] === 'check'
              ? { deliveryId: 'delivery_a', acknowledged: true, messages: [] }
              : { messageId: 'message_a' };
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              id: 'request_a',
              ok: true,
              result,
              _meta: { runtimeId: 'runtime_a', runtimeVersion: '1.2.3' },
            }),
            stderr: '',
          };
        },
      });
      const response = await adapter.execute(input);
      expect(response.receipt?.verb).toBe(input.operation);
      expect(response.receipt?.readbackVerb).toBeNull();
      expect(calls).toBe(1);
    }
  });

  test('rejects duplicate JSON keys and arbitrary nested identifiers', async () => {
    for (const stdout of [
      '{"id":"request_a","ok":true,"result":{"runs":[],"runs":[]}}',
      '{"id":"request_a","ok":true,"result":{"nested":{"runId":"run_a"}}}',
    ]) {
      let calls = 0;
      const adapter = createOrcaOrchestrationAdapter({
        executable: 'orca-test',
        executor: async () => {
          calls += 1;
          return { exitCode: 0, stdout, stderr: '' };
        },
      });
      await expect(adapter.execute({ operation: 'run-create', objective: 'x' })).rejects.toBeInstanceOf(
        OrcaAdapterError,
      );
      expect(calls).toBe(1);
    }
  });

  test('requires exact acknowledgement state and runtime-attested terminal binding', async () => {
    const ack = createOrcaOrchestrationAdapter({
      executable: 'orca-test',
      executor: async () => ({
        exitCode: 0,
        stdout:
          '{"id":"request_a","ok":true,"result":{"deliveryId":"delivery_a","acknowledged":false},"_meta":{"runtimeId":"runtime_a","runtimeVersion":"1.2.3"}}',
        stderr: '',
      }),
    });
    await expect(ack.execute({ operation: 'check', ack: 'delivery_a' })).rejects.toMatchObject({
      code: 'missing_receipt',
    });

    const terminal = createOrcaOrchestrationAdapter({
      executable: 'orca-test',
      executor: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          id: 'request_a',
          ok: true,
          result: { runId: 'run_a', coordinatorTerminalHandle: 'term_wrong' },
          _meta: { runtimeId: 'runtime_a', runtimeVersion: '1.2.3', invokingTerminal: 'term_a' },
        }),
        stderr: '',
      }),
    });
    await expect(terminal.execute({ operation: 'run-use', id: 'run_a' })).rejects.toMatchObject({
      code: 'readback_mismatch',
    });
  });

  test('accepts the public retained worker disposition', async () => {
    const verbs: string[] = [];
    const adapter = createOrcaOrchestrationAdapter({
      executable: 'orca-test',
      executor: async (request) => {
        const verb = request.argv[1] as string;
        verbs.push(verb);
        const result =
          verb === 'worker-release'
            ? { dispatchId: 'dispatch_a' }
            : { dispatch: { id: 'dispatch_a', taskId: 'task_a', terminalDisposition: 'retained' } };
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            id: 'request_a',
            ok: true,
            result,
            _meta: { runtimeId: 'runtime_a', runtimeVersion: '1.2.3' },
          }),
          stderr: '',
        };
      },
    });
    await adapter.execute({ operation: 'worker-release', dispatch: 'dispatch_a' });
    expect(verbs).toEqual(['worker-release', 'worker-show']);
  });

  test('classifies output and transport loss after mutation spawn as ambiguous without persistence or retry', async () => {
    for (const result of [
      { exitCode: null, stdout: '', stderr: '', outputLimited: true },
      { exitCode: null, stdout: '', stderr: '', transportLost: true },
    ]) {
      let calls = 0;
      const adapter = createOrcaOrchestrationAdapter({
        executable: 'orca-test',
        executor: async () => {
          calls += 1;
          return result;
        },
      });
      await expect(adapter.execute({ operation: 'send', subject: 'once' })).rejects.toMatchObject({
        code: 'ambiguous_after_possible_commit',
        retrySafety: 'unrecoverably-ambiguous',
      });
      expect(calls).toBe(1);
    }
  });
});
