#!/usr/bin/env node

/**
 * session-state-updater.js
 *
 * Updates SESSION-STATE.md with agent/workflow session information.
 * Called by agents via: !`npx node .genie/scripts/session-state-updater.js "action=started agent=implementor session_id=abc123 purpose=..."`
 *
 * Parameters (space or key=value separated):
 * - action: started|in_progress|completed|waiting|paused
 * - agent: agent name (implementor, tests, git, genie, learn, release, roadmap)
 * - session_id: UUID or session identifier
 * - purpose: string description of work
 * - context: optional structured data
 * - parent_session: optional parent UUID for child workflows
 * - branch: optional branch name
 *
 * Returns JSON with status and details
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ============================================================================
// Parsing
// ============================================================================

function parseParameters(argsString) {
  if (!argsString) return {};

  const params = {};
  const pairs = argsString.split(/\s+/).filter(Boolean);

  for (const pair of pairs) {
    if (pair.includes('=')) {
      const [key, ...valueParts] = pair.split('=');
      params[key.toLowerCase()] = valueParts.join('=');
    }
  }

  return params;
}

function validateParameters(params) {
  const errors = [];

  if (!params.action) errors.push('Missing required parameter: action');
  if (!['started', 'in_progress', 'completed', 'waiting', 'paused'].includes(params.action)) {
    errors.push(`Invalid action: ${params.action}. Must be: started|in_progress|completed|waiting|paused`);
  }

  if (!params.agent) errors.push('Missing required parameter: agent');
  if (!params.session_id) errors.push('Missing required parameter: session_id');

  if (errors.length > 0) {
    throw new Error(`Parameter validation failed:\n${errors.join('\n')}`);
  }
}

// ============================================================================
// Session State Management
// ============================================================================

function readSessionState() {
  const statePath = path.join(process.cwd(), '.genie', 'SESSION-STATE.md');
  if (!fs.existsSync(statePath)) {
    throw new Error('.genie/SESSION-STATE.md not found');
  }
  return fs.readFileSync(statePath, 'utf8');
}

function getCurrentTimestamp() {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function formatSessionEntry(params) {
  const timestamp = getCurrentTimestamp();
  let entry = `### ${params.agent.charAt(0).toUpperCase() + params.agent.slice(1)} - ${params.purpose || 'Unknown task'}\n`;
  entry += `**Session ID:** \`${params.session_id}\`\n`;
  entry += `**Started:** ${timestamp}\n`;
  entry += `**Status:** ${params.action}\n`;

  if (params.parent_session) {
    entry += `**Parent:** ${params.parent_session}\n`;
  }

  if (params.branch) {
    entry += `**Branch:** ${params.branch}\n`;
  }

  if (params.context) {
    entry += `**Context:** ${params.context}\n`;
  }

  entry += `**Next:** [pending]\n`;

  return entry;
}

function updateSessionState(content, params, action) {
  const activeSection = '## 🎯 Active Sessions';

  // Find or create session entry
  const sessionIdPattern = `**Session ID:** \`${params.session_id}\``;
  let existingEntryIndex = content.indexOf(sessionIdPattern);

  if (action === 'started' && existingEntryIndex === -1) {
    // Create new entry in Active Sessions
    const newEntry = formatSessionEntry(params);
    const insertPos = content.indexOf(activeSection);

    if (insertPos === -1) {
      throw new Error('Could not find "## 🎯 Active Sessions" section in SESSION-STATE.md');
    }

    // Find the end of the section header line
    const lineEnd = content.indexOf('\n', insertPos) + 1;
    // Check if there's another newline (separator line)
    const nextLineEnd = content.indexOf('\n', lineEnd);
    let insertAfter = nextLineEnd + 1;

    // Skip empty lines
    while (insertAfter < content.length && content[insertAfter] === '\n') {
      insertAfter++;
    }

    return content.slice(0, insertAfter) + newEntry + '\n\n' + content.slice(insertAfter);
  }

  if (existingEntryIndex !== -1) {
    // Update existing entry
    const entryStart = content.lastIndexOf('### ', existingEntryIndex);
    const entryEnd = content.indexOf('\n---', existingEntryIndex);
    const nextSectionStart = content.indexOf('\n### ', existingEntryIndex + 1);

    let entryEndPos;
    if (entryEnd !== -1) {
      entryEndPos = entryEnd;
    } else if (nextSectionStart !== -1) {
      entryEndPos = nextSectionStart;
    } else {
      entryEndPos = content.length;
    }

    const existingEntry = content.slice(entryStart, entryEndPos);

    // Update status line
    let updatedEntry = existingEntry.replace(
      /\*\*Status:\*\* \w+/,
      `**Status:** ${params.action}`
    );

    // Update context if provided
    if (params.context) {
      if (updatedEntry.includes('**Context:**')) {
        updatedEntry = updatedEntry.replace(
          /\*\*Context:\*\* .+/,
          `**Context:** ${params.context}`
        );
      } else {
        updatedEntry = updatedEntry.replace(
          /\*\*Next:\*\* /,
          `**Context:** ${params.context}\n**Next:** `
        );
      }
    }

    // Handle status transitions
    if (action === 'completed') {
      // Move to history (we'll update Last Updated timestamp)
      updatedEntry = updatedEntry.replace(
        /\*\*Started:\*\*/,
        `**Completed:** ${getCurrentTimestamp()}\n**Started:**`
      );
    }

    return content.slice(0, entryStart) + updatedEntry + content.slice(entryEndPos);
  }

  return content;
}

// ============================================================================
// Main
// ============================================================================

function main() {
  try {
    const argsString = process.argv.slice(2).join(' ');
    const params = parseParameters(argsString);

    validateParameters(params);

    const currentContent = readSessionState();
    const updatedContent = updateSessionState(currentContent, params, params.action);

    // Write updated content
    const statePath = path.join(process.cwd(), '.genie', 'SESSION-STATE.md');
    fs.writeFileSync(statePath, updatedContent);

    // Stage the file
    execSync('git add .genie/SESSION-STATE.md', { stdio: 'pipe' });

    // Return success
    const response = {
      status: 'success',
      action: params.action,
      session_id: params.session_id,
      agent: params.agent,
      updated_files: ['.genie/SESSION-STATE.md'],
      timestamp: getCurrentTimestamp(),
      message: `Session state updated: ${params.action} (${params.agent})`
    };

    console.log(JSON.stringify(response, null, 2));
    process.exit(0);

  } catch (error) {
    const response = {
      status: 'failed',
      error: error.message,
      details: error.stack
    };

    console.error(JSON.stringify(response, null, 2));
    process.exit(1);
  }
}

main();
