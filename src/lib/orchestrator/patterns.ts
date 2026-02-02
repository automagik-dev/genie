/**
 * Claude Code output patterns for state detection
 *
 * These patterns are used to identify different interactive states
 * when Claude Code is running in a terminal session.
 */

export interface PatternMatch {
  type: string;
  pattern: RegExp;
  extract?: (match: RegExpMatchArray) => Record<string, string>;
}

// Permission request patterns
export const permissionPatterns: PatternMatch[] = [
  {
    type: 'bash_permission',
    pattern: /Allow (?:Bash|bash|command|shell).*\?\s*(?:\[([YyNn])\/([YyNn])\])?/i,
    extract: (match) => ({ default: match[1] || 'y' }),
  },
  {
    type: 'file_permission',
    pattern: /Allow (?:Edit|Write|Read|file|reading|writing|editing).*\?\s*(?:\[([YyNn])\/([YyNn])\])?/i,
    extract: (match) => ({ default: match[1] || 'y' }),
  },
  {
    type: 'mcp_permission',
    pattern: /Allow (?:MCP|mcp|tool).*\?\s*(?:\[([YyNn])\/([YyNn])\])?/i,
    extract: (match) => ({ default: match[1] || 'y' }),
  },
  {
    type: 'generic_permission',
    // Only match actual permission prompts, not questions with "proceed"
    // Must start with "Allow" and typically have a tool/action context
    pattern: /^(?:Allow|Confirm|Approve)\s+(?:this|the|once|always)?\s*(?:\w+)?\s*\?\s*(?:\[([YyNn])\/([YyNn])\])?/im,
    extract: (match) => ({ default: match[1] || 'y' }),
  },
  {
    type: 'claude_code_yes_no',
    // Claude Code uses Yes/No prompts
    pattern: /(?:Yes|No)\s*$/m,
  },
  {
    type: 'claude_code_permission_block',
    // Claude Code permission blocks often show the tool name
    pattern: /(?:Allow|Run|Execute)\s+(?:once|always)/i,
  },
];

// Question with options patterns
export const questionPatterns: PatternMatch[] = [
  {
    type: 'numbered_options',
    pattern: /\[(\d+)\]\s+(.+?)(?=\[(\d+)\]|$)/g,
    extract: (match) => ({ number: match[1], option: match[2].trim() }),
  },
  {
    type: 'lettered_options',
    pattern: /\(([a-z])\)\s+(.+?)(?=\([a-z]\)|$)/gi,
    extract: (match) => ({ letter: match[1], option: match[2].trim() }),
  },
  {
    type: 'yes_no_question',
    pattern: /\?\s*\[([YyNn])\/([YyNn])\]\s*$/,
    extract: (match) => ({ default: match[1] }),
  },
  {
    type: 'claude_code_numbered_options',
    // Claude Code uses "❯ 1." or "  2." format for menu selection
    pattern: /(?:❯|>)?\s*(\d+)\.\s+(.+?)(?:\n|$)/g,
    extract: (match) => ({ number: match[1], option: match[2].trim() }),
  },
  {
    type: 'claude_code_plan_approval',
    // Claude Code plan approval prompt
    pattern: /Would you like to proceed\?/i,
  },
];

// Error patterns
export const errorPatterns: PatternMatch[] = [
  {
    type: 'error',
    pattern: /(?:^|\n)\s*(?:Error|ERROR|error):\s*(.+)/,
    extract: (match) => ({ message: match[1] }),
  },
  {
    type: 'failed',
    pattern: /(?:^|\n)\s*(?:Failed|FAILED|failed):\s*(.+)/,
    extract: (match) => ({ message: match[1] }),
  },
  {
    type: 'exception',
    pattern: /(?:^|\n)\s*(?:Exception|EXCEPTION|Uncaught|Unhandled):\s*(.+)/,
    extract: (match) => ({ message: match[1] }),
  },
  {
    type: 'api_error',
    pattern: /(?:API|api)\s+(?:error|Error|ERROR):\s*(.+)/,
    extract: (match) => ({ message: match[1] }),
  },
];

// Completion/success patterns
export const completionPatterns: PatternMatch[] = [
  {
    type: 'checkmark',
    pattern: /[✓✔☑︎]/,
  },
  {
    type: 'success_message',
    pattern: /(?:Successfully|Completed|Done|Finished|Created|Updated|Saved)/i,
  },
  {
    type: 'task_complete',
    pattern: /(?:task|operation|process)\s+(?:complete|completed|finished|done)/i,
  },
];

// Working/thinking patterns
export const workingPatterns: PatternMatch[] = [
  {
    type: 'thinking',
    pattern: /(?:Thinking|thinking|Processing|processing)\.\.\./,
  },
  {
    type: 'spinner',
    pattern: /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/,
  },
  {
    type: 'loading',
    pattern: /(?:Loading|loading|Working|working)\.\.\./,
  },
  {
    type: 'claude_code_working',
    // Claude Code shows tool icons when working
    pattern: /[🛠️🔧⚙️]\s*(?:Read|Edit|Write|Bash|Glob|Grep|Task)/,
  },
  {
    type: 'claude_code_streaming',
    // Partial response streaming
    pattern: /▌$/,
  },
  {
    type: 'claude_code_propagating',
    // Claude shows "Propagating..." when applying changes
    pattern: /Propagating…/,
  },
];

// Idle/prompt patterns - Claude Code is waiting for input
export const idlePatterns: PatternMatch[] = [
  {
    type: 'claude_prompt',
    // Look for the Claude Code prompt character (typically > or similar)
    // But NOT when followed by a number (that's a menu)
    pattern: /(?:^|\n)\s*>\s*$/,
  },
  {
    type: 'claude_code_prompt',
    // Claude Code prompt with ❯ alone (NOT followed by number - that's a menu)
    // Match ❯ at end of line, or ❯ followed by text (user input)
    pattern: /❯\s*(?!\d\.)/,
  },
  {
    type: 'claude_code_input_line',
    // Claude Code shows ❯ followed by user's typed input, then a line of dashes
    // This indicates the input prompt is active
    pattern: /❯\s*.+\n─+\n/,
  },
  {
    type: 'idle_indicator',
    // Claude Code status bar showing idle
    pattern: /\|\s*idle\s*$/i,
  },
  {
    type: 'input_prompt',
    // Generic input prompt
    pattern: /(?:^|\n)(?:Enter|Input|Type|Provide).*:\s*$/i,
  },
];

// Tool use patterns
export const toolUsePatterns: PatternMatch[] = [
  {
    type: 'run_command',
    pattern: /(?:Run|Running|Executing)\s+(?:command|bash):\s*(.+)/i,
    extract: (match) => ({ command: match[1] }),
  },
  {
    type: 'read_file',
    pattern: /(?:Read|Reading)\s+(?:file):\s*(.+)/i,
    extract: (match) => ({ file: match[1] }),
  },
  {
    type: 'write_file',
    pattern: /(?:Write|Writing|Edit|Editing)\s+(?:file|to):\s*(.+)/i,
    extract: (match) => ({ file: match[1] }),
  },
  {
    type: 'search',
    pattern: /(?:Search|Searching|Grep|Glob)(?:ing)?:\s*(.+)/i,
    extract: (match) => ({ query: match[1] }),
  },
];

// Plan file patterns - extract plan file paths from Claude Code output
export const planFilePatterns: PatternMatch[] = [
  {
    type: 'claude_plan_file',
    // Matches: ~/.claude/plans/something.md or full paths
    pattern: /(~\/\.claude\/plans\/[\w-]+\.md|\/[^\s]+\/\.claude\/plans\/[\w-]+\.md)/,
    extract: (match) => ({ path: match[1] }),
  },
];

// ANSI escape code stripper
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

// Extract plan file path from output
export function extractPlanFile(content: string): string | null {
  const cleanContent = stripAnsi(content);
  const match = getFirstMatch(cleanContent, planFilePatterns);
  if (match?.extracted?.path) {
    // Expand ~ to home directory
    let path = match.extracted.path;
    if (path.startsWith('~')) {
      path = path.replace('~', process.env.HOME || '');
    }
    return path;
  }
  return null;
}

// Match all patterns of a type against content
export function matchPatterns(
  content: string,
  patterns: PatternMatch[]
): { type: string; match: RegExpMatchArray; extracted?: Record<string, string> }[] {
  const cleanContent = stripAnsi(content);
  const matches: { type: string; match: RegExpMatchArray; extracted?: Record<string, string> }[] = [];

  for (const pattern of patterns) {
    const regex = new RegExp(pattern.pattern.source, pattern.pattern.flags || 'g');
    let match: RegExpMatchArray | null;

    while ((match = regex.exec(cleanContent)) !== null) {
      matches.push({
        type: pattern.type,
        match,
        extracted: pattern.extract ? pattern.extract(match) : undefined,
      });

      // If not global, only match once
      if (!pattern.pattern.flags?.includes('g')) break;
    }
  }

  return matches;
}

// Check if content matches any pattern in a set
export function hasMatch(content: string, patterns: PatternMatch[]): boolean {
  return matchPatterns(content, patterns).length > 0;
}

// Get the first match from a pattern set
export function getFirstMatch(
  content: string,
  patterns: PatternMatch[]
): { type: string; match: RegExpMatchArray; extracted?: Record<string, string> } | null {
  const matches = matchPatterns(content, patterns);
  return matches.length > 0 ? matches[0] : null;
}
