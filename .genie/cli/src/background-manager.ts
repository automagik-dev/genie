import { spawn, SpawnOptionsWithoutStdio } from 'child_process';
import EventEmitter from 'events';

export const INTERNAL_BACKGROUND_ENV = 'GENIE_AGENT_BACKGROUND_RUNNER';
export const INTERNAL_START_TIME_ENV = 'GENIE_AGENT_START_TIME';
export const INTERNAL_LOG_PATH_ENV = 'GENIE_AGENT_LOG_FILE';
// Propagate the pre-assigned session ID to the background runner so it updates
// the same store entry instead of creating a duplicate.
export const INTERNAL_SESSION_ID_ENV = 'GENIE_AGENT_SESSION_ID';
export const INTERNAL_BACKGROUND_MARKER_ENV = 'GENIE_INTERNAL_BACKGROUND';

export interface BackgroundLaunchOptions {
  rawArgs?: string[];
  startTime?: number;
  logFile?: string;
  backgroundConfig?: {
    enabled?: boolean;
    detach?: boolean;
  };
  scriptPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface BackgroundMetadata {
  pid: number;
  rawArgs: string[];
  logFile?: string;
  startTime: number;
  launchedAt: Date;
  detach: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  exitedAt?: Date;
  error?: Error;
}

export class BackgroundManager extends EventEmitter {
  private readonly execPath: string;
  private readonly children: Map<number, BackgroundMetadata> = new Map();

  constructor(options: { execPath?: string } = {}) {
    super();
    this.execPath = options.execPath || process.execPath;
  }

  launch(options: BackgroundLaunchOptions = {}): number {
    const {
      rawArgs = [],
      startTime = Date.now(),
      logFile,
      backgroundConfig = {},
      scriptPath,
      env: extraEnv = {}
    } = options;

    if (!backgroundConfig || backgroundConfig.enabled === false) {
      throw new Error('Background execution is disabled in configuration.');
    }
    if (!scriptPath) {
      throw new Error('BackgroundManager.launch requires a scriptPath.');
    }

    const spawnEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...extraEnv,
      [INTERNAL_BACKGROUND_ENV]: '1',
      [INTERNAL_BACKGROUND_MARKER_ENV]: '1',
      [INTERNAL_START_TIME_ENV]: String(startTime),
      [INTERNAL_LOG_PATH_ENV]: logFile ?? ''
    };

    const spawnOptions: SpawnOptionsWithoutStdio = {
      detached: Boolean(backgroundConfig.detach),
      // TypeScript's Node types express stdio as tuples; cast keeps the intent clear.
      stdio: (backgroundConfig.detach ? 'ignore' : 'inherit') as any,
      env: spawnEnv
    };

    const child = spawn(this.execPath, [scriptPath, ...rawArgs], spawnOptions);

    if (!child.pid) {
      throw new Error('Failed to spawn background process.');
    }

    const metadata: BackgroundMetadata = {
      pid: child.pid,
      rawArgs: [...rawArgs],
      logFile,
      startTime,
      launchedAt: new Date(),
      detach: Boolean(backgroundConfig.detach)
    };

    this.children.set(child.pid, metadata);

    child.on('exit', (code, signal) => {
      metadata.exitCode = code;
      metadata.signal = signal;
      metadata.exitedAt = new Date();
      this.children.delete(child.pid!);
      this.emit('exit', metadata);
    });

    child.on('error', (error: Error | null) => {
      const errInstance = error ?? new Error('Unknown background error');
      metadata.error = errInstance;
      this.emit('error', metadata, errInstance);
    });

    if (backgroundConfig.detach) {
      child.unref();
    }

    return child.pid;
  }

  stop(pid: number, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (!pid || typeof pid !== 'number') return false;
    try {
      process.kill(pid, signal);
      return true;
    } catch (error: unknown) {
      if (isErrnoException(error) && error.code === 'ESRCH') return false;
      throw error;
    }
  }

  isAlive(pid?: number | null): boolean {
    if (!pid || typeof pid !== 'number') return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: unknown) {
      if (isErrnoException(error) && error.code === 'EPERM') return true;
      return false;
    }
  }

  get(pid: number): BackgroundMetadata | null {
    return this.children.get(pid) ?? null;
  }

  list(): BackgroundMetadata[] {
    return Array.from(this.children.values());
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

export default BackgroundManager;
