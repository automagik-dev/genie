import { spawn } from 'node:child_process';
import { z } from 'zod';

export const ORCA_ORCHESTRATION_VERBS = [
  'run-create',
  'run-list',
  'run-show',
  'run-current',
  'run-use',
  'task-create',
  'task-list',
  'task-update',
  'worker-start',
  'worker-show',
  'worker-read',
  'worker-release',
  'send',
  'check',
  'reply',
  'ask',
  'gate-create',
  'gate-list',
  'gate-resolve',
] as const;

export type OrcaOrchestrationVerb = (typeof ORCA_ORCHESTRATION_VERBS)[number];

export type OrcaAdapterErrorCode =
  | 'unsupported_platform'
  | 'unsupported_environment'
  | 'executable_unavailable'
  | 'incompatible_cli_version'
  | 'invalid_operation'
  | 'invalid_argument'
  | 'timeout'
  | 'output_limit'
  | 'ambiguous_after_possible_commit'
  | 'process_exit'
  | 'malformed_json'
  | 'unexpected_response'
  | 'missing_receipt'
  | 'readback_mismatch'
  | 'local_lifecycle_disabled_in_orca_mode';

export type RetrySafety = 'safe' | 'unsafe' | 'readback-required' | 'unrecoverably-ambiguous';

export class OrcaAdapterError extends Error {
  readonly name = 'OrcaAdapterError';

  constructor(
    readonly code: OrcaAdapterErrorCode,
    readonly operation: OrcaOrchestrationVerb | 'runtime',
    readonly phase: 'validate' | 'resolve' | 'execute' | 'decode' | 'receipt' | 'readback',
    readonly retrySafety: RetrySafety,
    readonly recovery: string,
    message: string,
    readonly stderr?: string,
  ) {
    super(message);
  }
}

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/);
const utf8 = (max: number) =>
  z
    .string()
    .refine((value) => value === value.normalize('NFC'), 'must be NFC-normalized')
    .refine((value) => !value.includes('\0') && !/[\uD800-\uDFFF]/u.test(value), 'contains an invalid code point')
    .refine((value) => Buffer.byteLength(value, 'utf8') >= 1 && Buffer.byteLength(value, 'utf8') <= max);
const longText = utf8(16_384);
const shortText = utf8(512);
const itemText = utf8(256);
const cursor = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[\x21-\x7E]+$/)
  .refine((value) => !value.startsWith('-') && !/[;&|`$<>\\(){}\[\]*?!'\"]/.test(value));
const model = cursor.refine((value) => Buffer.byteLength(value, 'utf8') <= 128);
const limit = z.number().int().min(1).max(100);
const timeout = z.number().int().min(250).max(600_000);
const taskStatus = z.enum(['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked']);
const gateStatus = z.enum(['pending', 'resolved']);
const messageType = z.enum([
  'status',
  'dispatch',
  'worker_done',
  'merge_ready',
  'escalation',
  'handoff',
  'question',
  'decision_gate',
  'heartbeat',
]);
const priority = z.enum(['low', 'normal', 'high', 'urgent']);
const workerSource = z.enum(['auto', 'transcript', 'terminal']);
const agent = z.enum(['claude', 'codex', 'cursor', 'droid', 'gemini', 'grok', 'opencode']);
const effort = z.enum(['low', 'medium', 'high', 'xhigh']);
const uniqueArray = <T extends z.ZodTypeAny>(member: T, maximum: number, minimum = 0) =>
  z
    .array(member)
    .min(minimum)
    .max(maximum)
    .refine((values) => new Set(values as unknown[]).size === values.length, 'items must be unique');
const result = z
  .object({ summary: longText, artifacts: uniqueArray(itemText, 32).optional() })
  .strict()
  .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 32_768);
const sendPayload = z
  .object({
    taskId: id.optional(),
    dispatchId: id.optional(),
    phase: itemText.optional(),
    outcome: z.enum(['succeeded', 'failed']).optional(),
    filesModified: uniqueArray(itemText, 128).optional(),
    reportPath: itemText.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'payload must not be empty')
  .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 32_768);
const base = <V extends OrcaOrchestrationVerb, T extends z.ZodRawShape>(verb: V, shape: T) =>
  z.object({ operation: z.literal(verb), ...shape }).strict();

export const orcaOperationSchema = z.union([
  base('run-create', { objective: longText }),
  base('run-list', { limit: limit.optional(), cursor: cursor.optional() }),
  base('run-show', { id }),
  base('run-current', {}),
  base('run-use', { id }),
  base('task-create', {
    spec: longText,
    title: shortText.optional(),
    deps: uniqueArray(id, 64).optional(),
    parent: id.optional(),
  }),
  base('task-list', {
    status: taskStatus.optional(),
    ready: z.boolean().optional(),
    brief: z.boolean().optional(),
  }),
  base('task-update', { id, status: taskStatus, result: result.optional() }),
  base('worker-start', {
    task: id,
    agent,
    model: model.optional(),
    effort: effort.optional(),
    timeoutMs: timeout.optional(),
  }).refine((value) => value.effort === undefined || value.model !== undefined, {
    message: 'effort requires model',
  }),
  base('worker-show', { dispatch: id }),
  base('worker-read', {
    dispatch: id,
    source: workerSource.optional(),
    cursor: cursor.optional(),
    limit: limit.optional(),
  }),
  base('worker-release', { dispatch: id }),
  base('send', {
    subject: shortText,
    body: longText.optional(),
    type: messageType.optional(),
    priority: priority.optional(),
    threadId: id.optional(),
    payload: sendPayload.optional(),
  }),
  base('check', {
    ack: id.optional(),
    unread: z.boolean().optional(),
    peek: z.boolean().optional(),
    all: z.boolean().optional(),
    types: uniqueArray(messageType, messageType.options.length, 1).optional(),
    wait: z.boolean().optional(),
    timeoutMs: timeout.optional(),
  })
    .refine((value) => [value.unread, value.peek, value.all].filter((entry) => entry === true).length <= 1, {
      message: 'unread, peek, and all are mutually exclusive',
    })
    .refine((value) => value.timeoutMs === undefined || value.wait === true, { message: 'timeoutMs requires wait' }),
  base('reply', { id, body: longText }),
  base('ask', {
    question: shortText.optional(),
    resume: id.optional(),
    options: uniqueArray(itemText, 10, 1).optional(),
    timeoutMs: timeout.optional(),
  })
    .refine((value) => (value.question === undefined) !== (value.resume === undefined), {
      message: 'exactly one of question or resume is required',
    })
    .refine((value) => value.options === undefined || value.question !== undefined, {
      message: 'options require question',
    })
    .refine((value) => value.options?.every((option) => !/[,\r\n]/.test(option)) ?? true, {
      message: 'ask options cannot contain comma, CR, or LF',
    }),
  base('gate-create', {
    task: id,
    question: shortText,
    options: uniqueArray(itemText, 10, 1).optional(),
  }),
  base('gate-list', { task: id.optional(), status: gateStatus.optional() }),
  base('gate-resolve', { id, resolution: longText, task: id }),
]);

export type OrcaOperation = z.input<typeof orcaOperationSchema>;
export type ValidatedOrcaOperation = z.output<typeof orcaOperationSchema>;

function flagValue(flag: string, value: string): string[] {
  if (value.length > 0 && value[0] === '-') {
    throw new OrcaAdapterError(
      'invalid_argument',
      'runtime',
      'validate',
      'safe',
      'Correct the rejected semantic value and retry.',
      `${flag} has a flag-shaped value`,
    );
  }
  return [flag, value];
}

function optionalFlag(flag: string, value: string | number | undefined): string[] {
  return value === undefined ? [] : flagValue(flag, String(value));
}

function boolFlag(flag: string, value: boolean | undefined): string[] {
  return value === true ? [flag] : [];
}

export function buildOrcaOrchestrationArgv(input: unknown): readonly string[] {
  const parsed = orcaOperationSchema.safeParse(input);
  if (!parsed.success) {
    const operation = readOperation(input);
    throw new OrcaAdapterError(
      operation === undefined ? 'invalid_operation' : 'invalid_argument',
      operation ?? 'runtime',
      'validate',
      'safe',
      'Correct the semantic input and retry.',
      parsed.error.issues.map((issue) => issue.message).join('; '),
    );
  }
  const operation = parsed.data;
  const args = buildArguments(operation);
  return Object.freeze(['orchestration', operation.operation, ...args, '--json']);
}

function readOperation(input: unknown): OrcaOrchestrationVerb | undefined {
  if (typeof input !== 'object' || input === null || !('operation' in input)) return undefined;
  const operation = (input as { operation?: unknown }).operation;
  return ORCA_ORCHESTRATION_VERBS.find((candidate) => candidate === operation);
}

function buildArguments(operation: ValidatedOrcaOperation): string[] {
  switch (operation.operation) {
    case 'run-create':
      return flagValue('--objective', operation.objective);
    case 'run-list':
      return [...optionalFlag('--limit', operation.limit), ...optionalFlag('--cursor', operation.cursor)];
    case 'run-show':
    case 'run-use':
      return flagValue('--id', operation.id);
    case 'run-current':
      return [];
    case 'task-create':
      return [
        ...flagValue('--spec', operation.spec),
        ...optionalFlag('--task-title', operation.title),
        ...(operation.deps === undefined ? [] : flagValue('--deps', JSON.stringify(operation.deps))),
        ...optionalFlag('--parent', operation.parent),
      ];
    case 'task-list':
      return [
        ...optionalFlag('--status', operation.status),
        ...boolFlag('--ready', operation.ready),
        ...boolFlag('--brief', operation.brief),
      ];
    case 'task-update':
      return [
        ...flagValue('--id', operation.id),
        ...flagValue('--status', operation.status),
        ...(operation.result === undefined ? [] : flagValue('--result', JSON.stringify(operation.result))),
      ];
    case 'worker-start':
      return [
        ...flagValue('--task', operation.task),
        '--worktree',
        'current',
        ...flagValue('--agent', operation.agent),
        ...optionalFlag('--model', operation.model),
        ...optionalFlag('--effort', operation.effort),
        ...optionalFlag('--timeout-ms', operation.timeoutMs),
      ];
    case 'worker-show':
    case 'worker-release':
      return flagValue('--dispatch', operation.dispatch);
    case 'worker-read':
      return [
        ...flagValue('--dispatch', operation.dispatch),
        ...optionalFlag('--source', operation.source),
        ...optionalFlag('--cursor', operation.cursor),
        ...optionalFlag('--limit', operation.limit),
      ];
    case 'send':
      return [
        ...flagValue('--subject', operation.subject),
        ...optionalFlag('--body', operation.body),
        ...optionalFlag('--type', operation.type),
        ...optionalFlag('--priority', operation.priority),
        ...optionalFlag('--thread-id', operation.threadId),
        ...(operation.payload === undefined ? [] : flagValue('--payload', JSON.stringify(operation.payload))),
      ];
    case 'check':
      return [
        ...optionalFlag('--ack', operation.ack),
        ...boolFlag('--unread', operation.unread),
        ...boolFlag('--peek', operation.peek),
        ...boolFlag('--all', operation.all),
        ...(operation.types === undefined ? [] : flagValue('--types', operation.types.join(','))),
        ...boolFlag('--wait', operation.wait),
        ...optionalFlag('--timeout-ms', operation.timeoutMs),
      ];
    case 'reply':
      return [...flagValue('--id', operation.id), ...flagValue('--body', operation.body)];
    case 'ask':
      return [
        ...(operation.question === undefined
          ? flagValue('--resume', operation.resume as string)
          : flagValue('--question', operation.question)),
        ...(operation.options === undefined ? [] : flagValue('--options', operation.options.join(','))),
        ...optionalFlag('--timeout-ms', operation.timeoutMs),
      ];
    case 'gate-create':
      return [
        ...flagValue('--task', operation.task),
        ...flagValue('--question', operation.question),
        ...(operation.options === undefined ? [] : flagValue('--options', JSON.stringify(operation.options))),
      ];
    case 'gate-list':
      return [...optionalFlag('--task', operation.task), ...optionalFlag('--status', operation.status)];
    case 'gate-resolve':
      return [...flagValue('--id', operation.id), ...flagValue('--resolution', operation.resolution)];
  }
}

export function resolveOrcaExecutable(
  options: {
    platform?: NodeJS.Platform;
    managedTerminal?: boolean;
  } = {},
): string {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') return 'orca.exe';
  if (platform === 'darwin') return 'orca';
  if (platform === 'linux') return options.managedTerminal === true ? 'orca' : 'orca-ide';
  throw new OrcaAdapterError(
    'unsupported_platform',
    'runtime',
    'resolve',
    'safe',
    'Run the adapter on a supported Orca host.',
    `unsupported platform: ${platform}`,
  );
}

export interface OrcaProcessRequest {
  executable: string;
  argv: readonly string[];
  shell: false;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  env: Readonly<Record<string, string | undefined>>;
}

export interface OrcaProcessResult {
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  outputLimited?: boolean;
  transportLost?: boolean;
}

export type OrcaProcessExecutor = (request: OrcaProcessRequest) => Promise<OrcaProcessResult>;

export const DEFAULT_ORCA_TIMEOUT_MS = 30_000;
export const MAX_ORCA_STDOUT_BYTES = 1_048_576;
export const MAX_ORCA_STDERR_BYTES = 65_536;
const ORCA_KILL_GRACE_MS = 1_000;
const ORCA_CLOSE_GRACE_MS = 1_000;

const spawnOrcaProcess: OrcaProcessExecutor = async (request) =>
  new Promise((resolve, reject) => {
    const child = spawn(request.executable, [...request.argv], {
      shell: request.shell,
      env: request.env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let outputLimited = false;
    let spawned = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: OrcaProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (closeTimer !== undefined) clearTimeout(closeTimer);
      resolve(result);
    };
    const stop = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => {
        child.kill('SIGKILL');
        closeTimer ??= setTimeout(
          () =>
            finish({
              exitCode: null,
              signal: 'SIGKILL',
              stdout: Buffer.concat(stdout).toString('utf8'),
              stderr: Buffer.concat(stderr).toString('utf8'),
              timedOut,
              outputLimited,
              transportLost: true,
            }),
          ORCA_CLOSE_GRACE_MS,
        );
      }, ORCA_KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, request.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > request.maxStdoutBytes) {
        outputLimited = true;
        stop();
      } else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > request.maxStderrBytes) {
        outputLimited = true;
        stop();
      } else stderr.push(chunk);
    });
    child.once('spawn', () => {
      spawned = true;
    });
    child.once('error', (error) => {
      if (settled) return;
      if (spawned) {
        finish({
          exitCode: null,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: `${Buffer.concat(stderr).toString('utf8')}\nprocess transport error: ${error.message}`,
          timedOut,
          outputLimited,
          transportLost: true,
        });
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (closeTimer !== undefined) clearTimeout(closeTimer);
      reject(error);
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      finish({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        outputLimited,
      });
    });
  });

const terminalId = id;
const receipt = (shape: z.ZodRawShape) => z.object(shape).strict();
const runEntity = receipt({ id, objective: longText.optional(), coordinatorTerminalHandle: terminalId.optional() });
const taskEntity = receipt({
  id,
  spec: longText,
  title: shortText.optional(),
  deps: uniqueArray(id, 64).optional(),
  parent: id.optional(),
  status: taskStatus,
  result: result.optional(),
});
const workerEntity = receipt({
  id,
  taskId: id,
  agent: agent.optional(),
  model: model.optional(),
  effort: effort.optional(),
  state: itemText.optional(),
  terminalDisposition: z.enum(['released', 'retained']).optional(),
});
const gateEntity = receipt({
  id,
  taskId: id,
  question: shortText,
  options: uniqueArray(itemText, 10, 1).optional(),
  status: gateStatus,
  resolution: longText.optional(),
});
const messageReceipt = receipt({ messageId: id });
const askReceipt = z.union([
  receipt({ messageId: id, state: z.literal('answered'), answer: longText }),
  receipt({ messageId: id, state: z.literal('pending') }),
]);
const checkResult = receipt({
  deliveryId: id.optional(),
  acknowledged: z.boolean().optional(),
  messages: z
    .array(receipt({ id, type: messageType, subject: shortText }))
    .max(50)
    .optional(),
  count: z.number().int().min(0).max(50).optional(),
});
const responseSchemas: Readonly<Record<OrcaOrchestrationVerb, z.ZodTypeAny>> = {
  'run-create': receipt({ runId: id }),
  'run-list': receipt({ runs: z.array(runEntity).max(100), cursor: cursor.optional() }),
  'run-show': receipt({ run: runEntity }),
  'run-current': receipt({ run: runEntity, coordinatorTerminalHandle: terminalId }),
  'run-use': receipt({ runId: id, coordinatorTerminalHandle: terminalId }),
  'task-create': receipt({ taskId: id }),
  'task-list': receipt({ tasks: z.array(taskEntity).max(100) }),
  'task-update': receipt({ taskId: id }),
  'worker-start': receipt({ dispatchId: id, taskId: id }),
  'worker-show': receipt({ dispatch: workerEntity }),
  'worker-read': receipt({ dispatchId: id, source: workerSource, output: longText, cursor: cursor.optional() }),
  'worker-release': receipt({ dispatchId: id }),
  send: messageReceipt,
  check: checkResult,
  reply: messageReceipt,
  ask: askReceipt,
  'gate-create': receipt({ gateId: id, taskId: id }),
  'gate-list': receipt({ gates: z.array(gateEntity).max(100) }),
  'gate-resolve': receipt({ gateId: id, taskId: id }),
};

const envelopeSchema = z
  .object({
    id: z.string().min(1).max(256),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z
      .object({ code: z.string().min(1).max(128), message: z.string().min(1).max(4096) })
      .strict()
      .optional(),
    _meta: z
      .object({
        runtimeId: id,
        runtimeVersion: shortText.optional(),
        version: shortText.optional(),
        invokingTerminal: terminalId.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) =>
    value.ok
      ? value.result !== undefined && value.error === undefined
      : value.result === undefined && value.error !== undefined,
  );

export type OrcaJsonEnvelope = z.infer<typeof envelopeSchema>;

export interface OrcaMutationReceipt {
  readonly verb: OrcaOrchestrationVerb;
  readonly ids: Readonly<Record<string, string>>;
  readonly runtimeId: string | null;
  readonly runtimeVersion: string | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly readbackVerb: OrcaOrchestrationVerb | null;
}

export type OrcaAdapterResponse = OrcaJsonEnvelope & { readonly receipt?: OrcaMutationReceipt };

function ambiguousMutationError(
  operation: OrcaOrchestrationVerb,
  phase: 'execute' | 'decode' | 'receipt',
  message: string,
): OrcaAdapterError {
  return new OrcaAdapterError(
    'ambiguous_after_possible_commit',
    operation,
    phase,
    'unrecoverably-ambiguous',
    'Do not retry automatically; inspect the documented public read operation before choosing another mutation.',
    message,
  );
}

function parseEnvelope(operation: OrcaOrchestrationVerb, stdout: string, mutation: boolean): OrcaJsonEnvelope {
  let decoded: unknown;
  try {
    decoded = parseJsonRejectingDuplicateKeys(stdout);
  } catch {
    if (mutation) throw ambiguousMutationError(operation, 'decode', 'stdout was not one JSON document');
    throw new OrcaAdapterError(
      'malformed_json',
      operation,
      'decode',
      'safe',
      'Inspect Orca health and retry this read-only operation when safe.',
      'stdout was not one JSON document',
    );
  }
  const parsed = envelopeSchema.safeParse(decoded);
  if (!parsed.success) {
    if (mutation) throw ambiguousMutationError(operation, 'decode', 'stdout did not match the Orca envelope contract');
    throw new OrcaAdapterError(
      'unexpected_response',
      operation,
      'decode',
      'safe',
      'Use a compatible Orca CLI version.',
      'stdout did not match the Orca envelope contract',
    );
  }
  if (parsed.data.ok) {
    const result = responseSchemas[operation].safeParse(parsed.data.result);
    if (!result.success) {
      if (mutation)
        throw ambiguousMutationError(
          operation,
          'receipt',
          `success result did not match the finite ${operation} response contract`,
        );
      throw new OrcaAdapterError(
        'unexpected_response',
        operation,
        'decode',
        'safe',
        'Use a compatible Orca CLI version and inspect the public operation result.',
        `success result did not match the finite ${operation} response contract`,
      );
    }
  }
  return parsed.data;
}

function parseJsonRejectingDuplicateKeys(text: string): unknown {
  const stack: Array<Set<string> | null> = [];
  let expectingKey = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < text.length) {
        if (text[index] === '\\') index += 2;
        else if (text[index] === '"') break;
        else index += 1;
      }
      if (index >= text.length) throw new Error('unterminated JSON string');
      if (expectingKey) {
        const key = JSON.parse(text.slice(start, index + 1)) as string;
        const keys = stack.at(-1);
        if (keys === null || keys === undefined || keys.has(key)) throw new Error('duplicate JSON key');
        keys.add(key);
        expectingKey = false;
      }
    } else if (char === '{') {
      stack.push(new Set());
      expectingKey = true;
    } else if (char === '[') stack.push(null);
    else if (char === '}') stack.pop();
    else if (char === ']') stack.pop();
    else if (char === ',' && stack.at(-1) instanceof Set) expectingKey = true;
    index += 1;
  }
  return JSON.parse(text);
}

interface OrcaAdapterTestOptions {
  executor?: OrcaProcessExecutor;
  env?: Readonly<Record<string, string | undefined>>;
  managedTerminal?: boolean;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  now?: () => Date;
}

export interface OrcaOrchestrationAdapter {
  readonly executable: string;
  execute(input: unknown): Promise<OrcaAdapterResponse>;
}

const mutationVerbs = new Set<OrcaOrchestrationVerb>([
  'run-create',
  'run-use',
  'task-create',
  'task-update',
  'worker-start',
  'worker-release',
  'send',
  'reply',
  'ask',
  'gate-create',
  'gate-resolve',
]);

function hasAcknowledgement(operation: OrcaOrchestrationVerb, input: unknown): boolean {
  return operation === 'check' && typeof input === 'object' && input !== null && 'ack' in input;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function receiptIds(operation: OrcaOrchestrationVerb, value: unknown): Readonly<Record<string, string>> {
  const result = recordOf(value);
  const fields: Partial<Record<OrcaOrchestrationVerb, readonly string[]>> = {
    'run-create': ['runId'],
    'run-use': ['runId'],
    'task-create': ['taskId'],
    'task-update': ['taskId'],
    'worker-start': ['dispatchId', 'taskId'],
    'worker-release': ['dispatchId'],
    send: ['messageId'],
    reply: ['messageId'],
    ask: ['messageId'],
    check: ['deliveryId'],
    'gate-create': ['gateId', 'taskId'],
    'gate-resolve': ['gateId', 'taskId'],
  };
  return Object.freeze(
    Object.fromEntries(
      (fields[operation] ?? []).flatMap((key) => (typeof result[key] === 'string' ? [[key, result[key]]] : [])),
    ),
  );
}

type ReadbackPlan = { operation: ValidatedOrcaOperation; matches: (result: unknown) => boolean };

function readbackPlan(operation: ValidatedOrcaOperation, result: unknown): ReadbackPlan | undefined {
  if (operation.operation === 'run-use') {
    const receipt = recordOf(result);
    return {
      operation: { operation: 'run-current' },
      matches: (readback) => {
        const current = recordOf(readback);
        const run = recordOf(current.run);
        return (
          receipt.runId === operation.id &&
          run.id === operation.id &&
          receipt.coordinatorTerminalHandle === current.coordinatorTerminalHandle
        );
      },
    };
  }
  if (operation.operation === 'gate-resolve') {
    const mutation = recordOf(result);
    return {
      operation: { operation: 'gate-list', task: operation.task },
      matches: (readback) => {
        if (mutation.gateId !== operation.id || mutation.taskId !== operation.task) return false;
        const gates = recordOf(readback).gates;
        if (!Array.isArray(gates)) return false;
        const matching = gates.map(recordOf).filter((gate) => gate.id === operation.id);
        return (
          matching.length === 1 &&
          matching[0].taskId === operation.task &&
          matching[0].status === 'resolved' &&
          matching[0].resolution === operation.resolution
        );
      },
    };
  }
  if (operation.operation === 'worker-release') {
    const mutation = recordOf(result);
    return {
      operation: { operation: 'worker-show', dispatch: operation.dispatch },
      matches: (readback) => {
        const worker = recordOf(recordOf(readback).dispatch);
        return (
          mutation.dispatchId === operation.dispatch &&
          worker.id === operation.dispatch &&
          ['released', 'retained'].includes(String(worker.terminalDisposition))
        );
      },
    };
  }
  if (operation.operation === 'run-create') {
    const runId = recordOf(result).runId;
    return {
      operation: { operation: 'run-show', id: String(runId) },
      matches: (readback) => {
        const run = recordOf(recordOf(readback).run);
        return run.id === runId && run.objective === operation.objective;
      },
    };
  }
  if (operation.operation === 'task-create' || operation.operation === 'task-update') {
    const mutation = recordOf(result);
    const taskId = operation.operation === 'task-create' ? mutation.taskId : operation.id;
    return {
      operation: { operation: 'task-list' },
      matches: (readback) => {
        if (mutation.taskId !== taskId) return false;
        const tasks = recordOf(readback).tasks;
        if (!Array.isArray(tasks)) return false;
        const matching = tasks.map(recordOf).filter((candidate) => candidate.id === taskId);
        if (matching.length !== 1) return false;
        const task = matching[0];
        return operation.operation === 'task-create'
          ? task.spec === operation.spec &&
              task.title === operation.title &&
              JSON.stringify(task.deps ?? []) === JSON.stringify(operation.deps ?? []) &&
              task.parent === operation.parent
          : task.status === operation.status && JSON.stringify(task.result) === JSON.stringify(operation.result);
      },
    };
  }
  if (operation.operation === 'worker-start') {
    const mutation = recordOf(result);
    const dispatchId = mutation.dispatchId;
    return {
      operation: { operation: 'worker-show', dispatch: String(dispatchId) },
      matches: (readback) => {
        const worker = recordOf(recordOf(readback).dispatch);
        return (
          mutation.taskId === operation.task &&
          worker.id === dispatchId &&
          worker.taskId === operation.task &&
          worker.agent === operation.agent &&
          worker.model === operation.model &&
          worker.effort === operation.effort
        );
      },
    };
  }
  if (operation.operation === 'gate-create') {
    const mutation = recordOf(result);
    const gateId = mutation.gateId;
    return {
      operation: { operation: 'gate-list', task: operation.task },
      matches: (readback) => {
        const gates = recordOf(readback).gates;
        if (!Array.isArray(gates)) return false;
        if (mutation.taskId !== operation.task) return false;
        const matching = gates.map(recordOf).filter((candidate) => candidate.id === gateId);
        if (matching.length !== 1) return false;
        const gate = matching[0];
        return (
          gate?.taskId === operation.task &&
          gate.question === operation.question &&
          JSON.stringify(gate.options) === JSON.stringify(operation.options)
        );
      },
    };
  }
  return undefined;
}

function processFailure(
  operation: OrcaOrchestrationVerb,
  input: unknown,
  result: OrcaProcessResult,
): OrcaAdapterError | undefined {
  const acknowledgement = hasAcknowledgement(operation, input);
  const mutation = mutationVerbs.has(operation) || acknowledgement;
  if (result.outputLimited || result.transportLost) {
    if (mutation)
      return ambiguousMutationError(
        operation,
        'execute',
        result.outputLimited
          ? 'Orca output exceeded the adapter limit'
          : 'Orca transport closed before a valid response',
      );
    return safeProcessError(
      operation,
      result.outputLimited ? 'output_limit' : 'process_exit',
      result.outputLimited ? 'Orca output exceeded the adapter limit' : 'Orca transport closed before a valid response',
    );
  }
  if (result.timedOut) {
    return mutation
      ? ambiguousMutationError(operation, 'execute', 'Orca did not finish before the deadline')
      : safeProcessError(operation, 'timeout', 'Orca did not finish before the deadline');
  }
  if (result.exitCode !== 0) {
    if (mutation)
      return new OrcaAdapterError(
        'ambiguous_after_possible_commit',
        operation,
        'execute',
        'unrecoverably-ambiguous',
        'Do not retry automatically; inspect the documented public read operation before choosing another mutation.',
        `Orca exited with status ${result.exitCode ?? 'signal'}`,
        result.stderr,
      );
    return new OrcaAdapterError(
      'process_exit',
      operation,
      'execute',
      mutation ? 'readback-required' : 'safe',
      'Inspect Orca state and use the documented recovery operation.',
      `Orca exited with status ${result.exitCode ?? 'signal'}`,
      result.stderr.slice(-4096),
    );
  }
  return undefined;
}

function safeProcessError(
  operation: OrcaOrchestrationVerb,
  code: 'timeout' | 'output_limit' | 'process_exit',
  message: string,
): OrcaAdapterError {
  return new OrcaAdapterError(
    code,
    operation,
    'execute',
    'safe',
    'Retry the read-only operation when Orca is healthy.',
    message,
  );
}

function createAdapter(options: OrcaAdapterTestOptions = {}): OrcaOrchestrationAdapter {
  const env = Object.freeze({ ...(options.env ?? process.env) });
  const executable = resolveOrcaExecutable({
    platform: options.platform,
    managedTerminal: options.managedTerminal ?? env.TERM_PROGRAM === 'Orca',
  });
  const executor = options.executor ?? spawnOrcaProcess;
  const defaultTimeout = options.timeoutMs ?? DEFAULT_ORCA_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  const invoke = async (operation: ValidatedOrcaOperation): Promise<OrcaJsonEnvelope> => {
    const argv = buildOrcaOrchestrationArgv(operation);
    let result: OrcaProcessResult;
    try {
      result = await executor({
        executable,
        argv,
        shell: false,
        timeoutMs: defaultTimeout,
        maxStdoutBytes: MAX_ORCA_STDOUT_BYTES,
        maxStderrBytes: MAX_ORCA_STDERR_BYTES,
        env,
      });
    } catch (error) {
      throw new OrcaAdapterError(
        'executable_unavailable',
        operation.operation,
        'resolve',
        'safe',
        'Verify that the deterministic Orca executable is installed and available, then retry.',
        error instanceof Error && 'code' in error
          ? `Orca execution failed (${String(error.code)})`
          : 'Orca execution failed',
      );
    }
    result = { ...result, stderr: sanitizeStderr(result.stderr, operation, env) };
    const isMutation = mutationVerbs.has(operation.operation) || hasAcknowledgement(operation.operation, operation);
    const failure = processFailure(operation.operation, operation, result);
    if (failure !== undefined) throw failure;
    const envelope = parseEnvelope(operation.operation, result.stdout, isMutation);
    if (!envelope.ok) {
      const message = sanitizeDiagnosticText(
        envelope.error?.message ?? 'Orca returned an error envelope',
        operation,
        env,
      );
      if (isMutation) throw ambiguousMutationError(operation.operation, 'decode', message);
      throw new OrcaAdapterError(
        'unexpected_response',
        operation.operation,
        'decode',
        isMutation ? 'readback-required' : 'safe',
        'Follow the public Orca diagnostic and inspect state before retrying.',
        message,
      );
    }
    return envelope;
  };
  return Object.freeze({
    executable,
    async execute(input: unknown): Promise<OrcaAdapterResponse> {
      const parsed = orcaOperationSchema.safeParse(input);
      if (!parsed.success) {
        buildOrcaOrchestrationArgv(input);
        throw new Error('unreachable');
      }
      const operation = parsed.data as ValidatedOrcaOperation;
      const startedAt = now().toISOString();
      const envelope = await invoke(operation);
      if (!mutationVerbs.has(operation.operation) && !hasAcknowledgement(operation.operation, operation))
        return envelope;
      return finalizeMutation(operation, envelope, startedAt, invoke, now, env);
    },
  });
}

async function finalizeMutation(
  operation: ValidatedOrcaOperation,
  envelope: OrcaJsonEnvelope,
  startedAt: string,
  invoke: (operation: ValidatedOrcaOperation) => Promise<OrcaJsonEnvelope>,
  now: () => Date,
  env: Readonly<Record<string, string | undefined>>,
): Promise<OrcaAdapterResponse> {
  validateMutationReceipt(operation, envelope);
  const plan = readbackPlan(operation, envelope.result);
  if (plan !== undefined) {
    let readback: OrcaJsonEnvelope;
    try {
      readback = await invoke(plan.operation);
    } catch (error) {
      throw mapReadbackFailure(operation, plan.operation.operation, error, env);
    }
    if (!plan.matches(readback.result)) {
      throw new OrcaAdapterError(
        'readback_mismatch',
        operation.operation,
        'readback',
        'unsafe',
        `Inspect state with orchestration ${plan.operation.operation}; do not retry the mutation automatically.`,
        `${plan.operation.operation} disagreed with the mutation receipt`,
      );
    }
  }
  const meta = envelope._meta as Record<string, unknown>;
  const receipt: OrcaMutationReceipt = Object.freeze({
    verb: operation.operation,
    ids: receiptIds(operation.operation, envelope.result),
    runtimeId: meta.runtimeId as string,
    runtimeVersion: meta.runtimeVersion as string,
    startedAt,
    completedAt: now().toISOString(),
    readbackVerb: plan?.operation.operation ?? null,
  });
  return Object.freeze({ ...envelope, receipt });
}

function mapReadbackFailure(
  mutation: ValidatedOrcaOperation,
  readback: OrcaOrchestrationVerb,
  error: unknown,
  env: Readonly<Record<string, string | undefined>>,
): OrcaAdapterError {
  if (!(error instanceof OrcaAdapterError)) {
    return new OrcaAdapterError(
      'unexpected_response',
      mutation.operation,
      'readback',
      'unrecoverably-ambiguous',
      `Inspect state with orchestration ${readback}; do not retry the mutation automatically.`,
      `${readback} failed after Orca returned a valid mutation receipt`,
    );
  }
  return new OrcaAdapterError(
    error.code,
    mutation.operation,
    'readback',
    'readback-required',
    `Repeat or inspect orchestration ${readback}; do not retry the mutation automatically.`,
    sanitizeDiagnosticText(
      `${readback} failed after Orca returned a valid mutation receipt: ${error.message}`,
      mutation,
      env,
    ),
    error.stderr,
  );
}

function validateMutationReceipt(operation: ValidatedOrcaOperation, envelope: OrcaJsonEnvelope): void {
  if (envelope._meta?.runtimeId === undefined || envelope._meta.runtimeVersion === undefined) {
    throw ambiguousMutationError(
      operation.operation,
      'receipt',
      'mutation receipt omitted bounded runtime identity/version metadata',
    );
  }
  if (!receiptMatchesRequest(operation, envelope.result)) {
    throw new OrcaAdapterError(
      'readback_mismatch',
      operation.operation,
      'receipt',
      'unsafe',
      'Inspect the requested entity with its documented public read operation; do not retry automatically.',
      'mutation receipt identity disagreed with the requested entity',
    );
  }
  if (
    operation.operation === 'check' &&
    operation.ack !== undefined &&
    recordOf(envelope.result).acknowledged !== true
  ) {
    throw ambiguousMutationError(
      operation.operation,
      'receipt',
      'check --ack success did not contain its matching delivery identifier',
    );
  }
  if (
    operation.operation === 'run-use' &&
    recordOf(envelope.result).coordinatorTerminalHandle !== envelope._meta.invokingTerminal
  ) {
    throw new OrcaAdapterError(
      'readback_mismatch',
      operation.operation,
      'readback',
      'unsafe',
      'Inspect orchestration run-current; do not retry run-use automatically.',
      'run-use terminal binding was not runtime-attested',
    );
  }
}

function receiptMatchesRequest(operation: ValidatedOrcaOperation, result: unknown): boolean {
  const value = recordOf(result);
  switch (operation.operation) {
    case 'run-use':
      return value.runId === operation.id;
    case 'task-update':
      return value.taskId === operation.id;
    case 'worker-start':
      return value.taskId === operation.task;
    case 'worker-release':
      return value.dispatchId === operation.dispatch;
    case 'reply':
      return value.messageId === operation.id;
    case 'ask':
      return operation.resume === undefined || value.messageId === operation.resume;
    case 'check':
      return operation.ack === undefined || value.deliveryId === operation.ack;
    case 'gate-create':
      return value.taskId === operation.task;
    case 'gate-resolve':
      return value.gateId === operation.id && value.taskId === operation.task;
    default:
      return true;
  }
}

function sanitizeStderr(
  stderr: string,
  operation: ValidatedOrcaOperation,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return sanitizeDiagnosticText(stderr, operation, env);
}

function sanitizeDiagnosticText(
  text: string,
  operation: ValidatedOrcaOperation,
  env: Readonly<Record<string, string | undefined>>,
): string {
  let safe = [...text]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127 && code < 128) || code > 159;
    })
    .join('');
  const requestValues = collectStringValues(operation);
  const secrets = Object.entries(env)
    .filter(
      ([key, value]) => value !== undefined && /(?:TOKEN|SECRET|PASSWORD|PASS|KEY|CREDENTIAL|AUTH|COOKIE)/i.test(key),
    )
    .map(([, value]) => value as string);
  const connectionCredentials = Object.values(env).flatMap((value) =>
    value === undefined ? [] : credentialValuesFromUrl(value),
  );
  for (const value of [...requestValues, ...secrets, ...connectionCredentials]
    .filter((candidate) => candidate.length >= 3)
    .sort((a, b) => b.length - a.length)) {
    safe = safe.split(value).join('[REDACTED]');
  }
  const bytes = Buffer.from(safe, 'utf8');
  return bytes.length <= 4096
    ? safe
    : Buffer.concat([Buffer.from('[truncated] '), bytes.subarray(bytes.length - 4084)]).toString('utf8');
}

function credentialValuesFromUrl(value: string): string[] {
  try {
    const url = new URL(value);
    if (url.password.length === 0) return [];
    try {
      return [url.password, decodeURIComponent(url.password)];
    } catch {
      return [url.password];
    }
  } catch {
    return [];
  }
}

function collectStringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStringValues);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(collectStringValues);
  return [];
}

export function createOrcaOrchestrationAdapter(): OrcaOrchestrationAdapter {
  return createAdapter();
}

/** Test-only dependency seam. Production callers must use createOrcaOrchestrationAdapter. */
export const __orcaAdapterTestOnly = Object.freeze({ createAdapter, spawnOrcaProcess });
