/**
 * Custom Logger for Forge MCP Server
 * Integrates with FastMCP logging system
 */

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

export class ForgeLogger implements Logger {
  constructor(private prefix: string = '[Forge MCP]') {}

  info(message: string, meta?: Record<string, unknown>): void {
    console.error(`${this.prefix} ℹ️  ${message}`, meta ? JSON.stringify(meta, null, 2) : '');
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    console.error(`${this.prefix} ⚠️  ${message}`, meta ? JSON.stringify(meta, null, 2) : '');
  }

  error(message: string, meta?: Record<string, unknown>): void {
    console.error(`${this.prefix} ❌ ${message}`, meta ? JSON.stringify(meta, null, 2) : '');
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    if (process.env.DEBUG) {
      console.error(`${this.prefix} 🐛 ${message}`, meta ? JSON.stringify(meta, null, 2) : '');
    }
  }
}
