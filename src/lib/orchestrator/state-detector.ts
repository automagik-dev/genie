/**
 * State detector for Claude Code sessions
 *
 * Analyzes terminal output to determine the current interactive state
 * of a Claude Code session.
 */

import {
  permissionPatterns,
  questionPatterns,
  errorPatterns,
  completionPatterns,
  workingPatterns,
  idlePatterns,
  toolUsePatterns,
  stripAnsi,
  hasMatch,
  getFirstMatch,
  matchPatterns,
} from './patterns.js';

export type ClaudeStateType =
  | 'idle'
  | 'working'
  | 'permission'
  | 'question'
  | 'error'
  | 'complete'
  | 'tool_use'
  | 'unknown';

export interface ClaudeState {
  type: ClaudeStateType;
  detail?: string;
  options?: string[];
  timestamp: number;
  rawOutput: string;
  confidence: number; // 0-1, how confident we are in this detection
}

export interface StateDetectorOptions {
  /** Number of lines from end to analyze (default: 50) */
  linesToAnalyze?: number;
  /** Minimum confidence threshold (default: 0.5) */
  minConfidence?: number;
}

/**
 * Detect the current state of a Claude Code session from terminal output
 */
export function detectState(
  output: string,
  options: StateDetectorOptions = {}
): ClaudeState {
  const { linesToAnalyze = 50, minConfidence = 0.3 } = options;

  // Get the last N lines for analysis
  const lines = output.split('\n');
  const recentLines = lines.slice(-linesToAnalyze).join('\n');
  const cleanOutput = stripAnsi(recentLines);

  const timestamp = Date.now();
  const baseState = {
    timestamp,
    rawOutput: recentLines,
  };

  // Check for permission requests (highest priority - needs user action)
  const permissionMatch = getFirstMatch(cleanOutput, permissionPatterns);
  if (permissionMatch) {
    return {
      ...baseState,
      type: 'permission',
      detail: permissionMatch.type.replace('_permission', ''),
      confidence: 0.9,
    };
  }

  // Check for plan approval or question prompts
  const hasPlanApproval = hasMatch(cleanOutput, questionPatterns.filter(p => p.type === 'claude_code_plan_approval'));

  // Check for questions with options - only look at last 15 lines for actual menu options
  const lastMenuLines = lines.slice(-15).join('\n');
  const cleanMenuLines = stripAnsi(lastMenuLines);
  const questionMatches = matchPatterns(cleanMenuLines, questionPatterns);

  if (questionMatches.length > 0 || hasPlanApproval) {
    // Extract options only from the numbered list at the end
    const menuOptions = questionMatches
      .filter((m) => m.type === 'claude_code_numbered_options' && m.extracted?.option)
      .map((m) => m.extracted!.option);

    if (menuOptions.length >= 2 || hasPlanApproval) {
      return {
        ...baseState,
        type: 'question',
        options: menuOptions.length > 0 ? menuOptions : undefined,
        detail: hasPlanApproval ? 'plan_approval' : undefined,
        confidence: 0.85,
      };
    }

    // Fall back to other option types
    const otherOptions = questionMatches
      .filter((m) => m.extracted?.option && m.type !== 'claude_code_numbered_options')
      .map((m) => m.extracted!.option);

    if (otherOptions.length >= 2) {
      return {
        ...baseState,
        type: 'question',
        options: otherOptions,
        confidence: 0.85,
      };
    }
  }

  // Check for yes/no questions
  const ynMatch = questionMatches.find((m) => m.type === 'yes_no_question');
  if (ynMatch) {
    return {
      ...baseState,
      type: 'question',
      options: ['Yes', 'No'],
      detail: `default: ${ynMatch.extracted?.default || 'y'}`,
      confidence: 0.85,
    };
  }

  // Check for errors
  const errorMatch = getFirstMatch(cleanOutput, errorPatterns);
  if (errorMatch) {
    return {
      ...baseState,
      type: 'error',
      detail: errorMatch.extracted?.message || errorMatch.match[0],
      confidence: 0.8,
    };
  }

  // Check for tool use
  const toolMatch = getFirstMatch(cleanOutput, toolUsePatterns);
  if (toolMatch) {
    return {
      ...baseState,
      type: 'tool_use',
      detail: `${toolMatch.type}: ${toolMatch.extracted?.command || toolMatch.extracted?.file || toolMatch.extracted?.query || ''}`,
      confidence: 0.75,
    };
  }

  // Check for working/thinking indicators
  if (hasMatch(cleanOutput, workingPatterns)) {
    return {
      ...baseState,
      type: 'working',
      confidence: 0.7,
    };
  }

  // Check for completion indicators
  if (hasMatch(cleanOutput, completionPatterns)) {
    return {
      ...baseState,
      type: 'complete',
      confidence: 0.6,
    };
  }

  // Check for idle/prompt state
  // Look at just the last few lines for prompt detection
  const lastFewLines = lines.slice(-5).join('\n');
  const cleanLastLines = stripAnsi(lastFewLines);

  if (hasMatch(cleanLastLines, idlePatterns)) {
    return {
      ...baseState,
      type: 'idle',
      confidence: 0.7,
    };
  }

  // Check for common Claude Code prompt patterns more specifically
  // Claude Code often shows a ">" prompt when waiting for input
  const trimmedLast = cleanLastLines.trim();
  if (trimmedLast.endsWith('>') || trimmedLast.match(/>\s*$/)) {
    return {
      ...baseState,
      type: 'idle',
      detail: 'prompt detected',
      confidence: 0.65,
    };
  }

  // Default: unknown state
  return {
    ...baseState,
    type: 'unknown',
    confidence: minConfidence,
  };
}

/**
 * Detect if output appears to be complete based on multiple signals
 */
export function detectCompletion(
  output: string,
  previousOutput: string
): { complete: boolean; reason: string; confidence: number } {
  const currentState = detectState(output);
  const prevState = detectState(previousOutput);

  // Permission or question = definitely not complete (needs user input)
  if (currentState.type === 'permission' || currentState.type === 'question') {
    return {
      complete: false,
      reason: `awaiting ${currentState.type}`,
      confidence: 0.95,
    };
  }

  // Error state = complete (but with error)
  if (currentState.type === 'error') {
    return {
      complete: true,
      reason: 'error detected',
      confidence: 0.8,
    };
  }

  // Idle state = likely complete
  if (currentState.type === 'idle') {
    return {
      complete: true,
      reason: 'idle prompt detected',
      confidence: currentState.confidence,
    };
  }

  // Explicit completion markers
  if (currentState.type === 'complete') {
    return {
      complete: true,
      reason: 'completion marker detected',
      confidence: currentState.confidence,
    };
  }

  // Transition from working to not working
  if (prevState.type === 'working' && currentState.type !== 'working') {
    return {
      complete: true,
      reason: 'work finished',
      confidence: 0.6,
    };
  }

  // Still working
  if (currentState.type === 'working' || currentState.type === 'tool_use') {
    return {
      complete: false,
      reason: 'still working',
      confidence: 0.7,
    };
  }

  // Unknown - inconclusive
  return {
    complete: false,
    reason: 'unknown state',
    confidence: 0.3,
  };
}

/**
 * Extract permission details from output
 */
export function extractPermissionDetails(output: string): {
  type: string;
  command?: string;
  file?: string;
} | null {
  const cleanOutput = stripAnsi(output);
  const match = getFirstMatch(cleanOutput, permissionPatterns);

  if (!match) return null;

  // Try to extract command or file from surrounding context
  const lines = cleanOutput.split('\n');
  const matchLine = lines.findIndex((line) =>
    line.match(permissionPatterns[0].pattern) ||
    line.match(permissionPatterns[1].pattern) ||
    line.match(permissionPatterns[2].pattern)
  );

  let command: string | undefined;
  let file: string | undefined;

  // Look at lines before the permission prompt for context
  if (matchLine > 0) {
    const contextLines = lines.slice(Math.max(0, matchLine - 5), matchLine).join('\n');

    // Extract command
    const cmdMatch = contextLines.match(/(?:Command|command|Bash|bash):\s*(.+)/);
    if (cmdMatch) {
      command = cmdMatch[1].trim();
    }

    // Extract file
    const fileMatch = contextLines.match(/(?:File|file|Path|path):\s*(.+)/);
    if (fileMatch) {
      file = fileMatch[1].trim();
    }
  }

  return {
    type: match.type.replace('_permission', ''),
    command,
    file,
  };
}

/**
 * Extract question options from output
 */
export function extractQuestionOptions(output: string): string[] {
  const cleanOutput = stripAnsi(output);
  const matches = matchPatterns(cleanOutput, questionPatterns);

  const options: string[] = [];

  for (const match of matches) {
    if (match.extracted?.option) {
      options.push(match.extracted.option);
    }
  }

  return options;
}
