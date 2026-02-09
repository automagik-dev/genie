/**
 * Orchestrate command - Claude Code session orchestration
 *
 * Provides commands for monitoring and controlling Claude Code sessions:
 * - start: Start Claude Code in a session with optional monitoring
 * - send: Send message and track completion
 * - status: Show current Claude state
 * - watch: Real-time event streaming
 * - approve: Handle permission requests
 * - answer: Answer questions
 * - experiment: Test completion detection methods
 */

import * as tmux from '../lib/tmux.js';
import { resolveTarget, formatResolvedLabel } from '../lib/target-resolver.js';
import {
  EventMonitor,
  ClaudeEvent,
  ClaudeState,
  detectState,
  extractPermissionDetails,
  extractQuestionOptions,
  extractPlanFile,
  getMethod,
  getDefaultMethod,
  presetMethods,
  PresetMethodName,
  CompletionMethodMetrics,
  stripAnsi,
} from '../lib/orchestrator/index.js';

// ============================================================================
// Types
// ============================================================================

export interface StartOptions {
  pane?: string;
  monitor?: boolean;
  command?: string;
  json?: boolean;
}

export interface RunOptions {
  pane?: string;
  autoApprove?: boolean;
  timeout?: number;
  json?: boolean;
}

export interface SendOptions {
  method?: string;
  timeout?: number;
  json?: boolean;
  noWait?: boolean;
  pane?: string;
}

export interface StatusOptions {
  json?: boolean;
  pane?: string;
}

export interface WatchOptions {
  json?: boolean;
  poll?: number;
  pane?: string;
}

export interface ApproveOptions {
  pane?: string;
  auto?: boolean;
  deny?: boolean;
}

export interface ExperimentOptions {
  runs?: number;
  task?: string;
  json?: boolean;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Legacy getSessionPane - preserved ONLY for startSession which needs session-creation behavior.
 * All other commands use resolveTarget() instead.
 */
async function getSessionPaneForStart(
  sessionName: string,
  targetPaneId?: string
): Promise<{ session: tmux.TmuxSession; paneId: string }> {
  const session = await tmux.findSessionByName(sessionName);
  if (!session) {
    console.error(`Session "${sessionName}" not found`);
    process.exit(1);
  }

  // If specific pane ID provided, validate and use it
  if (targetPaneId) {
    // Normalize pane ID (add % prefix if missing)
    const paneId = targetPaneId.startsWith('%') ? targetPaneId : `%${targetPaneId}`;
    return { session, paneId };
  }

  const windows = await tmux.listWindows(session.id);
  if (!windows || windows.length === 0) {
    console.error(`No windows found in session "${sessionName}"`);
    process.exit(1);
  }

  const panes = await tmux.listPanes(windows[0].id);
  if (!panes || panes.length === 0) {
    console.error(`No panes found in session "${sessionName}"`);
    process.exit(1);
  }

  return { session, paneId: panes[0].id };
}

/**
 * Resolve a target to paneId + session using the target resolver.
 * Used by all orchestrate commands except startSession.
 */
async function resolveOrcTarget(
  target: string,
  paneOverride?: string
): Promise<{ paneId: string; session: string; label: string }> {
  if (paneOverride) {
    // Deprecated --pane escape hatch: honor but warn
    console.error(
      `\x1b[33m` +
      `Warning: --pane is deprecated. Use target addressing instead: term orc <cmd> ${target}` +
      `\x1b[0m`
    );
    const paneId = paneOverride.startsWith('%') ? paneOverride : `%${paneOverride}`;

    // Try to resolve target as session for backwards compat
    const tmuxSession = await tmux.findSessionByName(target);
    return {
      paneId,
      session: tmuxSession ? target : target,
      label: `${target} (pane ${paneId})`,
    };
  }

  const resolved = await resolveTarget(target);

  return {
    paneId: resolved.paneId,
    session: resolved.session || target,
    label: formatResolvedLabel(resolved, target),
  };
}

function formatState(state: ClaudeState): string {
  let result = `${state.type}`;
  if (state.detail) {
    result += ` (${state.detail})`;
  }
  if (state.options && state.options.length > 0) {
    result += `\n  Options: ${state.options.join(', ')}`;
  }
  result += ` [confidence: ${(state.confidence * 100).toFixed(0)}%]`;
  return result;
}

function formatEvent(event: ClaudeEvent): string {
  const time = new Date(event.timestamp).toISOString().split('T')[1].split('.')[0];

  switch (event.type) {
    case 'output':
      return `[${time}] OUTPUT: ${(event.output || '').substring(0, 100).replace(/\n/g, '\\n')}`;
    case 'state_change':
      return `[${time}] STATE: ${event.state?.type || 'unknown'}${event.state?.detail ? ` (${event.state.detail})` : ''}`;
    case 'silence':
      return `[${time}] SILENCE: ${event.silenceMs}ms`;
    case 'activity':
      return `[${time}] ACTIVITY`;
    case 'permission':
      return `[${time}] PERMISSION: ${event.state?.detail || 'unknown'}`;
    case 'question':
      return `[${time}] QUESTION: ${event.state?.options?.join(', ') || 'unknown'}`;
    case 'error':
      return `[${time}] ERROR: ${event.state?.detail || 'unknown'}`;
    case 'complete':
      return `[${time}] COMPLETE`;
    default:
      return `[${time}] ${event.type}`;
  }
}

// ============================================================================
// Commands
// ============================================================================

/**
 * Start Claude Code in a session with optional monitoring
 *
 * NOTE: This command preserves session-creation behavior from getSessionPane().
 * It does NOT use resolveTarget() because it needs to create sessions that don't exist.
 */
export async function startSession(
  sessionName: string,
  options: StartOptions = {}
): Promise<void> {
  try {
    // Check if session exists
    let session = await tmux.findSessionByName(sessionName);

    if (!session) {
      // Create new session
      session = await tmux.createSession(sessionName);
      if (!session) {
        console.error(`Failed to create session "${sessionName}"`);
        process.exit(1);
      }
      console.log(`Created session "${sessionName}"`);
    } else {
      console.log(`Session "${sessionName}" already exists`);
    }

    // Get pane (use specified pane or default to first pane)
    let paneId: string;
    if (options.pane) {
      paneId = options.pane.startsWith('%') ? options.pane : `%${options.pane}`;
    } else {
      const windows = await tmux.listWindows(session.id);
      const panes = await tmux.listPanes(windows[0].id);
      paneId = panes[0].id;
    }

    // Start Claude Code (or custom command)
    const command = options.command || 'claude';
    await tmux.executeCommand(paneId, command, false, false);
    console.log(`Started "${command}" in session "${sessionName}"`);

    // Start monitoring if requested
    if (options.monitor) {
      console.log(`Starting event monitor...`);

      const monitor = new EventMonitor(sessionName, {
        pollIntervalMs: 500,
        paneId: options.pane,
      });

      monitor.on('event', (event: ClaudeEvent) => {
        if (options.json) {
          console.log(JSON.stringify(event));
        } else {
          console.log(formatEvent(event));
        }
      });

      monitor.on('poll_error', (error: Error) => {
        console.error(`Poll error: ${error.message}`);
      });

      await monitor.start();
      console.log(`Monitor active. Press Ctrl+C to stop.`);

      // Keep running until interrupted
      process.on('SIGINT', () => {
        monitor.stop();
        console.log('\nMonitor stopped.');
        process.exit(0);
      });

      // Keep process alive
      await new Promise(() => {});
    }
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Send a message to Claude and track completion
 */
export async function sendMessage(
  target: string,
  message: string,
  options: SendOptions = {}
): Promise<void> {
  try {
    const { paneId, session, label } = await resolveOrcTarget(target, options.pane);

    // Send the message cleanly (no TMUX_MCP markers)
    const escapedMessage = message.replace(/'/g, "'\\''");
    await tmux.executeTmux(`send-keys -t '${paneId}' '${escapedMessage}' Enter`);

    if (options.noWait) {
      console.log(`Message sent to ${label}`);
      return;
    }

    // Start monitoring for completion
    const monitor = new EventMonitor(session, {
      pollIntervalMs: 250,
      paneId,
    });

    await monitor.start();

    // Use specified completion method or default
    const method = options.method ? getMethod(options.method) : getDefaultMethod();
    const timeoutMs = options.timeout || 120000;

    console.log(`Waiting for completion using "${method.name}"...`);

    try {
      const result = await method.detect(monitor, timeoutMs);
      monitor.stop();

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Completion detected: ${result.reason}`);
        console.log(`   Latency: ${result.latencyMs}ms`);
        if (result.state) {
          console.log(`   State: ${formatState(result.state)}`);
        }
      }

      // Capture and output the response
      const output = await tmux.capturePaneContent(paneId, 100);
      console.log('\n--- Response ---');
      console.log(stripAnsi(output).trim());
    } catch (error: any) {
      monitor.stop();
      console.error(`Completion detection failed: ${error.message}`);
      process.exit(1);
    }
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Show current Claude state
 */
export async function showStatus(
  target: string,
  options: StatusOptions = {}
): Promise<void> {
  try {
    const { paneId, session, label } = await resolveOrcTarget(target, options.pane);

    // Capture current output
    const output = await tmux.capturePaneContent(paneId, 100);

    // Detect state
    const state = detectState(output);

    // Get permission/question details if applicable
    let permissionDetails = null;
    let questionOptions: string[] = [];
    let planFile: string | null = null;

    if (state.type === 'permission') {
      permissionDetails = extractPermissionDetails(output);
    } else if (state.type === 'question') {
      questionOptions = extractQuestionOptions(output);
      // Check for plan file when in plan approval state
      if (state.detail === 'plan_approval') {
        planFile = extractPlanFile(output);
      }
    }

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            target,
            session,
            state: state.type,
            detail: state.detail,
            confidence: state.confidence,
            timestamp: state.timestamp,
            permissionDetails,
            questionOptions,
            planFile,
          },
          null,
          2
        )
      );
    } else {
      console.log(`Target: ${label}`);
      console.log(`State: ${state.type}`);
      if (state.detail) {
        console.log(`Detail: ${state.detail}`);
      }
      console.log(`Confidence: ${(state.confidence * 100).toFixed(0)}%`);

      if (permissionDetails) {
        console.log(`\nPermission Request:`);
        console.log(`  Type: ${permissionDetails.type}`);
        if (permissionDetails.command) {
          console.log(`  Command: ${permissionDetails.command}`);
        }
        if (permissionDetails.file) {
          console.log(`  File: ${permissionDetails.file}`);
        }
      }

      if (questionOptions.length > 0) {
        console.log(`\nQuestion Options:`);
        questionOptions.forEach((opt, i) => {
          console.log(`  [${i + 1}] ${opt}`);
        });
      }

      if (planFile) {
        console.log(`\nPlan File: ${planFile}`);
      }

      // Show last few lines of output
      const lines = stripAnsi(output).trim().split('\n');
      const lastLines = lines.slice(-5);
      console.log(`\nLast output:`);
      lastLines.forEach((line) => console.log(`  ${line}`));
    }
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Watch session events in real-time
 */
export async function watchSession(
  target: string,
  options: WatchOptions = {}
): Promise<void> {
  try {
    const { paneId, session, label } = await resolveOrcTarget(target, options.pane);

    const monitor = new EventMonitor(session, {
      pollIntervalMs: options.poll || 500,
      paneId,
    });

    monitor.on('event', (event: ClaudeEvent) => {
      if (options.json) {
        console.log(JSON.stringify(event));
      } else {
        console.log(formatEvent(event));
      }
    });

    monitor.on('poll_error', (error: Error) => {
      console.error(`Poll error: ${error.message}`);
    });

    await monitor.start();
    console.log(`Watching ${label}. Press Ctrl+C to stop.`);

    // Show initial state
    const state = monitor.getCurrentState();
    if (state) {
      console.log(`Initial state: ${formatState(state)}`);
    }

    // Handle Ctrl+C
    process.on('SIGINT', () => {
      monitor.stop();
      console.log('\nWatch stopped.');
      process.exit(0);
    });

    // Keep process alive
    await new Promise(() => {});
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Approve a pending permission request
 */
export async function approvePermission(
  target: string,
  options: ApproveOptions = {}
): Promise<void> {
  try {
    const { paneId, session, label } = await resolveOrcTarget(target, options.pane);

    // Check current state
    const output = await tmux.capturePaneContent(paneId, 50);
    const state = detectState(output);

    if (state.type !== 'permission' && !options.auto) {
      console.log(`No permission request pending (state: ${state.type})`);
      return;
    }

    // For Claude Code, permissions use a menu with cursor
    // We need to navigate to the right option and press Enter
    // Option 1 is "Yes" (approve), other options are deny or more specific
    if (options.deny) {
      // Navigate down to "No" option (typically option 2 or 3)
      await tmux.executeTmux(`send-keys -t '${paneId}' Down`);
      await sleep(100);
    }
    // Press Enter to confirm selection
    await tmux.executeTmux(`send-keys -t '${paneId}' Enter`);

    console.log(`${options.deny ? 'Denied' : 'Approved'} permission for ${label}`);

    // If auto mode, keep monitoring and approving
    if (options.auto) {
      console.log(`Auto-approve mode enabled. Press Ctrl+C to stop.`);

      const monitor = new EventMonitor(session, {
        pollIntervalMs: 250,
        paneId,
      });

      monitor.on('permission', async (event: ClaudeEvent) => {
        try {
          const response = options.deny ? 'n' : 'y';
          await tmux.executeCommand(paneId, response, false, true);
          console.log(`Auto-${options.deny ? 'denied' : 'approved'}: ${event.state?.detail || 'unknown'}`);
        } catch (err: any) {
          console.error(`Auto-approve failed: ${err.message}`);
        }
      });

      await monitor.start();

      process.on('SIGINT', () => {
        monitor.stop();
        console.log('\nAuto-approve stopped.');
        process.exit(0);
      });

      await new Promise(() => {});
    }
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Answer a question with options
 *
 * For Claude Code menus:
 * - Numeric choice (1-9): Navigate to that option and select
 * - "text:..." prefix: Type text directly (for option 4 "Type here...")
 * - Other: Send as raw keystrokes
 */
export async function answerQuestion(
  target: string,
  choice: string,
  options: { pane?: string } = {}
): Promise<void> {
  try {
    const { paneId, label } = await resolveOrcTarget(target, options.pane);

    // Check current state
    const output = await tmux.capturePaneContent(paneId, 50);
    const state = detectState(output);

    if (state.type !== 'question') {
      console.log(`No question pending (state: ${state.type})`);
      return;
    }

    // Handle different choice formats
    if (choice.startsWith('text:')) {
      // Send text directly (for "Type here to tell Claude what to change")
      const text = choice.slice(5);
      // First select option 4 (or last option) to get to text input
      await tmux.executeTmux(`send-keys -t '${paneId}' End`);
      await sleep(100);
      await tmux.executeTmux(`send-keys -t '${paneId}' Enter`);
      await sleep(100);
      // Now type the feedback
      await tmux.executeTmux(`send-keys -t '${paneId}' ${shellEscape(text)}`);
      await sleep(100);
      await tmux.executeTmux(`send-keys -t '${paneId}' Enter`);
      console.log(`Sent feedback: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
    } else if (/^\d+$/.test(choice)) {
      // Numeric choice - navigate using arrow keys to the option
      const targetOption = parseInt(choice, 10);

      // Find current selection position by looking for cursor marker
      const cleanOutput = stripAnsi(output);
      const lines = cleanOutput.split('\n');
      let currentOption = 1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].match(/^\s*❯\s*\d+\./)) {
          const match = lines[i].match(/❯\s*(\d+)\./);
          if (match) currentOption = parseInt(match[1], 10);
          break;
        }
      }

      // Navigate to target option
      const diff = targetOption - currentOption;
      if (diff > 0) {
        for (let i = 0; i < diff; i++) {
          await tmux.executeTmux(`send-keys -t '${paneId}' Down`);
          await sleep(50);
        }
      } else if (diff < 0) {
        for (let i = 0; i < Math.abs(diff); i++) {
          await tmux.executeTmux(`send-keys -t '${paneId}' Up`);
          await sleep(50);
        }
      }

      // Press Enter to select
      await sleep(100);
      await tmux.executeTmux(`send-keys -t '${paneId}' Enter`);
      console.log(`Selected option ${targetOption} for ${label}`);
    } else {
      // Raw keystroke (e.g., 'y', 'n', 'Enter')
      await tmux.executeTmux(`send-keys -t '${paneId}' '${choice}'`);
      console.log(`Sent '${choice}' to ${label}`);
    }
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

// Helper to escape shell arguments
function shellEscape(str: string): string {
  return `"${str.replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`;
}

// Helper to sleep
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Test a completion detection method
 */
export async function runExperiment(
  methodName: string,
  options: ExperimentOptions = {}
): Promise<void> {
  const runs = options.runs || 1;
  const testTask = options.task || 'echo "Hello, World!"';

  console.log(`Experiment: Testing "${methodName}" method`);
  console.log(`   Runs: ${runs}`);
  console.log(`   Task: ${testTask}`);
  console.log('');

  const method = getMethod(methodName);
  const results: Array<{
    run: number;
    latencyMs: number;
    complete: boolean;
    reason: string;
  }> = [];

  // Create a test session
  const testSessionName = `orc-experiment-${Date.now()}`;
  let session = await tmux.createSession(testSessionName);
  if (!session) {
    console.error('Failed to create test session');
    process.exit(1);
  }

  try {
    const windows = await tmux.listWindows(session.id);
    const panes = await tmux.listPanes(windows[0].id);
    const paneId = panes[0].id;

    for (let i = 0; i < runs; i++) {
      console.log(`\nRun ${i + 1}/${runs}...`);

      // Clear pane
      await tmux.executeCommand(paneId, 'clear', false, false);
      await new Promise((r) => setTimeout(r, 500));

      // Start monitor
      const monitor = new EventMonitor(testSessionName, {
        pollIntervalMs: 100,
      });
      await monitor.start();

      // Execute task
      await tmux.executeCommand(paneId, testTask, false, false);

      // Detect completion
      const result = await method.detect(monitor, 30000);
      monitor.stop();

      results.push({
        run: i + 1,
        latencyMs: result.latencyMs,
        complete: result.complete,
        reason: result.reason,
      });

      console.log(`   Complete: ${result.complete}`);
      console.log(`   Latency: ${result.latencyMs}ms`);
      console.log(`   Reason: ${result.reason}`);

      // Wait between runs
      if (i < runs - 1) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    // Calculate statistics
    const successfulRuns = results.filter((r) => r.complete);
    const avgLatency =
      successfulRuns.reduce((sum, r) => sum + r.latencyMs, 0) / successfulRuns.length || 0;
    const minLatency = Math.min(...successfulRuns.map((r) => r.latencyMs)) || 0;
    const maxLatency = Math.max(...successfulRuns.map((r) => r.latencyMs)) || 0;

    const summary = {
      method: methodName,
      totalRuns: runs,
      successfulRuns: successfulRuns.length,
      successRate: (successfulRuns.length / runs) * 100,
      avgLatencyMs: Math.round(avgLatency),
      minLatencyMs: minLatency,
      maxLatencyMs: maxLatency,
      results,
    };

    console.log('\n--- Summary ---');
    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`Method: ${summary.method}`);
      console.log(`Success Rate: ${summary.successRate.toFixed(1)}%`);
      console.log(`Avg Latency: ${summary.avgLatencyMs}ms`);
      console.log(`Min Latency: ${summary.minLatencyMs}ms`);
      console.log(`Max Latency: ${summary.maxLatencyMs}ms`);
    }
  } finally {
    // Cleanup test session
    await tmux.killSession(session.id);
    console.log(`\nCleaned up test session`);
  }
}

/**
 * List available completion methods
 */
export async function listMethods(): Promise<void> {
  console.log('Available completion methods:');
  console.log('');

  for (const name of Object.keys(presetMethods) as PresetMethodName[]) {
    const method = presetMethods[name]();
    console.log(`  ${name}`);
    console.log(`    ${method.description}`);
    console.log('');
  }

  console.log('Custom methods:');
  console.log('  silence-Xms  - Silence timeout (e.g., silence-2000ms)');
  console.log('  silence-Xs   - Silence timeout (e.g., silence-5s)');
}

/**
 * Run a task with auto-approval until idle
 *
 * Fire-and-forget: send message, auto-approve permissions, wait for idle
 */
export async function runTask(
  target: string,
  message: string,
  options: RunOptions = {}
): Promise<void> {
  try {
    const { paneId, session, label } = await resolveOrcTarget(target, options.pane);
    const timeoutMs = options.timeout || 300000; // 5 minute default

    // Send the message
    await tmux.executeCommand(paneId, message, false, false);
    console.log(`Sent task: "${message.substring(0, 50)}${message.length > 50 ? '...' : ''}"`);

    // Start monitoring
    const monitor = new EventMonitor(session, {
      pollIntervalMs: 250,
      paneId,
    });

    await monitor.start();
    const startTime = Date.now();

    console.log(`Monitoring for completion...${options.autoApprove ? ' (auto-approve enabled)' : ''}`);

    // Main monitoring loop
    let lastState: string | null = null;

    const checkState = async (): Promise<boolean> => {
      const output = await tmux.capturePaneContent(paneId, 30);
      const state = detectState(output);

      // Log state changes
      if (state.type !== lastState) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[${elapsed}s] State: ${state.type}${state.detail ? ` (${state.detail})` : ''}`);
        lastState = state.type;
      }

      // Handle permission requests
      if (state.type === 'permission' && options.autoApprove) {
        console.log(`   Auto-approving permission...`);
        await tmux.executeTmux(`send-keys -t '${paneId}' Enter`);
        await sleep(200);
        return false; // Continue monitoring
      }

      // Handle question states
      if (state.type === 'question') {
        if (state.detail === 'plan_approval' && options.autoApprove) {
          // Auto-approve plans
          console.log(`   Auto-approving plan...`);
          await tmux.executeTmux(`send-keys -t '${paneId}' Enter`);
          await sleep(200);
          return false; // Continue monitoring
        }
        // Other questions require user input - exit and report
        console.log(`Question requires manual input`);
        const questionOptions = extractQuestionOptions(output);
        if (questionOptions.length > 0) {
          console.log(`   Options:`);
          questionOptions.forEach((opt, i) => console.log(`     [${i + 1}] ${opt}`));
        }
        return true; // Stop monitoring, need user input
      }

      // Check for idle (task complete)
      if (state.type === 'idle') {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`Task complete (${elapsed}s)`);
        return true; // Done
      }

      // Check for error
      if (state.type === 'error') {
        console.log(`Task encountered error`);
        return true; // Done (with error)
      }

      return false; // Continue monitoring
    };

    // Poll until done or timeout
    const pollInterval = 500;
    const maxIterations = Math.ceil(timeoutMs / pollInterval);

    for (let i = 0; i < maxIterations; i++) {
      const done = await checkState();
      if (done) break;

      if (Date.now() - startTime > timeoutMs) {
        console.log(`Timeout after ${timeoutMs / 1000}s`);
        break;
      }

      await sleep(pollInterval);
    }

    monitor.stop();

    // Output final state as JSON if requested
    if (options.json) {
      const output = await tmux.capturePaneContent(paneId, 30);
      const state = detectState(output);
      console.log(JSON.stringify({
        target,
        session,
        state: state.type,
        detail: state.detail,
        elapsedMs: Date.now() - startTime,
      }, null, 2));
    }
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
