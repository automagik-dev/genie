declare module 'pgserve' {
  interface MultiTenantServerOptions {
    port?: number;
    host?: string;
    baseDir?: string | null;
    logLevel?: string;
    autoProvision?: boolean;
    maxConnections?: number;
    enablePgvector?: boolean;
    useRam?: boolean;
    syncTo?: string | null;
    syncDatabases?: string | null;
  }

  interface MultiTenantRouter {
    stop(): Promise<void>;
    getStats(): {
      port: number;
      host: string;
      pgPort: number;
      activeConnections: number;
      postgres: unknown;
    };
    listDatabases(): string[];
  }

  export function startMultiTenantServer(options?: MultiTenantServerOptions): Promise<MultiTenantRouter>;
}
