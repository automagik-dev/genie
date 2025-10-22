#!/usr/bin/env node

/**
 * Genie Workflow Output Parser
 *
 * Extracts structured data from Genie agent sessions for use in git hooks.
 *
 * Usage:
 *   node genie-workflow-parser.js <sessionId> <outputFormat>
 *
 * Formats:
 *   - json: Structured JSON output
 *   - exit-code: Returns 0/1/2 based on validation results
 *   - markdown: Markdown summary
 *   - validation: Validation results only
 *
 * Example:
 *   const result = require('./genie-workflow-parser.js')
 *   const output = result.parseSession('abc123', 'json')
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const LOGS_DIR = path.join(REPO_ROOT, '.genie', 'state', 'agents', 'logs');
const SESSIONS_FILE = path.join(REPO_ROOT, '.genie', 'state', 'agents', 'sessions.json');

class GenieworkflowParser {
  constructor() {
    this.output = [];
    this.errors = [];
    this.warnings = [];
    this.validations = {};
    this.exitCode = 0;
  }

  /**
   * Find log file for session
   */
  findLogFile(sessionId) {
    if (!fs.existsSync(LOGS_DIR)) return null;

    // Try direct lookup from sessions file first
    if (fs.existsSync(SESSIONS_FILE)) {
      try {
        const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
        const sessions = data.sessions || {};
        const entry = Object.values(sessions).find(s => s.sessionId === sessionId);
        if (entry && entry.logFile) {
          const logPath = entry.logFile.startsWith('/')
            ? entry.logFile
            : path.join(REPO_ROOT, entry.logFile);
          if (fs.existsSync(logPath)) return logPath;
        }
      } catch {}
    }

    // Fallback: find by pattern
    const files = fs.readdirSync(LOGS_DIR);
    const matching = files.find(f => f.includes(sessionId.substring(0, 8)));
    return matching ? path.join(LOGS_DIR, matching) : null;
  }

  /**
   * Parse JSONL log file
   */
  parseLogFile(logPath) {
    if (!fs.existsSync(logPath)) {
      this.errors.push(`Log file not found: ${logPath}`);
      return null;
    }

    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());

    const events = [];
    const messages = [];

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        events.push(event);

        // Extract assistant messages
        if (event.type === 'item.completed' && event.item?.item_type === 'assistant_message') {
          messages.push(event.item.text);
        }
      } catch {
        // Skip unparseable lines
      }
    }

    return { events, messages, fullText: messages.join('\n') };
  }

  /**
   * Extract validation structure from workflow output
   *
   * Genie workflows typically produce structured output like:
   * ```markdown
   * ## Validation Results
   *
   * ### ✅ Passed
   * - Rule 1 passed
   * - Rule 2 passed
   *
   * ### ⚠️ Warnings (2)
   * 1. Warning 1
   * 2. Warning 2
   *
   * ### ❌ Errors (1)
   * 1. Error 1
   * ```
   */
  extractValidationStructure(fullText) {
    const result = {
      passed: [],
      warnings: [],
      errors: [],
      hasBlockingErrors: false,
      hasWarnings: false
    };

    // Extract passed items
    const passedMatch = fullText.match(/###\s*✅\s*Passed[\s\S]*?(?=###|$)/);
    if (passedMatch) {
      const items = passedMatch[0].match(/[-*]\s+(.+)/g) || [];
      result.passed = items.map(item => item.replace(/^[-*]\s+/, '').trim());
    }

    // Extract warnings
    const warningsMatch = fullText.match(/###\s*⚠️\s*Warnings?\s*\((\d+)\)[\s\S]*?(?=###|$)/);
    if (warningsMatch) {
      const count = parseInt(warningsMatch[1]);
      if (count > 0) {
        result.hasWarnings = true;
        const items = warningsMatch[0].match(/^\d+\.\s+(.+?)(?=\n\d+\.|$)/gm) || [];
        result.warnings = items.map(item => item.replace(/^\d+\.\s+/, '').trim());
      }
    }

    // Extract errors
    const errorsMatch = fullText.match(/###\s*❌\s*(?:Blocking\s+)?Issues?\s*\((\d+)\)[\s\S]*?(?=###|$)/);
    if (errorsMatch) {
      const count = parseInt(errorsMatch[1]);
      if (count > 0) {
        result.hasBlockingErrors = true;
        const items = errorsMatch[0].match(/^\d+\.\s+(.+?)(?=\n\d+\.|$)/gm) || [];
        result.errors = items.map(item => item.replace(/^\d+\.\s+/, '').trim());
      }
    }

    return result;
  }

  /**
   * Parse session and extract validation data
   */
  parseSession(sessionId, format = 'json') {
    const logPath = this.findLogFile(sessionId);
    if (!logPath) {
      this.errors.push(`Session not found: ${sessionId}`);
      return this.formatOutput(format);
    }

    const parsed = this.parseLogFile(logPath);
    if (!parsed) {
      return this.formatOutput(format);
    }

    // Extract validation structure
    this.validations = this.extractValidationStructure(parsed.fullText);

    // Determine exit code
    if (this.validations.hasBlockingErrors) {
      this.exitCode = 2;
    } else if (this.validations.hasWarnings) {
      this.exitCode = 1;
    } else {
      this.exitCode = 0;
    }

    return this.formatOutput(format, parsed.fullText);
  }

  /**
   * Format output based on requested format
   */
  formatOutput(format, fullText = '') {
    switch (format) {
      case 'json':
        return JSON.stringify({
          exitCode: this.exitCode,
          validations: this.validations,
          errors: this.errors,
          warnings: this.warnings
        }, null, 2);

      case 'exit-code':
        return this.exitCode.toString();

      case 'validation':
        return JSON.stringify(this.validations, null, 2);

      case 'markdown':
        return fullText;

      case 'summary':
        return {
          exitCode: this.exitCode,
          passed: this.validations.passed?.length || 0,
          warnings: this.validations.warnings?.length || 0,
          errors: this.validations.errors?.length || 0,
          blocking: this.validations.hasBlockingErrors
        };

      default:
        return JSON.stringify({
          exitCode: this.exitCode,
          validations: this.validations
        }, null, 2);
    }
  }
}

// Module export
if (require.main === module) {
  // CLI usage: node script.js <sessionId> <format>
  const sessionId = process.argv[2];
  const format = process.argv[3] || 'json';

  if (!sessionId) {
    console.error('Usage: genie-workflow-parser.js <sessionId> [format]');
    console.error('Formats: json, exit-code, markdown, validation, summary');
    process.exit(1);
  }

  const parser = new GenieworkflowParser();
  const output = parser.parseSession(sessionId, format);

  if (format === 'exit-code') {
    process.stdout.write(output);
    process.exit(parseInt(output));
  } else if (format === 'summary' && typeof output === 'object') {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(output);
  }
} else {
  // Module export
  module.exports = GenieworkflowParser;
}
