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

const executableToken = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !/[\s;&|`$<>\r\n\0]/.test(value))
  .refine((value) => !value.includes('..'));

export function resolveOrcaExecutable(
  options: {
    platform?: NodeJS.Platform;
    env?: Readonly<Record<string, string | undefined>>;
    managedTerminal?: boolean;
  } = {},
): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (env.ORCA_CLI_COMMAND !== undefined) {
    const parsed = executableToken.safeParse(env.ORCA_CLI_COMMAND);
    if (!parsed.success) {
      throw new OrcaAdapterError(
        'unsupported_environment',
        'runtime',
        'resolve',
        'safe',
        'Provide ORCA_CLI_COMMAND as one executable token without flags.',
        'ORCA_CLI_COMMAND is not a safe executable token',
      );
    }
    return parsed.data;
  }
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
}

export type OrcaProcessExecutor = (request: OrcaProcessRequest) => Promise<OrcaProcessResult>;

export const DEFAULT_ORCA_TIMEOUT_MS = 30_000;
export const MAX_ORCA_STDOUT_BYTES = 1_048_576;
export const MAX_ORCA_STDERR_BYTES = 65_536;

export const spawnOrcaProcess: OrcaProcessExecutor = async (request) =>
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
    const stop = () => child.kill('SIGTERM');
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
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        outputLimited,
      });
    });
  });

const envelopeSchema = z
  .object({
    id: z.string().min(1).max(256),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z
      .object({ code: z.string().min(1).max(128), message: z.string().min(1).max(4096) })
      .passthrough()
      .optional(),
    _meta: z.record(z.unknown()).optional(),
  })
  .strict()
  .refine((value) => (value.ok ? value.result !== undefined && value.error === undefined : value.error !== undefined));

export type OrcaJsonEnvelope = z.infer<typeof envelopeSchema>;

function parseEnvelope(operation: OrcaOrchestrationVerb, stdout: string): OrcaJsonEnvelope {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout);
  } catch {
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
    throw new OrcaAdapterError(
      'unexpected_response',
      operation,
      'decode',
      'safe',
      'Use a compatible Orca CLI version.',
      'stdout did not match the Orca envelope contract',
    );
  }
  return parsed.data;
}

export interface OrcaAdapterOptions {
  executor?: OrcaProcessExecutor;
  executable?: string;
  env?: Readonly<Record<string, string | undefined>>;
  managedTerminal?: boolean;
  timeoutMs?: number;
}

export interface OrcaOrchestrationAdapter {
  readonly executable: string;
  execute(input: unknown): Promise<OrcaJsonEnvelope>;
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

function processFailure(
  operation: OrcaOrchestrationVerb,
  input: unknown,
  result: OrcaProcessResult,
): OrcaAdapterError | undefined {
  const acknowledgement = hasAcknowledgement(operation, input);
  const mutation = mutationVerbs.has(operation) || acknowledgement;
  if (result.outputLimited) {
    return new OrcaAdapterError(
      'output_limit',
      operation,
      'execute',
      mutation ? 'readback-required' : 'safe',
      'Inspect state with the documented read operation before retrying.',
      'Orca output exceeded the adapter limit',
    );
  }
  if (result.timedOut) {
    return new OrcaAdapterError(
      acknowledgement ? 'ambiguous_after_possible_commit' : 'timeout',
      operation,
      'execute',
      acknowledgement ? 'unrecoverably-ambiguous' : mutation ? 'readback-required' : 'safe',
      acknowledgement
        ? 'Do not acknowledge again automatically; only external confirmation can establish whether it committed.'
        : 'Use the documented public readback before retrying a mutation.',
      'Orca did not finish before the deadline',
    );
  }
  if (result.exitCode !== 0) {
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

export function createOrcaOrchestrationAdapter(options: OrcaAdapterOptions = {}): OrcaOrchestrationAdapter {
  const env = Object.freeze({ ...(options.env ?? process.env) });
  const executable =
    options.executable ??
    resolveOrcaExecutable({ env, managedTerminal: options.managedTerminal ?? env.TERM_PROGRAM === 'Orca' });
  const executor = options.executor ?? spawnOrcaProcess;
  const defaultTimeout = options.timeoutMs ?? DEFAULT_ORCA_TIMEOUT_MS;
  return Object.freeze({
    executable,
    async execute(input: unknown): Promise<OrcaJsonEnvelope> {
      const argv = buildOrcaOrchestrationArgv(input);
      const operation = argv[1] as OrcaOrchestrationVerb;
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
          operation,
          'execute',
          'safe',
          `Verify that ${executable} is installed and available to the plugin host.`,
          error instanceof Error ? error.message : 'failed to launch Orca',
        );
      }
      const failure = processFailure(operation, input, result);
      if (failure !== undefined) throw failure;
      const envelope = parseEnvelope(operation, result.stdout);
      if (!envelope.ok) {
        const isMutation = mutationVerbs.has(operation) || hasAcknowledgement(operation, input);
        throw new OrcaAdapterError(
          'unexpected_response',
          operation,
          'decode',
          isMutation ? 'readback-required' : 'safe',
          'Follow the public Orca diagnostic and inspect state before retrying.',
          envelope.error?.message ?? 'Orca returned an error envelope',
        );
      }
      return envelope;
    },
  });
}
