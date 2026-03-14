/**
 * Session Store — Named leader session management.
 *
 * Maintains a name→UUID mapping at `~/.genie/sessions.json`.
 * When `genie --session <name>` is invoked:
 *   - First time: creates a new UUID, returns isNew=true
 *   - Subsequent: returns the existing UUID, returns isNew=false
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// ============================================================================
// Types
// ============================================================================

interface SessionEntry {
  uuid: string;
  createdAt: string;
  lastUsedAt: string;
}

interface SessionMap {
  sessions: Record<string, SessionEntry>;
}

// ============================================================================
// Configuration
// ============================================================================

function getSessionsPath(): string {
  return join(process.env.GENIE_HOME ?? join(homedir(), '.genie'), 'sessions.json');
}

// ============================================================================
// Internal
// ============================================================================

async function loadSessions(): Promise<SessionMap> {
  try {
    const content = await readFile(getSessionsPath(), 'utf-8');
    return JSON.parse(content);
  } catch {
    return { sessions: {} };
  }
}

async function saveSessions(data: SessionMap): Promise<void> {
  const filePath = getSessionsPath();
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2));
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Get or create a session UUID for the given name.
 * Returns the UUID and whether it was newly created.
 */
export async function getOrCreateSession(name: string): Promise<{ uuid: string; isNew: boolean }> {
  const data = await loadSessions();
  const existing = data.sessions[name];

  if (existing) {
    existing.lastUsedAt = new Date().toISOString();
    await saveSessions(data);
    return { uuid: existing.uuid, isNew: false };
  }

  // crypto.randomUUID() is available as a global in Bun (Web Crypto API), no import needed
  const uuid = crypto.randomUUID();
  data.sessions[name] = {
    uuid,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  };
  await saveSessions(data);
  return { uuid, isNew: true };
}
