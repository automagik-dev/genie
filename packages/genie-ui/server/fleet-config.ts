// fleet-config.ts — loads and normalizes the fleet source of truth (fleet.json).
//
// SEAM: this is the ONLY module that reads pane definitions. The genie orchestration
// lane (G2) extends PaneSpec with genie keys ({ wishId, role }) and this loader
// surfaces them — no other module changes to carry richer fleet data. Pure config:
// no PTY, no ACP, no DB imports.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(HERE, '..', 'fleet.json');

/** One agent's real terminal face. */
export interface PaneSpec {
  /** Stable identity, used as the transport channel key. */
  id: string;
  /** Human label for the tab. */
  name: string;
  /** SEAM (genie): fleet role — author / reviewer / coder / remote / ... */
  role: string | null;
  /** SEAM (genie): the wish this pane is hired onto (G2 binds it). */
  wishId: string | null;
  /** Executable to spawn under a PTY. */
  command: string;
  /** argv for the command. */
  args: string[];
  /** Working dir ('~' expands to home). */
  cwd: string;
  /** Extra env, merged over process.env. */
  env: Record<string, string>;
  cols: number;
  rows: number;
}

interface RawPane {
  id: string;
  name?: string;
  role?: string;
  wish_id?: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

interface RawFleet {
  defaults?: { cwd?: string; cols?: number; rows?: number };
  panes?: RawPane[];
}

/** Expand a leading '~' to the user's home directory. */
function expandHome(p: string): string {
  if (!p || p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

/** Load + normalize the fleet spec, applying defaults. */
export function loadFleet(configPath: string = CONFIG_PATH): PaneSpec[] {
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as RawFleet;
  const defaults = raw.defaults ?? {};
  return (raw.panes ?? []).map((p) => ({
    id: p.id,
    name: p.name ?? p.id,
    role: p.role ?? null,
    wishId: p.wish_id ?? null,
    command: p.command,
    args: Array.isArray(p.args) ? p.args : [],
    cwd: expandHome(p.cwd ?? defaults.cwd ?? '~'),
    env: p.env ?? {},
    cols: p.cols ?? defaults.cols ?? 100,
    rows: p.rows ?? defaults.rows ?? 30,
  }));
}

export { CONFIG_PATH };
