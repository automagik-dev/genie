import fs from 'fs';

export interface SessionEntry {
  agent: string;
  preset?: string;
  mode?: string;
  logFile?: string;
  lastPrompt?: string;
  created?: string;
  lastUsed?: string;
  status?: string;
  background?: boolean;
  runnerPid?: number | null;
  executor?: string;
  executorPid?: number | null;
  exitCode?: number | null;
  signal?: string | null;
  startTime?: string;
  sessionId?: string | null;
  [key: string]: unknown;
}

export interface SessionStore {
  version: number;
  sessions: Record<string, SessionEntry>; // keyed by sessionId, not agent name
  // Legacy format compatibility (will be migrated on load)
  agents?: Record<string, SessionEntry>;
}

export interface SessionPathsConfig {
  sessionsFile?: string;
}

export interface SessionLoadConfig {
  defaults?: {
    executor?: string;
  };
}

export interface SessionDefaults {
  defaults?: {
    executor?: string;
  };
}

export function loadSessions(
  paths: SessionPathsConfig = {},
  config: SessionLoadConfig = {},
  defaults: SessionDefaults = {},
  callbacks: { onWarning?: (message: string) => void } = {}
): SessionStore {
  const storePath = paths.sessionsFile;
  let store: SessionStore;

  if (storePath && fs.existsSync(storePath)) {
    store = normalizeSessionStore(readJson(storePath, callbacks), callbacks);
  } else {
    store = { version: 2, sessions: {} };
  }

  const defaultExecutor = resolveDefaultExecutor(config, defaults);
  return migrateSessionEntries(store, defaultExecutor);
}

export function saveSessions(paths: SessionPathsConfig = {}, store: SessionStore): void {
  if (!paths.sessionsFile) return;
  const payload = JSON.stringify(store, null, 2);
  fs.writeFileSync(paths.sessionsFile, payload);
}

function readJson(filePath: string, callbacks: { onWarning?: (message: string) => void }): unknown {
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.trim().length) return {};
  try {
    return JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    callbacks.onWarning?.(`Could not parse JSON from ${filePath}: ${message}`);
    return {};
  }
}

function normalizeSessionStore(
  data: unknown,
  callbacks: { onWarning?: (message: string) => void } = {}
): SessionStore {
  if (!data || typeof data !== 'object') {
    return { version: 2, sessions: {} };
  }

  const incoming = data as Partial<SessionStore> & {
    agents?: Record<string, SessionEntry>;
    sessions?: Record<string, SessionEntry>;
  };

  // Version 2 format (sessions keyed by sessionId)
  if (incoming.sessions) {
    return {
      version: 2,
      sessions: incoming.sessions
    };
  }

  // Version 1 format (agents keyed by agent name) - MIGRATE
  if (incoming.agents) {
    callbacks.onWarning?.('Migrating sessions.json from v1 (agent-keyed) to v2 (sessionId-keyed)');

    const sessions: Record<string, SessionEntry> = {};
    Object.entries(incoming.agents).forEach(([agentName, entry]) => {
      // Generate sessionId if missing (fallback to agent name for old entries)
      const sessionId = entry.sessionId || `legacy-${agentName}-${Date.now()}`;
      sessions[sessionId] = {
        ...entry,
        agent: agentName,
        sessionId
      };
    });

    return {
      version: 2,
      sessions
    };
  }

  // Empty or malformed
  return {
    version: 2,
    sessions: {}
  };
}

function migrateSessionEntries(store: SessionStore, defaultExecutor: string): SessionStore {
  const result: SessionStore = {
    version: store.version ?? 2,
    sessions: { ...store.sessions }
  };

  // Migrate session entries (apply defaults)
  Object.entries(result.sessions || {}).forEach(([sessionId, entry]) => {
    if (!entry || typeof entry !== 'object') return;
    if (!entry.mode && entry.preset) result.sessions[sessionId].mode = entry.preset;
    if (!entry.preset && entry.mode) result.sessions[sessionId].preset = entry.mode;
    if (!entry.executor) result.sessions[sessionId].executor = defaultExecutor;
  });

  return result;
}

function resolveDefaultExecutor(config: SessionLoadConfig = {}, defaults: SessionDefaults = {}): string {
  return (
    config.defaults?.executor ||
    defaults.defaults?.executor ||
    'codex'
  );
}

export const _internals = {
  readJson,
  normalizeSessionStore,
  migrateSessionEntries,
  resolveDefaultExecutor
};
