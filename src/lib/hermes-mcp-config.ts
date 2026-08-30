import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

export class HermesConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'HermesConfigError';
    this.code = code;
  }
}

export interface RetireMcpGenieResult {
  status: 'updated' | 'unchanged';
  path: string;
  backupPath?: string;
}

interface RetireMcpGenieOptions {
  configPath: string;
  now?: Date;
}

const MARKER_BEGIN = '# genie:managed:mcp_servers.genie — begin (managed by genie; edit via genie only)';
const MARKER_END = '# genie:managed:mcp_servers.genie — end';

/** Remove only Genie's marker-owned historical Hermes route, preserving all other bytes. */
export function retireMcpServersGenie(opts: RetireMcpGenieOptions): RetireMcpGenieResult {
  if (!existsSync(opts.configPath)) return { status: 'unchanged', path: opts.configPath };
  const original = readFileSync(opts.configPath, 'utf8');
  const lines = original.split('\n');
  const begins = lines.flatMap((line, index) => (line.trim() === MARKER_BEGIN ? [index] : []));
  const ends = lines.flatMap((line, index) => (line.trim() === MARKER_END ? [index] : []));
  if (begins.length !== ends.length || begins.length > 1 || (begins[0] !== undefined && begins[0] >= (ends[0] ?? -1))) {
    throw new HermesConfigError(
      'ambiguous-managed-marker',
      `expected exactly one complete Genie MCP marker pair, found ${begins.length} begin and ${ends.length} end markers`,
    );
  }
  if (begins.length === 0) return { status: 'unchanged', path: opts.configPath };
  const next = [...lines.slice(0, begins[0]), ...lines.slice((ends[0] ?? begins[0]) + 1)].join('\n');
  const backupPath = `${opts.configPath}.genie-backup-${(opts.now ?? new Date()).toISOString().replaceAll(':', '-').replaceAll('.', '-')}`;
  copyFileSync(opts.configPath, backupPath);
  writeFileSync(opts.configPath, next, 'utf8');
  return { status: 'updated', path: opts.configPath, backupPath };
}

/** Detect duplicate direct `genie:` children under a block-style top-level `mcp_servers:` key. */
export function hasDuplicateMcpGenieKeys(text: string): boolean {
  const lines = text.split('\n');
  let inServers = false;
  let childIndent: number | null = null;
  let count = 0;
  for (const line of lines) {
    const content = line.trim();
    if (content === '' || content.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (!inServers) {
      if (indent === 0 && content === 'mcp_servers:') inServers = true;
      continue;
    }
    if (indent === 0) break;
    if (childIndent === null) childIndent = indent;
    if (indent === childIndent && /^genie\s*:/.test(content)) count += 1;
  }
  return count > 1;
}
