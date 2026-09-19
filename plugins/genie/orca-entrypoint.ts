import type { OrcaAdapterResponse, OrcaOrchestrationAdapter } from '../../src/lib/orca-orchestration-adapter';
import { type OrcaPluginRuntime, createOrcaPluginRuntime } from './orca-runtime';

/**
 * The genie verbs Orca's palette and keybindings expose, in manifest order.
 *
 * Six carry a slash verb and are delivered into the workspace's agent terminal
 * (or to a supervised worker started on a fresh Run when there is none). The two
 * with `verb: null` have no slash command — group 5 replaces their stubs with
 * the genie-binary handlers RF6 names, and they are declared from this group so
 * the contributed command set never changes shape again.
 */
export interface GeniePaletteCommand {
  readonly id: string;
  readonly title: string;
  readonly verb: string | null;
}

export const GENIE_PALETTE_COMMANDS: readonly GeniePaletteCommand[] = Object.freeze([
  Object.freeze({ id: 'genie.wish', title: 'Genie: Wish', verb: 'wish' }),
  Object.freeze({ id: 'genie.work', title: 'Genie: Work', verb: 'work' }),
  Object.freeze({ id: 'genie.review', title: 'Genie: Review', verb: 'review' }),
  Object.freeze({ id: 'genie.fix', title: 'Genie: Fix', verb: 'fix' }),
  Object.freeze({ id: 'genie.report', title: 'Genie: Report', verb: 'report' }),
  Object.freeze({ id: 'genie.council', title: 'Genie: Council', verb: 'council' }),
  Object.freeze({ id: 'genie.doctor', title: 'Genie: Doctor', verb: null }),
  Object.freeze({ id: 'genie.update', title: 'Genie: Update', verb: null }),
]);

/**
 * Mirrors the closed `agent` enum of `src/lib/orca-orchestration-adapter.ts`,
 * which is not exported. A workspace Orca created with anything outside it
 * starts its supervised worker under `claude` rather than failing validation.
 */
export const GENIE_WORKER_AGENTS = Object.freeze([
  'claude',
  'codex',
  'cursor',
  'droid',
  'gemini',
  'grok',
  'opencode',
] as const);

export type GenieWorkerAgent = (typeof GENIE_WORKER_AGENTS)[number];

/**
 * `activate(ctx)`'s host bridge, read from Orca 1.4.205's own
 * `out/main/plugin-host-entry.js`: `call(method, params)` resolves with the
 * host's `value` and REJECTS with an `Error` carrying `code` when the host
 * answers `ok: false`. A host that instead resolves an `{ok: false, code}`
 * envelope is treated as the same refusal, so a handler never reads a refusal
 * as a result.
 */
export interface OrcaPluginHost {
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface OrcaPluginActivationContext {
  commands: {
    register(commandId: string, handler: (args?: unknown) => Promise<unknown>): void;
  };
  host?: OrcaPluginHost;
  log?: (message: string) => void;
}

/** Test and group-5 seams: whatever is supplied here wins over `activate`'s own context. */
export interface OrcaPluginHostOverrides {
  readonly host?: OrcaPluginHost;
  readonly log?: (message: string) => void;
}

export type GenieCommandResult =
  | { readonly ok: true; readonly mode: 'sent'; readonly terminalId: string }
  | { readonly ok: true; readonly mode: 'started'; readonly runId: string; readonly dispatchId: string }
  | { readonly ok: false; readonly reason: 'no-active-workspace' | 'ambiguous-start' | 'not-yet-available' }
  | { readonly ok: false; readonly reason: 'error'; readonly code: string };

export interface GenieWorkspace {
  readonly id: string;
  readonly path: string;
  readonly branch: string | null;
  readonly displayName: string;
  readonly linkedIssue: number | string | null;
  readonly createdWithAgent: string | null;
}

export interface GenieTerminal {
  readonly handle: string;
  readonly agentIdentity?: string | null;
  readonly connected?: boolean;
  readonly writable?: boolean;
  readonly lastOutputAt?: number | null;
}

export interface ChosenAgentTerminal {
  readonly terminal: GenieTerminal;
  /**
   * The `workspace.readContext` spelling of the id. `terminal.sendText` is
   * bound to ids the host itself issued, and the CLI's handle may be spelled
   * with a `term_` prefix the host does not use (design risk 1).
   */
  readonly terminalId: string;
  readonly match: 'exact' | 'prefix-stripped';
}

/** The workspace selector every palette handler addresses: the one the host just resolved. */
const ACTIVE_WORKSPACE = 'active';
const NOTIFICATION_TITLE = 'Genie';
const MAX_NOTIFICATION_BODY = 300;
/** `worker-start` carries its own bound; the two reads use the adapter's 8 s default. */
const WORKER_START_TIMEOUT_MS = 15_000;
/** The adapter's `title` domain is 512 UTF-8 bytes; a 512-byte display name would overflow it. */
const MAX_WORKER_TITLE_BYTES = 512;
const TERMINAL_HANDLE_PREFIX = 'term_';

const encoder = new TextEncoder();

class GenieHostRefusal extends Error {
  readonly name = 'GenieHostRefusal';

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function booleanOf(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function resultOf(response: OrcaAdapterResponse): Record<string, unknown> {
  return recordOf(response.result);
}

/** `OrcaAdapterError.code` and the host's own rejected `Error.code` are both own properties. */
function errorCode(error: unknown): string {
  return textOf(recordOf(error).code) ?? 'unknown';
}

function boundText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function boundBytes(value: string, maxBytes: number): string {
  if (encoder.encode(value).length <= maxBytes) return value;
  let kept = '';
  for (const character of value) {
    if (encoder.encode(kept + character).length > maxBytes) break;
    kept += character;
  }
  return kept;
}

/** Orca's text domains require NFC; a display name that is not normalized would be refused. */
function normalized(value: string): string {
  return value.normalize('NFC');
}

function refusalOf(value: unknown): GenieHostRefusal | undefined {
  const record = recordOf(value);
  if (record.ok !== false) return undefined;
  const code = textOf(record.code) ?? 'host_call_failed';
  return new GenieHostRefusal(code, textOf(record.error) ?? `the Orca host refused the call (${code})`);
}

async function hostCall(
  host: OrcaPluginHost | undefined,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (host === undefined) {
    throw new GenieHostRefusal('host_unavailable', `the Orca host API is unavailable for ${method}`);
  }
  const value = await host.call(method, params);
  const refusal = refusalOf(value);
  if (refusal !== undefined) throw refusal;
  return value;
}

interface HandlerDeps {
  readonly runtime: OrcaPluginRuntime;
  readonly host: OrcaPluginHost | undefined;
  readonly log: (message: string) => void;
}

/** The one place a handler talks to the operator. It absorbs its own failure: a host that will not show a notification must not turn into a rejected command. */
async function notify(deps: HandlerDeps, body: string): Promise<void> {
  try {
    await hostCall(deps.host, 'notifications.show', {
      title: NOTIFICATION_TITLE,
      body: boundText(body, MAX_NOTIFICATION_BODY),
    });
  } catch (error) {
    deps.log(`genie: notification refused (${errorCode(error)})`);
  }
}

function recency(terminal: GenieTerminal): number {
  return typeof terminal.lastOutputAt === 'number' ? terminal.lastOutputAt : Number.NEGATIVE_INFINITY;
}

function stripTerminalPrefix(value: string): string {
  return value.startsWith(TERMINAL_HANDLE_PREFIX) ? value.slice(TERMINAL_HANDLE_PREFIX.length) : value;
}

/**
 * The most recently active writable, connected agent terminal whose handle is
 * one the host itself listed — exact spelling first, `term_`-stripped second.
 */
export function chooseAgentTerminal(
  readContextTerminalIds: readonly string[],
  terminals: readonly GenieTerminal[],
): ChosenAgentTerminal | undefined {
  const candidates = terminals.filter(
    (terminal) =>
      textOf(terminal.agentIdentity) !== null && terminal.connected !== false && terminal.writable !== false,
  );
  const exact = new Map(readContextTerminalIds.map((id) => [id, id]));
  const stripped = new Map(readContextTerminalIds.map((id) => [stripTerminalPrefix(id), id]));
  const tier = (match: ChosenAgentTerminal['match']): ChosenAgentTerminal[] =>
    candidates.flatMap((terminal) => {
      const terminalId =
        match === 'exact' ? exact.get(terminal.handle) : stripped.get(stripTerminalPrefix(terminal.handle));
      return terminalId === undefined ? [] : [{ terminal, terminalId, match }];
    });
  const exactMatches = tier('exact');
  const chosen = exactMatches.length > 0 ? exactMatches : tier('prefix-stripped');
  return chosen.reduce<ChosenAgentTerminal | undefined>(
    (best, entry) => (best === undefined || recency(entry.terminal) > recency(best.terminal) ? entry : best),
    undefined,
  );
}

function bareBranch(branch: string | null): string | null {
  const value = textOf(branch);
  if (value === null) return null;
  return value.startsWith('refs/heads/') ? textOf(value.slice('refs/heads/'.length)) : value;
}

function issueNumber(linkedIssue: number | string | null): string | null {
  if (typeof linkedIssue === 'number' && Number.isFinite(linkedIssue)) return String(linkedIssue);
  const raw = textOf(linkedIssue);
  if (raw === null) return null;
  const value = raw.trim().replace(/^#/, '');
  return value.length === 0 || /\s/.test(value) ? null : value;
}

/**
 * `/<verb> — workspace <name>; branch <branch>; issue #<n>; worktree <path>`.
 * A segment whose fact the workspace does not carry is omitted rather than
 * rendered empty: an unlinked workspace has no issue, and a detached one has no
 * branch name to name.
 */
export function composeSlashCommand(verb: string, workspace: GenieWorkspace): string {
  const segments = [`workspace ${workspace.displayName}`];
  const branch = bareBranch(workspace.branch);
  if (branch !== null) segments.push(`branch ${branch}`);
  const issue = issueNumber(workspace.linkedIssue);
  if (issue !== null) segments.push(`issue #${issue}`);
  segments.push(`worktree ${workspace.path}`);
  return normalized(`/${verb} — ${segments.join('; ')}`);
}

function contextTerminalIds(context: unknown): string[] {
  const terminals = recordOf(context).terminals;
  if (!Array.isArray(terminals)) return [];
  return terminals.flatMap((entry) => {
    const id = textOf(recordOf(entry).id);
    return id === null ? [] : [id];
  });
}

async function readWorkspace(deps: HandlerDeps): Promise<GenieWorkspace> {
  const response = await deps.runtime.execute({ operation: 'worktree-show', worktree: ACTIVE_WORKSPACE });
  const record = recordOf(resultOf(response).worktree);
  const linkedIssue = record.linkedIssue;
  return Object.freeze({
    id: textOf(record.id) ?? '',
    path: textOf(record.path) ?? '',
    branch: textOf(record.branch),
    displayName: textOf(record.displayName) ?? 'this workspace',
    linkedIssue: typeof linkedIssue === 'number' ? linkedIssue : textOf(linkedIssue),
    createdWithAgent: textOf(record.createdWithAgent),
  });
}

async function readTerminals(deps: HandlerDeps): Promise<GenieTerminal[]> {
  const response = await deps.runtime.execute({ operation: 'terminal-list', worktree: ACTIVE_WORKSPACE });
  const terminals = resultOf(response).terminals;
  if (!Array.isArray(terminals)) return [];
  return terminals.flatMap((entry) => {
    const record = recordOf(entry);
    const handle = textOf(record.handle);
    if (handle === null) return [];
    return [
      {
        handle,
        agentIdentity: textOf(record.agentIdentity),
        connected: booleanOf(record.connected),
        writable: booleanOf(record.writable),
        lastOutputAt: typeof record.lastOutputAt === 'number' ? record.lastOutputAt : null,
      },
    ];
  });
}

function createdRunId(response: OrcaAdapterResponse): string | undefined {
  const result = resultOf(response);
  return textOf(response.receipt?.ids.runId) ?? textOf(result.runId) ?? textOf(recordOf(result.run).id) ?? undefined;
}

function workerAgent(createdWithAgent: string | null): GenieWorkerAgent {
  return GENIE_WORKER_AGENTS.find((agent) => agent === createdWithAgent) ?? 'claude';
}

/**
 * No agent terminal: create a Run the worker can be started on and hand the
 * composed text to a supervised worker as its spec. `worker-start` is a
 * mutation, so a `timeout` or an ambiguous receipt is reported to the operator
 * and never retried — a second start could double-commit it.
 */
async function startSupervisedWorker(
  deps: HandlerDeps,
  command: GeniePaletteCommand,
  workspace: GenieWorkspace,
  spec: string,
): Promise<GenieCommandResult> {
  const objective = normalized(`${command.title} — ${workspace.displayName}`);
  const created = await deps.runtime.execute({ operation: 'run-create', objective });
  const runId = createdRunId(created);
  if (runId === undefined) {
    throw new GenieHostRefusal('missing_receipt', 'the Orca Run receipt carried no run id');
  }
  const agent = workerAgent(workspace.createdWithAgent);
  let started: OrcaAdapterResponse;
  try {
    started = await deps.runtime.execute({
      operation: 'worker-start',
      spec,
      title: boundBytes(objective, MAX_WORKER_TITLE_BYTES),
      run: runId,
      worktree: `id:${workspace.id}`,
      agent,
      timeoutMs: WORKER_START_TIMEOUT_MS,
    });
  } catch (error) {
    const code = errorCode(error);
    if (code !== 'timeout' && code !== 'ambiguous_after_possible_commit') throw error;
    await notify(deps, `Genie: start requested for ${workspace.displayName}; confirm in Orca before retrying`);
    return { ok: false, reason: 'ambiguous-start' };
  }
  const dispatchId = textOf(started.receipt?.ids.dispatchId) ?? textOf(resultOf(started).dispatchId) ?? '';
  await notify(deps, `Genie: no agent terminal — started ${agent} on ${workspace.displayName} for ${objective}`);
  return { ok: true, mode: 'started', runId, dispatchId };
}

async function runVerb(deps: HandlerDeps, command: GeniePaletteCommand, verb: string): Promise<GenieCommandResult> {
  const context = await hostCall(deps.host, 'workspace.readContext', {});
  if (context === null || context === undefined) {
    await notify(deps, 'Genie: no active workspace');
    return { ok: false, reason: 'no-active-workspace' };
  }
  const workspace = await readWorkspace(deps);
  const terminals = await readTerminals(deps);
  const chosen = chooseAgentTerminal(contextTerminalIds(context), terminals);
  const commandText = composeSlashCommand(verb, workspace);
  if (chosen === undefined) return startSupervisedWorker(deps, command, workspace, commandText);
  deps.log(`genie: ${command.id} chose terminal ${chosen.terminalId} (${chosen.match} handle match)`);
  await hostCall(deps.host, 'terminal.sendText', { terminalId: chosen.terminalId, text: commandText, enter: true });
  await notify(deps, `Genie: sent /${verb} to ${workspace.displayName}`);
  return { ok: true, mode: 'sent', terminalId: chosen.terminalId };
}

/** Every outcome ends in exactly one notification, and nothing is ever thrown into the plugin host. */
async function handleCommand(deps: HandlerDeps, command: GeniePaletteCommand): Promise<GenieCommandResult> {
  if (command.verb === null) {
    await notify(deps, `${command.title} is not yet available in this build`);
    return { ok: false, reason: 'not-yet-available' };
  }
  try {
    return await runVerb(deps, command, command.verb);
  } catch (error) {
    const code = errorCode(error);
    const message = error instanceof Error ? error.message : String(error);
    await notify(deps, `${command.title} failed (${code}): ${message}`);
    return { ok: false, reason: 'error', code };
  }
}

export function createOrcaPluginEntrypoint(
  adapter?: OrcaOrchestrationAdapter,
  hostOverrides?: OrcaPluginHostOverrides,
): (context: OrcaPluginActivationContext) => Promise<void> {
  const runtime = createOrcaPluginRuntime(adapter);
  return async (context) => {
    const deps: HandlerDeps = Object.freeze({
      runtime,
      host: hostOverrides?.host ?? context.host,
      log: hostOverrides?.log ?? context.log ?? (() => undefined),
    });
    for (const command of GENIE_PALETTE_COMMANDS) {
      context.commands.register(command.id, () => handleCommand(deps, command));
    }
  };
}

export default createOrcaPluginEntrypoint();
