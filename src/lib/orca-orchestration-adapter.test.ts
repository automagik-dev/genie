import { describe, expect, test } from 'bun:test';
import {
  MAX_ORCA_STDERR_BYTES,
  MAX_ORCA_STDOUT_BYTES,
  OrcaAdapterError,
  type OrcaOperation,
  type OrcaProcessExecutor,
  __orcaAdapterTestOnly,
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
    expect(resolveOrcaExecutable({ platform: 'win32' })).toBe('orca.exe');
    expect(resolveOrcaExecutable({ platform: 'darwin' })).toBe('orca');
    expect(resolveOrcaExecutable({ platform: 'linux', managedTerminal: false })).toBe('orca-ide');
    expect(resolveOrcaExecutable({ platform: 'linux', managedTerminal: true })).toBe('orca');
    expect(createOrcaOrchestrationAdapter().executable).toBe(
      resolveOrcaExecutable({ managedTerminal: process.env.TERM_PROGRAM === 'Orca' }),
    );
  });

  test('does not spawn on invalid input and owns all process controls', async () => {
    const requests: Parameters<OrcaProcessExecutor>[0][] = [];
    const adapter = __orcaAdapterTestOnly.createAdapter({
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
        executable: 'orca-ide',
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
      const adapter = __orcaAdapterTestOnly.createAdapter({
        executor: async () => ({ exitCode: 0, stdout, stderr: '' }),
      });
      await expect(adapter.execute({ operation: 'run-list' })).rejects.toBeInstanceOf(OrcaAdapterError);
    }
  });

  test('classifies an acknowledgement timeout as unrecoverably ambiguous', async () => {
    const adapter = __orcaAdapterTestOnly.createAdapter({
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
    const adapter = __orcaAdapterTestOnly.createAdapter({
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
    for (const stdout of ['not-json', '{"id":"request_a","ok":true,"result":{"released":true}}']) {
      let calls = 0;
      const adapter = __orcaAdapterTestOnly.createAdapter({
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
        expect((error as OrcaAdapterError).code).toBe('ambiguous_after_possible_commit');
        expect((error as OrcaAdapterError).retrySafety).toBe('unrecoverably-ambiguous');
      }
      expect(calls).toBe(1);
    }
  });

  test('normalizes run-use identifiers, runtime metadata, timestamps, and run-current proof', async () => {
    const requests: string[][] = [];
    const instants = [new Date('2026-08-29T00:00:00.000Z'), new Date('2026-08-29T00:00:01.000Z')];
    const adapter = __orcaAdapterTestOnly.createAdapter({
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
      const adapter = __orcaAdapterTestOnly.createAdapter({
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
    const adapter = __orcaAdapterTestOnly.createAdapter({
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

  test('maps every post-receipt readback failure onto the mutation and never makes it safe to retry', async () => {
    const failures: ReadonlyArray<{
      name: string;
      result?: Awaited<ReturnType<OrcaProcessExecutor>>;
      rejection?: Error;
      code: string;
    }> = [
      {
        name: 'timeout',
        result: { exitCode: null, stdout: '', stderr: '', timedOut: true },
        code: 'timeout',
      },
      {
        name: 'process exit',
        result: { exitCode: 7, stdout: '', stderr: 'read failed' },
        code: 'process_exit',
      },
      {
        name: 'launch transport',
        rejection: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
        code: 'executable_unavailable',
      },
      {
        name: 'transport loss',
        result: { exitCode: null, stdout: '', stderr: '', transportLost: true },
        code: 'process_exit',
      },
      {
        name: 'output limit',
        result: { exitCode: null, stdout: '', stderr: '', outputLimited: true },
        code: 'output_limit',
      },
      {
        name: 'malformed JSON',
        result: { exitCode: 0, stdout: 'not-json', stderr: '' },
        code: 'malformed_json',
      },
      {
        name: 'invalid JSON envelope',
        result: { exitCode: 0, stdout: '{"id":"r","ok":true,"result":{}}', stderr: '' },
        code: 'unexpected_response',
      },
      {
        name: 'error envelope',
        result: {
          exitCode: 0,
          stdout: '{"id":"r","ok":false,"error":{"code":"read_failed","message":"failed"}}',
          stderr: '',
        },
        code: 'unexpected_response',
      },
    ];
    for (const failure of failures) {
      const verbs: string[] = [];
      const adapter = __orcaAdapterTestOnly.createAdapter({
        executor: async (request) => {
          const verb = request.argv[1] as string;
          verbs.push(verb);
          if (verb === 'run-current') {
            if (failure.rejection !== undefined) throw failure.rejection;
            return failure.result as Awaited<ReturnType<OrcaProcessExecutor>>;
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              id: 'request_a',
              ok: true,
              result: { runId: 'run_a', coordinatorTerminalHandle: 'term_a' },
              _meta: {
                runtimeId: 'runtime_a',
                runtimeVersion: '1.2.3',
                invokingTerminal: 'term_a',
              },
            }),
            stderr: '',
          };
        },
      });
      try {
        await adapter.execute({ operation: 'run-use', id: 'run_a' });
        throw new Error(`expected ${failure.name} failure`);
      } catch (error) {
        expect(error).toBeInstanceOf(OrcaAdapterError);
        expect(error).toMatchObject({
          code: failure.code,
          operation: 'run-use',
          phase: 'readback',
          retrySafety: 'readback-required',
        });
        expect((error as OrcaAdapterError).recovery).toContain('do not retry the mutation automatically');
      }
      expect(verbs).toEqual(['run-use', 'run-current']);
    }
  });

  test('returns receipt-only proofs for send/reply and supported check --ack', async () => {
    for (const input of [
      { operation: 'send', subject: 'hello' },
      { operation: 'reply', id: 'message_a', body: 'yes' },
      { operation: 'check', ack: 'delivery_a' },
    ] satisfies OrcaOperation[]) {
      let calls = 0;
      const adapter = __orcaAdapterTestOnly.createAdapter({
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
      const adapter = __orcaAdapterTestOnly.createAdapter({
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
    const ack = __orcaAdapterTestOnly.createAdapter({
      executor: async () => ({
        exitCode: 0,
        stdout:
          '{"id":"request_a","ok":true,"result":{"deliveryId":"delivery_a","acknowledged":false},"_meta":{"runtimeId":"runtime_a","runtimeVersion":"1.2.3"}}',
        stderr: '',
      }),
    });
    await expect(ack.execute({ operation: 'check', ack: 'delivery_a' })).rejects.toMatchObject({
      code: 'ambiguous_after_possible_commit',
    });

    const terminal = __orcaAdapterTestOnly.createAdapter({
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
    const adapter = __orcaAdapterTestOnly.createAdapter({
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
      const adapter = __orcaAdapterTestOnly.createAdapter({
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

  test('classifies every verb failure by whether the invocation could mutate', async () => {
    const mutation = new Set([
      'run-create',
      'run-use',
      'task-create',
      'task-update',
      'worker-start',
      'worker-release',
      'send',
      'check',
      'reply',
      'ask',
      'gate-create',
      'gate-resolve',
    ]);
    const failures = [
      { exitCode: 7, stdout: '', stderr: 'failed' },
      { exitCode: 0, stdout: 'not-json', stderr: '' },
      { exitCode: 0, stdout: '{"id":"r","ok":true,"result":{}}', stderr: '' },
      { exitCode: null, stdout: '', stderr: '', timedOut: true },
      { exitCode: null, stdout: '', stderr: '', outputLimited: true },
      {
        exitCode: 0,
        stdout: '{"id":"r","ok":false,"error":{"code":"nope","message":"failed"}}',
        stderr: '',
      },
    ];
    for (const [, input] of cases) {
      for (const failure of failures) {
        const adapter = __orcaAdapterTestOnly.createAdapter({ executor: async () => failure });
        try {
          await adapter.execute(input);
          throw new Error('expected adapter failure');
        } catch (error) {
          expect(error).toBeInstanceOf(OrcaAdapterError);
          if (mutation.has(input.operation)) {
            expect((error as OrcaAdapterError).code).toBe('ambiguous_after_possible_commit');
            expect((error as OrcaAdapterError).retrySafety).toBe('unrecoverably-ambiguous');
          } else {
            expect((error as OrcaAdapterError).retrySafety).toBe('safe');
          }
        }
      }
    }
  });

  test('treats executor rejection as safe pre-spawn executable unavailability', async () => {
    const adapter = __orcaAdapterTestOnly.createAdapter({
      executor: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    });
    await expect(adapter.execute({ operation: 'send', subject: 'once' })).rejects.toMatchObject({
      code: 'executable_unavailable',
      phase: 'resolve',
      retrySafety: 'safe',
    });
  });

  test('bounds timeout termination through the kill escalation path', async () => {
    const started = Date.now();
    const result = await __orcaAdapterTestOnly.spawnOrcaProcess({
      executable: process.execPath,
      argv: ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      shell: false,
      timeoutMs: 20,
      maxStdoutBytes: MAX_ORCA_STDOUT_BYTES,
      maxStderrBytes: MAX_ORCA_STDERR_BYTES,
      env: process.env,
    });
    expect(result.timedOut).toBeTrue();
    expect(result.signal).toBe('SIGKILL');
    expect(Date.now() - started).toBeLessThan(2500);
  });

  test('redacts secrets and request values, strips controls, and truncates stderr', async () => {
    const secret = 'super-secret-token';
    const body = 'private request body';
    const adapter = __orcaAdapterTestOnly.createAdapter({
      env: { API_TOKEN: secret },
      executor: async () => ({
        exitCode: 2,
        stdout: '',
        stderr: `${'x'.repeat(5000)}\u0001 ${secret} ${body}`,
      }),
    });
    try {
      await adapter.execute({ operation: 'send', subject: 'subject', body });
      throw new Error('expected failure');
    } catch (error) {
      const stderr = (error as OrcaAdapterError).stderr ?? '';
      expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(4096);
      expect(stderr).not.toContain(secret);
      expect(stderr).not.toContain(body);
      expect(stderr).not.toContain('\u0001');
      expect(stderr).toContain('[REDACTED]');
    }
  });

  test('redacts secrets and request values echoed by a direct error envelope', async () => {
    const secret = 'credential';
    const databaseUrl = `postgres://brain:${secret}@db/internal`;
    const requestedId = 'run_private';
    let calls = 0;
    const adapter = __orcaAdapterTestOnly.createAdapter({
      env: { DATABASE_URL: databaseUrl },
      executor: async () => {
        calls += 1;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            id: 'request_a',
            ok: false,
            error: { code: 'read_failed', message: `could not read ${requestedId} via ${databaseUrl}` },
          }),
          stderr: '',
        };
      },
    });

    try {
      await adapter.execute({ operation: 'run-show', id: requestedId });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(OrcaAdapterError);
      expect((error as OrcaAdapterError).message).not.toContain(requestedId);
      expect((error as OrcaAdapterError).message).not.toContain(secret);
      expect((error as OrcaAdapterError).message).not.toContain(databaseUrl);
      expect((error as OrcaAdapterError).message).toContain('[REDACTED]');
      expect((error as OrcaAdapterError).message).toContain('postgres://brain:[REDACTED]@db/internal');
      expect(calls).toBe(1);
    }
  });

  test('keeps error-envelope diagnostics redacted when reattributing a post-receipt readback failure', async () => {
    const secret = 'credential';
    const databaseUrl = `postgres://brain:${secret}@db/internal`;
    const requestedId = 'run_private';
    const calls: string[] = [];
    const adapter = __orcaAdapterTestOnly.createAdapter({
      env: { DATABASE_URL: databaseUrl },
      executor: async (request) => {
        calls.push(request.argv[1] ?? '');
        return request.argv[1] === 'run-use'
          ? {
              exitCode: 0,
              stdout: JSON.stringify({
                id: 'request_a',
                ok: true,
                result: { runId: requestedId, coordinatorTerminalHandle: 'term_a' },
                _meta: { runtimeId: 'runtime_a', runtimeVersion: '1.2.3', invokingTerminal: 'term_a' },
              }),
              stderr: '',
            }
          : {
              exitCode: 0,
              stdout: JSON.stringify({
                id: 'request_b',
                ok: false,
                error: { code: 'read_failed', message: `could not read ${requestedId} via ${databaseUrl}` },
              }),
              stderr: '',
            };
      },
    });

    try {
      await adapter.execute({ operation: 'run-use', id: requestedId });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(OrcaAdapterError);
      expect(error).toMatchObject({ operation: 'run-use', phase: 'readback', retrySafety: 'readback-required' });
      expect((error as OrcaAdapterError).message).not.toContain(requestedId);
      expect((error as OrcaAdapterError).message).not.toContain(secret);
      expect((error as OrcaAdapterError).message).not.toContain(databaseUrl);
      expect((error as OrcaAdapterError).message).toContain('[REDACTED]');
      expect((error as OrcaAdapterError).message).toContain('postgres://brain:[REDACTED]@db/internal');
      expect((error as OrcaAdapterError).recovery).toContain('do not retry the mutation automatically');
      expect(calls).toEqual(['run-use', 'run-current']);
    }
  });

  test('rejects non-finite ask states and mixed success/error envelopes', async () => {
    for (const stdout of [
      '{"id":"r","ok":true,"result":{"messageId":"message_a","state":"pending","answer":"no"},"_meta":{"runtimeId":"runtime_a","runtimeVersion":"1"}}',
      '{"id":"r","ok":true,"result":{"messageId":"message_a","state":"answered"},"_meta":{"runtimeId":"runtime_a","runtimeVersion":"1"}}',
      '{"id":"r","ok":true,"result":{"messageId":"message_a","state":"other"},"_meta":{"runtimeId":"runtime_a","runtimeVersion":"1"}}',
      '{"id":"r","ok":false,"result":{},"error":{"code":"x","message":"x"}}',
      '{"id":"r","ok":false,"error":{"code":"x","message":"x","extra":true}}',
    ]) {
      const adapter = __orcaAdapterTestOnly.createAdapter({
        executor: async () => ({ exitCode: 0, stdout, stderr: '' }),
      });
      await expect(adapter.execute({ operation: 'ask', question: 'q' })).rejects.toMatchObject({
        code: 'ambiguous_after_possible_commit',
      });
    }
  });

  test('rejects mismatched receipt identities and duplicate readback rows', async () => {
    const scenarios: Array<{ input: OrcaOperation; mutationResult: object; readResult?: object }> = [
      {
        input: { operation: 'task-update', id: 'task_a', status: 'completed' },
        mutationResult: { taskId: 'task_other' },
      },
      {
        input: { operation: 'worker-start', task: 'task_a', agent: 'codex' },
        mutationResult: { dispatchId: 'dispatch_a', taskId: 'task_other' },
      },
      {
        input: { operation: 'gate-create', task: 'task_a', question: 'q' },
        mutationResult: { gateId: 'gate_a', taskId: 'task_other' },
      },
      {
        input: { operation: 'reply', id: 'message_a', body: 'yes' },
        mutationResult: { messageId: 'message_other' },
      },
      {
        input: { operation: 'task-create', spec: 'spec' },
        mutationResult: { taskId: 'task_a' },
        readResult: {
          tasks: [
            { id: 'task_a', spec: 'spec', status: 'ready' },
            { id: 'task_a', spec: 'spec', status: 'ready' },
          ],
        },
      },
    ];
    for (const scenario of scenarios) {
      let call = 0;
      const adapter = __orcaAdapterTestOnly.createAdapter({
        executor: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            id: 'request_a',
            ok: true,
            result: call++ === 0 ? scenario.mutationResult : scenario.readResult,
            _meta: { runtimeId: 'runtime_a', runtimeVersion: '1' },
          }),
          stderr: '',
        }),
      });
      await expect(adapter.execute(scenario.input)).rejects.toMatchObject({ code: 'readback_mismatch' });
    }
  });
});
