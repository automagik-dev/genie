#!/usr/bin/env bun
/**
 * Worker Service for genie
 *
 * Background HTTP service for workflow state management.
 * Port: 48888 (avoids collision with claude-mem's 37777)
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn, execSync } from 'child_process';

const PORT = 48888;
const GENIE_DIR = join(homedir(), '.genie');
const PID_FILE = join(GENIE_DIR, 'worker.pid');
const STATE_FILE = join(GENIE_DIR, 'workflow-state.json');

// Ensure .genie directory exists
if (!existsSync(GENIE_DIR)) {
  mkdirSync(GENIE_DIR, { recursive: true });
}

interface WorkflowState {
  activeWish?: string;
  activeForge?: {
    wishSlug: string;
    currentTask?: string;
    completedTasks: string[];
    failedTasks: string[];
  };
  lastUpdate: string;
}

function loadState(): WorkflowState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch {
    // Ignore parse errors
  }
  return { lastUpdate: new Date().toISOString() };
}

function saveState(state: WorkflowState): void {
  state.lastUpdate = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method || 'GET';

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (path === '/health' || path === '/') {
    json(res, {
      status: 'ok',
      service: 'genie',
      version: process.env.GENIE_VERSION || 'dev',
      port: PORT,
      uptime: process.uptime()
    });
    return;
  }

  // Workflow status
  if (path === '/api/workflow/status' && method === 'GET') {
    const state = loadState();
    json(res, state);
    return;
  }

  // Update workflow state
  if (path === '/api/workflow/update' && method === 'POST') {
    try {
      const body = await parseBody(req) as Partial<WorkflowState>;
      const state = loadState();
      Object.assign(state, body);
      saveState(state);
      json(res, { success: true, state });
    } catch (error) {
      json(res, { error: 'Invalid request body' }, 400);
    }
    return;
  }

  // Start wish tracking
  if (path === '/api/workflow/wish/start' && method === 'POST') {
    try {
      const body = await parseBody(req) as { slug: string };
      const state = loadState();
      state.activeWish = body.slug;
      saveState(state);
      json(res, { success: true, wish: body.slug });
    } catch {
      json(res, { error: 'Invalid request' }, 400);
    }
    return;
  }

  // Start forge session
  if (path === '/api/workflow/forge/start' && method === 'POST') {
    try {
      const body = await parseBody(req) as { wishSlug: string };
      const state = loadState();
      state.activeForge = {
        wishSlug: body.wishSlug,
        completedTasks: [],
        failedTasks: []
      };
      saveState(state);
      json(res, { success: true, forge: state.activeForge });
    } catch {
      json(res, { error: 'Invalid request' }, 400);
    }
    return;
  }

  // Update forge task status
  if (path === '/api/workflow/forge/task' && method === 'POST') {
    try {
      const body = await parseBody(req) as { task: string; status: 'started' | 'completed' | 'failed' };
      const state = loadState();
      if (!state.activeForge) {
        json(res, { error: 'No active forge session' }, 400);
        return;
      }
      if (body.status === 'started') {
        state.activeForge.currentTask = body.task;
      } else if (body.status === 'completed') {
        state.activeForge.completedTasks.push(body.task);
        state.activeForge.currentTask = undefined;
      } else if (body.status === 'failed') {
        state.activeForge.failedTasks.push(body.task);
        state.activeForge.currentTask = undefined;
      }
      saveState(state);
      json(res, { success: true, forge: state.activeForge });
    } catch {
      json(res, { error: 'Invalid request' }, 400);
    }
    return;
  }

  // Context hook - inject active workflow into Claude session
  if (path === '/api/hook/context' && method === 'GET') {
    const state = loadState();
    let context = '';

    if (state.activeWish) {
      context += `Active Wish: ${state.activeWish}\n`;
    }
    if (state.activeForge) {
      context += `Active Forge: ${state.activeForge.wishSlug}\n`;
      if (state.activeForge.currentTask) {
        context += `  Current Task: ${state.activeForge.currentTask}\n`;
      }
      context += `  Completed: ${state.activeForge.completedTasks.length} tasks\n`;
      if (state.activeForge.failedTasks.length > 0) {
        context += `  Failed: ${state.activeForge.failedTasks.length} tasks\n`;
      }
    }

    if (context) {
      json(res, { context });
    } else {
      json(res, { context: null });
    }
    return;
  }

  // Admin restart endpoint
  if (path === '/api/admin/restart' && method === 'POST') {
    json(res, { success: true, message: 'Worker restarting...' });
    // Schedule restart after response is sent
    setTimeout(() => {
      process.exit(0);
    }, 100);
    return;
  }

  // 404 for unknown routes
  json(res, { error: 'Not found', path }, 404);
}

// Check if another instance is running
function isAlreadyRunning(): boolean {
  try {
    if (existsSync(PID_FILE)) {
      const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
      // Check if process exists
      process.kill(pid, 0);
      return true;
    }
  } catch {
    // Process doesn't exist or PID file invalid
  }
  return false;
}

// Write PID file
function writePidFile(): void {
  writeFileSync(PID_FILE, String(process.pid));
}

// CLI commands
const command = process.argv[2];

if (command === 'start') {
  if (isAlreadyRunning()) {
    console.log('Worker already running');
    process.exit(0);
  }

  // Start as daemon (background process)
  if (process.argv[3] !== '--foreground') {
    const child = spawn(process.argv[0], [process.argv[1], 'start', '--foreground'], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    console.log(`Worker started (PID: ${child.pid})`);
    process.exit(0);
  }

  // Running in foreground
  const server = createServer((req, res) => {
    handleRequest(req, res).catch(err => {
      console.error('Request error:', err);
      json(res, { error: 'Internal server error' }, 500);
    });
  });

  server.listen(PORT, '127.0.0.1', () => {
    writePidFile();
    console.log(`genie worker listening on http://127.0.0.1:${PORT}`);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    server.close();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    server.close();
    process.exit(0);
  });

} else if (command === 'stop') {
  try {
    if (existsSync(PID_FILE)) {
      const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
      process.kill(pid, 'SIGTERM');
      console.log('Worker stopped');
    } else {
      console.log('Worker not running');
    }
  } catch {
    console.log('Worker not running');
  }
  process.exit(0);

} else if (command === 'status') {
  if (isAlreadyRunning()) {
    const pid = readFileSync(PID_FILE, 'utf-8').trim();
    console.log(`Worker running (PID: ${pid})`);
    // Try to get health status
    try {
      execSync(`curl -s http://127.0.0.1:${PORT}/health`, { encoding: 'utf-8' });
      console.log('Health: OK');
    } catch {
      console.log('Health: Unable to connect');
    }
  } else {
    console.log('Worker not running');
  }
  process.exit(0);

} else if (command === 'hook') {
  // Hook subcommand for lifecycle hooks
  const hookType = process.argv[3];

  if (hookType === 'context') {
    // Inject workflow context - called by SessionStart hook
    try {
      const response = execSync(`curl -s http://127.0.0.1:${PORT}/api/hook/context`, { encoding: 'utf-8' });
      const data = JSON.parse(response);
      if (data.context) {
        console.log(`\n<genie-workflow>\n${data.context}</genie-workflow>\n`);
      }
    } catch {
      // Worker not running, no context to inject
    }
  }
  process.exit(0);

} else {
  console.log(`
genie worker service

Usage:
  worker-service start     Start the worker (daemonized)
  worker-service stop      Stop the worker
  worker-service status    Check worker status
  worker-service hook <type>  Run hook command

Endpoints:
  GET  /health                    Health check
  GET  /api/workflow/status       Get workflow state
  POST /api/workflow/update       Update workflow state
  POST /api/workflow/wish/start   Start tracking a wish
  POST /api/workflow/forge/start  Start forge session
  POST /api/workflow/forge/task   Update forge task status
  GET  /api/hook/context          Get context for injection
  POST /api/admin/restart         Restart worker
`);
  process.exit(0);
}
