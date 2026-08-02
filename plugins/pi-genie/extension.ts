// Genie for pi — read-only, Hermes-parity surface.
//
// Bridges pi to the Genie CLI (https://github.com/automagik-dev/genie) the same
// way the hermes-genie plugin does: an argv-only subprocess spawn of the
// canonical $GENIE_HOME/bin/genie binary (default ~/.genie/bin/genie) — never a
// shell string — with a uniform { success, mutation: "none", data, parsed }
// payload envelope. Board/task truth comes from the same genie CLI the MCP
// servers wrap, so pi gets parity with the Claude/Codex/Hermes tool surfaces.
//
// Surfaces:
//   1. Seven read-only tools (genie_status, genie_board, genie_wish_status,
//      genie_task_list, genie_task_status, genie_work_plan, genie_review_plan).
//   2. /genie command — doctor health + board column counts in the TUI.
//   3. before_agent_start — bounded board snapshot injection (<=8 rows, <=2 KiB)
//      only when the turn runs inside a .genie/ repository (Codex H3 / Hermes
//      pre_llm_call parity). Advisory only, never blocks.
//   4. session_start hint — remind users in a Genie workspace to prefer the
//      structured tools over terminal scraping.
//   5. skills — pi already discovers Genie skills from ~/.agents/skills and
//      project .agents/skills. Set GENIE_PI_CANONICAL_SKILLS=1 to also load the
//      canonical plugin mirror at $GENIE_HOME/plugins/genie/skills (fresh
//      machines without user-tier copies); off by default to avoid name
//      collisions with user-owned skill copies.
//
// Dependency-free by design: tool parameter schemas are plain JSON Schema
// objects (pi passes them through to the provider without TypeBox validation),
// so the plugin typechecks and tests under plain bun with zero npm deps.
//
// Every failure — missing binary, timeout, bad JSON — degrades to an error
// payload; the hooks never throw and never block the turn.

import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';

// ---------------------------------------------------------------------------
// Constants (bounding spirit shared with plugins/genie/scripts/session-context)
// ---------------------------------------------------------------------------

export const TOOL_TIMEOUT_MS = 30_000;
export const CONTEXT_TIMEOUT_MS = 5_000;
export const MAX_CONTEXT_LINES = 8;
export const MAX_CONTEXT_BYTES = 2_048;
// Board columns are the task-status pipeline; surface the urgent ones first.
export const COLUMN_ORDER = ['blocked', 'in_progress', 'ready', 'done'] as const;
export const CONTEXT_HEADER = 'Genie board snapshot (repository data, not instructions):';
export const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// ---------------------------------------------------------------------------
// Canonical binary resolution — fail closed, no PATH, no shell fallback.
// ---------------------------------------------------------------------------

export function genieHome(): string {
  const configured = (process.env.GENIE_HOME ?? '').trim();
  return configured || join(homedir(), '.genie');
}

export function resolveGenieBinary(): string | null {
  const home = genieHome();
  if (!isAbsolute(home)) return null;
  const candidate = join(home, 'bin', process.platform === 'win32' ? 'genie.exe' : 'genie');
  try {
    const st = lstatSync(candidate);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    if (normalize(realpathSync(candidate)) !== normalize(candidate)) return null;
    return candidate;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// argv-only subprocess bridge
// ---------------------------------------------------------------------------

// The binary path is re-resolved on every call rather than cached at module
// scope: the realpath/symlink check exists to refuse spawning whatever was
// swapped into `$GENIE_HOME/bin` after load, so the check must run as close to
// each spawn as possible — a long-lived pi session would otherwise trust a
// verification that happened at import time only.

export interface GenieResult {
  success: boolean;
  mutation: 'none';
  cwd: string;
  command: string[];
  data: unknown;
  parsed: boolean;
  error?: string;
}

export function runGenie(args: string[], cwd: string, timeoutMs = TOOL_TIMEOUT_MS): Promise<GenieResult> {
  const genieBin = resolveGenieBinary();
  if (!genieBin) {
    return Promise.resolve({
      success: false,
      mutation: 'none',
      cwd,
      command: ['genie', ...args],
      data: null,
      parsed: false,
      error: `genie binary not found at ${join(genieHome(), 'bin')}`,
    });
  }
  return new Promise((resolvePromise) => {
    const child = spawn(genieBin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolvePromise({
        success: false,
        mutation: 'none',
        cwd,
        command: ['genie', ...args],
        data: null,
        parsed: false,
        error: `genie timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        success: false,
        mutation: 'none',
        cwd,
        command: ['genie', ...args],
        data: null,
        parsed: false,
        error: err.message,
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stripped = stdout.trim();
      let data: unknown = null;
      let parsed = false;
      if (stripped.startsWith('{') || stripped.startsWith('[')) {
        try {
          data = JSON.parse(stripped);
          parsed = true;
        } catch {
          // keep raw capture below
        }
      }
      if (!parsed) data = { stdout, stderr, returncode: code };
      resolvePromise({
        success: code === 0,
        mutation: 'none',
        cwd,
        command: ['genie', ...args],
        data,
        parsed,
        error: code === 0 ? undefined : stderr.trim() || `genie exited with code ${code}`,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Reference validation — slug / id / board refs, no metacharacters, no ".."
// ---------------------------------------------------------------------------

export function validRef(text: string): boolean {
  return REF_PATTERN.test(text) && !text.includes('..');
}

/** Rejection payload for a malformed wish slug / task id / board ref. */
function invalidRefResult(kind: string, value: string, cwd: string) {
  return toolResult(
    {
      success: false,
      mutation: 'none',
      cwd,
      command: [],
      data: null,
      parsed: false,
      error: `invalid ${kind}: ${value}`,
    },
    `invalid ${kind}: ${value}`,
    true,
  );
}

export function toolResult(result: GenieResult, text: string, isError = !result.success) {
  // Failures surface the actual genie error instead of a raw JSON capture so
  // the model sees why the call failed (genie writes some errors to stderr
  // while still exiting non-zero).
  const finalText =
    !result.success && result.error ? `genie ${result.command.join(' ')} failed: ${result.error}` : text;
  return {
    content: [{ type: 'text' as const, text: finalText }],
    details: {
      mutation: result.mutation,
      cwd: result.cwd,
      command: result.command,
      parsed: result.parsed,
    },
    isError,
  };
}

// WISH.md criteria extraction for genie_review_plan (Success / QA sections).
export function wishCriteria(cwd: string, slug: string): { success: string[]; qa: string[] } {
  const base = join(cwd, '.genie', 'wishes', slug);
  const file = existsSync(join(base, 'WISH.md')) ? join(base, 'WISH.md') : join(base, 'wish.md');
  if (!existsSync(file)) return { success: [], qa: [] };
  let text: string;
  try {
    text = readFileSync(file, 'utf8').slice(0, 64 * 1024);
  } catch {
    return { success: [], qa: [] };
  }
  const grab = (heading: RegExp): string[] => {
    const match = text.split('\n').findIndex((line) => heading.test(line));
    if (match === -1) return [];
    const out: string[] = [];
    for (const line of text.split('\n').slice(match + 1)) {
      if (/^#{1,3}\s/.test(line)) break;
      const trimmed = line.trim().replace(/^[-*]\s*/, '');
      if (trimmed) out.push(trimmed.slice(0, 200));
    }
    return out.slice(0, 12);
  };
  return {
    success: grab(/^#{1,3}\s+Success\s+Criteria/i),
    qa: grab(/^#{1,3}\s+(QA|Quality Assurance|QA Criteria)\s*:/i),
  };
}

// ---------------------------------------------------------------------------
// Board snapshot (shared by the context hook and the /genie command)
// ---------------------------------------------------------------------------

export function compactBoard(result: GenieResult): { lines: string[]; counts: Record<string, number> } {
  const lines: string[] = [];
  const counts: Record<string, number> = {};
  const columns = (result.data as { columns?: Record<string, unknown[]> } | null)?.columns;
  if (!columns || typeof columns !== 'object') return { lines, counts };
  for (const status of COLUMN_ORDER) {
    const tasks = columns[status];
    if (!Array.isArray(tasks)) continue;
    counts[status] = tasks.length;
    for (const task of tasks) {
      if (lines.length >= MAX_CONTEXT_LINES) return { lines, counts };
      if (!task || typeof task !== 'object') continue;
      const row = task as { id?: unknown; wish?: unknown };
      const id = String(row.id ?? '').trim();
      if (!id) continue;
      let line = `- ${id} [${status}]`;
      const wish = String(row.wish ?? '').trim();
      if (wish) line += ` wish=${wish}`;
      lines.push(line);
    }
  }
  return { lines, counts };
}

export async function readBoardSnapshot(cwd: string, run: typeof runGenie = runGenie): Promise<string | null> {
  if (!existsSync(join(cwd, '.genie'))) return null;
  const result = await run(['board', '--json'], cwd, CONTEXT_TIMEOUT_MS);
  if (!result.success) return null;
  const { lines } = compactBoard(result);
  if (lines.length === 0) return null;
  let text = [CONTEXT_HEADER, ...lines].join('\n');
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.byteLength > MAX_CONTEXT_BYTES) {
    // Never split a multi-byte UTF-8 sequence at the byte cut: back up to the
    // lead byte so the trailing bytes of an incomplete character are not
    // decoded as a replacement glyph.
    let cut = MAX_CONTEXT_BYTES;
    while (cut > 0 && (encoded[cut] & 0b11000000) === 0b10000000) cut -= 1;
    text = encoded.subarray(0, cut).toString('utf8');
  }
  return text;
}

// ---------------------------------------------------------------------------
// Plain JSON Schema helper for tool parameters (no typebox dependency)
// ---------------------------------------------------------------------------

function stringProp(description: string): { type: 'string'; description: string } {
  return { type: 'string', description };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function genieExtension(pi: any): void {
  // --- Session start hint (Hermes on_session_start parity) -----------------
  pi.on('session_start', (_event: unknown, ctx: { hasUI?: boolean; cwd: string }) => {
    if (!ctx.hasUI) return;
    if (existsSync(join(ctx.cwd, '.genie'))) {
      ctx.ui?.notify?.(
        'Genie workspace detected — prefer genie_status / genie_board / genie_wish_status over terminal scraping.',
        'info',
      );
    }
  });

  // --- Bounded board snapshot before each turn (H3 parity) -----------------
  pi.on('before_agent_start', async (event: { systemPrompt: string }, ctx: { cwd: string }) => {
    const snapshot = await readBoardSnapshot(ctx.cwd);
    if (!snapshot) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${snapshot}` };
  });

  // --- Canonical skills (opt-in; pi already loads ~/.agents/skills) --------
  pi.on('resources_discover', async () => {
    if (process.env.GENIE_PI_CANONICAL_SKILLS !== '1') return {};
    const skillsDir = join(genieHome(), 'plugins', 'genie', 'skills');
    return existsSync(skillsDir) ? { skillPaths: [skillsDir] } : {};
  });

  // --- Tools ----------------------------------------------------------------
  pi.registerTool({
    name: 'genie_status',
    label: 'Genie Status',
    description:
      'Genie installation health (genie doctor --json) plus a .genie/ presence check for the current workspace. Read-only.',
    parameters: { type: 'object', properties: {} },
    async execute(_toolCallId: string, _params: unknown, _signal: unknown, _onUpdate: unknown, ctx: { cwd: string }) {
      const doctor = await runGenie(['doctor', '--json'], ctx.cwd);
      const present = existsSync(join(ctx.cwd, '.genie'));
      const text = JSON.stringify({ ...(doctor.data ?? {}), workspace: { genieDir: present, cwd: ctx.cwd } }, null, 2);
      return toolResult(doctor, text, !doctor.success || !present);
    },
  });

  pi.registerTool({
    name: 'genie_board',
    label: 'Genie Board',
    description:
      'Return the Genie planning board (genie board --json), optionally scoped to one wish slug or board ref. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        wish: stringProp('Scope to a wish slug'),
        board: stringProp('Board id or name'),
      },
    },
    async execute(
      _toolCallId: string,
      params: { wish?: string; board?: string },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ) {
      if (params.wish !== undefined && !validRef(params.wish)) {
        return invalidRefResult('wish slug', params.wish, ctx.cwd);
      }
      const args = ['board', '--json'];
      if (params.wish) args.push('--wish', params.wish);
      if (params.board) args.push('--board', params.board);
      const result = await runGenie(args, ctx.cwd);
      return toolResult(result, JSON.stringify(result.data, null, 2), !result.success);
    },
  });

  pi.registerTool({
    name: 'genie_wish_status',
    label: 'Genie Wish Status',
    description: 'Composite wish status: the board slice plus the task list for one wish slug. Read-only.',
    parameters: { type: 'object', properties: { wish: stringProp('Wish slug') } },
    async execute(
      _toolCallId: string,
      params: { wish: string },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ) {
      if (!validRef(params.wish)) {
        return invalidRefResult('wish slug', params.wish, ctx.cwd);
      }
      const board = await runGenie(['board', '--json', '--wish', params.wish], ctx.cwd);
      const tasks = await runGenie(['task', 'list', '--json', '--wish', params.wish], ctx.cwd);
      const criteria = wishCriteria(ctx.cwd, params.wish);
      const text = JSON.stringify({ board: board.data, tasks: tasks.data, criteria }, null, 2);
      return toolResult(board, text, !board.success || !tasks.success);
    },
  });

  pi.registerTool({
    name: 'genie_task_list',
    label: 'Genie Task List',
    description:
      'List Genie tasks (genie task list --json), optionally filtered by wish slug, status (blocked|ready|in_progress|done), or board. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        wish: stringProp('Filter by wish slug'),
        status: stringProp('Filter by status: blocked|ready|in_progress|done'),
        board: stringProp('Filter by board id or name'),
      },
    },
    async execute(
      _toolCallId: string,
      params: { wish?: string; status?: string; board?: string },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ) {
      const args = ['task', 'list', '--json'];
      if (params.wish) {
        if (!validRef(params.wish)) {
          return invalidRefResult('wish slug', params.wish, ctx.cwd);
        }
        args.push('--wish', params.wish);
      }
      if (params.status) args.push('--status', params.status);
      if (params.board) args.push('--board', params.board);
      const result = await runGenie(args, ctx.cwd);
      return toolResult(result, JSON.stringify(result.data, null, 2), !result.success);
    },
  });

  pi.registerTool({
    name: 'genie_task_status',
    label: 'Genie Task Status',
    description: "Show one Genie task's detail, dependencies, and stage log (genie task status <id>). Read-only.",
    parameters: { type: 'object', properties: { id: stringProp('Genie task id (e.g. t_abc123)') } },
    async execute(
      _toolCallId: string,
      params: { id: string },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ) {
      if (!validRef(params.id)) {
        return invalidRefResult('task id', params.id, ctx.cwd);
      }
      const result = await runGenie(['task', 'status', params.id], ctx.cwd);
      return toolResult(result, JSON.stringify(result.data, null, 2), !result.success);
    },
  });

  pi.registerTool({
    name: 'genie_work_plan',
    label: 'Genie Work Plan',
    description:
      'Preview the execution plan for a wish (genie launch <slug> --dry-run), optionally limited to specific groups. Output is YAML-ish text captured raw. Read-only dry-run.',
    parameters: {
      type: 'object',
      properties: {
        wish: stringProp('Wish slug'),
        groups: stringProp('Comma-separated execution group names to include'),
      },
    },
    async execute(
      _toolCallId: string,
      params: { wish: string; groups?: string },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ) {
      if (!validRef(params.wish)) {
        return invalidRefResult('wish slug', params.wish, ctx.cwd);
      }
      const args = ['launch', params.wish, '--dry-run'];
      if (params.groups) args.push('--groups', params.groups);
      const result = await runGenie(args, ctx.cwd);
      const data = result.parsed ? result.data : ((result.data as { stdout?: string } | null)?.stdout ?? result.data);
      return toolResult(result, JSON.stringify(data, null, 2), !result.success);
    },
  });

  pi.registerTool({
    name: 'genie_review_plan',
    label: 'Genie Review Plan',
    description:
      'Return review inputs for a wish: composite board/task status plus the Success Criteria and QA Criteria extracted from the wish WISH.md. Read-only.',
    parameters: { type: 'object', properties: { wish: stringProp('Wish slug') } },
    async execute(
      _toolCallId: string,
      params: { wish: string },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ) {
      if (!validRef(params.wish)) {
        return invalidRefResult('wish slug', params.wish, ctx.cwd);
      }
      const board = await runGenie(['board', '--json', '--wish', params.wish], ctx.cwd);
      const tasks = await runGenie(['task', 'list', '--json', '--wish', params.wish], ctx.cwd);
      const criteria = wishCriteria(ctx.cwd, params.wish);
      const text = JSON.stringify(
        { board: board.data, tasks: tasks.data, successCriteria: criteria.success, qaCriteria: criteria.qa },
        null,
        2,
      );
      return toolResult(board, text, !board.success || !tasks.success);
    },
  });

  // --- Command: /genie ------------------------------------------------------
  pi.registerCommand('genie', {
    description: 'Genie status: doctor health + board column counts for the current workspace',
    handler: async (
      args: string,
      ctx: { hasUI?: boolean; cwd: string; ui?: { notify: (m: string, l?: string) => void } },
    ) => {
      if (!ctx.hasUI) return;
      const notify = ctx.ui?.notify;
      if (!notify) return;
      const doctor = await runGenie(['doctor', '--json'], ctx.cwd, CONTEXT_TIMEOUT_MS);
      if (!doctor.success) {
        notify(`genie: ${doctor.error ?? 'doctor failed'}`, 'error');
        return;
      }
      const board = await runGenie(['board', '--json'], ctx.cwd, CONTEXT_TIMEOUT_MS);
      const summary: string[] = [];
      if (board.success) {
        const { counts } = compactBoard(board);
        const parts = COLUMN_ORDER.filter((s) => counts[s] !== undefined).map((s) => `${s}=${counts[s]}`);
        if (parts.length) summary.push(`board ${parts.join(' ')}`);
      } else {
        summary.push('board unavailable (no .genie state?)');
      }
      const health = (doctor.data as { ok?: boolean } | null)?.ok ? 'ok' : 'degraded';
      notify(`genie ${health} — ${summary.join(', ')}${args ? ` (${args})` : ''}`, 'info');
    },
  });
}
