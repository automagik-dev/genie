/**
 * State detector for Claude Code sessions
 *
 * Analyzes terminal output to determine the current interactive state
 * of a Claude Code session.
 */

import {
  completionPatterns,
  errorPatterns,
  getFirstMatch,
  hasMatch,
  idlePatterns,
  matchPatterns,
  permissionPatterns,
  questionPatterns,
  stripAnsi,
  toolUsePatterns,
  workingPatterns,
} from './patterns.js';

type ClaudeStateType = 'idle' | 'working' | 'permission' | 'question' | 'error' | 'complete' | 'tool_use' | 'unknown';

interface ClaudeState {
  type: ClaudeStateType;
  detail?: string;
  options?: string[];
  timestamp: number;
  rawOutput: string;
  confidence: number; // 0-1, how confident we are in this detection
}

interface StateDetectorOptions {
  /** Number of lines from end to analyze (default: 50) */
  linesToAnalyze?: number;
  /** Minimum confidence threshold (default: 0.5) */
  minConfidence?: number;
}

/**
 * Detect the current state of a Claude Code session from terminal output
 */
interface BaseState {
  timestamp: number;
  rawOutput: string;
}

type QuestionMatchResult = ReturnType<typeof matchPatterns>;

function detectQuestionState(
  questionMatches: QuestionMatchResult,
  hasPlanApproval: boolean,
  baseState: BaseState,
): ClaudeState | null {
  if (questionMatches.length === 0 && !hasPlanApproval) return null;

  const menuOptions = questionMatches
    .filter((m) => m.type === 'claude_code_numbered_options' && m.extracted?.option)
    .map((m) => m.extracted?.option)
    .filter((o): o is string => o !== undefined);

  if (menuOptions.length >= 2 || hasPlanApproval) {
    return {
      ...baseState,
      type: 'question',
      options: menuOptions.length > 0 ? menuOptions : undefined,
      detail: hasPlanApproval ? 'plan_approval' : undefined,
      confidence: 0.85,
    };
  }

  const otherOptions = questionMatches
    .filter((m) => m.extracted?.option && m.type !== 'claude_code_numbered_options')
    .map((m) => m.extracted?.option)
    .filter((o): o is string => o !== undefined);

  if (otherOptions.length >= 2) {
    return { ...baseState, type: 'question', options: otherOptions, confidence: 0.85 };
  }

  return null;
}

export function detectState(output: string, options: StateDetectorOptions = {}): ClaudeState {
  const { linesToAnalyze = 50, minConfidence = 0.3 } = options;

  const lines = output.split('\n');
  const recentLines = lines.slice(-linesToAnalyze).join('\n');
  const cleanOutput = stripAnsi(recentLines);

  const baseState: BaseState = { timestamp: Date.now(), rawOutput: recentLines };

  // Check for permission requests (highest priority)
  const permissionMatch = getFirstMatch(cleanOutput, permissionPatterns);
  if (permissionMatch) {
    return {
      ...baseState,
      type: 'permission',
      detail: permissionMatch.type.replace('_permission', ''),
      confidence: 0.9,
    };
  }

  // Check for questions
  const hasPlanApproval = hasMatch(
    cleanOutput,
    questionPatterns.filter((p) => p.type === 'claude_code_plan_approval'),
  );
  const cleanMenuLines = stripAnsi(lines.slice(-15).join('\n'));
  const questionMatches = matchPatterns(cleanMenuLines, questionPatterns);

  const questionState = detectQuestionState(questionMatches, hasPlanApproval, baseState);
  if (questionState) return questionState;

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

  if (hasMatch(cleanOutput, workingPatterns)) {
    return { ...baseState, type: 'working', confidence: 0.7 };
  }

  if (hasMatch(cleanOutput, completionPatterns)) {
    return { ...baseState, type: 'complete', confidence: 0.6 };
  }

  // Check for idle/prompt state
  const cleanLastLines = stripAnsi(lines.slice(-5).join('\n'));
  if (hasMatch(cleanLastLines, idlePatterns)) {
    return { ...baseState, type: 'idle', confidence: 0.7 };
  }

  const trimmedLast = cleanLastLines.trim();
  if (trimmedLast.endsWith('>') || trimmedLast.match(/>\s*$/)) {
    return { ...baseState, type: 'idle', detail: 'prompt detected', confidence: 0.65 };
  }

  return { ...baseState, type: 'unknown', confidence: minConfidence };
}
