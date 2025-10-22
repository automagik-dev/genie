#!/usr/bin/env node
/**
 * log-blocker.js
 *
 * Purpose: Auto-log blockers detected in conversation to wishes
 * Triggers: "blocked", "cannot proceed", "dependency missing", "permission denied"
 * Action: Create or update blocker log in appropriate wish document
 *
 * Usage: node log-blocker.js <transcript-file> [--wish-path <path>]
 *
 * Part of: Skills Prioritization & Architecture Automation (Wish #107)
 */

const fs = require('fs');
const path = require('path');

// Blocker signal patterns (from blocker-protocol.md)
const BLOCKER_PATTERNS = [
  /blocked by/i,
  /cannot proceed/i,
  /dependency missing/i,
  /permission denied/i,
  /waiting for/i,
  /requires.*before/i,
  /blocker:/i,
  /stuck on/i,
  /needs.*first/i,
  /prerequisite not met/i
];

/**
 * Detect blockers in a transcript
 * @param {string} transcriptPath - Path to conversation transcript
 * @returns {Array} - Array of detected blockers with context
 */
function detectBlockers(transcriptPath) {
  if (!fs.existsSync(transcriptPath)) {
    console.error(`❌ Transcript file not found: ${transcriptPath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const lines = content.split('\n');

  const blockers = [];

  lines.forEach((line, index) => {
    BLOCKER_PATTERNS.forEach(pattern => {
      if (pattern.test(line)) {
        blockers.push({
          line: index + 1,
          content: line.trim(),
          pattern: pattern.source,
          context: getContext(lines, index),
          timestamp: new Date().toISOString()
        });
      }
    });
  });

  return blockers;
}

/**
 * Get surrounding context for a blocker
 * @param {Array} lines - All lines in transcript
 * @param {number} index - Index of blocker
 * @returns {string} - Context lines (±3 lines)
 */
function getContext(lines, index) {
  const start = Math.max(0, index - 3);
  const end = Math.min(lines.length, index + 4);
  return lines.slice(start, end).join('\n');
}

/**
 * Format blockers for wish document
 * @param {Array} blockers - Detected blockers
 * @returns {string} - Formatted blocker section
 */
function formatBlockersForWish(blockers) {
  if (blockers.length === 0) {
    return '';
  }

  const formatted = blockers.map((blocker, i) => {
    return `
### Blocker #${i + 1} (Detected: ${blocker.timestamp})

**Line ${blocker.line}:**
> ${blocker.content}

**Context:**
\`\`\`
${blocker.context}
\`\`\`

**Pattern matched:** \`${blocker.pattern}\`

**Status:** 🔴 ACTIVE
**Workaround:** [To be determined]
`;
  }).join('\n---\n');

  return `
## 🚫 Blockers

${formatted}
`;
}

/**
 * Append blockers to wish document
 * @param {string} wishPath - Path to wish document
 * @param {Array} blockers - Detected blockers
 */
function appendBlockersToWish(wishPath, blockers) {
  if (blockers.length === 0) {
    console.log('✅ No blockers detected.');
    return;
  }

  if (!fs.existsSync(wishPath)) {
    console.error(`❌ Wish document not found: ${wishPath}`);
    console.log('💡 Specify wish path with --wish-path option');
    process.exit(1);
  }

  const wishContent = fs.readFileSync(wishPath, 'utf-8');
  const blockerSection = formatBlockersForWish(blockers);

  // Check if blocker section already exists
  if (wishContent.includes('## 🚫 Blockers')) {
    console.log('⚠️  Blocker section already exists in wish document');
    console.log('📝 Manual merge required:');
    console.log(blockerSection);
  } else {
    // Append blocker section before "## 📝 Lessons Learned" or at end
    let updatedContent;
    if (wishContent.includes('## 📝 Lessons Learned')) {
      updatedContent = wishContent.replace(
        '## 📝 Lessons Learned',
        blockerSection + '\n---\n\n## 📝 Lessons Learned'
      );
    } else {
      updatedContent = wishContent + '\n---\n' + blockerSection;
    }

    fs.writeFileSync(wishPath, updatedContent, 'utf-8');
    console.log(`✅ Logged ${blockers.length} blocker(s) to ${wishPath}`);
  }
}

/**
 * Generate blocker report
 * @param {Array} blockers - Detected blockers
 * @returns {string} - Formatted report
 */
function generateBlockerReport(blockers) {
  if (blockers.length === 0) {
    return '✅ No blockers detected.';
  }

  const report = blockers.map((blocker, i) => {
    return `
🚫 Blocker #${i + 1} (Line ${blocker.line}):
   "${blocker.content}"

   Pattern: ${blocker.pattern}
   Detected: ${blocker.timestamp}
`;
  }).join('\n---\n');

  return `
🔍 Detected ${blockers.length} blocker(s):
${report}

💡 Action: Log to wish document or create workaround
   Use: --wish-path <path> to automatically append to wish
`;
}

// Main execution
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
Usage: node log-blocker.js <transcript-file> [--wish-path <path>]

Detects blockers in conversation transcripts and logs them to wish documents.

Blocker patterns:
${BLOCKER_PATTERNS.map(p => `  - ${p.source}`).join('\n')}

Options:
  --wish-path <path>   Path to wish document to append blockers
`);
    process.exit(0);
  }

  const transcriptPath = path.resolve(args[0]);
  const wishPathIndex = args.indexOf('--wish-path');
  const wishPath = wishPathIndex !== -1 ? path.resolve(args[wishPathIndex + 1]) : null;

  const blockers = detectBlockers(transcriptPath);

  if (wishPath) {
    appendBlockersToWish(wishPath, blockers);
  } else {
    const report = generateBlockerReport(blockers);
    console.log(report);
  }

  // Exit with non-zero if blockers found (for CI/CD integration)
  process.exit(blockers.length > 0 ? 1 : 0);
}

module.exports = { detectBlockers, formatBlockersForWish, appendBlockersToWish };
