#!/usr/bin/env node
/**
 * track-promise.js
 *
 * Purpose: Say-do gap detector - tracks promises vs actual actions
 * Detects: Commitments made vs tasks completed
 * Action: Report gaps between promises and execution
 *
 * Usage: node track-promise.js <transcript-file>
 *
 * Part of: Skills Prioritization & Architecture Automation (Wish #107)
 * Related: execution-integrity-protocol.md
 */

const fs = require('fs');
const path = require('path');

// Promise patterns (commitment signals)
const PROMISE_PATTERNS = [
  /I will\s+(.+)/i,
  /I'll\s+(.+)/i,
  /Let me\s+(.+)/i,
  /I'm going to\s+(.+)/i,
  /Next,?\s+I'll\s+(.+)/i,
  /I'll start by\s+(.+)/i,
  /I'll then\s+(.+)/i,
  /I plan to\s+(.+)/i,
  /I'm planning to\s+(.+)/i,
  /The next step is to\s+(.+)/i
];

// Completion patterns (action signals)
const COMPLETION_PATTERNS = [
  /✅\s*(.+)/,
  /Done:?\s+(.+)/i,
  /Completed:?\s+(.+)/i,
  /Finished:?\s+(.+)/i,
  /Successfully\s+(.+)/i,
  /Created:?\s+(.+)/i,
  /Implemented:?\s+(.+)/i,
  /Fixed:?\s+(.+)/i
];

/**
 * Extract promises from transcript
 * @param {string} content - Transcript content
 * @returns {Array} - Array of promises with line numbers
 */
function extractPromises(content) {
  const lines = content.split('\n');
  const promises = [];

  lines.forEach((line, index) => {
    PROMISE_PATTERNS.forEach(pattern => {
      const match = line.match(pattern);
      if (match) {
        promises.push({
          line: index + 1,
          content: line.trim(),
          action: match[1].trim(),
          fulfilled: false,
          timestamp: null
        });
      }
    });
  });

  return promises;
}

/**
 * Extract completions from transcript
 * @param {string} content - Transcript content
 * @returns {Array} - Array of completed actions with line numbers
 */
function extractCompletions(content) {
  const lines = content.split('\n');
  const completions = [];

  lines.forEach((line, index) => {
    COMPLETION_PATTERNS.forEach(pattern => {
      const match = line.match(pattern);
      if (match) {
        completions.push({
          line: index + 1,
          content: line.trim(),
          action: match[1].trim()
        });
      }
    });
  });

  return completions;
}

/**
 * Match promises with completions using fuzzy matching
 * @param {Array} promises - Extracted promises
 * @param {Array} completions - Extracted completions
 * @returns {Array} - Promises with fulfillment status
 */
function matchPromisesWithCompletions(promises, completions) {
  return promises.map(promise => {
    // Check if any completion matches this promise (fuzzy match)
    const matchingCompletion = completions.find(completion => {
      const promiseWords = promise.action.toLowerCase().split(/\s+/);
      const completionWords = completion.action.toLowerCase().split(/\s+/);

      // Count common words (simple similarity)
      const commonWords = promiseWords.filter(word =>
        word.length > 3 && completionWords.some(cw => cw.includes(word) || word.includes(cw))
      );

      // Consider fulfilled if 50%+ overlap
      return commonWords.length >= Math.min(promiseWords.length, completionWords.length) * 0.5;
    });

    if (matchingCompletion) {
      return {
        ...promise,
        fulfilled: true,
        completionLine: matchingCompletion.line,
        completionContent: matchingCompletion.content
      };
    }

    return promise;
  });
}

/**
 * Analyze say-do gap
 * @param {string} transcriptPath - Path to transcript file
 * @returns {Object} - Analysis result with gaps and stats
 */
function analyzeSayDoGap(transcriptPath) {
  if (!fs.existsSync(transcriptPath)) {
    console.error(`❌ Transcript file not found: ${transcriptPath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(transcriptPath, 'utf-8');

  const promises = extractPromises(content);
  const completions = extractCompletions(content);
  const matched = matchPromisesWithCompletions(promises, completions);

  const fulfilled = matched.filter(p => p.fulfilled);
  const unfulfilled = matched.filter(p => !p.fulfilled);

  return {
    totalPromises: promises.length,
    fulfilled: fulfilled.length,
    unfulfilled: unfulfilled.length,
    fulfillmentRate: promises.length > 0 ? (fulfilled.length / promises.length * 100).toFixed(1) : 0,
    unfulfilledPromises: unfulfilled,
    fulfilledPromises: fulfilled,
    allPromises: matched
  };
}

/**
 * Generate say-do gap report
 * @param {Object} analysis - Analysis result
 * @returns {string} - Formatted report
 */
function generateReport(analysis) {
  let report = `
📊 Say-Do Gap Analysis
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Total Promises: ${analysis.totalPromises}
Fulfilled: ${analysis.fulfilled} (${analysis.fulfillmentRate}%)
Unfulfilled: ${analysis.unfulfilled}

`;

  if (analysis.unfulfilled > 0) {
    report += `\n⚠️  UNFULFILLED PROMISES:\n`;
    analysis.unfulfilledPromises.forEach((promise, i) => {
      report += `
${i + 1}. Line ${promise.line}: "${promise.content}"
   Action: ${promise.action}
   Status: 🔴 NOT COMPLETED
`;
    });
  }

  if (analysis.fulfilled > 0) {
    report += `\n✅ FULFILLED PROMISES:\n`;
    analysis.fulfilledPromises.slice(0, 5).forEach((promise, i) => {
      report += `
${i + 1}. Line ${promise.line} → ${promise.completionLine}
   Promised: ${promise.action}
   Completed: ✅ (Line ${promise.completionLine})
`;
    });

    if (analysis.fulfilled > 5) {
      report += `\n   ... and ${analysis.fulfilled - 5} more\n`;
    }
  }

  if (analysis.unfulfilled > 0) {
    report += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚨 ACTION REQUIRED: ${analysis.unfulfilled} promise(s) not fulfilled

Recommendations:
  1. Review unfulfilled promises and complete them
  2. Update transcript or clarify status
  3. If not needed, document why promise was not fulfilled

Related: execution-integrity-protocol.md (say-do gap detection)
`;
  } else {
    report += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ All promises fulfilled! No say-do gap detected.
`;
  }

  return report;
}

/**
 * Export analysis as JSON
 * @param {Object} analysis - Analysis result
 * @param {string} outputPath - Output file path
 */
function exportAnalysis(analysis, outputPath) {
  const json = JSON.stringify(analysis, null, 2);
  fs.writeFileSync(outputPath, json, 'utf-8');
  console.log(`✅ Analysis exported to ${outputPath}`);
}

// Main execution
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
Usage: node track-promise.js <transcript-file> [--export <output.json>]

Detects say-do gaps by tracking promises vs completed actions.

Promise patterns:
${PROMISE_PATTERNS.map(p => `  - ${p.source}`).join('\n')}

Completion patterns:
${COMPLETION_PATTERNS.map(p => `  - ${p.source}`).join('\n')}

Options:
  --export <path>   Export analysis as JSON
`);
    process.exit(0);
  }

  const transcriptPath = path.resolve(args[0]);
  const exportIndex = args.indexOf('--export');
  const exportPath = exportIndex !== -1 ? path.resolve(args[exportIndex + 1]) : null;

  const analysis = analyzeSayDoGap(transcriptPath);
  const report = generateReport(analysis);

  console.log(report);

  if (exportPath) {
    exportAnalysis(analysis, exportPath);
  }

  // Exit with non-zero if say-do gap exists
  process.exit(analysis.unfulfilled > 0 ? 1 : 0);
}

module.exports = { analyzeSayDoGap, generateReport, extractPromises, extractCompletions };
