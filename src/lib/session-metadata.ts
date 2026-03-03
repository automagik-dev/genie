import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SessionMetadata {
  worktreePath?: string;
  workspace?: string;
  createdAt: string;
}

interface SessionsData {
  sessions: Record<string, SessionMetadata>;
}

const CONFIG_DIR = join(homedir(), '.config', 'term');
const SESSIONS_FILE = join(CONFIG_DIR, 'sessions.json');

async function ensureConfigDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
}

async function loadSessions(): Promise<SessionsData> {
  try {
    await access(SESSIONS_FILE);
    const content = await readFile(SESSIONS_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return { sessions: {} };
  }
}

async function saveSessions(data: SessionsData): Promise<void> {
  await ensureConfigDir();
  await writeFile(SESSIONS_FILE, JSON.stringify(data, null, 2));
}

export async function saveSessionMetadata(name: string, data: Omit<SessionMetadata, 'createdAt'>): Promise<void> {
  const sessions = await loadSessions();
  sessions.sessions[name] = {
    ...data,
    createdAt: new Date().toISOString(),
  };
  await saveSessions(sessions);
}

export async function loadSessionMetadata(name: string): Promise<SessionMetadata | null> {
  const sessions = await loadSessions();
  return sessions.sessions[name] || null;
}

export async function deleteSessionMetadata(name: string): Promise<void> {
  const sessions = await loadSessions();
  delete sessions.sessions[name];
  await saveSessions(sessions);
}
