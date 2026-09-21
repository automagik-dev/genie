import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mirrorTransition } from '../../src/lib/orca-lifecycle-mirror';
import type { OrcaAdapterResponse, OrcaOrchestrationAdapter } from '../../src/lib/orca-orchestration-adapter';
import { OrcaAdapterError, buildOrcaOrchestrationArgv } from '../../src/lib/orca-orchestration-adapter';
import {
  GENIE_PALETTE_COMMANDS,
  GENIE_WORKER_AGENTS,
  type GenieFetch,
  type GenieProcessRequest,
  type GenieProcessResult,
  type GenieSpawn,
  type GenieTerminal,
  type GenieWorkspace,
  type OrcaPluginHost,
  type OrcaPluginHostOverrides,
  chooseAgentTerminal,
  composeSlashCommand,
  createOrcaPluginEntrypoint,
} from './orca-entrypoint';
import { ORCA_MINIMUM_RUNTIME_VERSION, ORCA_PLUGIN_ADAPTER_TIMEOUT_MS, createOrcaPluginRuntime } from './orca-runtime';

const status = (
  runtimeVersion = ORCA_MINIMUM_RUNTIME_VERSION,
  capabilities: string[] = ['orchestration.contract.v1'],
) => ({
  id: 'local-status',
  ok: true as const,
  result: {
    target: { kind: 'local' as const },
    app: { running: true as const, pid: 123, desktopWindowStatus: 'available' as const },
    runtime: {
      state: 'ready' as const,
      reachable: true as const,
      runtimeId: 'runtime_1',
      appVersion: runtimeVersion,
      remoteUpdateSupport: { installMode: 'manual', automatic: false, reason: 'manual-update' },
      capabilities,
    },
    graph: { state: 'ready' as const },
  },
  _meta: { runtimeId: 'runtime_1' },
});

const envelope = (result: unknown, ids?: Record<string, string>): OrcaAdapterResponse =>
  ({
    id: 'response_1',
    ok: true,
    result,
    _meta: { runtimeId: 'runtime_1' },
    ...(ids === undefined
      ? {}
      : {
          receipt: {
            verb: 'run-create',
            ids,
            runtimeId: 'runtime_1',
            runtimeVersion: ORCA_MINIMUM_RUNTIME_VERSION,
            startedAt: '2026-09-19T00:00:00.000Z',
            completedAt: '2026-09-19T00:00:01.000Z',
            readbackVerb: null,
          },
        }),
  }) as unknown as OrcaAdapterResponse;

const WORKSPACE_PATH = '/home/genie/orca/workspaces/genie/orca-plugin-genie';
const WORKSPACE_ID = `repo_1::${WORKSPACE_PATH}`;
const WORKSPACE_RECORD = {
  id: WORKSPACE_ID,
  path: WORKSPACE_PATH,
  branch: 'refs/heads/namastex888/orca-plugin-genie',
  displayName: 'orca plugin genie',
  comment: null,
  workspaceStatus: 'in-progress',
  createdWithAgent: 'codex',
  linkedIssue: 3005,
};

const agentTerminal = (handle: string, lastOutputAt: number): Record<string, unknown> => ({
  handle,
  worktreeId: WORKSPACE_ID,
  agentIdentity: 'claude',
  connected: true,
  writable: true,
  lastOutputAt,
});

type FakeOperation = Record<string, unknown>;

interface FakeAdapter {
  readonly adapter: OrcaOrchestrationAdapter;
  readonly operations: FakeOperation[];
  statusCalls: number;
}

/** Records every operation the handlers push through, and answers from a per-verb script. */
function fakeAdapter(script: Record<string, (operation: FakeOperation) => unknown> = {}): FakeAdapter {
  const state: FakeAdapter = {
    operations: [],
    statusCalls: 0,
    adapter: {
      executable: 'opaque-to-plugin',
      status: async () => {
        state.statusCalls += 1;
        return status();
      },
      execute: async (input: unknown) => {
        const operation = input as FakeOperation;
        state.operations.push(operation);
        const answer = script[String(operation.operation)];
        const value = answer === undefined ? undefined : answer(operation);
        if (value instanceof Error) throw value;
        return (value ?? envelope({})) as OrcaAdapterResponse;
      },
    },
  };
  return state;
}

interface FakeHost {
  readonly host: OrcaPluginHost;
  readonly calls: { method: string; params: Record<string, unknown> }[];
  readonly notifications: string[];
}

const READ_CONTEXT = {
  branch: 'namastex888/orca-plugin-genie',
  displayName: 'orca plugin genie',
  terminals: [{ id: 'term_agent' }, { id: 'term_plain' }],
};

/** `host.call` rejects when the script answers an `Error`, the way Orca's own worker bridge does. */
function fakeHost(script: Record<string, (params: Record<string, unknown>) => unknown> = {}): FakeHost {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const notifications: string[] = [];
  const defaults: Record<string, (params: Record<string, unknown>) => unknown> = {
    'workspace.readContext': () => READ_CONTEXT,
    'terminal.sendText': () => ({ accepted: true }),
    'notifications.show': () => ({ shown: true }),
  };
  return {
    calls,
    notifications,
    host: {
      call: async (method, params) => {
        calls.push({ method, params });
        if (method === 'notifications.show') notifications.push(String(params.body));
        const answer = script[method] ?? defaults[method];
        const value = answer === undefined ? undefined : answer(params);
        if (value instanceof Error) throw value;
        return value;
      },
    },
  };
}

function hostError(code: string, message = `host refused: ${code}`): Error {
  const error = new Error(message);
  (error as { code?: string }).code = code;
  return error;
}

const adapterError = (code: 'timeout' | 'ambiguous_after_possible_commit' | 'process_exit') =>
  new OrcaAdapterError(code, 'worker-start', 'execute', 'unsafe', 'Inspect Orca before retrying.', `failed: ${code}`);

interface Palette {
  readonly handlers: Map<string, (args?: unknown) => Promise<unknown>>;
  readonly logs: string[];
  /** Delivers one `agent.status.changed` payload the way Orca's worker bridge does. */
  readonly emit: (event: string, payload: unknown) => Promise<void>;
  readonly subscribed: string[];
}

const enoent = (command: string): Error => Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' });

/**
 * No test ever spawns a real binary or opens a real socket: the default seams
 * fail the way an absent genie and an offline host do, so a handler that
 * forgot its seam fails loudly instead of reaching the network.
 */
const offlineSpawn: GenieSpawn = async (request) => {
  throw enoent(request.command);
};
const offlineFetch: GenieFetch = async () => {
  throw new Error('no network in tests');
};

type ActivationSeams = Omit<OrcaPluginHostOverrides, 'host' | 'log'>;

async function activate(
  adapter: OrcaOrchestrationAdapter,
  host: OrcaPluginHost,
  seams: ActivationSeams = {},
): Promise<Palette> {
  const handlers = new Map<string, (args?: unknown) => Promise<unknown>>();
  const logs: string[] = [];
  const subscribed: string[] = [];
  const listeners = new Map<string, ((payload: unknown) => Promise<void> | void)[]>();
  await createOrcaPluginEntrypoint(adapter, { spawn: offlineSpawn, fetch: offlineFetch, ...seams })({
    commands: { register: (id, handler) => handlers.set(id, handler) },
    events: {
      on: (event, handler) => {
        subscribed.push(event);
        listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      },
    },
    host,
    log: (message) => logs.push(message),
  });
  return {
    handlers,
    logs,
    subscribed,
    // Orca awaits each handler inside its own try/catch and then acks; a
    // handler that rejects here would prove the worker-killing shape.
    emit: async (event, payload) => {
      for (const handler of listeners.get(event) ?? []) await handler(payload);
    },
  };
}

async function invoke(palette: Palette, id: string): Promise<unknown> {
  const handler = palette.handlers.get(id);
  if (handler === undefined) throw new Error(`no handler registered for ${id}`);
  return handler();
}

const operationNames = (adapter: FakeAdapter): string[] => adapter.operations.map((entry) => String(entry.operation));

describe('the genie palette manifest', () => {
  test('contributes exactly the eight genie commands with matching worktree keybindings and object capabilities', async () => {
    const manifest = JSON.parse(await readFile(resolve(import.meta.dir, 'orca-plugin.json'), 'utf8'));
    expect(manifest).toMatchObject({
      manifestVersion: 1,
      id: 'genie',
      publisher: 'automagik',
      engines: { orca: `>=${ORCA_MINIMUM_RUNTIME_VERSION}` },
      pluginApi: 1,
      main: 'orca-entrypoint.min.js',
    });

    const commands = manifest.contributes.commands as { id: string; title: string; context: string }[];
    expect(commands).toHaveLength(8);
    expect(commands.map((command) => [command.id, command.title, command.context])).toEqual([
      ['genie.wish', 'Genie: Wish', 'worktree'],
      ['genie.work', 'Genie: Work', 'worktree'],
      ['genie.review', 'Genie: Review', 'worktree'],
      ['genie.fix', 'Genie: Fix', 'worktree'],
      ['genie.report', 'Genie: Report', 'worktree'],
      ['genie.council', 'Genie: Council', 'worktree'],
      ['genie.doctor', 'Genie: Doctor', 'worktree'],
      ['genie.update', 'Genie: Update', 'worktree'],
    ]);
    // The retired run-list entry and its export are gone.
    expect(JSON.stringify(manifest)).not.toContain('run-list');

    const keybindings = manifest.contributes.keybindings as { command: string; key: string; when: string }[];
    expect(keybindings).toHaveLength(8);
    expect(keybindings.map((binding) => binding.key)).toEqual([
      'Ctrl+Alt+Shift+W',
      'Ctrl+Alt+Shift+K',
      'Ctrl+Alt+Shift+R',
      'Ctrl+Alt+Shift+F',
      'Ctrl+Alt+Shift+P',
      'Ctrl+Alt+Shift+L',
      'Ctrl+Alt+Shift+D',
      'Ctrl+Alt+Shift+U',
    ]);
    // Orca's manifest validator rejects a keybinding whose `when` differs from
    // its command's `context`, and any keybinding naming an uncontributed id.
    for (const binding of keybindings) {
      const command = commands.find((entry) => entry.id === binding.command);
      expect(command, binding.command).toBeDefined();
      expect(binding.when).toBe(command?.context as string);
    }
    expect(new Set(keybindings.map((binding) => binding.key)).size).toBe(8);

    // `capabilities` is `f.array(f.object({kind}).strict())`: a bare string
    // element fails validation and the plugin never loads.
    expect(manifest.capabilities).toEqual([
      { kind: 'workspace:read' },
      { kind: 'terminal:send' },
      { kind: 'notifications:show' },
      { kind: 'events:subscribe' },
    ]);
    // RF6's one subscription; `events:subscribe` above is what Orca grants it.
    expect(manifest.contributes.events).toEqual([{ on: 'agent.status.changed' }]);

    expect(GENIE_PALETTE_COMMANDS.map((command) => [command.id, command.title])).toEqual(
      commands.map((command) => [command.id, command.title]),
    );
  });

  test('every agent the start path may name is inside the closed agent domain of the adapter', () => {
    for (const agent of GENIE_WORKER_AGENTS) {
      expect(() => buildOrcaOrchestrationArgv({ operation: 'worker-start', spec: 'spec', agent }), agent).not.toThrow();
    }
    expect(() => buildOrcaOrchestrationArgv({ operation: 'worker-start', spec: 'spec', agent: 'nonesuch' })).toThrow();
  });
});

describe('composeSlashCommand', () => {
  const workspace: GenieWorkspace = {
    id: WORKSPACE_ID,
    path: WORKSPACE_PATH,
    branch: 'refs/heads/namastex888/orca-plugin-genie',
    displayName: 'orca plugin genie',
    linkedIssue: 3005,
    createdWithAgent: 'codex',
  };

  test('names the workspace, the bare branch, the issue and the worktree path', () => {
    expect(composeSlashCommand('review', workspace)).toBe(
      `/review — workspace orca plugin genie; branch namastex888/orca-plugin-genie; issue #3005; worktree ${WORKSPACE_PATH}`,
    );
  });

  test('omits the issue segment when the workspace is unlinked, and the branch when there is none', () => {
    expect(composeSlashCommand('wish', { ...workspace, linkedIssue: null })).toBe(
      `/wish — workspace orca plugin genie; branch namastex888/orca-plugin-genie; worktree ${WORKSPACE_PATH}`,
    );
    expect(composeSlashCommand('wish', { ...workspace, branch: null, linkedIssue: null })).toBe(
      `/wish — workspace orca plugin genie; worktree ${WORKSPACE_PATH}`,
    );
  });

  // The composed text is submitted (`enter: true`), and a display name is an
  // agent-facing value (`orca worktree create --name`): a newline inside one
  // would be a SECOND command typed into another agent's terminal.
  test('a control character in the display name or the path never becomes a second line', () => {
    const injected = composeSlashCommand('review', {
      ...workspace,
      displayName: 'orca\nrm -rf ~\rplugin\tgenie\u001b[2J',
      path: `${WORKSPACE_PATH}\ngit push --force\u007f`,
    });
    expect(injected).toBe(
      `/review — workspace orca rm -rf ~ plugin genie [2J; branch namastex888/orca-plugin-genie; issue #3005; worktree ${WORKSPACE_PATH} git push --force`,
    );
    expect(injected.split('\n')).toHaveLength(1);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the assertion IS that none of them survived.
    expect(/[\u0000-\u001F\u007F-\u009F]/.test(injected)).toBe(false);
  });

  test('a branch, a line separator and a display name of nothing but control characters are all one clean line', () => {
    for (const workspaceUnderTest of [
      { ...workspace, branch: 'refs/heads/feat\u0085injected' },
      { ...workspace, displayName: 'name\u2028\u2029two' },
      { ...workspace, displayName: '\n\t\u0007' },
      { ...workspace, path: '\u0000' },
    ] satisfies GenieWorkspace[]) {
      const composed = composeSlashCommand('work', workspaceUnderTest);
      expect(composed.split('\n'), composed).toHaveLength(1);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the assertion IS that none of them survived.
      expect(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/.test(composed), composed).toBe(false);
    }
    // Nothing survives sanitization: the name falls back, and the path segment
    // is omitted rather than rendered as an empty fact.
    expect(composeSlashCommand('work', { ...workspace, displayName: '\n\t\u0007', path: '\u0000' })).toBe(
      '/work — workspace this workspace; branch namastex888/orca-plugin-genie; issue #3005',
    );
  });

  test('spaces and unicode in a real path are left exactly as Orca reports them', () => {
    const path = '/home/genie/My Worktrees/wish—café/orca plugin';
    expect(composeSlashCommand('fix', { ...workspace, path })).toBe(
      `/fix — workspace orca plugin genie; branch namastex888/orca-plugin-genie; issue #3005; worktree ${path}`,
    );
  });

  /**
   * The branch owner's hostile-record case (2c5e8aec6), kept and re-pinned
   * against the sanitizer this branch settled on: a control character becomes a
   * SPACE rather than vanishing, because dropping it silently joins two tokens
   * into a word the record never held.
   */
  test('control characters in the workspace record never reach the terminal as keystrokes', () => {
    const text = composeSlashCommand('review', {
      ...workspace,
      displayName: 'orca\nplugin\r\u001b[2J genie',
      branch: 'refs/heads/feature\u0007/x',
      path: '/home/genie/orca/work\u0000spaces/genie\u007f',
    });
    expect(text).toBe(
      '/review — workspace orca plugin [2J genie; branch feature /x; issue #3005; worktree /home/genie/orca/work spaces/genie',
    );
    expect([...text].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)).toBe(
      false,
    );
    expect(text.split('\n')).toHaveLength(1);
  });
});

describe('chooseAgentTerminal', () => {
  const terminal = (handle: string, lastOutputAt: number, extra: Partial<GenieTerminal> = {}): GenieTerminal => ({
    handle,
    agentIdentity: 'claude',
    connected: true,
    writable: true,
    lastOutputAt,
    ...extra,
  });

  test('prefers an exact handle match over a more recent prefix-stripped one', () => {
    const chosen = chooseAgentTerminal(['alpha', 'term_beta'], [terminal('term_alpha', 99), terminal('term_beta', 1)]);
    expect(chosen).toMatchObject({ terminalId: 'term_beta', match: 'exact' });
    expect(chosen?.terminal.handle).toBe('term_beta');
  });

  test('matches the `term_`-stripped spelling second and answers with the id the host issued', () => {
    const chosen = chooseAgentTerminal(['alpha', 'beta'], [terminal('term_alpha', 1), terminal('term_beta', 5)]);
    expect(chosen).toMatchObject({ terminalId: 'beta', match: 'prefix-stripped' });
  });

  test('skips terminals with no agent, disconnected, or not writable, and answers undefined with no candidate', () => {
    const ids = ['a', 'b', 'c', 'd'];
    expect(
      chooseAgentTerminal(ids, [
        terminal('a', 9, { agentIdentity: null }),
        terminal('b', 8, { connected: false }),
        terminal('c', 7, { writable: false }),
        terminal('d', 1),
      ]),
    ).toMatchObject({ terminalId: 'd' });
    expect(
      chooseAgentTerminal(ids, [terminal('a', 9, { agentIdentity: null }), terminal('b', 8, { connected: false })]),
    ).toBeUndefined();
    expect(chooseAgentTerminal([], [terminal('a', 9)])).toBeUndefined();
  });
});

describe('the six slash verbs', () => {
  const sendScript = {
    'worktree-show': () => envelope({ worktree: WORKSPACE_RECORD }),
    'terminal-list': () => envelope({ terminals: [agentTerminal('term_agent', 42)] }),
  };

  test('sends the composed slash command into the chosen agent terminal and notifies once', async () => {
    const adapter = fakeAdapter(sendScript);
    const host = fakeHost();
    const palette = await activate(adapter.adapter, host.host);

    expect(await invoke(palette, 'genie.review')).toEqual({ ok: true, mode: 'sent', terminalId: 'term_agent' });

    const send = host.calls.find((call) => call.method === 'terminal.sendText');
    expect(send?.params.terminalId).toBe('term_agent');
    expect(send?.params.enter).toBe(true);
    const text = String(send?.params.text);
    expect(text.startsWith('/review')).toBe(true);
    expect(text).toContain('namastex888/orca-plugin-genie');
    expect(text).not.toContain('refs/heads/');
    expect(text).toContain('orca plugin genie');
    expect(text).toContain(WORKSPACE_PATH);

    expect(host.notifications).toEqual(['Genie: sent /review to orca plugin genie']);
    // `active`/`current` are cwd shortcuts the worker can never satisfy: the
    // workspace is the host's, enriched by name and checked against its branch.
    expect(adapter.operations).toEqual([
      { operation: 'worktree-show', worktree: 'name:orca plugin genie' },
      { operation: 'terminal-list', worktree: `id:${WORKSPACE_ID}` },
    ]);
    // The spelling that won is recorded for QA (design risk 1).
    expect(palette.logs.join('\n')).toContain('exact handle match');
  });

  test('a desktop whose CLI cannot reach the workspace still sends, to the first terminal the host lists', async () => {
    // A Mac paired to a remote runtime: the local CLI answers selector_not_found
    // for every workspace of that runtime, and the host API is the only bridge.
    const adapter = fakeAdapter({ 'worktree-show': () => adapterError('process_exit') });
    const host = fakeHost();
    const palette = await activate(adapter.adapter, host.host);

    expect(await invoke(palette, 'genie.review')).toEqual({ ok: true, mode: 'sent', terminalId: 'term_agent' });
    const send = host.calls.find((call) => call.method === 'terminal.sendText');
    const text = String(send?.params.text);
    expect(text.startsWith('/review — workspace orca plugin genie; branch namastex888/orca-plugin-genie')).toBe(true);
    expect(text).not.toContain('worktree ');
    expect(operationNames(adapter)).toEqual(['worktree-show']);
    expect(host.notifications).toEqual(['Genie: sent /review to orca plugin genie']);
    expect(palette.logs.join('\n')).toContain('using the host context alone');
  });

  test('a name that resolves a workspace on another branch is not trusted', async () => {
    const adapter = fakeAdapter({
      'worktree-show': () => envelope({ worktree: { ...WORKSPACE_RECORD, branch: 'refs/heads/dev' } }),
    });
    const host = fakeHost();
    const palette = await activate(adapter.adapter, host.host);
    expect(await invoke(palette, 'genie.work')).toEqual({ ok: true, mode: 'sent', terminalId: 'term_agent' });
    expect(operationNames(adapter)).toEqual(['worktree-show']);
    expect(String(host.calls.find((call) => call.method === 'terminal.sendText')?.params.text)).not.toContain(
      WORKSPACE_PATH,
    );
  });

  test('an unreachable workspace with no terminal is one notification, never a worker', async () => {
    const adapter = fakeAdapter({ 'worktree-show': () => adapterError('process_exit') });
    const host = fakeHost({ 'workspace.readContext': () => ({ ...READ_CONTEXT, terminals: [] }) });
    const palette = await activate(adapter.adapter, host.host);
    expect(await invoke(palette, 'genie.wish')).toEqual({ ok: false, reason: 'unreachable-workspace' });
    expect(operationNames(adapter)).toEqual(['worktree-show']);
    expect(host.notifications).toHaveLength(1);
    expect(host.notifications[0]).toContain('open a terminal there and retry');
  });

  test('probes the runtime exactly once across three invocations', async () => {
    const adapter = fakeAdapter(sendScript);
    const palette = await activate(adapter.adapter, fakeHost().host);
    for (const id of ['genie.wish', 'genie.work', 'genie.review']) await invoke(palette, id);
    expect(adapter.statusCalls).toBe(1);
    expect(operationNames(adapter)).toHaveLength(6);
  });

  test('builds its adapter with the explicit 8 s process bound, once and lazily', async () => {
    const built: unknown[] = [];
    const adapter = fakeAdapter(sendScript);
    const runtime = createOrcaPluginRuntime(undefined, (options) => {
      built.push(options);
      return adapter.adapter;
    });
    expect(built).toEqual([]);
    await runtime.execute({ operation: 'worktree-show', worktree: 'active' });
    await runtime.execute({ operation: 'terminal-list', worktree: 'active' });
    expect(built).toEqual([{ timeoutMs: ORCA_PLUGIN_ADAPTER_TIMEOUT_MS }]);
    expect(ORCA_PLUGIN_ADAPTER_TIMEOUT_MS).toBe(8_000);
  });
});

describe('the supervised-worker start path', () => {
  const startScript = {
    'worktree-show': () => envelope({ worktree: WORKSPACE_RECORD }),
    // A terminal with no agent is not a candidate, so there is nothing to send to.
    'terminal-list': () => envelope({ terminals: [{ ...agentTerminal('term_plain', 7), agentIdentity: null }] }),
    'run-create': () => envelope({ runId: 'run_7' }, { runId: 'run_7' }),
    'worker-start': () => envelope({ dispatchId: 'dispatch_9', taskId: 'task_9' }, { dispatchId: 'dispatch_9' }),
  };

  test('a read phase past 20 s reports slow reads and never reaches run-create', async () => {
    const adapter = fakeAdapter(startScript);
    const host = fakeHost();
    // The first reading is the handler's start; every later reading is 25 s on.
    let readings = 0;
    const now = () => (readings++ === 0 ? 0 : 25_000);
    const palette = await activate(adapter.adapter, host.host, { now });

    expect(await invoke(palette, 'genie.wish')).toEqual({ ok: false, reason: 'slow-reads' });
    expect(operationNames(adapter)).toEqual(['worktree-show', 'terminal-list']);
    expect(host.notifications).toHaveLength(1);
    expect(host.notifications[0]).toContain('too slowly');
  });

  test('creates a Run and starts a worker on it with the composed text as its spec', async () => {
    const adapter = fakeAdapter(startScript);
    const host = fakeHost();
    const palette = await activate(adapter.adapter, host.host);

    expect(await invoke(palette, 'genie.wish')).toEqual({
      ok: true,
      mode: 'started',
      runId: 'run_7',
      dispatchId: 'dispatch_9',
    });

    expect(operationNames(adapter)).toEqual(['worktree-show', 'terminal-list', 'run-create', 'worker-start']);
    expect(adapter.operations[2]).toEqual({
      operation: 'run-create',
      objective: 'Genie: Wish — orca plugin genie',
    });
    const start = adapter.operations[3];
    expect(start).toMatchObject({
      operation: 'worker-start',
      run: 'run_7',
      worktree: `id:${WORKSPACE_ID}`,
      agent: 'codex',
      title: 'Genie: Wish — orca plugin genie',
      timeoutMs: 15_000,
    });
    expect(String(start.spec).startsWith('/wish')).toBe(true);
    expect(host.calls.some((call) => call.method === 'terminal.sendText')).toBe(false);
    expect(host.notifications).toHaveLength(1);
    expect(host.notifications[0]).toContain('codex');
  });

  test('starts under claude when the workspace names no agent genie can dispatch', async () => {
    const adapter = fakeAdapter({
      ...startScript,
      'worktree-show': () => envelope({ worktree: { ...WORKSPACE_RECORD, createdWithAgent: 'some-other-agent' } }),
    });
    await invoke(await activate(adapter.adapter, fakeHost().host), 'genie.council');
    expect(adapter.operations[3]).toMatchObject({ agent: 'claude' });
  });

  for (const code of ['timeout', 'ambiguous_after_possible_commit'] as const) {
    test(`reports a ${code} start as ambiguous and never starts a second worker`, async () => {
      const adapter = fakeAdapter({ ...startScript, 'worker-start': () => adapterError(code) });
      const host = fakeHost();
      const palette = await activate(adapter.adapter, host.host);

      expect(await invoke(palette, 'genie.fix')).toEqual({ ok: false, reason: 'ambiguous-start' });
      expect(operationNames(adapter).filter((name) => name === 'worker-start')).toHaveLength(1);
      expect(host.notifications).toHaveLength(1);
      // The adapter's own message rides along so a genuinely failed start is not read as a mere "requested".
      expect(host.notifications[0]).toMatch(
        /^Genie: start requested for orca plugin genie; confirm in Orca before retrying \(.+\)$/,
      );
    });
  }

  test('a start that fails for any other reason is one notification and an error result', async () => {
    const adapter = fakeAdapter({ ...startScript, 'worker-start': () => adapterError('process_exit') });
    const host = fakeHost();
    expect(await invoke(await activate(adapter.adapter, host.host), 'genie.report')).toEqual({
      ok: false,
      reason: 'error',
      code: 'process_exit',
    });
    expect(host.notifications).toHaveLength(1);
    expect(host.notifications[0]).toContain('process_exit');
  });
});

describe('refusals never reach the plugin host', () => {
  const sendScript = {
    'worktree-show': () => envelope({ worktree: WORKSPACE_RECORD }),
    'terminal-list': () => envelope({ terminals: [agentTerminal('term_agent', 42)] }),
  };

  test('no active workspace is one notification, a {ok:false} result, and no adapter call', async () => {
    const adapter = fakeAdapter(sendScript);
    const host = fakeHost({ 'workspace.readContext': () => null });
    expect(await invoke(await activate(adapter.adapter, host.host), 'genie.work')).toEqual({
      ok: false,
      reason: 'no-active-workspace',
    });
    expect(host.notifications).toEqual(['Genie: no active workspace']);
    expect(adapter.operations).toEqual([]);
  });

  test('a rejected host call and an {ok:false} host answer are the same refusal', async () => {
    for (const answer of [
      () => hostError('capability_denied'),
      () => ({ ok: false, code: 'capability_denied', error: 'plugin is not enabled with current consent' }),
    ]) {
      const adapter = fakeAdapter(sendScript);
      const host = fakeHost({ 'workspace.readContext': answer });
      expect(await invoke(await activate(adapter.adapter, host.host), 'genie.review')).toEqual({
        ok: false,
        reason: 'error',
        code: 'capability_denied',
      });
      expect(host.notifications).toHaveLength(1);
      expect(host.notifications[0]).toContain('capability_denied');
      expect(adapter.operations).toEqual([]);
    }
  });

  test('an adapter error past the reads becomes one bounded notification and an error result', async () => {
    const adapter = fakeAdapter({
      'worktree-show': () => envelope({ worktree: WORKSPACE_RECORD }),
      'terminal-list': () => envelope({ terminals: [] }),
      'run-create': () =>
        new OrcaAdapterError(
          'unsupported_environment',
          'run-create',
          'resolve',
          'safe',
          'Run this plugin in a supported Orca host.',
          'x'.repeat(2_000),
        ),
    });
    const host = fakeHost();
    expect(await invoke(await activate(adapter.adapter, host.host), 'genie.review')).toEqual({
      ok: false,
      reason: 'error',
      code: 'unsupported_environment',
    });
    expect(host.notifications).toHaveLength(1);
    expect(host.notifications[0].length).toBeLessThanOrEqual(300);
  });

  test('every command resolves even when the host refuses every call, notifications included', async () => {
    const adapter = fakeAdapter({ 'worktree-show': () => adapterError('process_exit') });
    const host = fakeHost({
      'workspace.readContext': () => hostError('consent_required'),
      'notifications.show': () => hostError('capability_denied'),
    });
    const palette = await activate(adapter.adapter, host.host);
    for (const command of GENIE_PALETTE_COMMANDS) {
      const result = (await invoke(palette, command.id)) as { ok: boolean };
      expect(result.ok, command.id).toBe(false);
    }
  });
});

describe('the two binary-backed commands', () => {
  const GENIE_FALLBACK = join(homedir(), '.local', 'bin', 'genie');
  const workspaceScript = { 'worktree-show': () => envelope({ worktree: WORKSPACE_RECORD }) };
  const processResult = (stdout: string, code = 0): GenieProcessResult => ({ code, stdout, stderr: '' });
  const doctorReport = (ok: boolean, checks: { name: string; status: string; detail?: string }[]) =>
    JSON.stringify({ ok, checks });

  /** Records every child process the handler asked for and answers from a script. */
  function fakeSpawn(answers: ((request: GenieProcessRequest) => GenieProcessResult | Error)[]): {
    spawn: GenieSpawn;
    requests: GenieProcessRequest[];
  } {
    const requests: GenieProcessRequest[] = [];
    return {
      requests,
      spawn: async (request) => {
        requests.push(request);
        const answer = answers[Math.min(requests.length - 1, answers.length - 1)];
        const value = answer === undefined ? enoent(request.command) : answer(request);
        if (value instanceof Error) throw value;
        return value;
      },
    };
  }

  test('doctor runs `genie doctor --json` in the workspace and names the checks that are not pass', async () => {
    const adapter = fakeAdapter(workspaceScript);
    const host = fakeHost();
    const spawn = fakeSpawn([
      () =>
        processResult(
          doctorReport(false, [
            { name: 'genie version', status: 'pass', detail: '5.260919.7' },
            { name: 'skills: agent dirs', status: 'warn', detail: 'x' },
          ]),
          1,
        ),
    ]);
    const palette = await activate(adapter.adapter, host.host, { spawn: spawn.spawn });

    expect(await invoke(palette, 'genie.doctor')).toEqual({ ok: false, warn: 1, fail: 0 });
    expect(host.notifications).toEqual(['Genie doctor: 1 warn, 0 fail — skills: agent dirs']);
    // The report is read from stdout whatever the exit code: `genie doctor
    // --json` prints its checks and exits 1 when it is not ok.
    expect(spawn.requests).toEqual([
      { command: 'genie', args: ['doctor', '--json'], cwd: WORKSPACE_PATH, timeoutMs: 20_000 },
    ]);
    expect(operationNames(adapter)).toEqual(['worktree-show']);
    expect(adapter.operations[0]).toEqual({ operation: 'worktree-show', worktree: 'name:orca plugin genie' });
  });

  test('doctor cannot run when this machine cannot resolve the workspace path', async () => {
    const adapter = fakeAdapter({ 'worktree-show': () => adapterError('process_exit') });
    const host = fakeHost();
    const spawn = fakeSpawn([]);
    const palette = await activate(adapter.adapter, host.host, { spawn: spawn.spawn });
    expect(await invoke(palette, 'genie.doctor')).toEqual({ ok: false, warn: 0, fail: 0 });
    expect(spawn.requests).toEqual([]);
    expect(host.notifications).toEqual([
      'Genie doctor: could not run (the workspace path is not known from this machine)',
    ]);
  });

  test('doctor counts fails, names at most three checks, and says so when everything passes', async () => {
    const flagged = [
      { name: 'a', status: 'warn' },
      { name: 'b', status: 'fail' },
      { name: 'c', status: 'warn' },
      { name: 'd', status: 'fail' },
      // A non-pass status outside the counted vocabulary is neither counted nor named.
      { name: 'e', status: 'skipped' },
    ];
    const flaggedSpawn = fakeSpawn([() => processResult(doctorReport(false, flagged))]);
    const flaggedHost = fakeHost();
    expect(
      await invoke(
        await activate(fakeAdapter(workspaceScript).adapter, flaggedHost.host, { spawn: flaggedSpawn.spawn }),
        'genie.doctor',
      ),
    ).toEqual({ ok: false, warn: 2, fail: 2 });
    expect(flaggedHost.notifications).toEqual(['Genie doctor: 2 warn, 2 fail — a; b; c +1 more']);

    const cleanSpawn = fakeSpawn([
      () => processResult(doctorReport(true, [{ name: 'genie version', status: 'pass' }])),
    ]);
    const cleanHost = fakeHost();
    expect(
      await invoke(
        await activate(fakeAdapter(workspaceScript).adapter, cleanHost.host, { spawn: cleanSpawn.spawn }),
        'genie.doctor',
      ),
    ).toEqual({ ok: true, warn: 0, fail: 0 });
    expect(cleanHost.notifications).toEqual(['Genie doctor: all checks pass']);
  });

  test('doctor falls back to ~/.local/bin/genie only when the PATH lookup answers ENOENT', async () => {
    const spawn = fakeSpawn([
      (request) => enoent(request.command),
      () => processResult(doctorReport(true, [{ name: 'genie version', status: 'pass' }])),
    ]);
    const host = fakeHost();
    const palette = await activate(fakeAdapter(workspaceScript).adapter, host.host, { spawn: spawn.spawn });

    expect(await invoke(palette, 'genie.doctor')).toEqual({ ok: true, warn: 0, fail: 0 });
    expect(spawn.requests.map((request) => request.command)).toEqual(['genie', GENIE_FALLBACK]);
    expect(spawn.requests[1]).toMatchObject({ args: ['doctor', '--json'], cwd: WORKSPACE_PATH });
    expect(host.notifications).toEqual(['Genie doctor: all checks pass']);
    expect(palette.logs.join('\n')).toContain(GENIE_FALLBACK);
  });

  test('a spawn failure and unparsable output are the same bounded `could not run` line', async () => {
    for (const answer of [
      () => new Error('Command failed: genie doctor --json'),
      () => processResult('Killed\n', 137),
    ]) {
      const host = fakeHost();
      const spawn = fakeSpawn([answer, answer]);
      expect(
        await invoke(
          await activate(fakeAdapter(workspaceScript).adapter, host.host, { spawn: spawn.spawn }),
          'genie.doctor',
        ),
      ).toEqual({ ok: false, warn: 0, fail: 0 });
      expect(host.notifications).toHaveLength(1);
      expect(host.notifications[0].startsWith('Genie doctor: could not run (')).toBe(true);
      expect(host.notifications[0].length).toBeLessThanOrEqual(300);
    }
  });

  /**
   * The update handler's two children, answered by what was asked rather than
   * by call order: `genie --version` and `genie config get updateChannel`.
   */
  const updateSpawn = (version: string, channel: GenieProcessResult | Error) =>
    fakeSpawn([
      (request) => (request.args[0] === '--version' ? processResult(version) : channel),
      (request) => (request.args[0] === '--version' ? processResult(version) : channel),
    ]);

  test('update compares `genie --version` with the manifest of the channel the CLI reports', async () => {
    const requested: { url: string; signal: AbortSignal }[] = [];
    const fetchManifest = (version: string, channel: string): GenieFetch => {
      return async (url, init) => {
        requested.push({ url, signal: init.signal });
        return { ok: true, status: 200, json: async () => ({ schema_version: 1, channel, version }) };
      };
    };

    const newerHost = fakeHost();
    const spawn = updateSpawn('5.260919.7\n', processResult('latest\n'));
    expect(
      await invoke(
        await activate(fakeAdapter().adapter, newerHost.host, {
          spawn: spawn.spawn,
          fetch: fetchManifest('5.260920.1', 'stable'),
        }),
        'genie.update',
      ),
    ).toEqual({ ok: true, installed: '5.260919.7', latest: '5.260920.1', channel: 'stable' });
    expect(newerHost.notifications).toEqual([
      'Genie update available: 5.260920.1 (installed 5.260919.7, stable channel) — run genie update',
    ]);
    expect(spawn.requests).toEqual([
      { command: 'genie', args: ['--version'], cwd: undefined, timeoutMs: 8_000 },
      { command: 'genie', args: ['config', 'get', 'updateChannel'], cwd: undefined, timeoutMs: 8_000 },
    ]);
    expect(requested).toHaveLength(1);
    expect(requested[0].url).toBe('https://raw.githubusercontent.com/automagik-dev/genie/main/.well-known/latest.json');
    expect(requested[0].signal).toBeInstanceOf(AbortSignal);

    const currentHost = fakeHost();
    expect(
      await invoke(
        await activate(fakeAdapter().adapter, currentHost.host, {
          spawn: updateSpawn('v5.260920.1\n', processResult('latest\n')).spawn,
          fetch: fetchManifest('5.260920.1', 'stable'),
        }),
        'genie.update',
      ),
    ).toEqual({ ok: true, installed: '5.260920.1', latest: '5.260920.1', channel: 'stable' });
    expect(currentHost.notifications).toEqual(['Genie is up to date (5.260920.1, stable channel)']);
  });

  /**
   * The bug this pins: a dev host read against `latest.json` reports the dev
   * build it already runs as an update, and stays silent when a dev build is
   * actually waiting.
   */
  test('a host on the dev channel reads dev.json, not the stable manifest', async () => {
    const requested: string[] = [];
    const host = fakeHost();
    expect(
      await invoke(
        await activate(fakeAdapter().adapter, host.host, {
          spawn: updateSpawn('5.260919.13\n', processResult('dev\n')).spawn,
          fetch: async (url) => {
            requested.push(url);
            return {
              ok: true,
              status: 200,
              json: async () => ({ schema_version: 1, channel: 'dev', version: '5.260919.14' }),
            };
          },
        }),
        'genie.update',
      ),
    ).toEqual({ ok: true, installed: '5.260919.13', latest: '5.260919.14', channel: 'dev' });
    expect(requested).toEqual(['https://raw.githubusercontent.com/automagik-dev/genie/main/.well-known/dev.json']);
    expect(host.notifications).toEqual([
      'Genie update available: 5.260919.14 (installed 5.260919.13, dev channel) — run genie update',
    ]);
  });

  test('every unreadable channel answer resolves to stable, the conservative direction', async () => {
    const answers: (GenieProcessResult | Error)[] = [
      // A binary too old to carry the `config` verb.
      processResult('Error (genie config get): unknown config key: updateChannel', 1),
      // A token this build does not know, and no token at all.
      processResult('homolog\n'),
      processResult(''),
      new Error('spawn genie ENOENT'),
    ];
    for (const answer of answers) {
      const host = fakeHost();
      const requested: string[] = [];
      const result = await invoke(
        await activate(fakeAdapter().adapter, host.host, {
          spawn: updateSpawn('5.260919.7\n', answer).spawn,
          fetch: async (url) => {
            requested.push(url);
            return {
              ok: true,
              status: 200,
              json: async () => ({ schema_version: 1, channel: 'stable', version: '5.260919.7' }),
            };
          },
        }),
        'genie.update',
      );
      expect(result, String(answer)).toEqual({
        ok: true,
        installed: '5.260919.7',
        latest: '5.260919.7',
        channel: 'stable',
      });
      expect(requested, String(answer)).toEqual([
        'https://raw.githubusercontent.com/automagik-dev/genie/main/.well-known/latest.json',
      ]);
    }
  });

  test('a manifest that cannot be read is one `could not check` line, never a thrown handler', async () => {
    const failures: GenieFetch[] = [
      async () => {
        throw new Error('fetch failed: getaddrinfo ENOTFOUND raw.githubusercontent.com');
      },
      async () => ({ ok: false, status: 503, json: async () => ({}) }),
      async () => ({ ok: true, status: 200, json: async () => ({ schema_version: 1 }) }),
    ];
    for (const fetchManifest of failures) {
      const host = fakeHost();
      const result = await invoke(
        await activate(fakeAdapter().adapter, host.host, {
          spawn: fakeSpawn([() => processResult('5.260919.7\n')]).spawn,
          fetch: fetchManifest,
        }),
        'genie.update',
      );
      expect(result).toEqual({ ok: false, installed: '5.260919.7' });
      expect(host.notifications).toHaveLength(1);
      expect(host.notifications[0].startsWith('Genie update: could not check (')).toBe(true);
      expect(host.notifications[0].length).toBeLessThanOrEqual(300);
    }
  });

  test('neither command touches the adapter beyond the one workspace read, and update does not read it at all', async () => {
    const adapter = fakeAdapter(workspaceScript);
    const host = fakeHost();
    const palette = await activate(adapter.adapter, host.host, {
      spawn: fakeSpawn([() => processResult(doctorReport(true, []))]).spawn,
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ version: '5.260919.7' }) }),
    });
    await invoke(palette, 'genie.doctor');
    await invoke(palette, 'genie.update');
    expect(operationNames(adapter)).toEqual(['worktree-show']);
    expect(host.calls.some((call) => call.method === 'terminal.sendText')).toBe(false);
  });
});

describe('result notifications from agent.status.changed', () => {
  const SHIP_COMMENT = mirrorTransition({
    to: 'REVIEW',
    verdict: 'SHIP',
    evidence: 'group 5 — 9 tests, head 445bd603a',
    today: '2026-09-19',
  }).comment;
  const BLOCKED_COMMENT = mirrorTransition({
    to: 'BLOCKED',
    evidence: 'gate merge-approval — awaiting the owner',
    today: '2026-09-19',
  }).comment;

  /** A `worktree-show` script whose comment advances one step per read. */
  function commentScript(comments: (string | null)[]): {
    script: Record<string, () => OrcaAdapterResponse>;
    reads: number;
  } {
    const state = { reads: 0 };
    return {
      script: {
        'worktree-show': () => {
          const comment = comments[Math.min(state.reads, comments.length - 1)] ?? null;
          state.reads += 1;
          return envelope({ worktree: { ...WORKSPACE_RECORD, comment } });
        },
      },
      get reads() {
        return state.reads;
      },
    };
  }

  const settled = (state: string, worktreeId: string | null = WORKSPACE_ID) => ({
    worktreeId,
    paneKey: 'pane_1',
    state,
    receivedAt: 1_758_240_000_000,
  });

  /** A clock the debounce reads; every test that wants a fresh window advances it itself. */
  function clock(): { now: () => number; advance: (ms: number) => void } {
    let value = 1_000;
    return {
      now: () => value,
      advance: (ms) => {
        value += ms;
      },
    };
  }

  test('a settled agent whose card carries a new genie line is exactly one notification for that workspace', async () => {
    const comments = commentScript([SHIP_COMMENT]);
    const adapter = fakeAdapter(comments.script);
    const host = fakeHost();
    const palette = await activate(adapter.adapter, host.host, { now: clock().now });

    expect(palette.subscribed).toEqual(['agent.status.changed']);
    await palette.emit('agent.status.changed', settled('done'));

    // The workspace is addressed by the id the event carried, never `active`.
    expect(adapter.operations).toEqual([{ operation: 'worktree-show', worktree: `id:${WORKSPACE_ID}` }]);
    const shown = host.calls.filter((call) => call.method === 'notifications.show');
    expect(shown).toHaveLength(1);
    expect(shown[0].params).toEqual({ title: 'Genie — orca plugin genie', body: SHIP_COMMENT });
    expect(SHIP_COMMENT).toMatch(/^2026-09-19 genie review: SHIP — /);
    expect(String(shown[0].params.body).length).toBeLessThanOrEqual(300);
  });

  test('a long display name still yields a title inside the host limit of 120 characters', async () => {
    const adapter = fakeAdapter({
      'worktree-show': () =>
        envelope({ worktree: { ...WORKSPACE_RECORD, displayName: 'w'.repeat(200), comment: SHIP_COMMENT } }),
    });
    const host = fakeHost();
    const palette = await activate(adapter.adapter, host.host, { now: clock().now });
    await palette.emit('agent.status.changed', settled('done'));
    const shown = host.calls.filter((call) => call.method === 'notifications.show');
    expect(shown).toHaveLength(1);
    const title = String(shown[0].params.title);
    expect(title.startsWith('Genie — ')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(120);
  });

  test('the same comment is never toasted twice, and the next genie line is', async () => {
    const comments = commentScript([SHIP_COMMENT, SHIP_COMMENT, BLOCKED_COMMENT]);
    const adapter = fakeAdapter(comments.script);
    const host = fakeHost();
    const time = clock();
    const palette = await activate(adapter.adapter, host.host, { now: time.now });

    await palette.emit('agent.status.changed', settled('done'));
    time.advance(10_000);
    await palette.emit('agent.status.changed', settled('done'));
    expect(host.notifications).toEqual([SHIP_COMMENT]);
    expect(comments.reads).toBe(2);

    time.advance(10_000);
    await palette.emit('agent.status.changed', settled('blocked'));
    expect(host.notifications).toEqual([SHIP_COMMENT, BLOCKED_COMMENT]);
    expect(BLOCKED_COMMENT).toMatch(/^2026-09-19 genie blocked — gate /);
  });

  test('`working` reads nothing while every other state settles', async () => {
    const comments = commentScript([SHIP_COMMENT]);
    const adapter = fakeAdapter(comments.script);
    const host = fakeHost();
    const palette = await activate(adapter.adapter, host.host, { now: clock().now });

    await palette.emit('agent.status.changed', settled('working'));
    expect(adapter.operations).toEqual([]);
    expect(host.notifications).toEqual([]);

    for (const state of ['blocked', 'waiting', 'done']) {
      const each = commentScript([SHIP_COMMENT]);
      const eachAdapter = fakeAdapter(each.script);
      const eachPalette = await activate(eachAdapter.adapter, fakeHost().host, { now: clock().now });
      await eachPalette.emit('agent.status.changed', settled(state));
      expect(operationNames(eachAdapter), state).toEqual(['worktree-show']);
    }
  });

  test('a comment that is not a genie line, and an event carrying no workspace, notify nothing', async () => {
    const comments = commentScript(['ready for review', null]);
    const adapter = fakeAdapter(comments.script);
    const host = fakeHost();
    const time = clock();
    const palette = await activate(adapter.adapter, host.host, { now: time.now });

    await palette.emit('agent.status.changed', settled('done'));
    time.advance(10_000);
    await palette.emit('agent.status.changed', settled('done'));
    expect(comments.reads).toBe(2);
    expect(host.notifications).toEqual([]);

    for (const payload of [settled('done', null), { state: 'done' }, null, 'done']) {
      await palette.emit('agent.status.changed', payload);
    }
    expect(comments.reads).toBe(2);
    expect(host.notifications).toEqual([]);
  });

  test('a read that fails is swallowed: no notification, no rejection into the host', async () => {
    const adapter = fakeAdapter({ 'worktree-show': () => adapterError('process_exit') });
    const host = fakeHost();
    const palette = await activate(adapter.adapter, host.host, { now: clock().now });

    await expect(palette.emit('agent.status.changed', settled('done'))).resolves.toBeUndefined();
    expect(host.notifications).toEqual([]);
    expect(palette.logs.join('\n')).toContain('agent.status.changed ignored (process_exit)');
  });

  test('at most one workspace read per 2 s window, however fast the burst is', async () => {
    const comments = commentScript([SHIP_COMMENT]);
    const adapter = fakeAdapter(comments.script);
    const host = fakeHost();
    const time = clock();
    const palette = await activate(adapter.adapter, host.host, { now: time.now });

    await palette.emit('agent.status.changed', settled('done'));
    time.advance(1_999);
    await palette.emit('agent.status.changed', settled('waiting'));
    expect(comments.reads).toBe(1);

    time.advance(1);
    await palette.emit('agent.status.changed', settled('done'));
    expect(comments.reads).toBe(2);
    // The window bounds child processes, not notifications: the comment is unchanged.
    expect(host.notifications).toEqual([SHIP_COMMENT]);
  });

  test('a host with no events API registers every command and says the notifications are off', async () => {
    const handlers: string[] = [];
    const logs: string[] = [];
    await createOrcaPluginEntrypoint(fakeAdapter().adapter)({
      commands: { register: (id) => handlers.push(id) },
      host: fakeHost().host,
      log: (message) => logs.push(message),
    });
    expect(handlers).toHaveLength(GENIE_PALETTE_COMMANDS.length);
    expect(logs.join('\n')).toContain('no events API');
  });
});

describe('native Orca plugin contract', () => {
  test('probes with one read-only public adapter call before allowing operations', async () => {
    const adapter = fakeAdapter();
    const runtime = createOrcaPluginRuntime(adapter.adapter);

    expect(await runtime.probe()).toEqual({
      runtimeId: 'runtime_1',
      runtimeVersion: ORCA_MINIMUM_RUNTIME_VERSION,
      contract: 'orchestration.contract.v1',
    });
    expect(adapter.operations).toEqual([]);
  });

  test('converts status, version, and capability failures to unsupported_environment and never mutates', async () => {
    for (const failure of [new Error('spawn denied'), status('1.3.999'), status(undefined, [])]) {
      const operations: unknown[] = [];
      const adapter: OrcaOrchestrationAdapter = {
        executable: 'opaque-to-plugin',
        status: async () => {
          if (failure instanceof Error) throw failure;
          return failure;
        },
        execute: async (operation) => {
          operations.push(operation);
          return envelope({});
        },
      };

      await expect(createOrcaPluginRuntime(adapter).probe()).rejects.toMatchObject({
        code: 'unsupported_environment',
        operation: 'runtime',
        phase: 'resolve',
        retrySafety: 'safe',
      });
      expect(operations).toEqual([]);
    }
  });

  // A rejected probe is never remembered: a host that recovers must be usable
  // without reloading the plugin.
  test('caches a successful probe and retries a rejected one', async () => {
    let healthy = false;
    let statusCalls = 0;
    const adapter: OrcaOrchestrationAdapter = {
      executable: 'opaque-to-plugin',
      status: async () => {
        statusCalls += 1;
        if (!healthy) throw new Error('runtime unreachable');
        return status();
      },
      execute: async () => envelope({}),
    };
    const runtime = createOrcaPluginRuntime(adapter);
    await expect(runtime.probe()).rejects.toMatchObject({ code: 'unsupported_environment' });
    await expect(runtime.probe()).rejects.toMatchObject({ code: 'unsupported_environment' });
    expect(statusCalls).toBe(2);
    healthy = true;
    await runtime.execute({ operation: 'worktree-show', worktree: 'active' });
    await runtime.execute({ operation: 'worktree-show', worktree: 'active' });
    expect(statusCalls).toBe(3);
  });

  // A prerelease of the minimum is NOT the minimum. The version gate dropped the
  // `-rc.1` suffix, so `1.4.205-rc.1` compared equal to the released `1.4.205`
  // and satisfied `>=1.4.205` — the plugin then ran against a runtime whose
  // orchestration contract is still in flux.
  test('rejects a prerelease of the minimum runtime version and accepts real successors', async () => {
    const accepted = [
      ORCA_MINIMUM_RUNTIME_VERSION,
      '1.4.206',
      '1.5.0',
      '2.0.0',
      '1.4.206-rc.1',
      `${ORCA_MINIMUM_RUNTIME_VERSION}+build.7`,
    ];
    const rejected = [
      '1.4.205-rc.1',
      '1.4.205-0',
      '1.4.205-alpha',
      '1.4.204',
      '1.4.192',
      '1.3.999',
      '0.9.9',
      'not-a-version',
      '1.4',
    ];
    const probeWith = async (runtimeVersion: string) => {
      const adapter: OrcaOrchestrationAdapter = {
        executable: 'opaque-to-plugin',
        status: async () => status(runtimeVersion),
        execute: async () => envelope({}),
      };
      return createOrcaPluginRuntime(adapter).probe();
    };
    for (const runtimeVersion of accepted) {
      expect(await probeWith(runtimeVersion), runtimeVersion).toMatchObject({ runtimeVersion });
    }
    for (const runtimeVersion of rejected) {
      await expect(probeWith(runtimeVersion), runtimeVersion).rejects.toMatchObject({
        code: 'unsupported_environment',
      });
    }
  });

  test('does not expose stores, fallback, argv, shells, dispatch injection, or executable selection', async () => {
    const source = await readFile(resolve(import.meta.dir, 'orca-runtime.ts'), 'utf8');
    for (const forbidden of [
      'node:child_process',
      'shell:',
      'Database',
      'dispatch --inject',
      'terminal send',
      'execPath',
      'executable:',
      'fallback',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
