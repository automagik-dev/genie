import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ORCA_WORKER_AGENTS,
  type OrcaAdapterResponse,
  type OrcaOrchestrationAdapter,
} from '../../src/lib/orca-orchestration-adapter';
import { type OrcaPluginRuntime, createOrcaPluginRuntime } from './orca-runtime';

/**
 * The genie verbs Orca's palette and keybindings expose, in manifest order.
 *
 * Six carry a slash verb and are delivered into the workspace's agent terminal
 * (or to a supervised worker started on a fresh Run when there is none). The two
 * with `verb: null` have no slash command: they run the genie binary in the
 * worker and notify their result (`GENIE_BINARY_HANDLERS`).
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
export const GENIE_WORKER_AGENTS = ORCA_WORKER_AGENTS;

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

/**
 * `activate(ctx)`'s event bridge, read from the same bundle:
 * `events:{on(e,t){let n=l.get(e)??[];n.push(t),l.set(e,n)}}`. A `deliverEvent`
 * message runs every registered handler for that event name in order, each
 * `await`ed inside its own `try`, and only then acknowledges the event
 * (`for(let t of e)try{await t(r.payload)}catch(e){…log…} a({type:'eventAck',…})`).
 * A handler is therefore never passed an ack, its return value is discarded,
 * and a slow handler holds the ack open — so the handler must be cheap, must
 * absorb its own failures, and must leave no floating promise behind (a
 * rejection OUTSIDE that `try` reaches `process.on('unhandledRejection')`,
 * which sends `fatal` and exits the worker).
 */
export interface OrcaPluginEvents {
  on(event: string, handler: (payload: unknown) => Promise<void> | void): void;
}

export interface OrcaPluginActivationContext {
  commands: {
    register(commandId: string, handler: (args?: unknown) => Promise<unknown>): void;
  };
  events?: OrcaPluginEvents;
  host?: OrcaPluginHost;
  log?: (message: string) => void;
}

/** One child process of the genie binary, bounded and shell-free. */
export interface GenieProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs: number;
}

export interface GenieProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Resolves for any exit code the binary itself chose (`genie doctor --json`
 * exits non-zero while still printing its report) and REJECTS when the process
 * could not run at all — an `ENOENT` rejection is what selects the
 * `~/.local/bin/genie` fallback.
 */
export type GenieSpawn = (request: GenieProcessRequest) => Promise<GenieProcessResult>;

export interface GenieFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type GenieFetch = (url: string, init: { readonly signal: AbortSignal }) => Promise<GenieFetchResponse>;

/** Test and event seams: whatever is supplied here wins over `activate`'s own context. */
export interface OrcaPluginHostOverrides {
  readonly host?: OrcaPluginHost;
  readonly log?: (message: string) => void;
  readonly spawn?: GenieSpawn;
  readonly fetch?: GenieFetch;
  /** The debounce clock. Injected so the 2 s window is provable without waiting 2 s. */
  readonly now?: () => number;
}

export type GenieCommandResult =
  | { readonly ok: true; readonly mode: 'sent'; readonly terminalId: string }
  | { readonly ok: true; readonly mode: 'started'; readonly runId: string; readonly dispatchId: string }
  | {
      readonly ok: false;
      readonly reason: 'no-active-workspace' | 'ambiguous-start' | 'slow-reads' | 'not-yet-available';
    }
  | { readonly ok: false; readonly reason: 'error'; readonly code: string };

/** `genie doctor --json` as the operator sees it: the counts the notification names. */
export interface GenieDoctorResult {
  readonly ok: boolean;
  readonly warn: number;
  readonly fail: number;
}

/** The two release channels genie publishes; `latest.json` is how `stable` is spelled on disk. */
export type GenieReleaseChannel = 'stable' | 'dev';

/** `genie --version` against the manifest of this host's channel. `latest` is absent when the check failed. */
export interface GenieUpdateResult {
  readonly ok: boolean;
  readonly installed: string | null;
  readonly latest?: string;
  /** Which ladder `latest` was read from — a dev host must not be compared against stable. */
  readonly channel?: GenieReleaseChannel;
}

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
/** Orca's `notifications.show` schema bounds `title` to 120 characters (body to 1 000); a longer title is `invalid_params`. */
const MAX_NOTIFICATION_TITLE = 120;
/** `worker-start` carries its own bound; the two reads use the adapter's 8 s default. */
const WORKER_START_TIMEOUT_MS = 15_000;
/** The adapter's `title` domain is 512 UTF-8 bytes; a 512-byte display name would overflow it. */
const MAX_WORKER_TITLE_BYTES = 512;
const TERMINAL_HANDLE_PREFIX = 'term_';

/** The event RF6 rides, and the settled states: everything but `working` (design risk 2). */
const AGENT_STATUS_EVENT = 'agent.status.changed';
const AGENT_STATE_WORKING = 'working';
/**
 * `agent.status.changed` fires per status refresh, so a settling agent can emit
 * a burst. One `worktree-show` per workspace per window bounds the child
 * processes that burst can spawn; the second settle inside it is dropped, and
 * the next event after it reads again.
 */
const SETTLE_READ_WINDOW_MS = 2_000;
/**
 * `<YYYY-MM-DD> genie ` — the fixed prefix of every comment `mirrorTransition`
 * composes (`src/lib/orca-lifecycle-mirror.ts`). A card comment a human wrote,
 * or another tool wrote, is not a genie line and is never toasted.
 */
const GENIE_COMMENT_PREFIX = /^\d{4}-\d{2}-\d{2} genie /;
/**
 * Doctor's path is the once-per-worker probe (8 s) + `worktree-show active`
 * (8 s) + the genie child itself (20 s): a 36 s ceiling against the host's 30 s
 * window, each sub-second on a healthy host. Past 30 s the host rejects the
 * invoke and the notification still arrives; nothing here mutates.
 */
const DOCTOR_TIMEOUT_MS = 20_000;
/**
 * Update spends two child processes (`--version`, `config get updateChannel`)
 * and one request, each bounded by this: a 24 s ceiling against the host's 30 s
 * window, sub-second apiece on a healthy host. Nothing on this path mutates.
 */
const UPDATE_TIMEOUT_MS = 8_000;
const MAX_NAMED_CHECKS = 3;
/** A failure reason rides inside a 300-character notification beside its own prefix. */
const MAX_FAILURE_REASON = 160;
/** `execFile` buffers both streams; `genie doctor --json` is a few kilobytes. */
const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;
const GENIE_BINARY = 'genie';
/** The one non-PATH location genie's own installer writes, tried only on `ENOENT`. */
const GENIE_FALLBACK_BINARY = join(homedir(), '.local', 'bin', 'genie');
/**
 * The release manifests `genie update` reads — `.well-known/<channel>.json` on
 * the release repo's `main` branch, where `stable` is spelled `latest.json`
 * (`manifestUrlForChannel`, `src/genie-commands/update.ts`). This is the
 * plugin's only network egress, and it is declared in the plugin manifest's
 * description and its README.
 *
 * The bundle imports nothing from `update.ts` — that would pull the whole
 * delivery path into an Orca worker — so it asks the installed binary for the
 * same sticky preference `resolveChannel` reads and spells the URL the same way.
 */
const MANIFEST_BASE_URL = 'https://raw.githubusercontent.com/automagik-dev/genie/main/.well-known';

function manifestUrlForChannel(channel: GenieReleaseChannel): string {
  return `${MANIFEST_BASE_URL}/${channel === 'dev' ? 'dev.json' : 'latest.json'}`;
}

const encoder = new TextEncoder();

/**
 * `shell: false` (execFile's default, named here because it is the security
 * property): argv reaches the binary as typed and no operator string is ever
 * parsed by a shell. A non-zero exit resolves — `genie doctor --json` prints
 * its report and exits 1 — while a process that could not start rejects with
 * its `errno` code intact.
 */
const defaultSpawn: GenieSpawn = (request) =>
  new Promise((resolve, reject) => {
    execFile(
      request.command,
      [...request.args],
      {
        cwd: request.cwd,
        timeout: request.timeoutMs,
        shell: false,
        maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const code = recordOf(error).code;
        if (typeof code === 'number') {
          resolve({ code, stdout, stderr });
          return;
        }
        reject(error);
      },
    );
  });

const defaultFetch: GenieFetch = async (url, init) => {
  const request = (globalThis as { fetch?: typeof globalThis.fetch }).fetch;
  if (request === undefined) {
    throw new GenieHostRefusal('fetch_unavailable', 'this Orca host runtime exposes no global fetch');
  }
  return request(url, init);
};

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

/**
 * C0, DEL and C1. Every one of them is a SUBMIT hazard, not a cosmetic one: the
 * composed slash command reaches `terminal.sendText` with `enter: true`, so a
 * newline inside an interpolated fact is a second line typed into another
 * agent's terminal — and a workspace display name is an agent-facing value
 * (`orca worktree create --name`), never a fact genie authored.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them IS the point — this class is the sanitizer's input domain, not an accidental escape.
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * One line, made safe to type into a terminal: control characters become
 * spaces, runs of whitespace (which `\s` already spans to U+2028/U+2029)
 * collapse to one, and the result is trimmed. Spaces and unicode are otherwise
 * untouched — a worktree path legitimately carries both.
 */
function sanitizedLine(value: string): string {
  return value.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * One interpolated segment. `null` when nothing survives sanitization, so a
 * display name made only of control characters is omitted rather than rendered
 * as an empty fact.
 */
function sanitizedSegment(value: string | null): string | null {
  if (value === null) return null;
  const cleaned = sanitizedLine(value);
  return cleaned.length === 0 ? null : cleaned;
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
  readonly spawn: GenieSpawn;
  readonly fetch: GenieFetch;
  readonly now: () => number;
}

/** The one place a handler talks to the operator. It absorbs its own failure: a host that will not show a notification must not turn into a rejected command. */
async function notify(deps: HandlerDeps, body: string, title: string = NOTIFICATION_TITLE): Promise<void> {
  try {
    // Sanitized for the same reason as the slash command: a display name and a
    // card comment both reach this, and a toast whose body carries newlines can
    // be made to read as two notifications.
    await hostCall(deps.host, 'notifications.show', {
      title: boundText(sanitizedLine(title), MAX_NOTIFICATION_TITLE),
      body: boundText(sanitizedLine(body), MAX_NOTIFICATION_BODY),
    });
  } catch (error) {
    deps.log(`genie: notification refused (${errorCode(error)})`);
  }
}

/** A failure the operator reads inside one notification: the message, never a stack. */
function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return boundText(message.replace(/\s+/g, ' ').trim(), MAX_FAILURE_REASON);
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
 *
 * The workspace record is Orca's data, not genie's, and the composed text is
 * SUBMITTED (`enter: true`): a display name, branch or path carrying a newline
 * or an escape sequence would otherwise reach the agent terminal as keystrokes
 * — a second command, or an ANSI sequence the TUI interprets. Every
 * interpolated fact therefore passes through `sanitizedSegment` first and the
 * whole line through `sanitizedLine` after, so the result is exactly ONE line
 * of printable text whatever the record carries. A control character becomes a
 * SPACE rather than vanishing, because dropping it silently joins two tokens
 * into a word the record never held.
 */
export function composeSlashCommand(verb: string, workspace: GenieWorkspace): string {
  const segments = [`workspace ${sanitizedSegment(workspace.displayName) ?? 'this workspace'}`];
  const branch = sanitizedSegment(bareBranch(workspace.branch));
  if (branch !== null) segments.push(`branch ${branch}`);
  const issue = issueNumber(workspace.linkedIssue);
  if (issue !== null) segments.push(`issue #${issue}`);
  const path = sanitizedSegment(workspace.path);
  if (path !== null) segments.push(`worktree ${path}`);
  return normalized(sanitizedLine(`/${verb} — ${segments.join('; ')}`));
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
  const objective = normalized(sanitizedLine(`${command.title} — ${workspace.displayName}`));
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
    const detail = error instanceof Error ? error.message : String(error);
    await notify(
      deps,
      `Genie: start requested for ${workspace.displayName}; confirm in Orca before retrying (${detail})`,
    );
    return { ok: false, reason: 'ambiguous-start' };
  }
  const dispatchId = textOf(started.receipt?.ids.dispatchId) ?? textOf(resultOf(started).dispatchId) ?? '';
  await notify(deps, `Genie: no agent terminal — started ${agent} on ${workspace.displayName} for ${objective}`);
  return { ok: true, mode: 'started', runId, dispatchId };
}

/**
 * The host rejects a plugin command after 30 s. The read phase (readContext,
 * `worktree-show`, `terminal-list`, plus the once-per-worker probe) may spend
 * up to 24 s of it, and the start path then issues a mutation whose ceiling is
 * another 36 s (`run-create` + read-back, `worker-start` at 15 s + read-back).
 * A deadline may fire only BEFORE the mutation: past this point the handler
 * reports and returns instead of starting a worker it could not wait for.
 */
const READ_PHASE_DEADLINE_MS = 20_000;
/** `terminal.sendText.text` is bounded to 4 096 characters by the host schema. */
const MAX_SEND_TEXT_CHARS = 4_096;

async function runVerb(deps: HandlerDeps, command: GeniePaletteCommand, verb: string): Promise<GenieCommandResult> {
  const startedAt = deps.now();
  const context = await hostCall(deps.host, 'workspace.readContext', {});
  if (context === null || context === undefined) {
    await notify(deps, 'Genie: no active workspace');
    return { ok: false, reason: 'no-active-workspace' };
  }
  const workspace = await readWorkspace(deps);
  const terminals = await readTerminals(deps);
  const chosen = chooseAgentTerminal(contextTerminalIds(context), terminals);
  const commandText = composeSlashCommand(verb, workspace);
  if (chosen === undefined) {
    if (deps.now() - startedAt > READ_PHASE_DEADLINE_MS) {
      await notify(deps, `Genie: Orca answered too slowly to start a worker on ${workspace.displayName} safely; retry`);
      return { ok: false, reason: 'slow-reads' };
    }
    return startSupervisedWorker(deps, command, workspace, commandText);
  }
  deps.log(`genie: ${command.id} chose terminal ${chosen.terminalId} (${chosen.match} handle match)`);
  await hostCall(deps.host, 'terminal.sendText', {
    terminalId: chosen.terminalId,
    text: boundText(commandText, MAX_SEND_TEXT_CHARS),
    enter: true,
  });
  await notify(deps, `Genie: sent /${verb} to ${workspace.displayName}`);
  return { ok: true, mode: 'sent', terminalId: chosen.terminalId };
}

/**
 * `genie` from PATH first, `~/.local/bin/genie` second — and only when the
 * first attempt proves the binary is not there. The plugin worker is forked by
 * Orca's main process, so it inherits the desktop app's PATH rather than a
 * login shell's, and a genie installed by its own installer is frequently
 * outside it. Any other spawn failure is the operator's to see, not a reason
 * to run a second process.
 */
async function runGenieBinary(
  deps: HandlerDeps,
  args: readonly string[],
  timeoutMs: number,
  cwd?: string,
): Promise<GenieProcessResult> {
  try {
    return await deps.spawn({ command: GENIE_BINARY, args, cwd, timeoutMs });
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    deps.log(`genie: "${GENIE_BINARY}" is not on the plugin worker's PATH; trying ${GENIE_FALLBACK_BINARY}`);
    return deps.spawn({ command: GENIE_FALLBACK_BINARY, args, cwd, timeoutMs });
  }
}

function parsedJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} printed no JSON`);
  }
}

interface DoctorSummary extends GenieDoctorResult {
  /** The warn and fail checks, in report order — the same set the counts describe. */
  readonly flagged: readonly string[];
}

/**
 * `{ok, checks:[{name, status, detail}]}`. Only `warn` and `fail` are counted
 * AND named: a check with any other non-pass status is outside the counts, and
 * naming it beside them would make one line disagree with itself.
 */
function summarizeDoctor(payload: unknown): DoctorSummary {
  const record = recordOf(payload);
  const checks = Array.isArray(record.checks) ? record.checks : [];
  const flagged = checks.flatMap((entry) => {
    const check = recordOf(entry);
    const status = textOf(check.status);
    if (status !== 'warn' && status !== 'fail') return [];
    return [{ name: textOf(check.name) ?? 'unnamed check', status }];
  });
  return {
    ok: record.ok === true,
    warn: flagged.filter((check) => check.status === 'warn').length,
    fail: flagged.filter((check) => check.status === 'fail').length,
    flagged: flagged.map((check) => check.name),
  };
}

function doctorBody(summary: DoctorSummary): string {
  if (summary.warn === 0 && summary.fail === 0) return 'Genie doctor: all checks pass';
  const named = summary.flagged.slice(0, MAX_NAMED_CHECKS);
  const remainder = summary.flagged.length - named.length;
  const names = remainder > 0 ? `${named.join('; ')} +${remainder} more` : named.join('; ');
  return `Genie doctor: ${summary.warn} warn, ${summary.fail} fail — ${names}`;
}

/** One read, one child process, one notification. Every failure is the same bounded line. */
async function runDoctor(deps: HandlerDeps): Promise<GenieDoctorResult> {
  try {
    const workspace = await readWorkspace(deps);
    const process = await runGenieBinary(
      deps,
      ['doctor', '--json'],
      DOCTOR_TIMEOUT_MS,
      workspace.path.length > 0 ? workspace.path : undefined,
    );
    const summary = summarizeDoctor(parsedJson(process.stdout, 'genie doctor --json'));
    await notify(deps, doctorBody(summary));
    return { ok: summary.ok, warn: summary.warn, fail: summary.fail };
  } catch (error) {
    await notify(deps, `Genie doctor: could not run (${failureReason(error)})`);
    return { ok: false, warn: 0, fail: 0 };
  }
}

/** The first non-empty line of a genie child's stdout; both verbs below print exactly one. */
function firstLine(stdout: string): string | null {
  const line = stdout
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line === undefined ? null : line;
}

/** The first line without the tag's `v`: `genie --version` prints the bare version. */
function versionText(stdout: string): string | null {
  const line = firstLine(stdout);
  return line === null ? null : line.replace(/^v/, '');
}

/**
 * The channel this host updates on, read through the CLI rather than guessed:
 * `genie config get updateChannel` prints the resolved token bare — `dev` (which
 * the legacy `next` alias transforms to) or `latest` (the schema default, and
 * what the retired `homolog` transforms to).
 *
 * Every other answer resolves to stable: a binary too old to carry the `config`
 * verb exits non-zero, an unreadable config resolves to the schema default, and
 * a token this build does not know is not a channel to point an operator at.
 * That is the direction `resolveChannel` falls back in too (`update.ts`), and it
 * is the conservative one — never subscribe a host to dev builds it never chose.
 */
async function readUpdateChannel(deps: HandlerDeps): Promise<GenieReleaseChannel> {
  try {
    const process = await runGenieBinary(deps, ['config', 'get', 'updateChannel'], UPDATE_TIMEOUT_MS);
    if (process.code !== 0) return 'stable';
    return firstLine(process.stdout) === 'dev' ? 'dev' : 'stable';
  } catch {
    return 'stable';
  }
}

async function readLatestVersion(deps: HandlerDeps, channel: GenieReleaseChannel): Promise<string> {
  const response = await deps.fetch(manifestUrlForChannel(channel), {
    signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`the ${channel} release manifest answered HTTP ${response.status}`);
  const version = textOf(recordOf(await response.json()).version);
  if (version === null) throw new Error(`the ${channel} release manifest carries no version`);
  return version.trim().replace(/^v/, '');
}

/**
 * Inequality of the two normalized strings is the whole comparison: this is a
 * notification, not the update gate. `genie update` owns the real precedence
 * rules (`compareGenieVersions`), and importing them would pull the whole
 * update command into a plugin bundle to answer a question whose wrong answer
 * costs one extra toast.
 */
async function runUpdate(deps: HandlerDeps): Promise<GenieUpdateResult> {
  let installed: string | null = null;
  try {
    const process = await runGenieBinary(deps, ['--version'], UPDATE_TIMEOUT_MS);
    installed = versionText(process.stdout);
    if (installed === null) throw new Error(`${GENIE_BINARY} --version printed no version`);
    // The channel comes first: comparing a dev host against the stable ladder
    // reports every newer dev build it already runs as an available update, and
    // reports nothing when a dev build actually is waiting.
    const channel = await readUpdateChannel(deps);
    const latest = await readLatestVersion(deps, channel);
    await notify(
      deps,
      latest === installed
        ? `Genie is up to date (${installed}, ${channel} channel)`
        : `Genie update available: ${latest} (installed ${installed}, ${channel} channel) — run genie update`,
    );
    return { ok: true, installed, latest, channel };
  } catch (error) {
    await notify(deps, `Genie update: could not check (${failureReason(error)})`);
    return { ok: false, installed };
  }
}

const GENIE_BINARY_HANDLERS: Readonly<
  Record<string, (deps: HandlerDeps) => Promise<GenieDoctorResult | GenieUpdateResult>>
> = Object.freeze({
  'genie.doctor': runDoctor,
  'genie.update': runUpdate,
});

/** Every outcome ends in exactly one notification, and nothing is ever thrown into the plugin host. */
async function handleCommand(
  deps: HandlerDeps,
  command: GeniePaletteCommand,
): Promise<GenieCommandResult | GenieDoctorResult | GenieUpdateResult> {
  const binary = GENIE_BINARY_HANDLERS[command.id];
  if (binary !== undefined) return binary(deps);
  if (command.verb === null) {
    // Unreachable for the eight contributed commands; the guard is what keeps a
    // ninth verbless entry a notification instead of a type error or a crash.
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

/** Per-activation worker memory: the last comment toasted per workspace, and the last read's clock. */
interface SettleState {
  readonly lastComment: Map<string, string>;
  readonly lastReadAt: Map<string, number>;
}

interface SettledWorkspace {
  readonly comment: string | null;
  readonly displayName: string;
}

async function readWorkspaceById(deps: HandlerDeps, worktreeId: string): Promise<SettledWorkspace> {
  // The record's own `id` (`<repoId>::<absolute path>`) is the `id:` selector's
  // argument, so the event's workspace is addressed directly — never `active`,
  // which is whichever workspace the operator is looking at right now.
  const response = await deps.runtime.execute({ operation: 'worktree-show', worktree: `id:${worktreeId}` });
  const record = recordOf(resultOf(response).worktree);
  return { comment: textOf(record.comment), displayName: textOf(record.displayName) ?? 'this workspace' };
}

/**
 * One settled agent → at most one `worktree-show` per workspace per window →
 * at most one notification per NEW genie comment. It resolves on every path,
 * including every failure: Orca logs a rejected handler and keeps going, but a
 * rejection that escaped this function asynchronously would reach the worker's
 * `unhandledRejection` hook and kill the plugin.
 */
async function handleAgentStatusChanged(deps: HandlerDeps, state: SettleState, payload: unknown): Promise<void> {
  try {
    const event = recordOf(payload);
    const worktreeId = textOf(event.worktreeId);
    // `worktreeId` is nullable in the event and the state vocabulary is read
    // from Orca's record schema, not a published contract (design risk 2): an
    // added state settles, costing one read bounded by the window and the dedupe.
    if (worktreeId === null || event.state === AGENT_STATE_WORKING) return;
    const now = deps.now();
    const lastReadAt = state.lastReadAt.get(worktreeId);
    if (lastReadAt !== undefined && now - lastReadAt < SETTLE_READ_WINDOW_MS) return;
    // Stamped BEFORE the read, so a failing read is debounced too: the window
    // bounds child processes, not successes.
    state.lastReadAt.set(worktreeId, now);
    const workspace = await readWorkspaceById(deps, worktreeId);
    const comment = workspace.comment;
    if (comment === null || !GENIE_COMMENT_PREFIX.test(comment)) return;
    if (state.lastComment.get(worktreeId) === comment) return;
    state.lastComment.set(worktreeId, comment);
    await notify(deps, comment, `${NOTIFICATION_TITLE} — ${workspace.displayName}`);
  } catch (error) {
    // Events are frequent and unsolicited; a failed read is a log line, never a toast.
    deps.log(`genie: ${AGENT_STATUS_EVENT} ignored (${errorCode(error)})`);
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
      spawn: hostOverrides?.spawn ?? defaultSpawn,
      fetch: hostOverrides?.fetch ?? defaultFetch,
      now: hostOverrides?.now ?? Date.now,
    });
    for (const command of GENIE_PALETTE_COMMANDS) {
      context.commands.register(command.id, () => handleCommand(deps, command));
    }
    // The dedupe memory is per activation, which is per worker: Orca reaps an
    // idle worker after 300 s, and the next one starts with an empty map and
    // re-toasts the comment it finds — one repeat per reap, never a silence.
    const settled: SettleState = { lastComment: new Map(), lastReadAt: new Map() };
    if (context.events === undefined) {
      deps.log(`genie: this Orca host exposes no events API; ${AGENT_STATUS_EVENT} notifications are off`);
      return;
    }
    context.events.on(AGENT_STATUS_EVENT, (payload) => handleAgentStatusChanged(deps, settled, payload));
  };
}

export default createOrcaPluginEntrypoint();
