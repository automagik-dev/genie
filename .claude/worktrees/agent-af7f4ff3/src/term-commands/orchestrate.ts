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

import { formatResolvedLabel, resolveTarget } from '../lib/target-resolver.js';
import * as tmux from '../lib/tmux.js';

import { detectState, stripAnsi } from '../lib/orchestrator/index.js';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Resolve a target to paneId + session using the target resolver.
 * Used by all orchestrate commands except startSession.
 */
async function resolveOrcTarget(target: string): Promise<{ paneId: string; session: string; label: string }> {
  const resolved = await resolveTarget(target);

  return {
    paneId: resolved.paneId,
    session: resolved.session || target,
    label: formatResolvedLabel(resolved, target),
  };
}

/**
 * Answer a question with options
 *
 * For Claude Code menus:
 * - Numeric choice (1-9): Navigate to that option and select
 * - "text:..." prefix: Type text directly (for option 4 "Type here...")
 * - Other: Send as raw keystrokes
 */
async function sendTextChoice(paneId: string, text: string): Promise<void> {
  await tmux.executeTmux(`send-keys -t '${paneId}' End`);
  await sleep(100);
  await tmux.executeTmux(`send-keys -t '${paneId}' Enter`);
  await sleep(100);
  await tmux.executeTmux(`send-keys -t '${paneId}' ${shellEscape(text)}`);
  await sleep(100);
  await tmux.executeTmux(`send-keys -t '${paneId}' Enter`);
}

function findCurrentOption(output: string): number {
  const lines = stripAnsi(output).split('\n');
  for (const line of lines) {
    const match = line.match(/^\s*❯\s*(\d+)\./);
    if (match) return Number.parseInt(match[1], 10);
  }
  return 1;
}

async function navigateToOption(paneId: string, targetOption: number, currentOption: number): Promise<void> {
  const diff = targetOption - currentOption;
  const key = diff > 0 ? 'Down' : 'Up';
  for (let i = 0; i < Math.abs(diff); i++) {
    await tmux.executeTmux(`send-keys -t '${paneId}' ${key}`);
    await sleep(50);
  }
  await sleep(100);
  await tmux.executeTmux(`send-keys -t '${paneId}' Enter`);
}

export async function answerQuestion(target: string, choice: string): Promise<void> {
  try {
    const { paneId, label } = await resolveOrcTarget(target);

    const output = await tmux.capturePaneContent(paneId, 50);
    const state = detectState(output);

    if (state.type !== 'question') {
      console.log(`No question pending (state: ${state.type})`);
      return;
    }

    if (choice.startsWith('text:')) {
      const text = choice.slice(5);
      await sendTextChoice(paneId, text);
      console.log(`Sent feedback: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
    } else if (/^\d+$/.test(choice)) {
      const targetOption = Number.parseInt(choice, 10);
      await navigateToOption(paneId, targetOption, findCurrentOption(output));
      console.log(`Selected option ${targetOption} for ${label}`);
    } else {
      await tmux.executeTmux(`send-keys -t '${paneId}' '${choice}'`);
      console.log(`Sent '${choice}' to ${label}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

// Helper to escape shell arguments
function shellEscape(str: string): string {
  return `"${str.replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`;
}

// Helper to sleep
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
