/**
 * PTY Manager — Manages PTY child processes via bun-pty.
 *
 * No tmux dependency. Each session is a direct PTY child process.
 * Integrates with PG executor model for agent-linked terminals.
 */

import { randomUUID } from 'node:crypto';

// ============================================================================
// Types
// ============================================================================

export type PtySessionState = 'running' | 'exited';

export interface PtySession {
  id: string;
  pty: PtyHandle;
  agentId: string | null;
  executorId: string | null;
  taskId: string | null;
  command: string;
  state: PtySessionState;
  cols: number;
  rows: number;
  createdAt: string;
}

export interface PtyHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData: ((data: string) => void) | null;
  onExit: ((code: number) => void) | null;
}

export type PtyDataCallback = (sessionId: string, data: string) => void;
export type PtyExitCallback = (sessionId: string, code: number) => void;

interface SpawnForAgentOpts {
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  taskId?: string;
}

// ============================================================================
// Session Registry
// ============================================================================

const sessions = new Map<string, PtySession>();
let dataCallback: PtyDataCallback | null = null;
let exitCallback: PtyExitCallback | null = null;

export function onPtyData(cb: PtyDataCallback): void {
  dataCallback = cb;
}

export function onPtyExit(cb: PtyExitCallback): void {
  exitCallback = cb;
}

export function getSession(sessionId: string): PtySession | undefined {
  return sessions.get(sessionId);
}

export function listSessions(): PtySession[] {
  return [...sessions.values()];
}

// ============================================================================
// Spawn Functions
// ============================================================================

/**
 * Spawn a PTY for an agent. Builds the Claude Code command,
 * creates an executor row in PG, and starts the PTY process.
 */
export async function spawnForAgent(agentName: string, opts: SpawnForAgentOpts = {}): Promise<PtySession> {
  const { buildClaudeCommand } = await import('../../../src/lib/provider-adapters.js');
  const { createExecutor } = await import('../../../src/lib/executor-registry.js');
  const { findOrCreateAgent, setCurrentExecutor } = await import('../../../src/lib/agent-registry.js');

  const cols = opts.cols ?? 120;
  const rows = opts.rows ?? 40;
  const cwd = opts.cwd ?? process.cwd();

  // Build the claude command
  const launch = buildClaudeCommand({
    provider: 'claude',
    team: 'app',
    role: 'engineer',
    name: agentName,
  });

  // Ensure agent exists
  const agent = await findOrCreateAgent(agentName, 'app', 'engineer');

  // Create executor row
  const executor = await createExecutor(agent.id, 'app-pty' as never, 'process', {
    repoPath: cwd,
    state: 'spawning',
    metadata: { command: launch.command, source: 'genie-app' },
  });

  await setCurrentExecutor(agent.id, executor.id);

  // Spawn the PTY
  const env = {
    ...process.env,
    ...launch.env,
    GENIE_APP_PTY: 'true',
  } as Record<string, string>;

  const session = spawnPty(launch.command, {
    cwd,
    cols,
    rows,
    env,
    agentId: agent.id,
    executorId: executor.id,
    taskId: opts.taskId ?? null,
  });

  // Update executor state to running
  const { updateExecutorState } = await import('../../../src/lib/executor-registry.js');
  await updateExecutorState(executor.id, 'running');

  return session;
}

/**
 * Spawn a plain bash terminal (no agent/executor link).
 */
export function spawnBash(cwd?: string): PtySession {
  const shell = process.env.SHELL ?? '/bin/bash';
  return spawnPty(shell, {
    cwd: cwd ?? process.cwd(),
    cols: 120,
    rows: 40,
    env: process.env as Record<string, string>,
    agentId: null,
    executorId: null,
    taskId: null,
  });
}

// ============================================================================
// Terminal Control
// ============================================================================

export function writeTerminal(sessionId: string, data: string): boolean {
  const session = sessions.get(sessionId);
  if (!session || session.state !== 'running') return false;
  session.pty.write(data);
  return true;
}

export function resizeTerminal(sessionId: string, cols: number, rows: number): boolean {
  const session = sessions.get(sessionId);
  if (!session || session.state !== 'running') return false;
  session.pty.resize(cols, rows);
  session.cols = cols;
  session.rows = rows;
  return true;
}

export async function killTerminal(sessionId: string): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) return false;

  session.pty.kill();
  session.state = 'exited';

  // Update executor state if linked
  if (session.executorId) {
    try {
      const { updateExecutorState } = await import('../../../src/lib/executor-registry.js');
      await updateExecutorState(session.executorId, 'terminated');
    } catch {
      // Best effort — executor update may fail if PG is down
    }
  }

  sessions.delete(sessionId);
  return true;
}

export async function killAll(): Promise<void> {
  const ids = [...sessions.keys()];
  await Promise.allSettled(ids.map((id) => killTerminal(id)));
}

// ============================================================================
// Internal PTY Spawning
// ============================================================================

interface SpawnPtyOpts {
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
  agentId: string | null;
  executorId: string | null;
  taskId: string | null;
}

// biome-ignore lint/suspicious/noExplicitAny: ReadableStream from Bun.spawn
async function pipeStdout(stdout: any, sessionId: string, ptyHandle: PtyHandle): Promise<void> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      if (dataCallback) dataCallback(sessionId, text);
      if (ptyHandle.onData) ptyHandle.onData(text);
    }
  } catch {
    // Stream closed
  }
}

function onProcExit(sessionId: string, code: number, ptyHandle: PtyHandle): void {
  const session = sessions.get(sessionId);
  if (session) session.state = 'exited';
  if (exitCallback) exitCallback(sessionId, code);
  if (ptyHandle.onExit) ptyHandle.onExit(code);
  handlePtyExit(sessionId, code);
}

function spawnPty(command: string, opts: SpawnPtyOpts): PtySession {
  const sessionId = randomUUID();

  // Dynamic import of bun-pty — deferred so the module loads even if bun-pty
  // is not installed (other backend modules can still be used)
  let ptyHandle: PtyHandle;

  try {
    // bun-pty spawn API
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bunPty = require('bun-pty') as {
      spawn: (
        cmd: string[],
        opts: { cwd: string; env: Record<string, string>; cols: number; rows: number },
      ) => {
        write: (data: string) => void;
        resize: (cols: number, rows: number) => void;
        kill: () => void;
        onData: ((data: string) => void) | null;
        onExit: ((exitCode: number) => void) | null;
      };
    };

    const parts = command.split(' ');
    const raw = bunPty.spawn(parts, {
      cwd: opts.cwd,
      env: opts.env,
      cols: opts.cols,
      rows: opts.rows,
    });

    ptyHandle = {
      write: (data) => raw.write(data),
      resize: (cols, rows) => raw.resize(cols, rows),
      kill: () => raw.kill(),
      onData: null,
      onExit: null,
    };

    // Wire up data callback
    raw.onData = (data: string) => {
      if (dataCallback) dataCallback(sessionId, data);
      if (ptyHandle.onData) ptyHandle.onData(data);
    };

    raw.onExit = (code: number) => {
      const session = sessions.get(sessionId);
      if (session) session.state = 'exited';
      if (exitCallback) exitCallback(sessionId, code);
      if (ptyHandle.onExit) ptyHandle.onExit(code);
      handlePtyExit(sessionId, code);
    };
  } catch {
    // Fallback: use Bun.spawn with pseudo-PTY (subprocess)
    const parts = command.split(' ');
    const proc = Bun.spawn(parts, {
      cwd: opts.cwd,
      env: opts.env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    ptyHandle = {
      write: (data) => proc.stdin.write(data),
      resize: () => {}, // No resize support in subprocess fallback
      kill: () => proc.kill(),
      onData: null,
      onExit: null,
    };

    void pipeStdout(proc.stdout, sessionId, ptyHandle);
    void proc.exited.then((code) => onProcExit(sessionId, code, ptyHandle));
  }

  const session: PtySession = {
    id: sessionId,
    pty: ptyHandle,
    agentId: opts.agentId,
    executorId: opts.executorId,
    taskId: opts.taskId,
    command,
    state: 'running',
    cols: opts.cols,
    rows: opts.rows,
    createdAt: new Date().toISOString(),
  };

  sessions.set(sessionId, session);
  return session;
}

function handlePtyExit(sessionId: string, code: number): void {
  const session = sessions.get(sessionId);
  if (!session?.executorId) return;

  // Fire-and-forget executor state update
  void (async () => {
    try {
      const { updateExecutorState } = await import('../../../src/lib/executor-registry.js');
      await updateExecutorState(session.executorId as string, code === 0 ? 'done' : 'error');
    } catch {
      // Best effort
    }
  })();
}
