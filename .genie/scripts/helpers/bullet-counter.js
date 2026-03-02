#!/usr/bin/env node

/**
 * Bullet Counter Updater
 *
 * Find and update helpful/harmful counters for learning bullets.
 *
 * Usage:
 *   genie helper bullet-counter ID --helpful
 *   genie helper bullet-counter ID --harmful
 *   genie helper bullet-counter ID (show current counters)
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

/**
 * Find bullet by ID across all markdown files
 * Returns: { file, line, content, helpful, harmful }
 */
function findBullet(id) {
  const searchPath = path.join(process.cwd(), '.genie');

  // Use ripgrep to find the bullet
  const pattern = `^- \\[${id}\\] helpful=(\\d+) harmful=(\\d+):`;

  try {
    const { execSync } = require('child_process');
    const result = execSync(
      `rg -n "${pattern}" "${searchPath}"`,
      { encoding: 'utf-8' }
    ).trim();

    if (!result) {
      return null;
    }

    // Parse result: file:line:content
    const match = result.match(/^([^:]+):(\d+):(.+)$/);
    if (!match) {
      return null;
    }

    const [, file, lineNum, content] = match;

    // Extract counters from content
    const counterMatch = content.match(/helpful=(\d+) harmful=(\d+)/);
    if (!counterMatch) {
      return null;
    }

    return {
      file: file,
      line: parseInt(lineNum, 10),
      content: content,
      helpful: parseInt(counterMatch[1], 10),
      harmful: parseInt(counterMatch[2], 10)
    };
  } catch (err) {
    // rg returns exit code 1 when no matches found
    if (err.status === 1) {
      return null;
    }
    throw err;
  }
}

/**
 * Update bullet counter in file
 */
function updateBulletCounter(bullet, incrementHelpful, incrementHarmful) {
  const newHelpful = bullet.helpful + (incrementHelpful ? 1 : 0);
  const newHarmful = bullet.harmful + (incrementHarmful ? 1 : 0);

  // Read file
  const content = fs.readFileSync(bullet.file, 'utf-8');
  const lines = content.split('\n');

  // Update the line (1-indexed to 0-indexed)
  const lineIndex = bullet.line - 1;
  const oldLine = lines[lineIndex];

  // Replace counters in the line
  const newLine = oldLine.replace(
    /helpful=(\d+) harmful=(\d+)/,
    `helpful=${newHelpful} harmful=${newHarmful}`
  );

  if (oldLine === newLine) {
    console.error('Warning: No change detected');
    return bullet;
  }

  // Write updated content
  lines[lineIndex] = newLine;
  fs.writeFileSync(bullet.file, lines.join('\n'));

  return {
    ...bullet,
    content: newLine,
    helpful: newHelpful,
    harmful: newHarmful
  };
}

/**
 * Display bullet info
 */
function displayBullet(bullet) {
  console.log(JSON.stringify({
    file: path.relative(process.cwd(), bullet.file),
    line: bullet.line,
    helpful: bullet.helpful,
    harmful: bullet.harmful,
    content: bullet.content.trim()
  }, null, 2));
}

/**
 * Main CLI
 */
async function main() {
  const args = process.argv.slice(2);

  // Help
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('Usage:');
    console.log('  genie helper bullet-counter ID');
    console.log('    Show current counters for bullet');
    console.log('');
    console.log('  genie helper bullet-counter ID --helpful');
    console.log('    Increment helpful counter');
    console.log('');
    console.log('  genie helper bullet-counter ID --harmful');
    console.log('    Increment harmful counter');
    console.log('');
    console.log('Examples:');
    console.log('  $ genie helper bullet-counter learn-042');
    console.log('  {');
    console.log('    "file": ".genie/spells/learn.md",');
    console.log('    "line": 356,');
    console.log('    "helpful": 5,');
    console.log('    "harmful": 0');
    console.log('  }');
    console.log('');
    console.log('  $ genie helper bullet-counter learn-042 --helpful');
    console.log('  Updated: helpful=6 harmful=0');
    return;
  }

  const id = args[0];
  const incrementHelpful = args.includes('--helpful');
  const incrementHarmful = args.includes('--harmful');

  if (!id) {
    console.error('Error: Bullet ID required');
    console.error('Usage: genie helper bullet-counter ID [--helpful|--harmful]');
    process.exit(1);
  }

  // Find bullet
  const bullet = findBullet(id);

  if (!bullet) {
    console.error(`Error: Bullet [${id}] not found`);
    console.error('');
    console.error('Searched in: .genie/');
    console.error('Pattern: - [ID] helpful=N harmful=M: content');
    console.error('');
    console.error('Tip: Use "genie helper bullet-find" to search for bullets');
    process.exit(1);
  }

  // Show current state
  if (!incrementHelpful && !incrementHarmful) {
    displayBullet(bullet);
    return;
  }

  // Update counter
  const updated = updateBulletCounter(bullet, incrementHelpful, incrementHarmful);

  console.log(`Updated: helpful=${updated.helpful} harmful=${updated.harmful}`);
  console.log(`File: ${path.relative(process.cwd(), updated.file)}:${updated.line}`);
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
