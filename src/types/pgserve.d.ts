declare module 'pgserve' {
  export interface PgserveDaemonState {
    running: boolean;
    pid: number | null;
    libpqSocketPresent?: boolean;
    socketPresent?: boolean;
    reason?: string | null;
  }

  export function ensureDaemon(options?: {
    dataDir?: string;
    logLevel?: string;
    timeoutMs?: number;
    controlSocketDir?: string;
  }): Promise<PgserveDaemonState>;
}
