/**
 * Team Chat — JSONL-based group channel per team.
 *
 * Each team has a chat channel stored at `<repoPath>/.genie/chat/<team-name>.jsonl`.
 * Messages are appended as newline-delimited JSON for efficient append-only writes.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// Types
// ============================================================================

export interface ChatMessage {
  /** Unique message ID. */
  id: string;
  /** Sender agent name. */
  sender: string;
  /** Message body text. */
  body: string;
  /** ISO timestamp when message was posted. */
  timestamp: string;
}

// ============================================================================
// Paths
// ============================================================================

function chatDir(repoPath: string): string {
  return join(repoPath, '.genie', 'chat');
}

function chatFilePath(repoPath: string, teamName: string): string {
  const safeName = teamName.replace(/\//g, '--');
  return join(chatDir(repoPath), `${safeName}.jsonl`);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Post a message to a team's chat channel.
 * Appends a JSON line to the team's JSONL file.
 */
export async function postMessage(
  repoPath: string,
  teamName: string,
  sender: string,
  body: string,
): Promise<ChatMessage> {
  const msg: ChatMessage = {
    id: `chat-${uuidv4()}`,
    sender,
    body,
    timestamp: new Date().toISOString(),
  };

  const dir = chatDir(repoPath);
  await mkdir(dir, { recursive: true });

  const filePath = chatFilePath(repoPath, teamName);
  await appendFile(filePath, `${JSON.stringify(msg)}\n`);

  return msg;
}

/**
 * Read messages from a team's chat channel.
 * Optionally filter messages since a given timestamp.
 */
export async function readMessages(
  repoPath: string,
  teamName: string,
  since?: string,
): Promise<ChatMessage[]> {
  const filePath = chatFilePath(repoPath, teamName);

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const lines = content.trim().split('\n').filter(Boolean);
  let messages: ChatMessage[] = [];

  for (const line of lines) {
    try {
      messages.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }

  if (since) {
    const sinceTime = new Date(since).getTime();
    messages = messages.filter((m) => new Date(m.timestamp).getTime() >= sinceTime);
  }

  return messages;
}
