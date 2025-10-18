import fs from 'fs';
import path from 'path';
import { spawn, SpawnOptionsWithoutStdio } from 'child_process';
import type { HandlerContext } from '../context';
import type { GenieConfig, AgentSpec, CLIOptions, ConfigPaths } from '../types';
import type { SessionStore, SessionEntry } from '../../session-store';
import type { Executor, ExecutorCommand } from '../../executors/types';
import {
  buildBackgroundPendingView,
  buildBackgroundStartView,
  buildBackgroundStartingView,
  buildRunCompletionView
} from '../../views/background';
import { transformDisplayPath } from '../../lib/display-transform';
import { INTERNAL_SESSION_ID_ENV, INTERNAL_START_TIME_ENV, INTERNAL_LOG_PATH_ENV } from '../../lib/constants';

export interface ExecuteRunArgs {
  agentName: string;
  command: ExecutorCommand;
  executorKey: string;
  executor: Executor;
  executorConfig: any;
  executorPaths: any;
  prompt: string;
  store: SessionStore;
  entry: SessionEntry;
  paths: Required<ConfigPaths>;
  config: GenieConfig;
  startTime: number;
  logFile: string;
  background: boolean;
  runnerPid: number | null;
  cliOptions: CLIOptions;
  executionMode: string;
}

export interface BackgroundLaunchArgs {
  parsed: { options: CLIOptions };
  config: GenieConfig;
  paths: Required<ConfigPaths>;
  store: SessionStore;
  entry: SessionEntry;
  agentName: string;
  executorKey: string;
  executionMode: string;
  startTime: number;
  logFile: string;
  allowResume: boolean;
  prompt?: string;  // Optional for Forge executor
}

export function applyStoreMerge(target: SessionStore, next: SessionStore): void {
  target.version = next.version;
  target.sessions = next.sessions;
}

export async function persistStore(ctx: HandlerContext, store: SessionStore): Promise<void> {
  const result = await ctx.sessionService.save(store);
  applyStoreMerge(store, result.store);
}

export function resolveExecutorKey(ctx: HandlerContext, modeName: string): string {
  const config = ctx.config;
  const modes = config.executionModes || config.presets || {};
  const mode = modes[modeName];
  if (mode && mode.executor) return mode.executor;
  if (config.defaults && config.defaults.executor) return config.defaults.executor;
  return ctx.defaultExecutorKey;
}

export function requireExecutor(ctx: HandlerContext, key: string): Executor {
  const executor = ctx.executors[key];
  if (!executor) {
    const available = Object.keys(ctx.executors).join(', ') || 'none';
    throw new Error(`Executor '${key}' not found. Available executors: ${available}`);
  }
  return executor;
}

export function buildExecutorConfig(
  ctx: HandlerContext,
  modeName: string,
  executorKey: string,
  agentOverrides: any
): any {
  const { config } = ctx;
  const base = deepClone((config.executors && config.executors[executorKey]) || {});
  const modes = config.executionModes || config.presets || {};
  const mode = modes[modeName];
  if (!mode && modeName && modeName !== 'default') {
    const available = Object.keys(modes).join(', ') || 'default';
    throw new Error(`Execution mode '${modeName}' not found. Available modes: ${available}`);
  }
  const overrides = getExecutorOverrides(mode, executorKey);
  let merged = mergeDeep(base, overrides);
  if (agentOverrides && Object.keys(agentOverrides).length) {
    merged = mergeDeep(merged, agentOverrides);
  }
  return merged;
}

export function extractExecutorOverrides(ctx: HandlerContext, agentGenie: any, executorKey: string): any {
  if (!agentGenie || typeof agentGenie !== 'object') return {};
  const {
    executor,
    background: _background,
    preset: _preset,
    mode: _mode,
    executionMode: _executionMode,
    json: _json,
    ...rest
  } = agentGenie;
  const overrides: Record<string, any> = {};
  const executorDef = ctx.executors[executorKey]?.defaults;
  const topLevelKeys = executorDef ? new Set(Object.keys(executorDef)) : null;

  Object.entries(rest || {}).forEach(([key, value]) => {
    if (key === 'json') return;
    if (key === 'exec' || key === 'resume') {
      overrides[key] = mergeDeep(overrides[key], deepClone(value));
      return;
    }
    if (topLevelKeys && topLevelKeys.has(key)) {
      overrides[key] = mergeDeep(overrides[key], deepClone(value));
      return;
    }
    if (!overrides.exec) overrides.exec = {};
    overrides.exec[key] = mergeDeep(overrides.exec[key], deepClone(value));
  });

  return overrides;
}

export function resolveExecutorPaths(paths: Required<ConfigPaths>, executorKey: string): any {
  if (!paths.executors) return {};
  return paths.executors[executorKey] || {};
}

export function deepClone<T>(input: T): T {
  return JSON.parse(JSON.stringify(input)) as T;
}

export function mergeDeep(target: any, source: any): any {
  if (source === null || source === undefined) return target;
  if (Array.isArray(source)) {
    return source.slice();
  }
  if (typeof source !== 'object') {
    return source;
  }
  const base = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  Object.entries(source).forEach(([key, value]) => {
    base[key] = mergeDeep(base[key], value);
  });
  return base;
}

function getExecutorOverrides(mode: any, executorKey: string): any {
  if (!mode || !mode.overrides) return {};
  const { overrides } = mode;
  if (overrides.executors && overrides.executors[executorKey]) {
    return overrides.executors[executorKey];
  }
  if (overrides[executorKey]) {
    return overrides[executorKey];
  }
  return overrides;
}

export function resolveAgentIdentifier(input: string): string {
  const trimmed = (input || '').trim();
  if (!trimmed) {
    throw new Error('Agent id is required');
  }
  const normalized = trimmed.replace(/\.md$/i, '');
  const normalizedLower = normalized.toLowerCase();

  const directCandidates = [normalized, normalizedLower];
  for (const candidate of directCandidates) {
    if (agentExists(candidate)) return candidate.replace(/\\/g, '/');
  }

  const agents = listAgents();
  const byExactId = agents.find((agent) => agent.id.toLowerCase() === normalizedLower);
  if (byExactId) return byExactId.id;

  const byLabel = agents.find((agent) => agent.label.toLowerCase() === normalizedLower);
  if (byLabel) return byLabel.id;

  const legacy = normalizedLower.replace(/^genie-/, '').replace(/^template-/, '');
  const legacyCandidates = [legacy, `core/${legacy}`, `specialized/${legacy}`];
  for (const candidate of legacyCandidates) {
    if (agentExists(candidate)) return candidate;
  }

  if (normalizedLower === 'forge-master' && agentExists('forge')) return 'forge';

  throw new Error(`❌ Agent '${input}' not found. Try 'genie list agents' to see available ids.`);
}

interface ListedAgent {
  id: string;
  displayId: string;
  label: string;
  meta: any;
  folder: string | null;
}

// transformDisplayPath imported from ../../lib/display-transform (single source of truth)

export function listAgents(): ListedAgent[] {
  const baseDir = '.genie/agents';
  const records: ListedAgent[] = [];
  if (!fs.existsSync(baseDir)) return records;
  const visit = (dirPath: string, relativePath: string | null) => {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    entries.forEach((entry) => {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath, relativePath ? path.join(relativePath, entry.name) : entry.name);
        return;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'README.md') return;
      const rawId = relativePath ? path.join(relativePath, entry.name) : entry.name;
      const normalizedId = rawId.replace(/\.md$/i, '').split(path.sep).join('/');
      const content = fs.readFileSync(entryPath, 'utf8');
      const { meta } = extractFrontMatter(content, () => {});
      const metaObj = meta || {};
      if (metaObj.hidden === true || metaObj.disabled === true) return;

      // Transform display path (strip template/category folders)
      const { displayId, displayFolder } = transformDisplayPath(normalizedId);
      const label = (metaObj.name || displayId.split('/').pop() || displayId).trim();

      records.push({ id: normalizedId, displayId, label, meta: metaObj, folder: displayFolder });
    });
  };

  visit(baseDir, null);
  return records;
}

export function agentExists(id: string): boolean {
  if (!id) return false;
  const normalized = id.replace(/\\/g, '/');
  const file = path.join('.genie', 'agents', `${normalized}.md`);
  return fs.existsSync(file);
}

export function loadAgentSpec(ctx: HandlerContext, name: string): AgentSpec {
  const base = name.endsWith('.md') ? name.slice(0, -3) : name;
  const agentPath = path.join('.genie', 'agents', `${base}.md`);
  if (!fs.existsSync(agentPath)) {
    throw new Error(`❌ Agent '${name}' not found in .genie/agents`);
  }
  const content = fs.readFileSync(agentPath, 'utf8');
  const { meta, body } = extractFrontMatter(content, ctx.recordStartupWarning);
  return {
    meta,
    instructions: body.replace(/^(\r?\n)+/, '')
  };
}

export function extractFrontMatter(source: string, onWarning: (message: string) => void): { meta?: Record<string, any>; body: string } {
  if (!source.startsWith('---')) {
    return { meta: {}, body: source };
  }
  const end = source.indexOf('\n---', 3);
  if (end === -1) {
    return { meta: {}, body: source };
  }
  const raw = source.slice(3, end).trim();
  const body = source.slice(end + 4);
  try {
    const YAML = require('yaml');
    const parsed = YAML.parse(raw) || {};
    return { meta: parsed, body };
  } catch {
    onWarning('[genie] YAML module unavailable or failed to parse; front matter metadata ignored.');
    return { meta: {}, body };
  }
}

export function deriveStartTime(): number {
  const fromEnv = process.env[INTERNAL_START_TIME_ENV];
  if (!fromEnv) return Date.now();
  const parsed = Number(fromEnv);
  if (Number.isFinite(parsed)) return parsed;
  return Date.now();
}

export function sanitizeLogFilename(agentName: string): string {
  const fallback = 'agent';
  if (!agentName || typeof agentName !== 'string') return fallback;
  const normalized = agentName
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/\.+/g, '.')
    .replace(/^-+|-+$/g, '')
    .replace(/^\.+|\.+$/g, '');
  return normalized.length ? normalized : fallback;
}

export function deriveLogFile(agentName: string, startTime: number, paths: Required<ConfigPaths>): string {
  const envPath = process.env[INTERNAL_LOG_PATH_ENV];
  if (envPath) return envPath;
  const filename = `${sanitizeLogFilename(agentName)}-${startTime}.log`;
  return path.join(paths.logsDir || '.genie/state/agents/logs', filename);
}

export async function maybeHandleBackgroundLaunch(ctx: HandlerContext, params: BackgroundLaunchArgs): Promise<boolean> {
  const { backgroundManager } = ctx;
  const { parsed, config, paths, store, entry, agentName, executionMode, startTime, logFile } = params;

  if (!parsed.options.background || parsed.options.backgroundRunner) {
    return false;
  }

  // Check if Forge backend is available
  const forgeEnabled = process.env.FORGE_BASE_URL || process.env.GENIE_USE_FORGE === 'true';

  if (forgeEnabled) {
    // Use Forge executor for background sessions
    try {
      const { handleForgeBackgroundLaunch } = require('../../lib/forge-executor');
      const prompt = params.prompt || '';

      const handled = await handleForgeBackgroundLaunch({
        agentName,
        prompt,
        config,
        paths,
        store,
        entry,
        executorKey: params.executorKey,
        executionMode,
        startTime
      });

      if (handled) {
        return true;
      }
      // If Forge fails, fall through to traditional background launcher
      process.stdout.write(`⚠️  Forge backend unavailable, using traditional background launcher\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`⚠️  Forge error: ${message}\n`);
      process.stdout.write(`⚠️  Falling back to traditional background launcher\n`);
    }
  }

  // Traditional background launcher (fallback)
  const runnerPid = backgroundManager.launch({
    rawArgs: parsed.options.rawArgs,
    startTime,
    logFile,
    backgroundConfig: config.background,
    scriptPath: __filename,
    env: entry.sessionId ? { [INTERNAL_SESSION_ID_ENV]: entry.sessionId } : undefined
  });

  entry.runnerPid = runnerPid;
  entry.status = 'running';
  entry.background = parsed.options.background;

  // Use name as key (v3 architecture)
  if (!entry.name) {
    throw new Error('Session name must be set before background launch');
  }
  store.sessions[entry.name] = entry;
  await persistStore(ctx, store);

  process.stdout.write(`▸ Launching ${agentName} in background...\n`);
  process.stdout.write(`▸ Session: ${entry.name}\n\n`);
  process.stdout.write('  View output:\n');
  process.stdout.write(`    npx automagik-genie view ${entry.name}\n\n`);
  process.stdout.write('  Continue conversation:\n');
  process.stdout.write(`    npx automagik-genie resume ${entry.name} "<your message>"\n\n`);
  process.stdout.write('  Stop session:\n');
  process.stdout.write(`    npx automagik-genie stop ${entry.name}\n`);
  return true;
}

export async function executeRun(ctx: HandlerContext, args: ExecuteRunArgs): Promise<void> {
  const {
    agentName,
    command,
    executorKey,
    executor,
    executorConfig,
    executorPaths,
    store,
    entry,
    paths,
    config,
    startTime,
    logFile,
    background,
    runnerPid,
    cliOptions,
    executionMode
  } = args;

  if (!command || typeof command.command !== 'string' || !Array.isArray(command.args)) {
    throw new Error(`Executor '${executorKey}' returned an invalid command configuration.`);
  }

  const logDir = path.dirname(logFile);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  // Debug: log the command being executed
  const fullCommand = `${command.command} ${command.args.join(' ')}`;
  try {
    fs.writeFileSync('/home/namastex/spawn-debug-test.txt', `${fullCommand}\n`, { flag: 'a' });
  } catch (e) {
    // Ignore errors
  }

  const spawnOptions: SpawnOptionsWithoutStdio = {
    stdio: ['ignore', 'pipe', 'pipe'] as any,
    ...(command.spawnOptions || {}),
    cwd: paths.baseDir  // Use workspace root, not inherited process.cwd()
  };
  const proc = spawn(command.command, command.args, spawnOptions);

  entry.status = 'running';
  entry.executorPid = proc.pid || null;
  if (runnerPid) entry.runnerPid = runnerPid;

  // Use name as key (v3 architecture)
  if (!entry.name) {
    throw new Error('Session name must be set before execution');
  }
  store.sessions[entry.name] = entry;
  await persistStore(ctx, store);

  let filteredStdout: NodeJS.ReadWriteStream | null = null;

  if (proc.stdout) {
    if (executor.createOutputFilter) {
      filteredStdout = executor.createOutputFilter(logStream);
      proc.stdout.pipe(filteredStdout);
    } else {
      proc.stdout.pipe(logStream);
    }
  }
  if (proc.stderr) proc.stderr.pipe(logStream);

  const updateSessionFromLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    try {
      const data = JSON.parse(trimmed);
      if (data && typeof data === 'object' && data.type === 'session.created') {
        // MCP might emit session.created event - update lastUsed if needed
        entry.lastUsed = new Date().toISOString();
        void persistStore(ctx, store);
      }
    } catch {
      // ignore malformed JSON lines
    }
  };

  if (proc.stdout) {
    let buffer = '';
    proc.stdout.on('data', (chunk: Buffer | string) => {
      const text = chunk instanceof Buffer ? chunk.toString('utf8') : chunk;
      buffer += text;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        updateSessionFromLine(line);
        index = buffer.indexOf('\n');
      }
    });
  }

  if (!background) {
    if (filteredStdout) {
      filteredStdout.pipe(process.stdout);
    } else if (proc.stdout) {
      proc.stdout.pipe(process.stdout);
    }
    if (proc.stderr) proc.stderr.pipe(process.stderr);
  }

  let settled = false;
  let resolvePromise: () => void = () => {};
  const settle = () => {
    if (!settled) {
      settled = true;
      logStream.end();
      resolvePromise();
    }
  };

  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  proc.on('error', (error) => {
    entry.status = 'failed';
    entry.error = error instanceof Error ? error.message : String(error);
    entry.lastUsed = new Date().toISOString();
    void persistStore(ctx, store);
    const message = error instanceof Error ? error.message : String(error);
    if (!background) {
      void ctx.emitView(
        buildRunCompletionView({
          agentName,
          outcome: 'failure',
          sessionName: entry.name,
          executorKey,
          model: executorConfig.exec?.model || executorConfig.model || null,
          permissionMode: executorConfig.exec?.permissionMode || executorConfig.permissionMode || null,
          sandbox: executorConfig.exec?.sandbox || executorConfig.sandbox || null,
          mode: entry.mode || entry.preset || executionMode,
          background: entry.background,
          exitCode: null,
          durationMs: Date.now() - startTime,
          extraNotes: [`Spawn error: ${message}`]
        }),
        cliOptions
      );
    }
    settle();
  });

  proc.on('close', (code, signal) => {
    entry.exitCode = typeof code === 'number' ? code : null;
    entry.signal = signal || null;
    entry.lastUsed = new Date().toISOString();
    entry.status = code === 0 ? 'completed' : 'failed';
    void persistStore(ctx, store);

    if (!background) {
      const outcome = code === 0 ? 'success' : 'failure';
      const notes = signal ? [`Signal: ${signal}`] : [];
      const envelope = buildRunCompletionView({
        agentName,
        outcome,
        sessionName: entry.name,
        executorKey,
        model: executorConfig.exec?.model || executorConfig.model || null,
        permissionMode: executorConfig.exec?.permissionMode || executorConfig.permissionMode || null,
        sandbox: executorConfig.exec?.sandbox || executorConfig.sandbox || null,
        mode: entry.mode || entry.preset || executionMode,
        background: entry.background,
        exitCode: code,
        durationMs: Date.now() - startTime,
        extraNotes: notes
      });
      void ctx.emitView(envelope, cliOptions).finally(settle);
    } else {
      settle();
    }
  });

  const defaultDelay = (config.background && config.background.sessionExtractionDelayMs) || 5000;
  const sessionDelay = executor.getSessionExtractionDelay
    ? executor.getSessionExtractionDelay({ config: executorConfig, defaultDelay })
    : defaultDelay;

  if (executor.extractSessionId) {
    const retryIntervals = [sessionDelay, 2000, 3000, 3000];
    let retryIndex = 0;

    const attemptExtraction = () => {
      // sessionId already assigned at creation time - just update lastUsed
      entry.lastUsed = new Date().toISOString();
      void persistStore(ctx, store);
    };

    setTimeout(attemptExtraction, retryIntervals[retryIndex++]);
  }

  await promise;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
