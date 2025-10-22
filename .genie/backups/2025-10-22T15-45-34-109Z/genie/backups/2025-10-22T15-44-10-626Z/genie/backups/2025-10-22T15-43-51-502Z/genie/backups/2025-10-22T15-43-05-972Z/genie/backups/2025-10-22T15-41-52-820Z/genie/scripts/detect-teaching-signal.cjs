#!/usr/bin/env node
/**
 * detect-teaching-signal.js
 *
 * Purpose: Auto-detect teaching moments in conversation transcripts
 * Triggers: "Let me teach you", "You should have", "From now on", "That was wrong because"
 * Action: Log teaching moment and suggest invoking learn agent
 *
 * Usage: node detect-teaching-signal.js <transcript-file>
 *
 * Part of: Skills Prioritization & Architecture Automation (Wish #107)
 */

const fs = require('fs');
const path = require('path');

// Teaching signal patterns (from routing.md lines 108-114)
const TEACHING_PATTERNS = [
  /let me teach you/i,
  /you should have/i,
  /from now on/i,
  /that was wrong because/i,
  /next time.*do this/i,
  /remember to always/i,
  /important lesson/i,
  /key learning/i
];

/**
 * Detect teaching signals in a transcript
 * @param {string} transcriptPath - Path to conversation transcript
 * @returns {Array} - Array of detected teaching moments with context
 */
function detectTeachingSignals(transcriptPath) {
  if (!fs.existsSync(transcriptPath)) {
    console.error(`❌ Transcript file not found: ${transcriptPath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const lines = content.split('\n');

  const teachingMoments = [];

  lines.forEach((line, index) => {
    TEACHING_PATTERNS.forEach(pattern => {
      if (pattern.test(line)) {
        teachingMoments.push({
          line: index + 1,
          content: line.trim(),
          pattern: pattern.source,
          context: getContext(lines, index)
        });
      }
    });
  });

  return teachingMoments;
}

/**
 * Get surrounding context for a teaching moment
 * @param {Array} lines - All lines in transcript
 * @param {number} index - Index of teaching moment
 * @returns {string} - Context lines (±2 lines)
 */
function getContext(lines, index) {
  const start = Math.max(0, index - 2);
  const end = Math.min(lines.length, index + 3);
  return lines.slice(start, end).join('\n');
}

/**
 * Generate learn agent invocation suggestion
 * @param {Array} moments - Detected teaching moments
 * @returns {string} - Suggested command
 */
function generateLearnSuggestion(moments) {
  if (moments.length === 0) {
    return '✅ No teaching signals detected.';
  }

  const suggestions = moments.map((moment, i) => {
    return `
📚 Teaching Moment #${i + 1} (Line ${moment.line}):
   "${moment.content}"

   Pattern matched: ${moment.pattern}

   Context:
   ${moment.context.split('\n').map(l => '   ' + l).join('\n')}

   ✅ Action: Invoke learn agent
   Command: mcp__genie__run agent="learn" prompt="Teaching: [describe learning]"
`;
  }).join('\n---\n');

  return `
🔍 Detected ${moments.length} teaching signal(s):
${suggestions}

⚠️ CRITICAL: According to routing.md (lines 106-127), teaching moments should trigger learn agent invocation.
   Do NOT skip this step - document the learning immediately.
`;
}

// Main execution
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
Usage: node detect-teaching-signal.js <transcript-file>

Detects teaching moments in conversation transcripts and suggests learn agent invocation.

Teaching patterns:
${TEACHING_PATTERNS.map(p => `  - ${p.source}`).join('\n')}
`);
    process.exit(0);
  }

  const transcriptPath = path.resolve(args[0]);
  const moments = detectTeachingSignals(transcriptPath);
  const suggestion = generateLearnSuggestion(moments);

  console.log(suggestion);

  // Exit with non-zero if teaching moments found (for CI/CD integration)
  process.exit(moments.length > 0 ? 1 : 0);
}

module.exports = { detectTeachingSignals, generateLearnSuggestion };
